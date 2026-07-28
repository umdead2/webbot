'use strict';
const fs = require('fs');
const path = require('path');
const anvilProviderLib = require('prismarine-provider-anvil');
const Anvil = anvilProviderLib.Anvil('1.20.1');

const FLIGHT_Y       = 500;   // Cruising altitude peak
const REACH_DIST     = 16;    // Blocks away to be considered "arrived"
const TICK_MS        = 50;
const BOOST_INTERVAL = 1200;  // ms between cruise rockets
const BOOST_LOW_Y    = 330;   // Start climbing when below this

// Negative pitch = nose up, Positive pitch = nose down
const PITCH_ASCEND   = 35;
const PITCH_GLIDE    = -5;

function setupElytraFlight(bot, id, io, emitStatus) {
    function log(msg) {
        console.log(`[Elytra][${id}] ${msg}`);
        emitStatus(id, `[Elytra] ${msg}`);
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ── Anvil Mapping ─────────────────────────────────────────────────────────
    const saveDir = path.join(__dirname, '..', 'downloads', id, 'region');
    fs.mkdirSync(saveDir, { recursive: true });
    const anvilProvider = new Anvil(saveDir);

    // One Promise chain per region file (.mca) so concurrent chunk arrivals
    // never interleave writes into the same file (which would corrupt it).
    const regionQueues = new Map();

    // Chunk dedup: the server can resend a chunk multiple times (e.g. when
    // the player re-enters its send distance). Only write each one once.
    const savedChunks = new Set();
    let chunksSaved   = 0;

    let saveQueue = Promise.resolve();

    function enqueueChunkSave(chunkX, chunkZ, column) {
        // 1. Validation check
        if (!column || !column.sections) {
            log(`SKIPPING: Empty column at [${chunkX}, ${chunkZ}]`);
            return;
        }

        const key = `${chunkX},${chunkZ}`;
        if (savedChunks.has(key)) return;
        savedChunks.add(key);

        saveQueue = saveQueue.then(async () => {
            try {
                // 2. Explicitly log the size before saving
                // If the column size is tiny/zero here, the issue is with the 
                // bot.world.getColumn() retrieval, not the save process.
                await anvilProvider.save(chunkX, chunkZ, column);
                chunksSaved++;
                
                if (chunksSaved % 10 === 0) {
                    log(`Saved ${chunksSaved} chunks. Last: [${chunkX}, ${chunkZ}]`);
                }
            } catch (err) {
                log(`Save ERROR [${chunkX}, ${chunkZ}]: ${err.message}`);
                savedChunks.delete(key); 
            }
        });
    }

    // ── Raw packet hook ───────────────────────────────────────────────────────
    //
    // WHY NOT chunkColumnLoad?
    //   Depending on the mineflayer build, chunkColumnLoad may emit the chunk
    //   origin in *block* space (chunkX * 16, chunkZ * 16).  That makes
    //   bot.world.getColumn(point.x, point.z) return undefined for every chunk
    //   except 0,0 (where 0*16 still equals 0), so only r.0.0.mca ever gets
    //   written.
    //
    // WHY map_chunk?
    //   It's the raw Minecraft protocol packet.  packet.x / packet.z are always
    //   in chunk units (no multiply-by-16), exactly what getColumn() expects.
    //
    // WHY setImmediate?
    //   Our listener and mineflayer's listener both subscribe to map_chunk.
    //   Mineflayer registered first, so it runs first — but setImmediate gives
    //   it one full tick to finish loading the column into bot.world before we
    //   try to read it back.
    //
    const onMapChunk = ({ x: chunkX, z: chunkZ }) => {
        // Wait for the next tick to ensure Mineflayer has processed the packet
        setImmediate(() => {
            const column = bot.world.getColumn(chunkX, chunkZ);
            
            // CRITICAL CHECK: Does this column have data?
            // If 'column.sections' is missing or empty, it's a useless chunk.
            if (!column || !column.sections || column.sections.length === 0) {
                return; // Skip: This is an empty or uninitialized column
            }

            // Only enqueue if it's a real, populated chunk
            enqueueChunkSave(chunkX, chunkZ, column);
        });
    };
    function startSaving() {
        // Reset state for a fresh flight session
        savedChunks.clear();
        regionQueues.clear();
        chunksSaved = 0;
        bot._client.on('map_chunk', onMapChunk);
        log('Mapping enabled');
    }

    function stopSaving() {
        bot._client.removeListener('map_chunk', onMapChunk);
        // Wait for any still-queued writes to flush, then report
        Promise.all([...regionQueues.values()]).then(() => {
            log(`Mapping done — ${chunksSaved} chunks across ${regionQueues.size} region file(s)`);
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function dist2D(ax, az, bx, bz) {
        return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
    }

    function findRocket() {
        for (let i = 0; i < 9; i++) {
            const item = bot.inventory.slots[36 + i];
            if (item && item.name === 'firework_rocket') return i;
        }
        return null;
    }

    // Non-blocking rocket fire.
    // We use setTimeout instead of await so it doesn't freeze the flight steering loop.
    // ── Rockets ───────────────────────────────────────────────────────────────
    async function fireRocket() {
        const firework = bot.registry.itemsByName['firework_rocket'];
        if (!firework) return;

        // Searches the ENTIRE inventory (null means we don't restrict to a specific metadata/NBT)
        const rocket = bot.inventory.findInventoryItem(firework.id, null);

        if (!rocket) {
            log('WARNING: Out of rockets in entire inventory!');
            return;
        }

        try {
            // bot.equip automatically moves the item to the hotbar and selects it.
            await bot.equip(rocket, 'hand');

            // A tiny delay ensures the server registers the hotbar swap before we click
            setTimeout(() => { bot.activateItem(); }, 30);
        } catch (err) {
            log(`Rocket equip error: ${err.message}`);
        }
    }

    // ── Launch ────────────────────────────────────────────────────────────────
    async function launchElytra() {
        log('Equipping elytra...');

        const chestSlot = bot.inventory.slots[6];
        if (!chestSlot || chestSlot.name !== 'elytra') {
            const elytra = bot.inventory.findInventoryItem(
                bot.registry.itemsByName['elytra'].id, null
            );
            if (!elytra) { log('ERROR: No elytra!'); return false; }
            await bot.equip(elytra, 'torso');
            await sleep(400);
        }

        bot.setControlState('jump', true);
        await sleep(150);
        bot.setControlState('jump', false);

        for (let i = 0; i < 20; i++) {
            await sleep(50);
            if (!bot.entity.onGround) break;
        }

        try {
            await bot.elytraFly();
            log('elytraFly() OK');
        } catch (err) {
            log(`elytraFly(): ${err.message}`);
        }

        await sleep(200);
        await fireRocket();
        await sleep(400);
        await fireRocket();
        return true;
    }

    // ── Fly to waypoint ───────────────────────────────────────────────────────
    async function flyToWaypoint(targetX, targetZ, stopFlag) {
        log(`Flying to X:${targetX} Z:${targetZ}`);

        let lastRocketTime = Date.now();
        let isClimbing = true; // Start in climb mode to gain altitude

        while (!stopFlag.stop) {
            const pos = bot.entity.position;
            const d   = dist2D(pos.x, pos.z, targetX, targetZ);

            if (d < REACH_DIST) {
                log(`Arrived at X:${targetX} Z:${targetZ} (dist: ${d.toFixed(1)})`);
                return true;
            }

            // ── Altitude State Machine ────────────────────────────────────
            if (pos.y < BOOST_LOW_Y) {
                isClimbing = true;
            } else if (pos.y >= FLIGHT_Y) {
                isClimbing = false;
            }

            const pitch    = isClimbing ? PITCH_ASCEND : PITCH_GLIDE;
            const pitchRad = pitch * (Math.PI / 180);

            // ── Yaw: point EXACTLY toward target ──────────────────────────
            const dx        = targetX - pos.x;
            const dz        = targetZ - pos.z;
            const targetYaw = Math.atan2(-dx, -dz);

            // Force internal entity rotation for physics calculations
            bot.entity.yaw   = targetYaw;
            bot.entity.pitch = pitchRad;

            // Fire-and-forget look packet to sync with the server (force = true)
            bot.look(targetYaw, pitchRad, true).catch(() => {});

            // ── Rockets ───────────────────────────────────────────────────
            const elapsed = Date.now() - lastRocketTime;

            if (isClimbing && elapsed > BOOST_INTERVAL) {
                fireRocket();
                lastRocketTime = Date.now();
            }

            // Relaunch if elytra closed (hit the ground or water)
            if (!bot.entity.elytraFlying && pos.y > 20 && elapsed > 1000) {
                log('Elytra closed — relaunching');
                await launchElytra();
                lastRocketTime = Date.now();
            }

            // Log position every 5s
            if (Math.floor(Date.now() / 5000) !== Math.floor((Date.now() - TICK_MS) / 5000)) {
                log(`Pos: ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)} | Dist: ${d.toFixed(0)} | Yaw: ${(targetYaw * 180 / Math.PI).toFixed(1)}° | Mode: ${isClimbing ? 'CLIMB' : 'GLIDE'}`);
            }

            await sleep(TICK_MS);
        }

        return false;
    }

    // ── Zigzag ────────────────────────────────────────────────────────────────
    async function startZigzag(waypoints) {
        let stopped = false;
        bot.once('stop_module_signal', () => { stopped = true; log('Aborting...'); });

        startSaving();

        const launched = await launchElytra();
        if (!launched) { stopSaving(); return; }

        const stopFlag = { stop: false };
        for (let i = 0; i < waypoints.length; i++) {
            if (stopped) break;
            await flyToWaypoint(waypoints[i].x, waypoints[i].z, stopFlag);
            await sleep(300);
        }

        stopSaving();
        log('Zigzag complete!');
    }

    function generateZigzag(startX, startZ, endZ, endX, stepX) {
        const waypoints = [];
        let fwd = true;
        for (let x = startX; x <= endX; x += stepX) {
            waypoints.push({ x, z: fwd ? startZ : endZ });
            waypoints.push({ x, z: fwd ? endZ : startZ });
            fwd = !fwd;
        }
        return waypoints;
    }

    return { startZigzag, generateZigzag };
}

module.exports = { setupElytraFlight };