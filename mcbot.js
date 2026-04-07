const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');

// 🔥 REQUIRED for Microsoft login link
process.env.DEBUG = 'minecraft-protocol';

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
    bot.on('playerLeft', () => broadcastPlayerList(id));

    bot.on('error', err => {
        console.log(`[${id}]`, err);
        emitStatus(id, err.message);
    });

    bot.on('kicked', () => emitStatus(id, 'Kicked'));
}

io.on('connection', (socket) => {

    const summary = Object.entries(bots).map(([id, e]) => ({
        id,
        label: e.config.label,
        authType: e.config.authType,
    }));
    socket.emit('bot_list', summary);

    Object.entries(bots).forEach(([id, entry]) => {
        socket.emit(`bot_status_${id}`, 'Active (Physics ON)');
        if (entry.bot && entry.bot.players) {
            socket.emit(`player_list_${id}`, Object.keys(entry.bot.players));
        }
        setupBotEvents(id, socket);
    });

    socket.on('create_bot', (data) => {
        const id = genId();
        const label = data.label || `Bot ${id}`;
        bots[id] = {
            bot: null,
            chatHistory: [],
            spawnTimer: null,
            config: { label, authType: data.authType || 'offline' }
        };
        io.emit('bot_added', { id, label, authType: data.authType || 'offline' });
    });

    socket.on('start_bot', (data) => {
        const { id } = data;
        if (!bots[id] || bots[id].bot) return;

        const entry = bots[id];
        entry.config = { ...entry.config, ...data };

        const botOptions = {
            host: data.host || 'play.minesteal.xyz',
            version: data.version || '1.20.1',
            hideErrors: true,
            physicsEnabled: false,
            checkTimeoutInterval: 60000,
        };

        if (data.authType === 'microsoft') {
            botOptions.auth = 'microsoft';
            botOptions.username = data.username;
            botOptions.profilesFolder = `./profiles/${id}`;

            emitStatus(id, 'Waiting for Microsoft login (check console)');
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

        if (entry.spawnTimer) clearTimeout(entry.spawnTimer);

        if (entry.bot) {
            entry.bot.removeAllListeners();
            entry.bot.quit();
            entry.bot = null;
        }

        entry.chatHistory = [];
        emitStatus(id, 'Disconnected');
    });

    socket.on('remove_bot', ({ id }) => {
        const entry = bots[id];
        if (!entry) return;

        if (entry.spawnTimer) clearTimeout(entry.spawnTimer);
        if (entry.bot) entry.bot.quit();

        delete bots[id];
        io.emit('bot_removed', { id });
    });
});

function spawnBot(id, botOptions, data, socket) {
    const entry = bots[id];
    const bot = mineflayer.createBot(botOptions);
    entry.bot = bot;

    setupBotEvents(id, socket);

    bot.on('inject_allowed', () => { bot.physics.enabled = false; });
    bot.on('resource_pack', () => bot.acceptResourcePack());

    bot.once('login', () => {
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
        emitStatus(id, 'Disconnected');

        // 🔁 Auto reconnect
        setTimeout(() => {
            spawnBot(id, botOptions, data, socket);
        }, 5000);
    });
}

http.listen(8080, () => console.log('Panel: http://localhost:8080'));