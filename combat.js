const { spawnMonster } = require('./monster_db');
const { generateLoot } = require('./loot_gen');
const db = require('./database');
const logger = require('./logger');

class CombatEngine {
    constructor(broadcastFn, sendToClientFn, wsClientsRef = null) {
        this.broadcast = broadcastFn;
        this.sendToClientFn = sendToClientFn;
        this.wsClientsRef = wsClientsRef; // Ссылка на wss.clients для записи cooldown
        
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
                maxStamina: data.maxStamina || 100,
                bonusHp: data.bonusHp || 0,
                baseDamage: data.baseDamage || 15,
                stamina: playerStamina,
                level: data.level || 1,
                isDefending: false,
                dodgeChance: data.dodgeChance || 10,
                critChance: (data.critChance || 5) / 100,
                blockChance: data.blockChance || 5,
                bonusVamp: data.bonusVamp || 0,
                accuracy: data.accuracy || 10,
                expMultiplier: data.expMultiplier || 1.0,
                goldMultiplier: data.goldMultiplier || 1.0
            },
            enemy: genMonster,
            turn: 'player',
            updatedAt: Date.now() // Метка для GC
        };
        
        // maxHp уже содержит все бонусы через effective_max_hp, не прибавляем bonusHp повторно
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
        try {
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

                // --- МЕХАНИКА ПОПАДАНИЯ ---
                const baseHitChance = 85; // Базовый шанс
                const hitChance = Math.min(99, Math.max(50, baseHitChance + (battle.player.accuracy || 10) - (battle.enemy.dodge || 5)));
                const isHit = (Math.random() * 100) <= hitChance;

                if (!isHit) {
                    battle.lastAction = { target: 'enemy', type: 'miss' };
                    this.sendToClientFn(characterId, { 
                        event: "chat_broadcast", 
                        sender: "Бой", 
                        type: "system", 
                        text: `Ваш удар прошел мимо! ${battle.enemy.name} уклонился.` 
                    });
                } else {
                    const baseDmg = (battle.player.baseDamage || 0);
                    let dmg = baseDmg + Math.floor(Math.random() * 6);
                    
                    // Critical Hit based on new stats
                    const isCrit = Math.random() < battle.player.critChance;
                    
                    if (isCrit) {
                        dmg = Math.floor(dmg * 2.0);
                    }

                    battle.lastAction = { target: 'enemy', value: dmg, isCrit: isCrit, type: 'hit' };

                    if (dmg <= 0) {
                         battle.lastAction.type = 'miss';
                         this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Ваш удар был слишком слабым! (0 урона)" });
                    } else {
                         battle.enemy.hp -= dmg;
                         const critText = isCrit ? " КРИТИЧЕСКИЙ УДАР!" : "";
                         this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "normal", text: `Вы наносите ${dmg}${critText} урона. У врага осталось ${Math.max(battle.enemy.hp, 0)} ХП.` });
                         
                         // ВАМПИРИЗМ
                         if ((battle.player.bonusVamp || 0) > 0) {
                             const healAmount = Math.floor(dmg * (battle.player.bonusVamp / 100));
                             if (healAmount > 0) {
                                 battle.player.hp = Math.min(battle.player.hp + healAmount, battle.player.maxHp);
                                 this.sendToClientFn(characterId, { 
                                     event: "chat_broadcast", 
                                     sender: "Бой", 
                                     type: "system", 
                                     text: `🩸 Вампиризм: +${healAmount} HP` 
                                 });
                             }
                         }
                    }
                }

                await this.processBuffs(characterId);
                await this.applyCurseDrain(characterId);
                
                const isEnded = await this.checkBattleEnd(characterId);
                if (!isEnded) {
                    this.enemyTurn(characterId);
                }
                return true;
            } 
            
            if (actionType === 'defend') {
                battle.player.stamina += 30;
                if (battle.player.stamina > (battle.player.maxStamina || 100)) battle.player.stamina = (battle.player.maxStamina || 100);
                
                battle.player.isDefending = true;
                battle.lastAction = { target: 'player', type: 'heal', value: 30 };

                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Вы ушли в глухую оборону. Стамина частично восстановлена." });
                
                await this.processBuffs(characterId);
                await this.applyCurseDrain(characterId);
                
                this.enemyTurn(characterId);
                return true;
            }
            
            if (actionType === 'flee') {
                if (Math.random() > 0.5) {
                    logger.info({ username: battle.player.username }, 'Player successfully fled from battle');
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Вам удалось сбежать с поля боя!" });
                    
                    await db.updateCharacter(characterId, { 
                        hp: Math.max(battle.player.hp, 1), 
                        stamina: battle.player.stamina 
                    });
                    
                    this.sendToClientFn(characterId, { event: "combat_ended", reason: "fled" });
                    this._setCombatCooldown(characterId);
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
        } catch (err) {
            logger.error({ characterId, error: err }, 'CRITICAL ERROR in combat handleAction');
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "error", text: "Критическая ошибка боя. Персонаж спасен." });
            this.activeBattles.delete(characterId);
            return false;
        }
    }

    async enemyTurn(characterId) {
        try {
            const battle = this.activeBattles.get(characterId);
            if (!battle) return;

            battle.turn = 'enemy';
            this.sendBattleState(characterId);

            // Имитация раздумий врага
            setTimeout(async () => {
                try {
                    const currentBattle = this.activeBattles.get(characterId);
                    if (!currentBattle) return;

                    // Шансы игрока (блоки/уклонения)
                    const dodgeChance = currentBattle.player.dodgeChance || 5;
                    const blockChance = currentBattle.player.blockChance || 5;
                    
                    if (Math.random() * 100 <= dodgeChance) {
                        currentBattle.lastAction = { target: 'player', type: 'miss' };
                        this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `Вы ловко уклонились от удара!` });
                    } else if (Math.random() * 100 <= blockChance) {
                        currentBattle.lastAction = { target: 'player', type: 'hit', value: 0 }; 
                        this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `Ваш щит/броня полностью заблокировали атаку!` });
                    } else {
                        // ВЫБОР СПОСОБНОСТИ
                        const abilities = currentBattle.enemy.abilities || [{ name: 'Атака', mult: 1.0, type: 'hit' }];
                        const ability = abilities[Math.floor(Math.random() * abilities.length)];
                        
                        const minDmg = currentBattle.enemy.damageMin || 1;
                        const maxDmg = currentBattle.enemy.damageMax || 10;
                        let dmg = Math.floor(Math.random() * (maxDmg - minDmg + 1)) + minDmg;
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
                    currentBattle.updatedAt = Date.now();
                    
                    const ended = await this.checkBattleEnd(characterId);
                    if (!ended) {
                        this.sendBattleState(characterId);
                    }
                } catch (err) {
                    logger.error({ characterId, error: err }, 'Error in enemy turn inner loop');
                    this.activeBattles.delete(characterId);
                }
            }, 1500);
        } catch (err) {
            logger.error({ characterId, error: err }, 'Error starting enemy turn');
            this.activeBattles.delete(characterId);
        }
    }

    async checkBattleEnd(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return true;

        // --- ПОБЕДА ---
        if (battle.enemy.hp <= 0) {
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: `⚔️ ${battle.enemy.name} повержен!` });
            
            try {
                const data = await db.getCharacterById(characterId);
                const expWon = Math.floor(battle.enemy.exp * (battle.player.expMultiplier || 1.0));
                const goldWon = Math.floor(battle.enemy.gold * (battle.player.goldMultiplier || 1.0));
                let newExp = (data.exp || 0) + expWon;
                let newGold = (data.gold || 0) + goldWon;
                let newLevel = data.level || 1;
                let newMaxHp = data.max_hp || 100;
                let newBaseDmg = data.base_damage || 5;

                let expNeeded = newLevel * 50;
                while (newExp >= expNeeded) {
                    newLevel++;
                    newExp -= expNeeded;
                    newMaxHp += 10;
                    newBaseDmg += 1;
                    battle.player.hp += 10;
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "system", text: `🎉 УРОВЕНЬ ПОВЫШЕН! Теперь вы ${newLevel} уровня. (+10 HP, +1 Урон)` });
                    expNeeded = newLevel * 50; 
                }
                
                const victoryHeal = Math.floor(newMaxHp * 0.25);
                const finalHp = Math.min(battle.player.hp + victoryHeal, newMaxHp + (battle.player.bonusHp || 0));
                
                await db.updateCharacter(characterId, {
                    exp: newExp, gold: newGold, stamina: battle.player.stamina,
                    level: newLevel, max_hp: newMaxHp, base_damage: newBaseDmg, hp: finalHp
                });

                await db.saveAuditLog(characterId, 'victory', { monster: battle.enemy.name, expEarned: expWon, goldEarned: goldWon });

                const effectiveAfterWin = await db.getEffectiveStats(characterId);
                this.sendToClientFn(characterId, { 
                    event: 'stat_update', username: battle.player.username, 
                    stamina: battle.player.stamina, exp: newExp, gold: newGold, level: newLevel,
                    hp: effectiveAfterWin.effective_hp, max_hp: effectiveAfterWin.effective_max_hp,
                    damage: effectiveAfterWin.effective_damage, dodge: effectiveAfterWin.effective_dodge
                });

                if (battle.enemy.loot_chance > 0 && Math.random() * 100 <= battle.enemy.loot_chance) {
                    const loot = generateLoot(battle.enemy.loot_tier);
                    const rarityLabel = `[${loot.rarity_name.toUpperCase()}]`;
                    const rarityColor = loot.rarity_color || "#ffffff";
                    this.sendToClientFn(characterId, { 
                        event: "chat_broadcast", sender: "Система", type: "normal", 
                        text: `💎 Вы выбили: [color=${rarityColor}][b]${rarityLabel} ${loot.name}[/b][/color] (Цена: [color=gold]${loot.price}💰[/color])` 
                    });
                    await db.addLoot(characterId, loot);
                }
                this.sendToClientFn(characterId, { event: "combat_ended", reason: "victory" });
                this._setCombatCooldown(characterId);
            } catch (err) {
                logger.error({ characterId, error: err }, 'Error checking battle victory outcome');
                this.sendToClientFn(characterId, { event: "combat_ended", reason: "error" });
            } finally {
                this.activeBattles.delete(characterId);
            }
            return true;
        }

        // --- ПОРАЖЕНИЕ ---
        if (battle.player.hp <= 0) {
            this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Бой", type: "error", text: `Темнота поглощает вас... Вы погибли в бою.` });
            
            try {
                const data = await db.getCharacterById(characterId);
                const loss = Math.floor(data.gold * 0.2);
                const newGold = Math.max(0, data.gold - loss);
                
                await db.updateCharacter(characterId, { gold: newGold, stamina: battle.player.stamina, hp: 20 });
                await db.saveAuditLog(characterId, 'death', { monster: battle.enemy.name, goldLost: loss });
                
                this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "error", text: `💸 Потеряно ${loss} золота при смерти.` });
                this.sendToClientFn(characterId, { event: 'stat_update', username: battle.player.username, gold: newGold, hp: 20, max_hp: data.max_hp || 100 });

                const invData = await db.getInventory(characterId);
                const droppableItems = (invData || []).filter(i => !i.is_equipped);
                if (droppableItems.length > 0) {
                    const randomItem = droppableItems[Math.floor(Math.random() * droppableItems.length)];
                    await db.deleteItem(randomItem.id);
                    this.sendToClientFn(characterId, { event: "chat_broadcast", sender: "Система", type: "error", text: `🗑️ Вы потеряли: ${randomItem.item_data.name}!` });
                }
                this.sendToClientFn(characterId, { event: "combat_ended", reason: "defeat" });
                this._setCombatCooldown(characterId);
            } catch (err) {
                logger.error({ characterId, error: err }, 'Error processing player defeat');
                this.sendToClientFn(characterId, { event: "combat_ended", reason: "error" });
            } finally {
                this.activeBattles.delete(characterId);
            }
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

    async processBuffs(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return;

        try {
            const char = await db.getCharacterById(characterId);
            let buffs = char.active_buffs || [];
            if (buffs.length === 0) return;

            let changed = false;
            let expiredNames = [];

            const updatedBuffs = buffs.map(b => {
                if (b.turns_left !== undefined && b.turns_left > 0) {
                    b.turns_left--;
                    changed = true;
                    if (b.turns_left <= 0) {
                        expiredNames.push(b.name);
                    }
                }
                return b;
            });

            if (changed) {
                const stillValid = updatedBuffs.filter(b => b.turns_left === undefined || b.turns_left > 0);
                await db.updateCharacter(characterId, { active_buffs: stillValid });

                for (const name of expiredNames) {
                    this.sendToClientFn(characterId, { 
                        event: "chat_broadcast", 
                        sender: "Система", 
                        type: "system", 
                        text: `⏳ Действие эликсира [${name}] закончилось.` 
                    });
                }

                // ПОЛНЫЙ ПЕРЕСЧЕТ СТАТОВ ПРЯМО В БОЮ
                if (expiredNames.length > 0) {
                    const effective = await db.getEffectiveStats(characterId);
                    
                    // Обновляем текущее состояние боя
                    battle.player.maxHp = effective.effective_max_hp;
                    battle.player.baseDamage = effective.effective_damage;
                    battle.player.dodgeChance = effective.effective_dodge;
                    battle.player.critChance = effective.effective_crit / 100;
                    battle.player.blockChance = effective.effective_block;
                    battle.player.bonusVamp = effective.effective_vamp;
                    battle.player.accuracy = effective.effective_accuracy;
                    
                    // Синхронизируем с клиентом
                    this.sendToClientFn(characterId, { 
                        event: "stat_update", 
                        username: battle.player.username, 
                        ...effective
                    });
                }
            }
        } catch (err) {
            logger.error({ characterId, error: err }, 'Error processing turns-based buffs');
        }
    }

    /**
     * Устанавливает метку кулдауна на WebSocket-клиенте
     */
    _setCombatCooldown(characterId) {
        if (!this.wsClientsRef) return;
        for (const client of this.wsClientsRef) {
            if (client.characterId === characterId) {
                client.lastBattleEnd = Date.now();
                break;
            }
        }
    }

    /**
     * Применяет утечку HP от проклятых предметов в начале каждого хода
     */
    async applyCurseDrain(characterId) {
        const battle = this.activeBattles.get(characterId);
        if (!battle) return;
        try {
            const effective = await db.getEffectiveStats(characterId);
            const drain = effective.curse_drain || 0;
            if (drain <= 0) return;

            battle.player.hp = Math.max(1, battle.player.hp - drain);
            this.sendToClientFn(characterId, {
                event: 'chat_broadcast',
                sender: 'Система',
                type: 'error',
                text: `💀 Проклятая экипировка высасывает из вас ${drain} HP!`
            });
            logger.info({ characterId, drain }, 'Curse drain applied');
        } catch (err) {
            logger.error({ characterId, error: err }, 'Error applying curse drain');
        }
    }

    cleanupBattle(characterId) {
        if (this.activeBattles.has(characterId)) {
            logger.info({ characterId }, 'Cleaning up battle due to disconnect');
            this.activeBattles.delete(characterId);
        }
    }
}

module.exports = CombatEngine;
