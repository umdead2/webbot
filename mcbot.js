const express = require('express')
const app = express()
const http = require('http').Server(app)
const io = require('socket.io')(http)
const mineflayer = require('mineflayer')

// Crash guard
process.on('uncaughtException', (err) => {
  console.log('[GUARD] Caught:', err.message)
})

app.use(express.static('web'))

app.get('/', (req, res) => res.sendFile(__dirname + '/web/main.html'))

let bot
let spawnTimer

io.on('connection', (socket) => {

  socket.on('start_bot', (data) => {
    console.log('[+] Starting bot')

    // 1. We removed loadInternalPlugins: false so the bot stays alive
    bot = mineflayer.createBot({
      host: data.host || 'play.minesteal.xyz',
      username: data.username,
      version: '1.20.1',
      physicsEnabled: false,
      hideErrors: true,
      checkTimeoutInterval: 60000 
    })

    // 2. THE ULTIMATE FIX: prependListener
    bot.on('inject_allowed', () => {
      // This forces our code to run BEFORE Mineflayer's inventory plugin
      bot._client.prependListener('window_items', (packet) => {
        if (packet && packet.items) {
          packet.items = packet.items.filter(item => item.slot >= 0)
        }
      })

      bot._client.prependListener('set_slot', (packet) => {
        if (packet && packet.slot < 0) {
          packet.slot = 0
        }
      })
    })

    bot.once('login', () => {
      console.log('[+] Logged in')
      socket.emit('bot_status', 'Connected')
    })

    bot.once('spawn', () => {
      console.log('[+] Spawned')

      if (spawnTimer) clearTimeout(spawnTimer)

      spawnTimer = setTimeout(() => {
        console.log('[>] Sending login command')
        bot.chat(`/login ${data.password}`)

        // enable physics after login
        setTimeout(() => {
          bot.physics.enabled = true
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 400)

          socket.emit('bot_status', 'Active & Stable')
          console.log('[✔] Physics enabled')
        }, 4000)
      }, 5000)
    })

    bot.on('messagestr', (msg) => {
      console.log('[CHAT]', msg)
      socket.emit('bot_chat', msg)
    })

    bot.on('resource_pack', () => bot.acceptResourcePack())
    bot.on('kicked', (reason) => console.log('[!] KICKED:', reason))
    bot.on('error', (err) => console.log('[ERROR]', err.message))
    bot.on('end', () => console.log('[-] Disconnected'))
  })

  socket.on('command_from_web', (cmd) => {
    if (bot && bot.chat) bot.chat(cmd)
    else socket.emit('bot_chat', '[SYSTEM] Bot not connected')
  })

})

http.listen(8080, () => console.log('Panel: http://localhost:8080'))