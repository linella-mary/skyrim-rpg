const { spawnMonster } = require('./monster_db');
const { generateLoot } = require('./loot_gen');
const db = require('./database');
const logger = require('./logger');

class CombatEngine {
    constructor(broadcastFn, sendToClientFn) {
        this.broadcast = broadcastFn;
        this.sendToClientFn = sendToClientFn;
        
        // Мапа активных боев. Ключ: characterId, Значение: состояние боя
        this.activeBattles = new Map();
        
        // --- ГАРБЕДЖ КОЛЛЕКТОР (GC) ---
        // Очищаем «мёртвые» бои раз в 5 минут, чтобы не текла память
        setInterval(() => {
            const now = Date.now();
            const timeout = 10 * 60 * 1000; // 10 минут инактива
            
            for (const [charId, battle] of this.activeBattles.entries()) {
                if (now - battle.updatedAt > timeout) {
                    logger.info({ characterId: charId }, 'GC: Removing inactive battle context');
                    this.activeBattles.delete(charId);
                }
            }
        }, 5 * 60 * 1000);
    }

    startPvEBattle(characterId, username, playerStamina, zoneId = 1, data = {}) {
        if (this.activeBattles.has(characterId)) {
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Возврат в текущее сражение..." });
            this.sendBattleState(characterId);
            return;
        }

        const genMonster = spawnMonster(zoneId); 
        logger.info({ username, monster: genMonster.name, zoneId }, 'Battle started');

        const battle = {
            player: {
                id: characterId,
                username: username,
                hp: data.hp || 100, 
                maxHp: data.maxHp || 100,
                baseDamage: data.baseDamage || 5,
                bonusDamage: data.bonusDamage || 0,
                bonusHp: data.bonusHp || 0,
                stamina: playerStamina,
                level: data.level || 1,
                isDefending: false,
                dodgeChance: 10 + (data.bonusDodge || 0),
                bonusCrit: data.bonusCrit || 0,
                bonusVamp: data.bonusVamp || 0
            },
            enemy: genMonster,
            turn: 'player',
            updatedAt: Date.now() // Метка для GC
        };
        
        // Применяем бонусы к HP героя (экипировка)
        battle.player.maxHp += battle.player.bonusHp;
        battle.player.hp = Math.min(battle.player.hp, battle.player.maxHp);

        this.activeBattles.set(characterId, battle);
        
        this.sendToClientFn(characterId, { 
            event: "chat_broadcast", 
            sender: "Бой", 
            type: "system", 
            text: `На вас нападает ${battle.enemy.name}! Ваш ход. Доступны: /attack, /defend` 
        });
        
        this.sendBattleState(characterId);
    }

    async handleAction(characterId, actionType) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return false;
        
        // Обновляем метку активности для GC
        battle.updatedAt = Date.now();
        
        if (battle.turn !== 'player') {
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: "Сейчас ход противника! Ожидайте." });
            return true;
        }

        if (actionType === 'attack') {
            const staminaCost = 15;
            if (battle.player.stamina < staminaCost) {
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: "Недостаточно Стамины для атаки!" });
                this.sendBattleState(characterId);
                return true;
            }
            
            battle.player.stamina -= staminaCost;
            battle.player.isDefending = false;

            const baseDmg = (battle.player.baseDamage || 0) + (battle.player.bonusDamage || 0);
            let dmg = baseDmg + Math.floor(Math.random() * 11);
            
            // Динамический Расчет Крита (База 10% + бонусы от вещей)
            const critChance = (10 + (battle.player.bonusCrit || 0)) / 100;
            const isCrit = Math.random() < critChance;
            
            if (isCrit) {
                dmg = Math.floor(dmg * 1.5);
            }

            battle.lastAction = { target: 'enemy', value: dmg, isCrit: isCrit, type: 'hit' };

            if (dmg === 0) {
                 battle.lastAction.type = 'miss';
                 this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Ваш удар скользнул по шкуре противника! (0 урона)" });
            } else {
                 battle.enemy.hp -= dmg;
                 const critText = isCrit ? " КРИТИЧЕСКИЙ УДАР!" : "";
                 this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "normal", text: `Вы наносите ${dmg}${critText} урона. У врага осталось ${Math.max(battle.enemy.hp, 0)} ХП.` });
                 
                 // ВАМПИРИЗМ (Исцеление за счет урона)
                 if ((battle.player.bonusVamp || 0) > 0) {
                     const healAmount = Math.floor(dmg * (battle.player.bonusVamp / 100));
                     if (healAmount > 0) {
                         const maxEffectiveHp = (battle.player.maxHp || 100) + (battle.player.bonusHp || 0);
                         battle.player.hp = Math.min(battle.player.hp + healAmount, maxEffectiveHp);
                         this.sendToClientFn(characterId, { 
                             event: "chat_broadcast", 
                             sender: "Бой", 
                             type: "system", 
                             text: `🩸 Вампиризм: +${healAmount} HP` 
                         });
                         // Синхронизируем статы
                         this.sendToClientFn(characterId, { 
                             event: "stat_update", 
                             username: battle.player.username, 
                             hp: battle.player.hp 
                         });
                     }
                 }
            }

            // ВАЖНО: Ждем завершения проверки, прежде чем передавать ход врагу
            const isEnded = await this.checkBattleEnd(characterId);
            if (!isEnded) {
                this.enemyTurn(characterId);
            }
            return true;
        } 
        
        if (actionType === 'defend') {
            battle.player.stamina += 30;
            if (battle.player.stamina > 100) battle.player.stamina = 100;
            
            battle.player.isDefending = true;
            battle.lastAction = { target: 'player', type: 'heal', value: 30 };

            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Вы ушли в глухую оборону. Стамина частично восстановлена." });
            
            this.enemyTurn(characterId);
            return true;
        }
        
        if (actionType === 'flee') {
            if (Math.random() > 0.5) {
                logger.info({ username: battle.player.username }, 'Player successfully fled from battle');
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Вам удалось сбежать с поля боя!" });
                
                db.updateCharacter(characterId, { 
                    hp: Math.max(battle.player.hp, 1), 
                    stamina: battle.player.stamina 
                }).then(() => {
                    this.sendToClientFn(characterId, { 
                        event: 'stat_update', 
                        username: battle.player.username, 
                        hp: Math.max(battle.player.hp, 1), 
                        stamina: battle.player.stamina 
                    });
                }).catch(err => logger.error({ username: battle.player.username, error: err }, 'Error updating stats after fleeing'));
                
                this.sendToClientFn(characterId, { event: "combat_ended", reason: "fled" });
                this.activeBattles.delete(characterId);
            } else {
                battle.lastAction = { target: 'player', type: 'miss' };
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: "Побег не удался! Враг бьет в спину." });
                battle.player.isDefending = false;
                this.enemyTurn(characterId);
            }
            return true;
        }
        
        this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: "В бою доступны: /attack, /defend, /flee" });
        return true; 
    }

    enemyTurn(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return;

        battle.turn = 'enemy';
        this.sendBattleState(characterId);

        setTimeout(async () => {
            const currentBattle = this.activeBattles.get(characterId);
            if (!currentBattle) return;
            
            if (Math.random() * 100 <= currentBattle.player.dodgeChance) {
                currentBattle.lastAction = { target: 'player', type: 'miss' };
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `Вы ловко уклонились от удара!` });
            } else {
                // ВЫБОР СПОСОБНОСТИ
                const abilities = currentBattle.enemy.abilities || [{ name: 'Атака', mult: 1.0, type: 'hit' }];
                const ability = abilities[Math.floor(Math.random() * abilities.length)];
                
                let dmg = Math.floor(Math.random() * (currentBattle.enemy.damageMax - currentBattle.enemy.damageMin + 1)) + currentBattle.enemy.damageMin;
                dmg = Math.floor(dmg * (ability.mult || 1.0));

                currentBattle.lastAction = { 
                    target: 'player', 
                    value: dmg, 
                    isCrit: ability.isCrit || false, 
                    type: 'hit',
                    abilityName: ability.name
                };

                if (ability.type === 'heal') {
                    const healVal = Math.floor(currentBattle.enemy.maxHp * (ability.mult || 0.2));
                    currentBattle.enemy.hp = Math.min(currentBattle.enemy.maxHp, currentBattle.enemy.hp + healVal);
                    currentBattle.lastAction.target = 'enemy';
                    currentBattle.lastAction.type = 'heal';
                    currentBattle.lastAction.value = healVal;
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "normal", text: `${currentBattle.enemy.name} использует [${ability.name}] и восстанавливает ${healVal} HP.` });
                } else if (ability.type === 'drain') {
                    currentBattle.player.hp -= dmg;
                    currentBattle.player.stamina = Math.max(0, currentBattle.player.stamina - 15);
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: `${currentBattle.enemy.name} использует [${ability.name}], наносит ${dmg} урона и похищает вашу стамину!` });
                } else {
                    if (currentBattle.player.isDefending) {
                        dmg = Math.floor(dmg / 2);
                        currentBattle.lastAction.value = dmg;
                        this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `Ваш блок поглотил часть урона от [${ability.name}].` });
                    }
                    currentBattle.player.hp -= dmg;
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: `${currentBattle.enemy.name} использует [${ability.name}] и наносит вам ${dmg} урона!` });
                }
            }
            
            currentBattle.player.isDefending = false;
            currentBattle.turn = 'player';
            
            const isEnded = await this.checkBattleEnd(characterId);
            if (!isEnded) {
                this.sendBattleState(characterId);
            }
            
        }, 1500);
    }

    async checkBattleEnd(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (battle.enemy.hp <= 0) {
            logger.info({ username: battle.player.username, monster: battle.enemy.name }, 'Battle won by player');
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `Славная победа! ${battle.enemy.name} повержен.` });
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "normal", text: `Вы получили ${battle.enemy.exp} опыта и ${battle.enemy.gold} золота.` });
            
            try {
                const data = await db.getCharacterById(characterId);
                let newExp = (data.exp || 0) + battle.enemy.exp;
                let newGold = (data.gold || 0) + battle.enemy.gold;
                let newLevel = data.level || 1;
                let newMaxHp = data.max_hp || 100;
                let newBaseDmg = data.base_damage || 5;

                const expNeeded = newLevel * 50;
                if (newExp >= expNeeded) {
                    newLevel++;
                    newExp -= expNeeded;
                    newMaxHp += 10;
                    newBaseDmg += 1;
                    // При левел-апе немного подлечиваем игрока (бонус +10)
                    battle.player.hp += 10;
                    logger.info({ username: battle.player.username, newLevel }, 'Player leveled up');
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "system", text: `🎉 УРОВЕНЬ ПОВЫШЕН! Теперь вы ${newLevel} уровня. (+10 HP, +1 Урон)` });
                }
                
                const newStamina = battle.player.stamina; 
                const victoryHeal = Math.floor(newMaxHp * 0.25);
                const finalHp = Math.min(battle.player.hp + victoryHeal, newMaxHp + (battle.player.bonusHp || 0));
                
                await db.updateCharacter(characterId, {
                    exp: newExp,
                    gold: newGold,
                    stamina: newStamina,
                    level: newLevel,
                    max_hp: newMaxHp,
                    base_damage: newBaseDmg,
                    hp: finalHp // Сохраняем РЕАЛЬНОЕ здоровье после боя
                });

                // ЛОГИРОВАНИЕ ПОБЕДЫ (АУДИТ)
                await db.saveAuditLog(characterId, 'victory', { 
                    monster: battle.enemy.name, 
                    expEarned: battle.enemy.exp, 
                    goldEarned: battle.enemy.gold,
                    newLevel: newLevel
                });

                this.sendToClientFn(characterId, { 
                    event: 'stat_update', 
                    username: battle.player.username, 
                    stamina: newStamina,
                    exp: newExp,
                    gold: newGold,
                    level: newLevel,
                    hp: newMaxHp,
                    max_hp: newMaxHp,
                    damage: newBaseDmg
                });

                if (battle.enemy.loot_chance > 0 && Math.random() * 100 <= battle.enemy.loot_chance) {
                    const loot = generateLoot(battle.enemy.loot_tier);
                    logger.info({ username: battle.player.username, loot: loot.name }, 'Loot dropped');
                    
                    const rarityLabel = `[${loot.rarity_name.toUpperCase()}]`;
                    const rarityColor = loot.rarity_color || "#ffffff";
                    
                    this.sendToClientFn(characterId, { 
                        event: "chat_broadcast", 
                        sender: "Система", 
                        type: "normal", 
                        text: `💎 Вы выбили: [color=${rarityColor}][b]${rarityLabel} ${loot.name}[/b][/color] (Цена: [color=gold]${loot.price}💰[/color])` 
                    });
                    
                    // ЛОГИРОВАНИЕ ЛУТА (АУДИТ)
                    await db.saveAuditLog(characterId, 'loot', { 
                        item: loot.name, 
                        rarity: loot.rarity_name, 
                        price: loot.price 
                    });
                    
                    await db.addLoot(characterId, loot);
                }
            } catch (err) {
                logger.error({ username: battle.player.username, error: err }, 'Error during battle victory processing');
            }
            
            this.sendToClientFn(characterId, { event: "combat_ended", reason: "victory" });
            this.activeBattles.delete(characterId);
            return true;
        }

        if (battle.player.hp <= 0) {
            logger.info({ username: battle.player.username, monster: battle.enemy.name }, 'Battle lost by player');
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: `Темнота поглощает вас... Вы погибли в бою.` });
            
            try {
                const data = await db.getCharacterById(characterId);
                const loss = Math.floor(data.gold * 0.2);
                const newGold = data.gold - loss;
                
                await db.updateCharacter(characterId, { gold: newGold, stamina: battle.player.stamina, hp: 20 });
                
                // ЛОГИРОВАНИЕ СМЕРТИ (АУДИТ)
                await db.saveAuditLog(characterId, 'death', { 
                    monster: battle.enemy.name, 
                    goldLost: loss 
                });
                
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "error", text: `💸 Потеряно ${loss} золота при смерти.` });
                this.sendToClientFn(characterId, { event: 'stat_update', username: battle.player.username, gold: newGold, hp: 20 });

                const invData = await db.getInventory(characterId);
                if (invData && invData.length > 0) {
                    const randomItem = invData[Math.floor(Math.random() * invData.length)];
                    await db.deleteItem(randomItem.id);
                    logger.info({ username: battle.player.username, item: randomItem.item_data.name }, 'Item lost on death');
                    this.sendToClientFn(characterId, { 
                        event: "chat_broadcast", 
                        sender: "Система", 
                        type: "error", 
                        text: `🗑️ Вы потеряли: ${randomItem.item_data.name}!` 
                    });
                }
            } catch (err) {
                logger.error({ username: battle.player.username, error: err }, 'Error during battle loss processing');
            }

            this.sendToClientFn(characterId, { event: "combat_ended", reason: "defeat" });
            this.activeBattles.delete(characterId);
            return true;
        }
        return false;
    }

    sendBattleState(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return;

        // Присваиваем ID действию, если оно есть
        if (battle.lastAction && !battle.lastAction.id) {
            battle.lastAction.id = Date.now();
        }

        this.sendToClientFn(characterId, {
            event: 'combat_update',
            ...battle
        });

        // Очищаем lastAction после отправки, чтобы он не спамил при повторных обновлениях стейта
        delete battle.lastAction;
    }

    cleanupBattle(characterId) {
        if (this.activeBattles.has(characterId)) {
            logger.info({ characterId }, 'Cleaning up battle due to disconnect');
            this.activeBattles.delete(characterId);
        }
    }
}

module.exports = CombatEngine;
