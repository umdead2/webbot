'use strict';

function setupSpawnerLoot(bot, id, io, emitStatus) {

    function log(msg) {
        console.log(`[SpawnerLoot][${id}] ${msg}`);
        emitStatus(id, `[SpawnerLoot] ${msg}`);
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function openBlock(block, timeout = 5000) {
        return new Promise(async (resolve, reject) => {
            if (!bot.blockAt(block.position)) {
                return reject(new Error("Block unloaded or out of reach"));
            }
            
            log(`Looking at block "${block.name}" at ${block.position}...`);
            // Force the bot to look directly at the center of the block
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

            log(`Activating block...`);
            const timer = setTimeout(() => {
                bot.removeListener('windowOpen', onOpen);
                reject(new Error(`Timed out ${timeout}ms waiting for windowOpen`));
            }, timeout);

            function onOpen(window) {
                clearTimeout(timer);
                log(`windowOpen — "${window.title}" slots: ${window.slots.length}`);
                resolve(window);
            }
            
            bot.once('windowOpen', onOpen);
            bot.activateBlock(block);
        });
    }
    // Register listener BEFORE clicking so we never miss the event
    function clickAndWaitForWindow(currentWindow, slot, timeout = 8000) {
        return new Promise((resolve, reject) => {
            log(`Registering windowOpen listener then clicking slot ${slot}...`);
            const timer = setTimeout(() => {
                bot.removeListener('windowOpen', onOpen);
                if (bot.currentWindow && bot.currentWindow.id !== currentWindow.id) {
                    log(`Missed windowOpen but bot.currentWindow changed — using it`);
                    resolve(bot.currentWindow);
                    return;
                }
                reject(new Error(`Timed out ${timeout}ms waiting for loot window`));
            }, timeout);
            function onOpen(newWindow) {
                clearTimeout(timer);
                log(`Loot window — "${newWindow.title}" slots: ${newWindow.slots.length}`);
                resolve(newWindow);
            }
            bot.once('windowOpen', onOpen);
            bot.clickWindow(slot, 0, 0).then(() => {
                log(`Slot ${slot} click sent`);
            }).catch(err => {
                clearTimeout(timer);
                bot.removeListener('windowOpen', onOpen);
                reject(new Error(`clickWindow failed: ${err.message}`));
            });
        });
    }

    function waitForWindowSettle(timeout = 5000) {
        return new Promise((resolve) => {
            let timer;
            function onUpdate() {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    bot.removeListener('windowUpdate', onUpdate);
                    resolve();
                }, 50);
            }
            bot.on('windowUpdate', onUpdate);
            setTimeout(() => {
                clearTimeout(timer);
                bot.removeListener('windowUpdate', onUpdate);
                resolve();
            }, timeout);
        });
    }

    async function lootSpawner(spawnerBlock) {
        if (!spawnerBlock) { log('ERROR: No block provided'); return { sawArrows: false }; }

        log(`Starting loot on "${spawnerBlock.name}" at ${spawnerBlock.position}`);
        log(`Bot pos: ${JSON.stringify(bot.entity.position)}`);

        // Step 1: open spawner menu
        let spawnerMenu;
        try {
            spawnerMenu = await openBlock(spawnerBlock, 5000);
        } catch (err) {
            log(`FAILED to open spawner: ${err.message}`);
            return { sawArrows: false };
        }

        log(`Spawner menu: ${spawnerMenu.slots.map((s,i) => s ? `[${i}]${s.name}` : null).filter(Boolean).join(', ')}`);
        await sleep(400);

        // Step 2: click slot 13, wait for loot window (listener set up first)
        log(`Clicking slot 13...`);
        let lootWindow;
        try {
            lootWindow = await clickAndWaitForWindow(spawnerMenu, 13, 8000);
        } catch (err) {
            log(`FAILED to get loot window: ${err.message}`);
            if (bot.currentWindow) {
                log(`Fallback: using bot.currentWindow (${bot.currentWindow.slots.length} slots)`);
                lootWindow = bot.currentWindow;
            } else {
                try { bot.closeWindow(spawnerMenu); } catch (_) {}
                return { sawArrows: false };
            }
        }

        log(`Loot window ready — ${lootWindow.slots.length} slots`);
        await sleep(500);

        // Step 3: drop bones, track if we ever saw arrows
        let round = 0;
        let sawArrows = false;

        while (true) {
            round++;
            const activeWindow = bot.currentWindow || lootWindow;
            const topSlots = activeWindow.slots.slice(0, 45);
            const nonEmpty = topSlots.map((s,i) => s ? `[${i}]${s.name}x${s.count}` : null).filter(Boolean);
            log(`Round ${round} — slots 0-44: ${nonEmpty.join(', ') || 'ALL EMPTY'}`);

            // Check for arrows in this scan
            const hasArrows = topSlots.some(s => s && s.name.toLowerCase().includes('arrow'));
            if (hasArrows) {
                sawArrows = true;
                log(`Arrows detected in slots 0-44`);
            }

            const boneSlots = [];
            for (let i = 0; i < 45; i++) {
                const item = activeWindow.slots[i];
                if (!item) continue;
                const name = item.name.toLowerCase();
                if (name.includes('arrow')) continue; // NEVER touch arrows
                if (name.includes('bone')) boneSlots.push(i);
            }

            if (boneSlots.length > 0) {
                log(`Found ${boneSlots.length} bone slot(s) — dropping...`);
                for (const slot of boneSlots) {
                    const item = activeWindow.slots[slot];
                    if (!item) continue;

                    // Re-check right before dropping — server may have swapped to arrow
                    const liveItem = (bot.currentWindow || activeWindow).slots[slot];
                    if (!liveItem) continue;
                    if (liveItem.name.toLowerCase().includes('arrow')) {
                        log(`Slot ${slot} changed to arrow before drop — skipping`);
                        sawArrows = true;
                        continue;
                    }

                    log(`Dropping [${slot}] ${liveItem.name} x${liveItem.count}`);
                    try {
                        await bot.clickWindow(slot, 1, 4); // Ctrl+Q
                    } catch (err) {
                        log(`Drop failed slot ${slot}: ${err.message}`);
                    }
                }

                // If we already saw arrows, don't bother waiting for refill — just close
                if (sawArrows) {
                    log(`Already saw arrows — dropping remaining bones then stopping`);
                    break;
                }

                log(`Waiting for server to refill...`);
                await waitForWindowSettle(5000);
                continue;
            }

            // No bones — check if only arrows left
            const nonArrow = topSlots.filter(s => s && !s.name.toLowerCase().includes('arrow'));
            if (nonArrow.length === 0) {
                log(`No bones, all remaining are arrows (or empty) — done looting`);
                break;
            }

            log(`No bones but non-arrow items present: ${nonArrow.map(s=>s.name).join(', ')} — waiting for refill...`);
            await waitForWindowSettle(5000);
            await sleep(100);
        }

        // Step 4: click slot 49 (6th from bottom-left) — only if arrows were seen
        const activeWindow = bot.currentWindow || lootWindow;
        if (sawArrows) {
            const bottomItem = activeWindow.slots[49];
            log(`Arrows were seen — clicking slot 49: ${bottomItem ? `${bottomItem.name} x${bottomItem.count}` : 'EMPTY'}`);
            try {
                await bot.clickWindow(50, 0, 0);
                log(`Slot 50 clicked`);
            } catch (err) {
                log(`Failed to click slot 50: ${err.message}`);
            }
            await sleep(200);
        }

        // Step 5: close
        try {
            bot.closeWindow(activeWindow);
            log(`Window closed`);
        } catch (_) {}

        return { sawArrows };
    }

    async function startLootLoop(spawnerBlock) {
        log(`Loot loop started`);
        while (true) {
            log(`====== Starting loot run ======`);
            let sawArrows = false;
            try {
                const result = await lootSpawner(spawnerBlock);
                sawArrows = result.sawArrows;
            } catch (err) {
                log(`Error during loot run: ${err.message}`);
                console.error(err);
            }

            if (sawArrows) {
                log(`====== Saw arrows — waiting 5 minutes ======`);
                await sleep(5 * 60 * 1000); // 5 minutes
            } else {
                log(`====== Done — waiting 60 seconds ======`);
                await sleep(60000);
            }
        }
    }

    return { lootSpawner, startLootLoop };
}

module.exports = { setupSpawnerLoot };