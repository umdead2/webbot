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
    console.log('[STABILITY GUARD] Ignored negative slot crash')
    return
  }
  console.error('[CRITICAL]', err)
})

function patchInventory(bot) {

  if (!bot.inventory) return

  const originalUpdateSlot = bot.inventory.updateSlot

  bot.inventory.updateSlot = function (slot, item) {

    if (slot == null || slot < 0) {
      console.log('[STABILITY] Prevented invalid inventory slot:', slot)
      return
    }

    try {
      return originalUpdateSlot.call(this, slot, item)
    } catch (e) {
      console.log('[STABILITY] Inventory update prevented crash')
    }
  }
}

function patchPackets(bot) {

  const client = bot._client

  const originalEmit = client.emit
  client.emit = function (event, packet) {

    if (event === 'set_slot') {
      if (!packet || packet.slot == null || packet.slot < 0) {
        console.log('[STABILITY] Blocked bad set_slot')
        return
      }
    }

    if (event === 'window_items' && packet && packet.items) {
      packet.items = packet.items.filter(i => i)
    }

    return originalEmit.apply(this, arguments)
  }

  const originalWrite = client.write
  client.write = function (name, params) {

    if (name === 'window_click' && params && params.slot < 0) {
      console.log('[STABILITY] Blocked window_click')
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
      disableWindowClick: true,
      checkTimeoutInterval: 60000
    })

    // PATCH PACKETS IMMEDIATELY
    patchPackets(bot)

    bot.once('spawn', () => {

      console.log('[+] Bot spawned')

      // PATCH INVENTORY AFTER SPAWN
      patchInventory(bot)

      if (spawnTimer) clearTimeout(spawnTimer)

      socket.emit('bot_status', 'Connected')

      spawnTimer = setTimeout(() => {

        console.log('[>] Sending login')

        bot.chat(`/login ${data.password}`)

        setTimeout(() => {

          bot.physics.enabled = true

          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 500)

          console.log('[✔] Bot stable')

          socket.emit('bot_status', 'Active')

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

    bot.on('windowOpen', () => {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    })

    bot.on('kicked', (reason) => {
      const msg = typeof reason === 'string'
        ? reason
        : JSON.stringify(reason)

      console.log('[!] KICKED:', msg)
    })

    bot.on('error', (err) => {
      console.log('[!] Error:', err.message)
    })

    bot.on('end', () => {
      console.log('[-] Disconnected')
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