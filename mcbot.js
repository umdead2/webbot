const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');

app.use(express.static('web'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/web/main.html');
});

let bot;
let spawnTimer;
let chatHistory = [];

// --- HELPER: BROADCAST PLAYER LIST ---
// Using io.emit so every open tab gets the update
function broadcastPlayerList() {
    if (bot && bot.players) {
        const playerNames = Object.keys(bot.players);
        io.emit('player_list', playerNames);
    }
}

// --- HELPER: SETUP EVENTS ---
function setupBotEvents(socket) {
    if (!bot) return;

    // Clean up to prevent memory leaks
    bot.removeAllListeners('messagestr');
    bot.removeAllListeners('playerJoined');
    bot.removeAllListeners('playerLeft');
    bot.removeAllListeners('error');
    bot.removeAllListeners('kicked');

    // Sync Chat History to the person who just connected
    chatHistory.forEach(msg => socket.emit('bot_chat', msg));

    // Listeners
    bot.on('messagestr', (message) => {
        io.emit('bot_chat', message); 
        if (!chatHistory.includes(message)) {
            chatHistory.push(message);
            if (chatHistory.length > 50) chatHistory.shift();
        }
    });

    // When someone joins/leaves, tell EVERYONE
    bot.on('playerJoined', broadcastPlayerList);
    bot.on('playerLeft', broadcastPlayerList);

    bot.on('error', (err) => io.emit('bot_status', 'Error: ' + err.message));
    bot.on('kicked', (reason) => io.emit('bot_status', 'Kicked from server'));
}

io.on('connection', (socket) => {
    // 1. SYNC IF BOT IS ALREADY RUNNING
    if (bot) {
        console.log('[Panel] Syncing existing bot state...');
        socket.emit('bot_status', 'Active (Physics ON)');
        if (bot.players) {
            socket.emit('player_list', Object.keys(bot.players));
        }
        setupBotEvents(socket); 
    }

    // 2. START BOT
    socket.on('start_bot', (data) => {
        if (bot) return;

        bot = mineflayer.createBot({
            host: data.host || 'play.minesteal.xyz',
            username: data.username,
            version: '1.20.1',
            hideErrors: true,
            physicsEnabled: false,
            checkTimeoutInterval: 60000
        });

        setupBotEvents(socket);

        bot.on('inject_allowed', () => { bot.physics.enabled = false; });
        bot.on('resource_pack', () => { bot.acceptResourcePack(); });

        bot.once('login', () => {
            if (spawnTimer) clearTimeout(spawnTimer);
            socket.emit('bot_status', "World Loaded (Waiting 5s...)");
            
            spawnTimer = setTimeout(() => {
                bot.chat(`/login ${data.password}`);
                setTimeout(() => { 
                    bot.physics.enabled = true; 
                    io.emit('bot_status', "Active (Physics ON)");
                }, 3000);
            }, 5000); 
        });

        bot.on('spawn', () => {
            setTimeout(broadcastPlayerList, 2000);
        });

        bot.on('end', () => {
            console.log('[-] Connection Lost.');
            io.emit('bot_status', 'Disconnected');
            bot = null;
        });
    });

    // 3. WEB COMMANDS
    socket.on('command_from_web', (cmd) => {
        if (bot && bot.chat) bot.chat(cmd);
    });

    socket.on('stop_bot', () => {
        if (bot) {
            if (spawnTimer) clearTimeout(spawnTimer);
            bot.removeAllListeners();
            bot.quit();
            bot = null;
            io.emit('bot_status', 'Disconnected');
            chatHistory = [];
        }
    });
});

// Start Server
http.listen(8080, () => console.log('Panel: http://localhost:8080'));