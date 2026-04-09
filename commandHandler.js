const db = require('./database');
const logger = require('./logger');
const merchant = require('./merchant');
const { ZONES } = require('./zones_db');

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
                }, ws.room);
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

                // COOLDOWN: нельзя начинать новый бой слишком быстро (5 секунд после последнего боя)
                const BATTLE_COOLDOWN_MS = 5000;
                if (ws.lastBattleEnd && (Date.now() - ws.lastBattleEnd) < BATTLE_COOLDOWN_MS) {
                    const remaining = Math.ceil((BATTLE_COOLDOWN_MS - (Date.now() - ws.lastBattleEnd)) / 1000);
                    this.sendSystemMessage(ws, `Отдохните перед следующей битвой! (${remaining}с)`, 'error');
                    return;
                }

                let zoneId = parseInt(args[1]) || 1;
                const MAX_ZONE = Object.keys(ZONES).length;
                if (zoneId < 1 || zoneId > MAX_ZONE) zoneId = 1;

                try {
                    ws.pendingBattle = true; // СТАВИМ ЗАМОК
                    const effective = await db.getEffectiveStats(ws.characterId);

                    // ВАЛИДАЦИЯ УРОВНЯ ДЛЯ ЗОНЫ
                    const zone = ZONES[zoneId];
                    if (zone && effective.level < zone.minLvl) {
                        this.sendSystemMessage(ws, `Слишком опасно! Для зоны «${zone.name}» нужен ${zone.minLvl}+ уровень.`, 'error');
                        ws.pendingBattle = false;
                        return;
                    }

                    if (effective) {
                        this.combat.startPvEBattle(ws.characterId, ws.username, effective.stamina, zoneId, {
                            level: effective.level,
                            baseDamage: effective.effective_damage,
                            hp: effective.effective_hp,
                            maxHp: effective.effective_max_hp,
                            maxStamina: effective.effective_max_stamina,
                            bonusHp: effective.bonusHp,
                            dodgeChance: effective.effective_dodge,
                            critChance: effective.effective_crit, // Будет нормализовано в combat.js
                            blockChance: effective.effective_block,
                            bonusVamp: effective.effective_vamp,
                            accuracy: effective.effective_accuracy,
                            expMultiplier: effective.exp_find_mult,
                            goldMultiplier: effective.gold_find_mult
                        });
                    }
                    ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПОСЛЕ УСПЕХА
                } catch (err) {
                    logger.error({ username: ws.username, zoneId, error: err }, 'Error starting battle');
                    ws.pendingBattle = false; // СНИМАЕМ ЗАМОК ПРИ КРАШЕ
                }
                break;

            case '/skills':
                this.sendSystemMessage(ws, '📜 Навыки пока в разработке. Следите за обновлениями!', 'system');
                break;

            case '/items':
                await this.handleItemsInCombat(ws);
                break;

            case '/rest':
                if (isInCombat) {
                    this.sendSystemMessage(ws, 'Нельзя отдыхать в бою!', 'error');
                    return;
                }
                try {
                    const eff = await db.getEffectiveStats(ws.characterId);
                    const restHp = Math.floor(eff.effective_max_hp * 0.15);
                    const restSt = Math.floor(eff.effective_max_stamina * 0.20);
                    const newHp = Math.min(eff.effective_hp + restHp, eff.effective_max_hp);
                    const newSt = Math.min((eff.stamina || 0) + restSt, eff.effective_max_stamina);
                    await db.updateCharacterStats(ws.characterId, { hp: newHp, stamina: newSt });
                    const effAfter = await db.getEffectiveStats(ws.characterId);
                    this.sendToSpecificClient(ws.characterId, {
                        event: 'stat_update',
                        hp: effAfter.effective_hp, max_hp: effAfter.effective_max_hp,
                        stamina: newSt, max_stamina: effAfter.effective_max_stamina
                    });
                    this.sendSystemMessage(ws, `🏕️ Вы отдохнули. HP +${restHp}, Стамина +${restSt}`, 'system');
                } catch (err) {
                    logger.error({ err }, 'Error in /rest');
                }
                break;

            case '/findgold':
                if (isInCombat) return;
                try {
                    const amount = Math.max(1, Math.min(parseInt(args[1]) || 5, 200));
                    const effG = await db.getEffectiveStats(ws.characterId);
                    const newGold = (effG.gold || 0) + amount;
                    await db.updateCharacter(ws.characterId, { gold: newGold });
                    this.sendToSpecificClient(ws.characterId, {
                        event: 'stat_update', gold: newGold
                    });
                } catch (err) {
                    logger.error({ err }, 'Error in /findgold');
                }
                break;

            case '/stuck':
                logger.warn({ username: ws.username, charId: ws.characterId }, 'Player used /stuck command');
                this.combat.activeBattles.delete(ws.characterId);
                ws.pendingBattle = false;
                ws.room = 'global';
                this.sendToSpecificClient(ws.characterId, { event: 'combat_ended', reason: 'stuck_command' });
                this.broadcast({ 
                    event: 'chat_broadcast', 
                    sender: "Система", 
                    text: `⚠️ ${ws.username} использовал команду /stuck для сброса состояния.`, 
                    type: 'system' 
                }, ws.room);
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
                const shopType = args[1] === 'bar' ? 'bar' : 'general';
                ws.currentShopType = shopType;
                
                const stock = merchant.getStock(ws.characterId, shopType);
                ws.send(JSON.stringify({ event: 'shop_data', items: stock }));
                break;

            case '/buy':
                const buyIdx = parseInt(args[1]);
                const currentShop = ws.currentShopType || 'general';
                try {
                    const result = await merchant.buyItem(ws, buyIdx, currentShop);
                    this.sendSystemMessage(ws, `Вы купили ${result.item.name} за ${result.item.price}💰`, 'system');
                    
                    // Обновляем золото
                    ws.send(JSON.stringify({ event: 'stat_update', username: ws.username, gold: result.newGold }));
                    
                    // СРАЗУ присылаем обновленный список товаров (из того же типа магазина)
                    const newStock = merchant.getStock(ws.characterId, currentShop);
                    ws.send(JSON.stringify({ event: 'shop_data', items: newStock }));
                    
                    await this.handleInventory(ws);
                } catch (err) {
                    // Отдельно обрабатываем ошибку переполненного инвентаря
                    if (err.message.includes('Инвентарь переполнен')) {
                        this.sendSystemMessage(ws, '🐛 ' + err.message, 'error');
                    } else {
                        this.sendSystemMessage(ws, err.message, 'error');
                    }
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
                
            case '/drop':
                const dropId = args[1];
                if (!dropId) {
                    this.sendSystemMessage(ws, 'Использование: /drop <ID_предмета>', 'error');
                    return;
                }
                await this.handleDrop(ws, dropId);
                break;

            case '/sellpotions':
                try {
                    const inv = await db.getInventory(ws.characterId);
                    const potions = inv.filter(i => i.item_data.type === 'potion' && !i.is_equipped);
                    
                    if (potions.length === 0) {
                        this.sendSystemMessage(ws, 'У вас нет лишних зелий для продажи.', 'error');
                        return;
                    }
                    
                    const effective = await db.getEffectiveStats(ws.characterId);
                    const tradeBonus = (effective.effective_trade || 0) / 100;
                    const goldMult = effective.gold_find_mult || 1.0;
                    const sellMultiplier = Math.min(0.95, (0.5 + tradeBonus / 200) * goldMult);
                    
                    let totalGold = 0;
                    for (const p of potions) {
                        const price = Math.floor((p.item_data.price || 0) * sellMultiplier);
                        totalGold += price;
                        await db.deleteItem(p.id);
                    }
                    
                    const char = await db.getCharacterById(ws.characterId);
                    const newGold = char.gold + totalGold;
                    await db.updateCharacter(ws.characterId, { gold: newGold });
                    
                    this.sendSystemMessage(ws, `Вы продали все зелья (${potions.length} шт.) за ${totalGold}💰`, 'system');
                    ws.send(JSON.stringify({ event: 'stat_update', username: ws.username, gold: newGold }));
                    await this.handleInventory(ws);
                    
                    logger.info({ username: ws.username, potionCount: potions.length, totalGold }, 'Bulk potions sold');
                } catch (err) {
                    logger.error({ username: ws.username, error: err }, 'Error in /sellpotions');
                    this.sendSystemMessage(ws, 'Ошибка при массовой продаже зелий.', 'error');
                }
                break;
                
            case '/use':
                const useId = args[1];
                if (!useId) {
                    this.sendSystemMessage(ws, 'Использование: /use <ID_предмета>', 'error');
                    return;
                }
                await this.handleUse(ws, useId);
                break;
                
            case '/sit':
                ws.body_state = 'sitting';
                await db.updateCharacter(ws.characterId, { body_state: 'sitting' });
                this.broadcastStatUpdate(ws);
                this.sendSystemMessage(ws, 'Вы присели отдохнуть.', 'system');
                break;
                
            case '/stand':
                ws.body_state = 'human';
                await db.updateCharacter(ws.characterId, { body_state: 'human' });
                this.broadcastStatUpdate(ws);
                this.sendSystemMessage(ws, 'Вы встали.', 'system');
                break;
                
            case '/drink':
                ws.body_state = 'drunk';
                await db.updateCharacter(ws.characterId, { body_state: 'drunk' });
                this.broadcastStatUpdate(ws);
                this.sendSystemMessage(ws, 'Вы выпили кружку эля. Голова пошла кругом!', 'system');
                
                // Через 30 секунд протрезвеем
                setTimeout(async () => {
                   if (ws.readyState === 1 && ws.body_state === 'drunk') {
                       ws.body_state = 'human';
                       await db.updateCharacter(ws.characterId, { body_state: 'human' });
                       this.broadcastStatUpdate(ws);
                       this.sendSystemMessage(ws, 'Вы протрезвели.', 'system');
                   }
                }, 30000);
                break;

            default:
                this.sendSystemMessage(ws, 'Неизвестная команда. Доступны: /battle, /inventory, /shop, /use, /equip, /unequip, /drop, /sell, /mutate, /stuck', 'error');
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
                ws.body_state = 'monster'; // ОБНОВЛЯЕМ В СОКЕТЕ ДЛЯ КОМНАТ
                
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

    async handleUse(ws, itemId) {
        try {
            const item = await db.getItem(itemId, ws.characterId);
            if (!item) {
                this.sendSystemMessage(ws, 'Предмет не найден в вашем инвентаре.', 'error');
                return;
            }

            const itemData = item.item_data;
            const itemDb = require('./item_db');
            
            // ПРОВЕРКА: Это вообще зелье?
            if (itemData.type !== 'potion') {
                this.sendSystemMessage(ws, `Вы не можете использовать ${itemData.name} таким образом.`, 'error');
                return;
            }

            const effect = itemDb.potion_effects[itemData.name];
            if (!effect) {
                this.sendSystemMessage(ws, `Это зелье слишком старое или испорченное, оно не дает эффекта.`, 'error');
                // Все равно удаляем
                await db.deleteItem(itemId);
                await this.handleInventory(ws);
                return;
            }

            // ПРИМЕНЕНИЕ БАФФА
            const char = await db.getCharacterById(ws.characterId);
            let buffs = char.active_buffs || [];
            
            const newBuff = {
                stat: effect.stat,
                value: effect.value,
                turns_left: effect.duration,
                name: itemData.name
            };
            
            buffs.push(newBuff);
            
            await db.updateCharacter(ws.characterId, { active_buffs: buffs });
            await db.deleteItem(itemId);
            
            this.sendSystemMessage(ws, `🧪 Вы выпили ${itemData.name}! Бонус к ${effect.stat} на ${effect.duration} ходов в бою.`, 'system');
            
            // Обновляем инвентарь и статы клиента
            await this.handleInventory(ws);
            const effective = await db.getEffectiveStats(ws.characterId);
            ws.send(JSON.stringify({ 
                event: 'stat_update', 
                username: ws.username, 
                ...effective
            }));

        } catch (err) {
            logger.error({ username: ws.username, itemId, error: err }, 'Error using item');
            this.sendSystemMessage(ws, 'Ошибка при использовании предмета.', 'error');
        }
    }

    /**
     * Выбрасывает предмет из инвентаря (без компенсации)
     */
    async handleDrop(ws, itemId) {
        try {
            const item = await db.getItem(itemId, ws.characterId);
            if (!item) {
                this.sendSystemMessage(ws, 'Предмет не найден в вашем инвентаре.', 'error');
                return;
            }
            if (item.is_equipped) {
                this.sendSystemMessage(ws, 'Сначала снимите предмет, чтобы выбросить его.', 'error');
                return;
            }
            const itemName = item.item_data.name || 'Предмет';
            await db.deleteItem(itemId);
            logger.info({ username: ws.username, itemId, itemName }, 'Item dropped by player');
            await db.saveAuditLog(ws.characterId, 'drop', { item: itemName });
            this.sendSystemMessage(ws, `🗑️ Вы выбросили: ${itemName}.`, 'system');
            await this.handleInventory(ws);
        } catch (err) {
            logger.error({ username: ws.username, itemId, error: err }, 'Error dropping item');
            this.sendSystemMessage(ws, 'Ошибка при выбрасывании предмета.', 'error');
        }
    }

    /**
     * Показывает зелья из инвентаря во время боя
     * Игрок получает список зелий с ID для быстрого использования через /use <ID>
     */
    async handleItemsInCombat(ws) {
        try {
            const inv = await db.getInventory(ws.characterId);
            const potions = (inv || []).filter(i => i.item_data.type === 'potion' && !i.is_equipped);

            if (potions.length === 0) {
                this.sendSystemMessage(ws, '🧴 У вас нет зелий в инвентаре.', 'system');
                return;
            }

            // Формируем список зелий с номерами для быстрого выбора
            let msg = '🧪 Зелья в инвентаре. Используйте /use <ID>:\n';
            potions.slice(0, 8).forEach((p, idx) => {
                msg += `[${idx + 1}] ${p.item_data.name} (ID: ${p.id.substring(0, 8)}...)\n`;
            });
            msg += 'Например: /use ' + potions[0].id;

            this.sendSystemMessage(ws, msg, 'system');
        } catch (err) {
            logger.error({ username: ws.username, error: err }, 'Error listing items in combat');
        }
    }

    async broadcastStatUpdate(ws) {
        const effective = await db.getEffectiveStats(ws.characterId);
        this.broadcast({
            event: 'stat_update',
            username: ws.username,
            ...effective
        }, ws.room);
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
