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

// Helper to attach listeners
function setupBotEvents(socket) {
    if (!bot) return;

bot.removeAllListeners('messagestr');
    bot.removeAllListeners('error');
    bot.removeAllListeners('kicked');
    bot.removeAllListeners('health');
    chatHistory.forEach(msg => socket.emit('bot_chat', msg));
    // 2. RE-ATTACH FRESH LISTENERS
    bot.on('messagestr', (message) => {
        // Only push to history once, but emit to the current socket
        socket.emit('bot_chat', message);
        // Logic to save history (only if not already handled elsewhere)
        if (!chatHistory.includes(message)) {
             chatHistory.push(message);
             if (chatHistory.length > 50) chatHistory.shift();
        }
    });

    bot.on('error', (err) => socket.emit('bot_status', 'Error: ' + err.message));
}


io.on('connection', (socket) => {
    if (bot) {
        console.log('[Panel] Syncing existing bot state...');
        socket.emit('bot_status', 'Active (Physics ON)');
        if (bot.players) {
            socket.emit('player_list', Object.keys(bot.players));
        }
        setupBotEvents(socket); // Re-attach listeners to the new socket
    }

    socket.on('start_bot', (data) => {

        // EXACTLY YOUR WORKING CONFIG
        bot = mineflayer.createBot({
        host: data.host || 'play.minesteal.xyz',
        username: data.username,
        version: '1.20.1', // Most Minesteal-style servers prefer 1.20.1
        hideErrors: true,
        clientRoot: null, 
        physicsEnabled: false,
        disableWindowClick: true,
        checkTimeoutInterval: 60000
      })

      // 1. SILENCE PHYSICS IMMEDIATELY
      bot.on('inject_allowed', () => {
        bot.physics.enabled = false 
      })

      // 2. LOG ALL CHAT (To see if it says "Register" or "Banned")
      bot.on('messagestr', (message) => {
        console.log(`[CHAT] ${message}`)
        socket.emit('bot_chat', message);
        if (!chatHistory.includes(message)) {
             chatHistory.push(message);
             if (chatHistory.length > 50) chatHistory.shift();
        }
      })

      // 3. HANDLE RESOURCE PACKS (Some proxies kick if you ignore these)
        bot.on('resource_pack', () => {
        bot.acceptResourcePack()
      })

      bot.once('login', () => {

        // 1. CLEAR any existing timer so they don't overlap
        if (spawnTimer) clearTimeout(spawnTimer);
        
        socket.emit('bot_status', "World Loaded (Waiting 5s...)");
        console.log('[!] Spawn detected. Starting login countdown...');

        // 2. Start a fresh 5-second timer
        spawnTimer = setTimeout(() => {
            console.log('[>] Sending login commands...');
            bot.chat(`/login ${data.password}`);
            
            // 3. Enable physics AFTER login
            setTimeout(() => { 
                bot.physics.enabled = true; 
                socket.emit('bot_status', "Active (Physics ON)");
                console.log('[✔] Physics enabled.');
            }, 3000);
        }, 5000); 
        });


    const sendPlayerList = () => {
        if (bot && bot.players) {
            // Convert the players object into a simple array of usernames
            const playerNames = Object.keys(bot.players); 
            socket.emit('player_list', playerNames);
        }
    };

    // Update the web panel when players join or leave
    bot.on('playerJoined', () => sendPlayerList());
    bot.on('playerLeft', () => sendPlayerList());

    // Also send it once when the bot fully spawns
    bot.on('spawn', () => {
        setTimeout(sendPlayerList, 2000); // Wait a bit for the tab list to populate
    });

        // Add this near your other bot.on events
      bot.on('error', (err) => {
          if (err.message.includes('slot >= 0')) {
              console.log('[!] Caught inventory sync error (Normal during server swaps).');
              return; // Ignore this specific error
          }
          console.log('[!] Bot Error:', err);
      });

      // Also add this to catch the "falsy value" crash specifically
      process.on('uncaughtException', (err) => {
          if (err.message.includes('slot >= 0')) {
              console.log('[!] Preventing crash from inventory slot error...');
          } else {
              console.error('Critical Error:', err);
              process.exit(1); 
          }
      });
      bot.on('kicked', (reason) => {
        const msg = typeof reason === 'string' ? reason : JSON.stringify(reason)
        console.log(`[!] KICKED: ${msg}`)
      })

      bot.on('error', (err) => console.log('[!] Error:', err.message))
      bot.on('end', () => console.log('[-] Socket closed. Restarting...'))
    });

    socket.on('command_from_web', (cmd) => {
        // Now 'bot' will be recognized here because we fixed the scoping
        if (bot && bot.chat) {
            bot.chat(cmd);
        } else {
            socket.emit('bot_chat', "[SYSTEM] Bot is not connected.");
        }
    });
    socket.on('debug', (cmd) => {
        console.log(cmd)
    });
    socket.on('stop_bot', () => {
        if (bot) {
            console.log('[!] Executing Instant Kill...');

            if (spawnTimer) {
                clearTimeout(spawnTimer);
                spawnTimer = null;
            }

            // 1. The protocol-safe way to say "I'm leaving"
            if (bot._client) {
                // If the raw socket exists, destroy it to avoid the 20s wait
                if (bot._client.socket) {
                    bot._client.socket.destroy(); 
                } else {
                    bot._client.end('User disconnect');
                }
            }

            // 2. Clear listeners so the 'end' event doesn't trigger a restart
            bot.removeAllListeners();
            bot.quit();
            bot = null;

            socket.emit('bot_status', 'Disconnected');
            socket.emit('bot_chat', '[SYSTEM] Bot disconnected.');
            chatHistory = [];
        }
    });
});

http.listen(8080, () => console.log('Panel: http://localhost:8080'));