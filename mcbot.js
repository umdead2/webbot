const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: 'play.minesteal.xyz',
  username: 'MoneyTalks',
  version: '1.20.1'
})

bot.on('spawn', () => {
  console.log('Spawned successfully')
})

bot.on('error', console.log)
bot.on('kicked', console.log)