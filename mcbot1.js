const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: 'play.minesteal.xyz',
  username: 'MoneyTalks',
  version: '1.20.1', // Most Minesteal-style servers prefer 1.20.1
  hideErrors: true,
  clientRoot: null, 
})

// 1. SILENCE PHYSICS IMMEDIATELY
bot.on('inject_allowed', () => {
  bot.physics.enabled = false 
})

// 2. LOG ALL CHAT (To see if it says "Register" or "Banned")
bot.on('messagestr', (message) => {
  console.log(`[CHAT] ${message}`)
})

// 3. HANDLE RESOURCE PACKS (Some proxies kick if you ignore these)
bot.on('resource_pack', () => {
  bot.acceptResourcePack()
})

bot.on('spawn', () => {
  setTimeout(() => {
    bot.chat('/register renars123 renars123')
    bot.chat('/login renars123')
    setTimeout(() => { bot.physics.enabled = true }, 3000)
  }, 5000)
})

bot.on('kicked', (reason) => {
  const msg = typeof reason === 'string' ? reason : JSON.stringify(reason)
  console.log(`[!] KICKED: ${msg}`)
})

bot.on('error', (err) => console.log('[!] Error:', err.message))
bot.on('end', () => console.log('[-] Socket closed. Restarting...'))