const express = require('express')
const app = express()
const http = require('http').Server(app)
const io = require('socket.io')(http)
const mineflayer = require('mineflayer')

app.use(express.static('web'))

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/web/main.html')
})

let bot
let spawnTimer

// Crash guard
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('slot >= 0')) {
    console.log('[GUARD] Prevented inventory crash')
    return
  }
  console.error(err)
})

// Disable inventory BEFORE Mineflayer loads it
function disableInventory(bot) {

  const client = bot._client

  const blockedPackets = [
    'set_slot',
    'window_items',
    'open_window',
    'close_window',
    'window_property'
  ]

  const originalEmit = client.emit

  client.emit = function (event, packet) {

    if (blockedPackets.includes(event)) {
      console.log('[STABILITY] Blocked packet:', event)
      return
    }

    return originalEmit.apply(this, arguments)
  }

}

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
      loadInternalPlugins: false // VERY IMPORTANT
    })

    // load only safe plugins
    bot.loadPlugin(require('mineflayer/lib/plugins/chat'))
    bot.loadPlugin(require('mineflayer/lib/plugins/entities'))
    bot.loadPlugin(require('mineflayer/lib/plugins/physics'))

    disableInventory(bot)

    bot.once('login', () => {

      console.log('[+] Logged in')

      socket.emit('bot_status', 'Connected')

      spawnTimer = setTimeout(() => {

        console.log('[>] Sending login')

        bot.chat(`/login ${data.password}`)

        setTimeout(() => {

          // enable physics AFTER login
          bot.physics.enabled = true

          socket.emit('bot_status', 'Active & Stable')

          console.log('[✔] Physics enabled')

        }, 4000)

      }, 5000)

    })

    bot.on('messagestr', (msg) => {
      console.log('[CHAT]', msg)
      socket.emit('bot_chat', msg)
    })

    bot.on('resource_pack', () => {
      bot.acceptResourcePack()
    })

    bot.on('kicked', (reason) => {
      const msg = typeof reason === 'string'
        ? reason
        : JSON.stringify(reason)

      console.log('[!] KICKED:', msg)
      socket.emit('bot_chat', '[KICKED] ' + msg)
    })

    bot.on('error', (err) => {
      console.log('[ERROR]', err.message)
    })

    bot.on('end', () => {
      console.log('[-] Disconnected')
      socket.emit('bot_status', 'Disconnected')
    })

  })

  socket.on('command_from_web', (cmd) => {

    if (bot && bot.chat) {
      bot.chat(cmd)
    } else {
      socket.emit('bot_chat', '[SYSTEM] Bot not connected')
    }

  })

})

http.listen(8080, () => {
  console.log('Panel: http://localhost:8080')
})