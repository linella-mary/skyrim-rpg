const db = require('./database');
const logger = require('./logger');
const merchant = require('./merchant');

class CommandHandler {
    constructor(broadcast, sendToSpecificClient, combat) {
        this.broadcast = broadcast;
        this.sendToSpecificClient = sendToSpecificClient;
        this.combat = combat;
    }

    async handle(ws, parsed) {
        const { action, text } = parsed;

        if (action === 'chat_message' && text && ws.characterId) {
            const trimmedText = text.trim();

            if (trimmedText.startsWith('/')) {
                logger.info({ username: ws.username, command: trimmedText }, 'Executing command');
                await this.handleCommand(ws, trimmedText);
            } else {
                // Логируем сообщения чата (опционально)
                // logger.debug({ username: ws.username, text: trimmedText }, 'Chat message');
                this.broadcast({ 
                    event: 'chat_broadcast', 
                    sender: ws.username, 
                    text: trimmedText, 
                    type: 'normal' 
                });
            }
        }
    }

    async handleCommand(ws, text) {
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts;

        const isInCombat = this.combat.activeBattles.has(ws.characterId);

        switch (command) {
            case '/attack':
            case '/defend':
            case '/flee':
                const handled = await this.combat.handleAction(ws.characterId, command.substring(1));
                if (!handled) {
                    this.sendSystemMessage(ws, 'Вы сейчас не в бою. Напишите /battle чтобы начать драку с монстром!', 'system');
                }
                break;

            case '/battle':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Вы уже находитесь в бою! Завершите текущую схватку.', 'error');
                    return;
                }

                // ЗАЩИТА ОТ СПАМА (ПОКА БОЙ СОЗДАЕТСЯ)
                if (ws.pendingBattle) {
                    return;
                }

                const zoneId = parseInt(args[1]) || 1;
                
                try {
                    ws.pendingBattle = true; // СТАВИМ ЗАМОК
                    const effective = await db.getEffectiveStats(ws.characterId);
                    
                    // ВАЛИДАЦИЯ УРОВНЯ ДЛЯ ЗОН
                    if (zoneId === 2 && effective.level < 3) {
                        this.sendSystemMessage(ws, 'Вам нужен хотя бы 3 уровень, чтобы попасть в Вьюжный Перевал.', 'error');
                        ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПРИ ОШИБКЕ
                        return;
                    }
                    if (zoneId === 3 && effective.level < 5) {
                        this.sendSystemMessage(ws, 'Там слишком опасно! Нужен 5 уровень для зоны Чёрный Предел.', 'error');
                        ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПРИ ОШИБКЕ
                        return;
                    }

                    if (effective) {
                        this.combat.startPvEBattle(ws.characterId, ws.username, effective.stamina, zoneId, {
                            level: effective.level,
                            baseDamage: effective.base_damage,
                            hp: effective.effective_hp, // Текущее здоровье (с учетом шмота)
                            maxHp: effective.base_max_hp, // БАЗОВОЕ макс здоровье
                            bonusHp: effective.bonusHp,  // БОНУС ОТ ШМОТА
                            bonusDamage: effective.bonusDamage,
                            bonusDodge: effective.bonusDodge,
                            bonusCrit: effective.bonusCrit,
                            bonusVamp: effective.bonusVamp
                        });
                    }
                    ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПОСЛЕ УСПЕХА
                } catch (err) {
                    logger.error({ username: ws.username, zoneId, error: err }, 'Error starting battle');
                    ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПРИ КРАШЕ
                }
                break;

            case '/mutate':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Вы слишком заняты боем, чтобы мутировать!', 'error');
                    return;
                }
                await this.handleMutate(ws);
                break;

            case '/inventory':
                await this.handleInventory(ws);
                break;

            case '/equip':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Вы не можете менять экипировку в разгаре боя!', 'error');
                    return;
                }
                await this.handleEquip(ws, args[1]);
                break;

            case '/unequip':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Снимать броню во время боя — плохая идея!', 'error');
                    return;
                }
                await this.handleUnequip(ws, args[1]);
                break;

            case '/shop':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Торговец боится подходить к вам во время драки!', 'error');
                    return;
                }
                const stock = merchant.getStock(ws.characterId);
                ws.send(JSON.stringify({ event: 'shop_data', items: stock }));
                break;

            case '/buy':
                const buyIdx = parseInt(args[1]);
                try {
                    const result = await merchant.buyItem(ws, buyIdx);
                    this.sendSystemMessage(ws, `Вы купили ${result.item.name} за ${result.item.price}💰`, 'system');
                    
                    // Обновляем золото
                    ws.send(JSON.stringify({ event: 'stat_update', username: ws.username, gold: result.newGold }));
                    
                    // СРАЗУ присылаем обновленный список товаров торговца
                    const newStock = merchant.getStock(ws.characterId);
                    ws.send(JSON.stringify({ event: 'shop_data', items: newStock }));
                    
                    await this.handleInventory(ws);
                } catch (err) {
                    this.sendSystemMessage(ws, err.message, 'error');
                }
                break;

            case '/sell':
                const sellId = args[1];
                try {
                    const sellResult = await merchant.sellItem(ws, sellId);
                    this.sendSystemMessage(ws, `Предмет продан за ${sellResult.price}💰`, 'system');
                    ws.send(JSON.stringify({ event: 'stat_update', username: ws.username, gold: sellResult.newGold }));
                    await this.handleInventory(ws);
                } catch (err) {
                    this.sendSystemMessage(ws, err.message, 'error');
                }
                break;

            default:
                this.sendSystemMessage(ws, 'Неизвестная команда. Доступны: /battle, /mutate, /inventory, /shop', 'error');
                break;
        }
    }

    async handleMutate(ws) {
        try {
            const charData = await db.getCharacterById(ws.characterId);
            if (charData.stamina < 20) {
                this.sendSystemMessage(ws, 'Недостаточно сил для мутации.', 'error');
            } else {
                const newStamina = charData.stamina - 20;
                await db.updateCharacter(ws.characterId, { stamina: newStamina, body_state: 'monster' });
                
                logger.info({ username: ws.username }, 'Player mutated into a monster');
                this.broadcast({ 
                    event: 'chat_broadcast', 
                    sender: 'Система', 
                    text: `Тело ${ws.username} содрогается от изменений. Он превращается в монстра!`, 
                    type: 'system' 
                });
                this.broadcast({ 
                    event: 'stat_update', 
                    username: ws.username, 
                    stamina: newStamina, 
                    body_state: 'monster' 
                });
            }
        } catch (err) {
            logger.error({ username: ws.username, error: err }, 'Error during mutation');
        }
    }

    async handleInventory(ws) {
        try {
            const invData = await db.getInventory(ws.characterId);
            ws.send(JSON.stringify({ event: 'inventory_data', items: invData }));
        } catch (err) {
            logger.error({ username: ws.username, error: err }, 'Error fetching inventory');
        }
    }

    async handleEquip(ws, itemId) {
        if (!itemId) return;
        try {
            const item = await db.getItem(itemId, ws.characterId);
            if (!item) return;

            const currentEquipped = await db.getEquippedItems(ws.characterId);
            const slotType = item.item_data.type;
            
            logger.info({ username: ws.username, itemId, itemType: slotType }, 'Equipping item');

            let oldItemHp = 0;
            if (slotType === 'jewel') {
                const jewels = currentEquipped.filter(j => j.item_data.type === 'jewel');
                if (jewels.length >= 3) {
                    const toRemove = jewels[0];
                    await db.setItemEquipped(toRemove.id, false);
                    oldItemHp += toRemove.item_data.stats?.hp || 0;
                }
            } else {
                const toRemove = currentEquipped.find(i => i.item_data.type === slotType);
                if (toRemove) {
                    await db.setItemEquipped(toRemove.id, false);
                    oldItemHp = toRemove.item_data.stats?.hp || 0;
                }
            }

            await db.setItemEquipped(itemId, true);

            const char = await db.getCharacterById(ws.characterId);
            const newItemHp = item.item_data.stats?.hp || 0;
            const diff = newItemHp - oldItemHp;
            
            if (diff !== 0) {
                await db.updateCharacter(ws.characterId, { hp: char.hp + diff });
            }

            const updatedInv = await db.getInventory(ws.characterId);
            ws.send(JSON.stringify({ event: 'inventory_data', items: updatedInv }));

            const effective = await db.getEffectiveStats(ws.characterId);
            ws.send(JSON.stringify({ 
                event: 'stat_update', 
                username: ws.username, 
                ...effective
            }));
        } catch (err) {
            logger.error({ username: ws.username, itemId, error: err }, 'Error equipping item');
        }
    }

    async handleUnequip(ws, itemId) {
        if (!itemId) return;
        try {
            const item = await db.getItem(itemId, ws.characterId);
            if (!item) return;

            const itemHp = item.item_data.stats?.hp || 0;
            logger.info({ username: ws.username, itemId }, 'Unequipping item');
            
            await db.setItemEquipped(itemId, false);

            if (itemHp !== 0) {
                const char = await db.getCharacterById(ws.characterId);
                await db.updateCharacter(ws.characterId, { hp: Math.max(1, char.hp - itemHp) });
            }

            const updatedInv = await db.getInventory(ws.characterId);
            ws.send(JSON.stringify({ event: 'inventory_data', items: updatedInv }));

            const effective = await db.getEffectiveStats(ws.characterId);
            ws.send(JSON.stringify({ 
                event: 'stat_update', 
                username: ws.username, 
                ...effective
            }));
        } catch (err) {
            logger.error({ username: ws.username, itemId, error: err }, 'Error unequipping item');
        }
    }

    sendSystemMessage(ws, text, type = 'system') {
        ws.send(JSON.stringify({ 
            event: 'chat_broadcast', 
            sender: 'Система', 
            text, 
            type 
        }));
    }
}

module.exports = CommandHandler;
