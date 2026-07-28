'use strict';
const fs   = require('fs');
const path = require('path');
const anvilProviderLib = require('prismarine-provider-anvil');
const Anvil = anvilProviderLib.Anvil('1.20.1');

function setupMapDownloader(bot, id, io, emitStatus) {
    function log(msg) {
        console.log(`[MapDL][${id}] ${msg}`);
        emitStatus(id, `[MapDL] ${msg}`);
    }

    const saveDir = path.join(__dirname, '..', 'downloads', id, 'region');
    fs.mkdirSync(saveDir, { recursive: true });
    const anvilProvider = new Anvil(saveDir);

    const savedChunks = new Set();
    let chunksSaved   = 0;
    let saveQueue     = Promise.resolve();

    function enqueueChunkSave(chunkX, chunkZ, column) {
        if (!column || !column.sections) return;

        const key = `${chunkX},${chunkZ}`;
        if (savedChunks.has(key)) return;
        savedChunks.add(key);

        saveQueue = saveQueue.then(async () => {
            try {
                await anvilProvider.save(chunkX, chunkZ, column);
                chunksSaved++;
                if (chunksSaved % 10 === 0) {
                    log(`Saved ${chunksSaved} chunks. Last: [${chunkX}, ${chunkZ}]`);
                }
            } catch (err) {
                log(`Save ERROR [${chunkX}, ${chunkZ}]: ${err.message}`);
                savedChunks.delete(key); // allow retry on next receipt
            }
        });
    }

    // Use the raw packet (map_chunk) rather than chunkColumnLoad because
    // chunkColumnLoad may emit block-space coordinates (chunkX*16, chunkZ*16)
    // on some mineflayer builds, breaking getColumn() lookups.
    const onMapChunk = ({ x: chunkX, z: chunkZ }) => {
        // setImmediate gives mineflayer one tick to load the column into
        // bot.world before we try to read it back.
        setImmediate(() => {
            const column = bot.world.getColumn(chunkX, chunkZ);
            if (!column || !column.sections || column.sections.length === 0) return;
            enqueueChunkSave(chunkX, chunkZ, column);
        });
    };

    function start() {
        savedChunks.clear();
        chunksSaved = 0;
        saveQueue   = Promise.resolve();
        bot._client.on('map_chunk', onMapChunk);
        log(`Passive map download started → ${saveDir}`);
    }

    function stop() {
        bot._client.removeListener('map_chunk', onMapChunk);
        // Wait for any in-flight writes to flush before logging the summary.
        saveQueue.then(() => {
            log(`Stopped — ${chunksSaved} unique chunks saved`);
        });
    }

    return { start, stop };
}

module.exports = { setupMapDownloader };