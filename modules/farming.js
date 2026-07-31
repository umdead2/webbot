const { Vec3 } = require('vec3');

const farmOffsets = [
    {x: 31446.500, z: 38207.500},
    {x: 31446.500, z: 38203.500},
    {x: 31444.500, z: 38205.500},
    {x: 31448.500, z: 38205.500}
];

function setupFarming(bot, id, io, emitStatus) {
    let lastInventoryCount = -1;
    let isDigging = false;
    let isPlacing = false;
    let isRightClicking = false;
    let isEating = false;
    let rightClickInterval = null;
    let inventoryFull = false;
    let isInSellGUI = false;

    async function eatIfHungry(bot) {
        if (bot.food === undefined || bot.food > 5) return;
        if (isEating) return;

        const goldenApple = bot.inventory.items().find(item =>
            item.name === 'golden_apple' || item.name === 'enchanted_golden_apple'
        );

        if (!goldenApple) return;

        try {
            isEating = true;
            await bot.equip(goldenApple, 'hand');
            await bot.consume();
            console.log(`[${new Date().toLocaleTimeString()}] [FOOD] Ate ${goldenApple.name} (hunger was ${bot.food})`);
        } catch (err) {
            console.log(`[FOOD] Failed to eat:`, err.message);
        } finally {
            isEating = false;
        }
    }

    function startRightClick() {
        console.log(`[DEBUG] startRightClick called - isRightClicking: ${isRightClicking}`);
        if (isRightClicking) return;
        isRightClicking = true;

        console.log(`[${new Date().toLocaleTimeString()}] [FARM] Mode: ${bot.username === 'dominance2' ? 'DIGGING' : 'PLANTING'}`);

        rightClickInterval = setInterval(async () => {
            if (!isRightClicking || isInSellGUI) return;

            await eatIfHungry(bot);

            for (const offset of farmOffsets) {
                if (bot.username === 'olegs123') {
                    const pos = new Vec3(offset.x, -32, offset.z).floored();
                    const plantBlock = bot.blockAt(pos);
                    if (!plantBlock || plantBlock.name !== 'potatoes') continue;

                    const props = plantBlock.getProperties();
                    if (props.age < 7) continue;

                    if (!isDigging) {
                        const dist = bot.entity.position.distanceTo(plantBlock.position);
                        if (dist > 4.5) continue;

                        isDigging = true;

                        await bot.lookAt(plantBlock.position.offset(0.5, 0.5, 0.5), true);

                        const hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
                        if (hoe) await bot.equip(hoe, 'hand');

                        try {
                            await bot.dig(plantBlock, true);
                        } catch (err) {
                            try {
                                await bot.activateBlock(plantBlock);
                            } catch (err2) {
                            }
                            bot.stopDigging();
                        } finally {
                            isDigging = false;
                        }
                    }
                }
                else {
                    const pos = new Vec3(offset.x, -33, offset.z).floored();
                    const farmlandBlock = bot.blockAt(pos);
                    if (!farmlandBlock || farmlandBlock.name !== 'farmland') continue;

                    const plantPos = pos.offset(0, 1, 0);
                    const plantBlock = bot.blockAt(plantPos);
                    if (plantBlock && plantBlock.name === 'air' && !isPlacing) {
                        const potatoItem = bot.inventory.items().find(item => item.name === 'potato');
                        if (potatoItem) {
                            isPlacing = true;

                            const dx = farmlandBlock.position.x + 0.5 - bot.entity.position.x;
                            const dy = farmlandBlock.position.y + 0.5 - (bot.entity.position.y + 1.62);
                            const dz = farmlandBlock.position.z + 0.5 - bot.entity.position.z;

                            const targetYaw = Math.atan2(-dx, dz);
                            const targetPitch = Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz));

                            const yaw = bot.entity.yaw + (targetYaw - bot.entity.yaw) * 0.2;
                            const pitch = bot.entity.pitch + (targetPitch - bot.entity.pitch) * 0.2;

                            bot.look(yaw, pitch, false);

                            await bot.equip(potatoItem, 'hand');
                            bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0)).catch(() => {});
                            await new Promise(r => setTimeout(r, 50));
                            isPlacing = false;
                        }
                    }
                }
            }
        }, 200);
    }

    function stopRightClick() {
        if (rightClickInterval) {
            clearInterval(rightClickInterval);
            rightClickInterval = null;
        }
        isRightClicking = false;
        console.log(`[${new Date().toLocaleTimeString()}] [FARM] Stopped right click`);
    }

    function checkInventory() {
        const emptySlots = bot.inventory.emptySlotCount();

        if (emptySlots === 0 && !inventoryFull) {
            inventoryFull = true;
            console.log(`[${new Date().toLocaleTimeString()}] [INVENTORY] Inventory full! Stopping farm and opening sell GUI...`);

            stopRightClick();

            setTimeout(() => {
                bot.chat('/sellgui');
                console.log(`[${new Date().toLocaleTimeString()}] [SELL] Sent /sellgui command`);
                isInSellGUI = true;
            }, 300);
        }
    }

    function closeGUIAndResume() {
        try {
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow);
                console.log(`[${new Date().toLocaleTimeString()}] [GUI] Closed sell GUI`);
            }

            isInSellGUI = false;
            inventoryFull = false;

            setTimeout(() => {
                startRightClick();
            }, 500);

        } catch (e) {
            console.error(`[ERROR] Error closing window: ${e.message}`);
        }
    }

    async function sellAllItems() {
        try {
            const window = bot.currentWindow;

            if (!window) {
                console.log(`[${new Date().toLocaleTimeString()}] [ERROR] No window found`);
                closeGUIAndResume();
                return;
            }

            console.log(`[${new Date().toLocaleTimeString()}] [SELL] Shift-clicking items to sell GUI...`);

            let clickCount = 0;

            const startSlot = window.inventoryStart;
            const endSlot = window.inventoryStart + 35;
            const protectedSlot = window.inventoryStart + 27;

            for (let i = startSlot; i <= endSlot; i++) {
                if (i === protectedSlot) continue;

                if (window.slots[i]) {
                    try {
                        await bot.clickWindow(i, 0, 1);
                        clickCount++;

                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch (e) {
                        // Silent
                    }
                }
            }

            console.log(`[${new Date().toLocaleTimeString()}] [SELL] Successfully moved ${clickCount} item stacks`);

            setTimeout(() => {
                closeGUIAndResume();
            }, 500);

        } catch (e) {
            console.error(`[ERROR] Error selling items: ${e.message}`);
            closeGUIAndResume();
        }
    }

    // Check inventory every 500ms
    const inventoryCheckInterval = setInterval(() => {
        const occupiedSlots = bot.inventory.items().length;

        if (occupiedSlots !== lastInventoryCount) {
            console.log(`[${new Date().toLocaleTimeString()}] [FARM] Inventory updated: ${occupiedSlots}/36`);
            lastInventoryCount = occupiedSlots;
        }
        if (!isInSellGUI) {
            checkInventory();
        }
    }, 500);

    // Listen for window open
    bot.on('windowOpen', (window) => {
        if (isInSellGUI) {
            console.log(`[${new Date().toLocaleTimeString()}] [GUI] Sell GUI opened - selling items...`);

            setTimeout(() => {
                sellAllItems();
            }, 500);
        }
    });

    return {
        startRightClick,
        stopRightClick,
        inventoryCheckInterval
    };
}

module.exports = { setupFarming };