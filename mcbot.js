const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

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
    bot.on('playerLeft',   () => broadcastPlayerList(id));

    bot.on('error', err => {
        entry.lastError = err.message || String(err);
        console.log(`[${id}]`, err.message);
        emitStatus(id, 'Error: ' + err.message);
    });

    bot.on('kicked', (reason) => {
        entry.lastError = 'kicked';
        emitStatus(id, 'Kicked: ' + reason);
    });
}

// Auth errors where retrying will never help
const FATAL_ERRORS = [
    'Failed to obtain profile data',
    'RateLimiter disallowed',
    'does the account own minecraft',
    'Invalid credentials',
    'Not authenticated',
];

function isFatal(msg) {
    return msg && FATAL_ERRORS.some(e => msg.includes(e));
}

io.on('connection', (socket) => {

    socket.emit('bot_list', Object.entries(bots).map(([id, e]) => ({
        id, label: e.config.label, authType: e.config.authType,
    })));

    Object.entries(bots).forEach(([id, entry]) => {
        const status = entry.bot ? 'Active (Physics ON)' : 'Disconnected';
        socket.emit(`bot_status_${id}`, status);
        if (entry.bot && entry.bot.players)
            socket.emit(`player_list_${id}`, Object.keys(entry.bot.players));
        setupBotEvents(id, socket);
    });

    socket.on('create_bot', (data) => {
        const id = genId();
        const label = data.label || `Bot ${id}`;
        bots[id] = {
            bot: null, chatHistory: [], spawnTimer: null,
            reconnectTimer: null, reconnectDelay: 5000,
            manuallyStopped: false, lastError: null,
            config: { label, authType: data.authType || 'offline' }
        };
        io.emit('bot_added', { id, label, authType: data.authType || 'offline' });
    });

    socket.on('start_bot', (data) => {
        const { id } = data;
        if (!bots[id] || bots[id].bot) return;

        const entry = bots[id];
        entry.config = { ...entry.config, ...data };
        entry.manuallyStopped = false;
        entry.reconnectDelay = 5000;

        const botOptions = {
            host: data.host || 'play.donutsmp.net',
            version: data.version || '1.20.1',
            hideErrors: true,
            physicsEnabled: false,
            checkTimeoutInterval: 60000,
        };

        if (data.authType === 'microsoft') {
            botOptions.auth = 'microsoft';
            botOptions.username = data.username;
            botOptions.profilesFolder = `./profiles/${id}`;
            emitStatus(id, 'Waiting for Microsoft login...');
        } else {
            botOptions.username = data.username;
            botOptions.auth = 'offline';
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

        entry.manuallyStopped = true;
        if (entry.spawnTimer)     clearTimeout(entry.spawnTimer);
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);

        if (entry.bot) {
            entry.bot.removeAllListeners();
            entry.bot.quit();
            entry.bot = null;
        }

        entry.chatHistory = [];
        entry.reconnectDelay = 5000;
        emitStatus(id, 'Disconnected');
    });

    socket.on('remove_bot', ({ id }) => {
        const entry = bots[id];
        if (!entry) return;

        entry.manuallyStopped = true;
        if (entry.spawnTimer)     clearTimeout(entry.spawnTimer);
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        if (entry.bot) { entry.bot.removeAllListeners(); entry.bot.quit(); }

        delete bots[id];
        io.emit('bot_removed', { id });
    });
});

function spawnBot(id, botOptions, data, socket) {
    const entry = bots[id];
    if (!entry || entry.manuallyStopped) return;

    let bot;
    try {
        bot = mineflayer.createBot(botOptions);
    } catch (err) {
        emitStatus(id, 'Failed to create bot: ' + err.message);
        return;
    }
    const farmOffsets = [
        {x: 70851.300, z: -2206.397},  // Up
        {x: 70855.452, z: -2206.397}, // Down
        {x: 70853.545, z: -2208.653},  // Right
        {x: 70853.545, z: -2204.510}  // Left
    ];
    bot.setMaxListeners(0);
    let lastInventoryCount = -1;
    let isDigging = false; 
    let isPlacing = false;
    let isRightClicking = false;
    let rightClickInterval = null;
    let inventoryFull = false;
    let isInSellGUI = false;
    entry.bot = bot;
    entry.lastError = null;
    setupBotEvents(id, socket);

    bot.on('inject_allowed', () => { bot.physics.enabled = false; });
    bot.on('resource_pack',  () => bot.acceptResourcePack());

    // ── Brand spoof ───────────────────────────────────────────────────────
    // Writes the minecraft:brand plugin channel packet with "vanilla"
    // immediately after the server handshake so we don't fingerprint as
    // mineflayer. The \x07 is a VarInt for 7, the length of "vanilla".
    bot._client.on('login', () => {
        try {
            bot._client.write('custom_payload', {
                channel: 'minecraft:brand',
                data: Buffer.from('\x07vanilla'),
            });
        } catch (e) {
            console.warn(`[${id}] Brand write failed:`, e.message);
        }
    });

    bot.once('login', () => {
        entry.reconnectDelay = 5000; // reset backoff on successful login
        emitStatus(id, 'World Loaded...');

        entry.spawnTimer = setTimeout(() => {
            if (data.password) bot.chat(`/login ${data.password}`);
            setTimeout(() => {
                bot.physics.enabled = true;
                emitStatus(id, 'Active (Physics ON)');
            }, 3000);
        }, 5000);
    });

    bot.on('spawn', () => {
        setTimeout(() => broadcastPlayerList(id), 2000);
        startRightClick();
    });
    // Add this lock variable outside the function

    function startRightClick() {
        console.log(`[DEBUG] startRightClick called - isRightClicking: ${isRightClicking}`);
        if (isRightClicking) return;
        isRightClicking = true;
        
        console.log(`[${new Date().toLocaleTimeString()}] [FARM] Mode: ${bot.username === 'dominance2' ? 'DIGGING' : 'PLANTING'}`);
        
        rightClickInterval = setInterval(async () => {
            if (!isRightClicking || isInSellGUI) return;

            for (const offset of farmOffsets) {
                if (bot.username === 'dominance2') {
                    const pos = new Vec3(offset.x, 241, offset.z).floored();
                    const plantBlock = bot.blockAt(pos);

                    if (!plantBlock || plantBlock.name !== 'potatoes') continue;

                    const props = plantBlock.getProperties();

                    if (props.age < 7) continue;

                    if (!isDigging) {
                        const dist = bot.entity.position.distanceTo(plantBlock.position);
                        if (dist > 4.5) continue;

                        isDigging = true;

                        await bot.lookAt(plantBlock.position.offset(0.5, 0.5, 0.5), true);

                        const hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
                        if (hoe) await bot.equip(hoe, 'hand');

                        try {
                            await bot.dig(plantBlock, true);
                        } catch (err) {
                            try {
                                await bot.activateBlock(plantBlock);
                            } catch (err2) {
                            }
                            bot.stopDigging();
                        } finally {
                            isDigging = false;
                        }
                    }
                }
                // MODE 2: Planting (everyone else)
                else {
                    const pos = new Vec3(offset.x, 240, offset.z).floored();
                    const farmlandBlock = bot.blockAt(pos);
                    if (!farmlandBlock || farmlandBlock.name !== 'farmland') continue;

                    const plantPos = pos.offset(0, 1, 0);
                    const plantBlock = bot.blockAt(plantPos);

                    if (plantBlock && plantBlock.name === 'air' && !isPlacing) {
                        const potatoItem = bot.inventory.items().find(item => item.name === 'potato');
                        if (potatoItem) {
                            isPlacing = true;

                            const dx = farmlandBlock.position.x + 0.5 - bot.entity.position.x;
                            const dy = farmlandBlock.position.y + 0.5 - (bot.entity.position.y + 1.62);
                            const dz = farmlandBlock.position.z + 0.5 - bot.entity.position.z;

                            const targetYaw = Math.atan2(-dx, dz);
                            const targetPitch = Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz));

                            const yaw = bot.entity.yaw + (targetYaw - bot.entity.yaw) * 0.2;
                            const pitch = bot.entity.pitch + (targetPitch - bot.entity.pitch) * 0.2;

                            bot.look(yaw, pitch, false);

                            await bot.equip(potatoItem, 'hand');
                            bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0)).catch(() => {});

                            await new Promise(r => setTimeout(r, 50));
                            isPlacing = false;
                        }
                    }
                }
            }
        }, 200);
    }
    function stopRightClick() {
        if (rightClickInterval) {
            clearInterval(rightClickInterval);
            rightClickInterval = null;
        }
        isRightClicking = false;
        console.log(`[${new Date().toLocaleTimeString()}] [FARM] Stopped right click`);
        }

        // Check inventory every 500ms
        setInterval(() => {
        const occupiedSlots = bot.inventory.items().length;

        if (occupiedSlots !== lastInventoryCount) {
            console.log(`[${new Date().toLocaleTimeString()}] [FARM] Inventory updated: ${occupiedSlots}/36`);
            lastInventoryCount = occupiedSlots; // Update the record
        }
        if (!isInSellGUI) {
            checkInventory();
        }
        }, 500);

        function checkInventory() {
            // bot.inventory.emptySlotCount() checks the entire player inventory (all 36 slots).
            // If it is 0, it means every single slot is completely full.
            const emptySlots = bot.inventory.emptySlotCount();
            
            if (emptySlots === 0 && !inventoryFull) {
                inventoryFull = true;
                console.log(`[${new Date().toLocaleTimeString()}] [INVENTORY] Inventory full! Stopping farm and opening sell GUI...`);
                
                // Stop right clicking
                stopRightClick();

                // Send sell command
                setTimeout(() => {
                    bot.chat('/sellgui');
                    console.log(`[${new Date().toLocaleTimeString()}] [SELL] Sent /sellgui command`);
                    isInSellGUI = true;
                }, 300);
            }
        }

        // Listen for window open
        bot.on('windowOpen', (window) => {
        if (isInSellGUI) {
            console.log(`[${new Date().toLocaleTimeString()}] [GUI] Sell GUI opened - selling items...`);
            
            // Wait a bit for GUI to fully load
            setTimeout(() => {
            sellAllItems();
            }, 500);
        }
        });

        async function sellAllItems() {
            try {
                const window = bot.currentWindow;
                
                if (!window) {
                    console.log(`[${new Date().toLocaleTimeString()}] [ERROR] No window found`);
                    closeGUIAndResume();
                    return;
                }

                console.log(`[${new Date().toLocaleTimeString()}] [SELL] Shift-clicking items to sell GUI...`);
                
                let clickCount = 0;
                
                // In Mineflayer, when a GUI is open:
                // window.inventoryStart is where the player's main inventory begins.
                // window.inventoryStart + 27 is the first slot of the hotbar ("slot 1").
                const startSlot = window.inventoryStart;
                const endSlot = window.inventoryStart + 35; 
                const protectedSlot = window.inventoryStart + 27; // The first hotbar slot
                
                // Loop through the player's inventory inside the GUI
                for (let i = startSlot; i <= endSlot; i++) {
                    // Skip the protected first hotbar slot
                    if (i === protectedSlot) continue;
                    
                    // If there is an item in this slot
                    if (window.slots[i]) {
                        try {
                            // clickWindow(slot, mouseButton, mode)
                            // mode 1 = shift-click (instantly moves item into the sell GUI)
                            await bot.clickWindow(i, 0, 1);
                            clickCount++;
                            
                            // Wait 100ms between clicks so the server doesn't kick for packet spam
                            await new Promise(resolve => setTimeout(resolve, 100)); 
                        } catch (e) {
                            // Silent
                        }
                    }
                }

                console.log(`[${new Date().toLocaleTimeString()}] [SELL] Successfully moved ${clickCount} item stacks`);

                // Wait a brief moment for the server to process the last click, then close
                setTimeout(() => {
                    closeGUIAndResume();
                }, 500);

            } catch (e) {
                console.error(`[ERROR] Error selling items: ${e.message}`);
                closeGUIAndResume();
            }
        }

        function closeGUIAndResume() {
        try {
            // Close the window
            if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
            console.log(`[${new Date().toLocaleTimeString()}] [GUI] Closed sell GUI`);
            }
            
            isInSellGUI = false;
            inventoryFull = false;

            // Resume farming after a short delay
            setTimeout(() => {
            startRightClick();
            }, 500);

        } catch (e) {
            console.error(`[ERROR] Error closing window: ${e.message}`);
        }
    }

    bot.on('end', () => {
        entry.bot = null;
        const err = entry.lastError;

        if (entry.manuallyStopped) {
            emitStatus(id, 'Disconnected');
            return;
        }

        if (isFatal(err)) {
            emitStatus(id, `Auth failed, not reconnecting: ${err}`);
            console.error(`[${id}] Fatal auth error – stopping:`, err);
            return;
        }

        const delay = entry.reconnectDelay;
        entry.reconnectDelay = Math.min(delay * 2, 60000); // 5s→10s→20s→40s→60s cap

        emitStatus(id, `Disconnected. Reconnecting in ${delay / 1000}s...`);
        console.log(`[${id}] Reconnecting in ${delay / 1000}s`);

        entry.reconnectTimer = setTimeout(() => {
            if (bots[id] && !bots[id].manuallyStopped) {
                spawnBot(id, botOptions, data, socket);
            }
        }, delay);
    });
}

http.listen(8080, () => console.log('Panel: http://localhost:8080'));