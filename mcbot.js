const express = require('express')
const app = express()
const http = require('http').Server(app)
const io = require('socket.io')(http)
const mineflayer = require('mineflayer')

// Crash guard (optional)
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

    bot = mineflayer.createBot({
      host: data.host || 'play.minesteal.xyz',
      username: data.username,
      version: '1.20.1',
      physicsEnabled: false,
      hideErrors: true,
      checkTimeoutInterval: 60000,
      loadInternalPlugins: false // IMPORTANT: prevents inventory plugin from loading
    })

    // Load only safe plugins
    const loadPlugin = (plugin) => bot.loadPlugin(require(plugin))
    loadPlugin('mineflayer/lib/plugins/chat')
    loadPlugin('mineflayer/lib/plugins/physics')
    loadPlugin('mineflayer/lib/plugins/entities')
    // NOTE: we never load 'inventory' or 'simple_inventory'

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