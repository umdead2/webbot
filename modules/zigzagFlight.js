'use strict';
const fs   = require('fs');
const path = require('path');
const anvilProviderLib = require('prismarine-provider-anvil');
const Anvil = anvilProviderLib.Anvil('1.20.1');

const REACH_DIST  = 16;
const TICK_MS     = 50;
const PITCH_GLIDE = -7;

function setupZigzagFlight(bot, id, io, emitStatus) {

    function log(msg) {
        console.log(`[Zigzag][${id}] ${msg}`);
        emitStatus(id, `[Zigzag] ${msg}`);
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ── Map downloading ───────────────────────────────────────────────────────
    const saveDir = path.join(__dirname, '..', 'downloads', id, 'region');
    fs.mkdirSync(saveDir, { recursive: true });
    const anvilProvider = new Anvil(saveDir);
    const savedChunks   = new Set();
    let chunksSaved     = 0;
    let saveQueue       = Promise.resolve();

    function enqueueChunkSave(chunkX, chunkZ, column) {
        if (!column || !column.sections) return;
        const key = `${chunkX},${chunkZ}`;
        if (savedChunks.has(key)) return;
        savedChunks.add(key);
        saveQueue = saveQueue.then(async () => {
            try {
                await anvilProvider.save(chunkX, chunkZ, column);
                chunksSaved++;
                if (chunksSaved % 5000 === 0) log(`Saved ${chunksSaved} chunks`);
            } catch (err) {
                log(`Save ERROR [${chunkX}, ${chunkZ}]: ${err.message}`);
                savedChunks.delete(key);
            }
        });
    }

    const onMapChunk = ({ x: chunkX, z: chunkZ }) => {
        setImmediate(() => {
            const col = bot.world.getColumn(chunkX, chunkZ);
            if (!col || !col.sections || col.sections.length === 0) return;
            enqueueChunkSave(chunkX, chunkZ, col);
        });
    };

    function startSaving() {
        savedChunks.clear();
        chunksSaved = 0;
        saveQueue   = Promise.resolve();
        bot._client.on('map_chunk', onMapChunk);
        log(`Chunk saving started → ${saveDir}`);
    }

    function stopSaving() {
        bot._client.removeListener('map_chunk', onMapChunk);
        saveQueue.then(() => log(`Chunk saving stopped — ${chunksSaved} total`));
    }

    // ── Flight ────────────────────────────────────────────────────────────────
    function dist2D(ax, az, bx, bz) {
        return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
    }

    // Fly in a straight line to a target, only looking toward it on ONE axis at a time.
    // targetX / targetZ can be null to mean "stay on current axis".
    async function flyToPoint(targetX, targetZ, stopFlag) {
        log(`→ flying to X:${targetX} Z:${targetZ}`);
        const pitchRad = PITCH_GLIDE * (Math.PI / 180);

        while (!stopFlag.stop) {
            const pos = bot.entity.position;
            const d   = dist2D(pos.x, pos.z, targetX, targetZ);

            if (d < REACH_DIST) {
                log(`Arrived at X:${targetX} Z:${targetZ} (${d.toFixed(1)} blocks away)`);
                return true;
            }

            if (!bot.entity.elytraFlying && pos.y > 10) {
                log('Elytra closed — reopening');
                try { await bot.elytraFly(); } catch (_) {}
            }

            const yaw = Math.atan2(-(targetX - pos.x), -(targetZ - pos.z));
            bot.entity.yaw   = yaw;
            bot.entity.pitch = pitchRad;
            bot.look(yaw, pitchRad, true).catch(() => {});

            if (Math.floor(Date.now() / 10000) !== Math.floor((Date.now() - TICK_MS) / 10000)) {
                log(`Y:${pos.y.toFixed(0)} dist:${d.toFixed(0)} | X:${pos.x.toFixed(0)} Z:${pos.z.toFixed(0)}`);
            }

            await sleep(TICK_MS);
        }
        return false;
    }

    // ── Main entry ────────────────────────────────────────────────────────────
    //
    //  Route pattern (firstX=0, xLength=1000, firstZ=0, stepZ=168):
    //
    //    Leg 1:  fly X  →  (1000, 0)      straight X run
    //    Step:   fly Z  →  (1000, 168)    short Z step at end of strip
    //    Leg 2:  fly X  →  (0,    168)    straight X run back
    //    Step:   fly Z  →  (0,    336)    short Z step at end of strip
    //    Leg 3:  fly X  →  (1000, 336)    ...and so on forever
    //
    async function startZigzag(getNextWaypoint) {
        const stopFlag = { stop: false };
        bot.once('stop_module_signal', () => {
            stopFlag.stop = true;
            log('Stop signal — halting after current leg');
        });

        startSaving();
        log('Starting infinite zigzag route...');

        // We track the bot's current logical position so we can do the Z step correctly.
        // Pull the first waypoint to know our starting X and Z.
        let prevWp = getNextWaypoint();  // e.g. { x: 0, z: 0 }  (the very first destination)

        // Fly to the first waypoint (handles case where bot spawned mid-air elsewhere)
        const firstOk = await flyToPoint(prevWp.x, prevWp.z, stopFlag);
        if (!firstOk || stopFlag.stop) { stopSaving(); return; }

        while (!stopFlag.stop) {
            // Get the NEXT destination from server.js state machine
            const nextWp = getNextWaypoint();  // alternates X, same Z as after Z-step

            // ── Z step: fly from current position straight along Z ──
            // The Z step happens at the current X (end of the previous X leg)
            const zStepOk = await flyToPoint(prevWp.x, nextWp.z, stopFlag);
            if (!zStepOk || stopFlag.stop) break;

            // ── X leg: fly straight along X at the new Z ──
            const xLegOk = await flyToPoint(nextWp.x, nextWp.z, stopFlag);
            if (!xLegOk || stopFlag.stop) break;

            prevWp = nextWp;
            await sleep(100);
        }

        stopSaving();
        log('Zigzag complete!');
    }

    return { startZigzag };
}

module.exports = { setupZigzagFlight };