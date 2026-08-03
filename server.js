const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');
const Vec3 = require('vec3');

process.env.DEBUG = 'minecraft-protocol';

const { setupFarming }       = require('./modules/farming');
const { setupSpawnerLoot }   = require('./modules/spawnerLoot');
const { setupElytraFlight }  = require('./modules/elytraFlight');
const { setupMapDownloader } = require('./modules/mapDownloader');
const { setupZigzagFlight }  = require('./modules/zigzagFlight');

app.use(express.static('web'));
app.get('/', (req, res) => res.sendFile(__dirname + '/web/main.html'));

const bots = {};
let nextBotId = 1;

function genId() { return `bot_${nextBotId++}`; }

function broadcastPlayerList(id) {
    const entry = bots[id];
    if (entry && entry.bot && entry.bot.players) {
        io.emit(`player_list_${id}`, Object.keys(entry.bot.players));
    }
}

function emitStatus(id, status) {
    console.log(`[STATUS][${id}] ${status}`);
    io.emit(`bot_status_${id}`, status);
}

function setupBotEvents(id, socket) {
    const entry = bots[id];
    if (!entry || !entry.bot) return;
    const { bot } = entry;

    bot.removeAllListeners('messagestr');
    bot.removeAllListeners('playerJoined');
    bot.removeAllListeners('playerLeft');
    bot.removeAllListeners('error');
    bot.removeAllListeners('kicked');

    entry.chatHistory.forEach(msg => socket.emit(`bot_chat_${id}`, msg));

    bot.on('messagestr', (message) => {
        io.emit(`bot_chat_${id}`, message);
        if (!entry.chatHistory.includes(message)) {
            entry.chatHistory.push(message);
            if (entry.chatHistory.length > 50) entry.chatHistory.shift();
        }
    });

    bot.on('playerJoined', () => broadcastPlayerList(id));
    bot.on('playerLeft',  () => broadcastPlayerList(id));

    bot.on('error', err => {
        console.log(`[ERROR][${id}]`, err);
        emitStatus(id, err.message);
    });

    bot.on('kicked', () => emitStatus(id, 'Kicked'));
}

io.on('connection', (socket) => {
    console.log('[SERVER] Web client connected');

    const summary = Object.entries(bots).map(([id, e]) => ({
        id,
        label:    e.config.label,
        authType: e.config.authType,
    }));
    socket.emit('bot_list', summary);

    Object.entries(bots).forEach(([id, entry]) => {
        socket.emit(`bot_status_${id}`, 'Active (Physics ON)');
        if (entry.bot && entry.bot.players)
            socket.emit(`player_list_${id}`, Object.keys(entry.bot.players));
        setupBotEvents(id, socket);
    });

    socket.on('create_bot', (data) => {
        console.log('[SERVER] create_bot:', data);
        const id    = genId();
        const label = data.label || `Bot ${id}`;
        bots[id] = {
            bot: null, chatHistory: [], spawnTimer: null,
            moduleStarted: false,
            config: { label, authType: data.authType || 'offline' }
        };
        io.emit('bot_added', { id, label, authType: data.authType || 'offline' });
    });

    socket.on('stop_module', ({ id }) => {
        const entry = bots[id];
        if (!entry || !entry.bot) return;
        entry.moduleStarted = false;
        entry.bot.emit('stop_module_signal');
        emitStatus(id, 'Module Stopped');
        console.log(`[SERVER][${id}] Module aborted by user`);
    });

    socket.on('start_bot', (data) => {
        console.log('[SERVER] start_bot:', data);
        const { id } = data;
        if (!bots[id] || bots[id].bot) return;

        const entry = bots[id];
        entry.config = { ...entry.config, ...data };

        entry.module = data.module || 'none';

        entry.spawnerX = parseInt(data.spawnerX) || 0;
        entry.spawnerY = parseInt(data.spawnerY) || 0;
        entry.spawnerZ = parseInt(data.spawnerZ) || 0;

        entry.elytraStartX  = parseInt(data.elytraStartX)  || 0;
        entry.elytraStartZ  = parseInt(data.elytraStartZ)  || 0;
        entry.elytraEndZ    = parseInt(data.elytraEndZ)    || 1000;
        entry.elytraEndX    = parseInt(data.elytraEndX)    || 1000;
        entry.elytraStepX   = parseInt(data.elytraStepX)   || 100;
        entry.elytraStepZ   = parseInt(data.elytraStepZ)   || 168;

        entry.zigFirstX     = parseInt(data.zigFirstX);
        entry.zigFirstZ     = parseInt(data.zigFirstZ);
        entry.zigXLength    = parseInt(data.zigXLength);
        entry.zigZStep      = parseInt(data.zigZStep);

        console.log(`[SERVER][${id}] Module: ${entry.module}`);

        const botOptions = {
            host:                 data.host    || 'mcsmp.gg',
            version:              data.version || '1.20.1',
            hideErrors:           true,
            physicsEnabled:       true,
            checkTimeoutInterval: 60000,
            viewDistance: 'far',
        };

        if (data.authType === 'microsoft') {
            botOptions.auth            = 'microsoft';
            botOptions.username        = data.username;
            botOptions.profilesFolder  = `./profiles/${id}`;
            emitStatus(id, 'Waiting for Microsoft login (check console)');
        } else {
            botOptions.username = data.username;
            botOptions.auth     = 'offline';
        }

        spawnBot(id, botOptions, data, socket);
    });

    socket.on('command_from_web', ({ id, cmd }) => {
        const entry = bots[id];
        if (entry && entry.bot) entry.bot.chat(cmd);
    });

    socket.on('stop_bot', ({ id }) => {
        const entry = bots[id];
        if (!entry) return;
        if (entry.spawnTimer) clearTimeout(entry.spawnTimer);
        if (entry.bot) {
            entry.bot.removeAllListeners();
            entry.bot.quit();
            entry.bot = null;
        }
        entry.chatHistory   = [];
        entry.moduleStarted = false;
        emitStatus(id, 'Disconnected');
    });

    socket.on('remove_bot', ({ id }) => {
        const entry = bots[id];
        if (!entry) return;

        if (entry.spawnTimer) clearTimeout(entry.spawnTimer);

        if (entry.bot) {
            if (typeof entry.bot.quit === 'function') {
                entry.bot.quit();
            } else if (typeof entry.bot.end === 'function') {
                entry.bot.end();
            }
        }

        delete bots[id];
        io.emit('bot_removed', { id });
    });
});

function spawnBot(id, botOptions, data, socket) {
    const entry = bots[id];
    if (!entry) return; // Guard clause in case it was already deleted

    const bot = mineflayer.createBot(botOptions);
    if (!bots[id]) {
        bot.quit();
        return;
    }
    entry.bot = bot;
    entry.moduleStarted = false;
    setupBotEvents(id, socket);

    bot.on('resource_pack', () => bot.acceptResourcePack());

    bot.once('login', () => {
        console.log(`[BOT][${id}] Login`);
        emitStatus(id, 'World Loaded...');
        
        if (!bots[id]) return;

        bots[id].spawnTimer = setTimeout(() => {
            if (!bots[id]) return;
            if (data.password) bot.chat(`/login ${data.password}`);
            setTimeout(() => {
                if (!bots[id]) return;
                bot.physics.enabled = true;
                emitStatus(id, 'Active (Physics ON)');
            }, 3000);
        }, 5000);
    });

    bot.on('spawn', () => {
        console.log(`[BOT][${id}] Spawn. Pos: ${JSON.stringify(bot.entity.position)}`);

        if (entry.moduleStarted) {
            console.log(`[BOT][${id}] Module already running — ignoring duplicate spawn`);
            return;
        }
        entry.moduleStarted = true;

        bot.isReady = false;

        setTimeout(async () => {
            broadcastPlayerList(id);
            bot.isReady = true;
            emitStatus(id, 'Active (Physics ON)');

            const mod = entry.module || 'none';
            console.log(`[BOT][${id}] Starting module: ${mod}`);
            emitStatus(id, `Module: ${mod}`);

            // ── Shared utilities (accessible to ALL modules) ──────────────────
            async function manageElytraDurability() {
                const elytra = bot.inventory.slots.find(item => item && item.name === 'elytra');
                if (!elytra) return;
                const durability = 432 - (elytra.durabilityUsed || 0);
                if (durability <= 20) {
                    const spare = bot.inventory.slots.find(item => {
                        // Basic checks: item exists, is an elytra, and isn't the one currently equipped
                        if (!item || item.name !== 'elytra' || item.slot === elytra.slot) return false;

                        const maxDurability = 432;
                        
                        // Safely access the damage value
                        // prismarine-nbt objects usually store values directly or in a 'value' property
                        let itemDamage = 0;
                        if (item.nbt) {
                            // Check if it's a standard NBT object where 'Damage' is a direct property
                            // or if it's nested within a 'value' object
                            itemDamage = item.nbt.Damage || (item.nbt.value && item.nbt.value.Damage ? item.nbt.value.Damage.value : 0);
                        }

                        const currentDurability = maxDurability - itemDamage;
                        return currentDurability > 20;
                    });

                    if (spare) {
                        await bot.equip(spare, 'torso');
                        console.log(`[BOT][${id}] Elytra durability low, swapped to a functional pair.`);
                    } else {
                        console.log(`[BOT][${id}] Warning: Elytra durability low and no functional spares found!`);
                    }
                }
            }

            function runMonitor() {
                if (!bot || !bot.entity) return;
                manageElytraDurability();
            }

            // Shared monitor — closes over bot and id, no arguments needed
            const monitor = () => runMonitor();

            // ── none (idle + passive map download) ───────────────────────────
            if (mod === 'none') {
                const { start, stop } = setupMapDownloader(bot, id, io, emitStatus);

                let lastCheck = 0;
                let lastLog   = 0;
                const CHECK_INTERVAL = 5000;
                const LOG_INTERVAL   = 5000;

                const tickMonitor = () => {
                    const now = Date.now();
                    if (now - lastCheck > CHECK_INTERVAL) {
                        lastCheck = now;
                        manageElytraDurability();
                    }
                    if (now - lastLog > LOG_INTERVAL) {
                        lastLog = now;
                        if (bot.entity) {
                            const yPos = Math.floor(bot.entity.position.y);
                        }
                    }
                };

                bot.on('physicsTick', tickMonitor);
                bot.once('stop_module_signal', () => {
                    bot.removeListener('physicsTick', tickMonitor);
                    stop();
                });

                start();
                emitStatus(id, 'Idle — passively downloading chunks around bot');
                return;
            }

            // ── spawnerLoot ───────────────────────────────────────────────────
            if (mod === 'spawnerLoot') {
                const block = bot.blockAt(new Vec3(entry.spawnerX, entry.spawnerY, entry.spawnerZ));
                if (!block) {
                    emitStatus(id, '[SpawnerLoot] Block not found — bot too far?');
                    entry.moduleStarted = false;
                    return;
                }
                console.log(`[BOT][${id}] Spawner block: "${block.name}"`);
                const { startLootLoop } = setupSpawnerLoot(bot, id, io, emitStatus);
                startLootLoop(block).catch(err => {
                    console.log(`[BOT][${id}] Loot loop crashed: ${err.message}`);
                    entry.moduleStarted = false;
                });
                return;
            }

            // ── farming ───────────────────────────────────────────────────────
            if (mod === 'farming') {
                const { startRightClick } = setupFarming(bot, id, io, emitStatus);
                startRightClick();
                return;
            }

            // ── elytraFlight (original) ───────────────────────────────────────
            if (mod === 'elytraFlight') {
                const { generateZigzag, startZigzag } = setupElytraFlight(bot, id, io, emitStatus);
                const waypoints = generateZigzag(
                    entry.elytraStartX,
                    entry.elytraStartZ,
                    entry.elytraEndZ,
                    entry.elytraEndX,
                    entry.elytraStepX
                );
                console.log(`[BOT][${id}] Elytra route: ${waypoints.length} waypoints`);
                startZigzag(waypoints).catch(err => {
                    console.log(`[BOT][${id}] Elytra crashed: ${err.message}`);
                    entry.moduleStarted = false;
                });
                return;
            }

            // ── zigzagFlight (cannon-launched X-strip route) ──────────────────
            if (mod === 'zigzagFlight') {
                const { startZigzag } = setupZigzagFlight(bot, id, io, emitStatus);

                entry.zigzagState = {
                    currentX: entry.zigFirstX,
                    currentZ: entry.zigFirstZ,
                    atFirst:  true
                };

                const getNextWaypoint = () => {
                    const returnX = entry.zigFirstX + entry.zigXLength;
                    const target = {
                        x: entry.zigzagState.atFirst ? entry.zigFirstX : returnX,
                        z: entry.zigzagState.currentZ
                    };
                    entry.zigzagState.atFirst  = !entry.zigzagState.atFirst;
                    entry.zigzagState.currentZ += entry.zigZStep;
                    return target;
                };

                console.log(`[BOT][${id}] Infinite Zigzag started.`);

                const monitorInterval = setInterval(monitor, 5000);

                startZigzag(getNextWaypoint)
                    .finally(() => {
                        clearInterval(monitorInterval);
                        entry.moduleStarted = false;
                    });

                return;
            }

            emitStatus(id, `Unknown module: ${mod}`);

        }, 2000);
    });

    bot.on('windowOpen', (window) => {
        if (!bot || !bot.isReady) return;
        if (!window) return;
        const title = window.title ? window.title : 'Unknown Menu';
        console.log(`[BOT][${id}] windowOpen — "${title}" slots: ${window.slots ? window.slots.length : 0}`);
        if (window.slots) {
            console.log(`[BOT][${id}] Non-empty:`, window.slots.map((s,i) => s ? `${i}:${s.name}(x${s.count})` : null).filter(Boolean));
        }
    });

    bot.on('windowClose', (window) => {
        if (!window) return;
        console.log(`[BOT][${id}] windowClose — "${window.title}"`);
    });

    bot.on('end', (reason) => {
        console.log(`[BOT][${id}] Disconnected: ${reason}`);
        entry.bot           = null;
        entry.moduleStarted = false;
        emitStatus(id, 'Disconnected');
        setTimeout(() => spawnBot(id, botOptions, data, socket), 5000);
    });
}

http.listen(3000, () => console.log('[SERVER] Panel: http://localhost:3000'));