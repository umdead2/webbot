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

// GLOBAL CRASH GUARD (must be outside everything)
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('slot >= 0')) {
    console.log('[STABILITY GUARD] Prevented inventory slot crash')
  } else {
    console.error('[CRITICAL]', err)
  }
})

io.on('connection', (socket) => {

  socket.on('start_bot', (data) => {

    console.log('[+] Starting bot...')

    bot = mineflayer.createBot({
      host: data.host || 'play.minesteal.xyz',
      username: data.username,
      version: '1.20.1',
      hideErrors: true,
      physicsEnabled: false,
      disableWindowClick: true,
      checkTimeoutInterval: 60000
    })

    // ========= PACKET STABILITY PATCH =========
    const client = bot._client

    const originalEmit = client.emit
    client.emit = function (event, packet) {

      // Block invalid inventory slot packets
      if (event === 'set_slot' && packet && packet.slot < 0) {
        console.log('[STABILITY] Blocked invalid set_slot packet')
        return
      }

      if (event === 'window_items' && packet && packet.items) {
        packet.items = packet.items.filter(i => i && i.slot >= 0)
      }

      return originalEmit.apply(this, arguments)
    }

    const originalWrite = client.write
    client.write = function (name, params) {

      if (name === 'window_click' && params && params.slot < 0) {
        console.log('[STABILITY] Blocked invalid window_click')
        return
      }

      return originalWrite.apply(this, arguments)
    }

    // ========= LOGIN =========
    bot.once('login', () => {

      console.log('[+] Logged in')

      if (spawnTimer) clearTimeout(spawnTimer)

      socket.emit('bot_status', 'Proxy Connected. Handshaking...')

      spawnTimer = setTimeout(() => {

        console.log('[>] Sending login command')

        bot.chat(`/login ${data.password}`)

        setTimeout(() => {

          bot.physics.enabled = true

          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 500)

          socket.emit('bot_status', 'Active & Stable')

          console.log('[✔] Physics/Entity sync complete')

        }, 5000)

      }, 5000)

    })

    // ========= CHAT =========
    bot.on('messagestr', (msg) => {
      console.log('[CHAT]', msg)
      socket.emit('bot_chat', msg)
    })

    // ========= RESOURCE PACK =========
    bot.on('resource_pack', () => {
      bot.acceptResourcePack()
    })

    // ========= PREVENT WINDOW BUGS =========
    bot.on('windowOpen', () => {
      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow)
      }
    })

    // ========= KICK =========
    bot.on('kicked', (reason) => {
      const msg = typeof reason === 'string'
        ? reason
        : JSON.stringify(reason)

      console.log('[!] KICKED:', msg)
      socket.emit('bot_chat', `[KICKED] ${msg}`)
    })

    // ========= ERROR =========
    bot.on('error', (err) => {
      console.log('[!] Error:', err.message)
    })

    // ========= END =========
    bot.on('end', () => {
      console.log('[-] Connection closed')
      socket.emit('bot_status', 'Disconnected')
    })

  })

  // ========= COMMANDS FROM WEB =========
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