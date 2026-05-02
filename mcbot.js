const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');

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
    });

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