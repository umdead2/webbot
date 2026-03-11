const express = require('express')
const app = express()
const http = require('http').Server(app)
const io = require('socket.io')(http)
const mineflayer = require('mineflayer')

app.use(express.static('web'))

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/web/main.html')
})

let bot = null
let spawnTimer = null

// GLOBAL CRASH GUARD
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('slot >= 0')) {
    console.log('[GUARD] Prevented inventory crash')
    return
  }
  console.error(err)
})

function disableInventory(bot) {

  const client = bot._client

  // Block all inventory packets
  const blocked = [
    'set_slot',
    'window_items',
    'open_window',
    'close_window',
    'window_property'
  ]

  const originalEmit = client.emit

  client.emit = function (event, packet) {

    if (blocked.includes(event)) {
      console.log('[STABILITY] Blocked inventory packet:', event)
      return
    }

    return originalEmit.apply(this, arguments)
  }

  // Block inventory clicks
  const originalWrite = client.write

  client.write = function (name, params) {

    if (name === 'window_click') {
      console.log('[STABILITY] Prevented window_click')
      return
    }

    return originalWrite.apply(this, arguments)
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
      checkTimeoutInterval: 60000
    })

    // DISABLE INVENTORY SYSTEM
    disableInventory(bot)

    bot.once('login', () => {

      console.log('[+] Connected')

      socket.emit('bot_status', 'Proxy Connected')

      spawnTimer = setTimeout(() => {

        console.log('[>] Sending login')

        bot.chat(`/login ${data.password}`)

        setTimeout(() => {

          bot.physics.enabled = true

          // small movement so server loads entities
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 400)

          socket.emit('bot_status', 'Active & Stable')

          console.log('[✔] Bot running')

        }, 5000)

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
      console.log('[-] Connection closed')
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