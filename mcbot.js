const express = require('express')
const app = express()
const http = require('http').Server(app)
const io = require('socket.io')(http)
const mineflayer = require('mineflayer')

// GLOBAL CRASH GUARD
process.on('uncaughtException', (err) => {
  if (err.message && err.message.includes('slot >= 0')) {
    console.log('[GUARD] Prevented quickbar slot crash')
    return
  }
  console.error('[CRITICAL]', err)
})

app.use(express.static('web'))

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/web/main.html')
})

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
      checkTimeoutInterval: 60000
    })

    // ======= PATCH setQuickBarSlot TO IGNORE NEGATIVE SLOTS =======
    const simpleInventory = require('mineflayer/lib/plugins/simple_inventory')
    const originalInventory = simpleInventory
    require.cache[require.resolve('mineflayer/lib/plugins/simple_inventory')].exports = function(bot, options) {
      originalInventory(bot, options)

      const oldSetQuickBarSlot = bot.setQuickBarSlot
      bot.setQuickBarSlot = function(slot) {
        if (slot < 0) {
          console.log('[PATCH] Ignored invalid quickbar slot:', slot)
          return
        }
        return oldSetQuickBarSlot.call(this, slot)
      }
    }

    // ======= EVENT HANDLERS =======
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

        // Enable physics after login
        setTimeout(() => {
          bot.physics.enabled = true

          // tiny jump to "wake up" the bot
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

    bot.on('windowOpen', () => {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    })

    bot.on('kicked', (reason) => {
      const msg = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log('[!] KICKED:', msg)
      socket.emit('bot_chat', '[KICKED] ' + msg)
    })

    bot.on('error', (err) => console.log('[ERROR]', err.message))

    bot.on('end', () => {
      console.log('[-] Disconnected')
      socket.emit('bot_status', 'Disconnected')
    })
  })

  socket.on('command_from_web', (cmd) => {
    if (bot && bot.chat) bot.chat(cmd)
    else socket.emit('bot_chat', '[SYSTEM] Bot not connected')
  })

})

http.listen(8080, () => console.log('Panel: http://localhost:8080'))