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

io.on('connection', (socket) => {
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
      })

      // 3. HANDLE RESOURCE PACKS (Some proxies kick if you ignore these)
      bot.on('resource_pack', () => {
        bot.acceptResourcePack()
      })

      bot.on('error', (err) => {
        console.log(`[STABILITY GUARD] Caught: ${err.message}`);
        // If it's the assertion error, we just keep the bot alive
        if (err.name === 'AssertionError') return; 
      });

      bot.once('login', () => {
        if (spawnTimer) clearTimeout(spawnTimer);
        
        socket.emit('bot_status', "Proxy Connected. Handshaking...");
        
        spawnTimer = setTimeout(() => {
            console.log('[>] Sending login...');
            bot.chat(`/login ${data.password}`);
            
            // WAIT an extra 5 seconds before turning on Physics
            // This is the most important part for preventing the crash
            setTimeout(() => { 
                bot.physics.enabled = true; 
                bot.setControlState('jump', true); // Tiny hop to "wake up" the bot
                setTimeout(() => bot.setControlState('jump', false), 500);
                
                socket.emit('bot_status', "Active & Stable");
                console.log('[✔] Physics/Entity sync complete.');
            }, 5000); 
        }, 5000); 
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
});

http.listen(8080, () => console.log('Panel: http://localhost:8080'));