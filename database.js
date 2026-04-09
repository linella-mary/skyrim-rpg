const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const RACE_BONUSES = {
    'Норд': { block: 10 },
    'Орсимер': { damage_mult: 1.25 },
    'Каджит': { crit: 5 },
    'Аргонианин': { hp_mult: 1.20 },
    'Имперец': { gold_mult: 1.30 },
    'Альтмер': { exp_mult: 1.20 },
    'Бретонец': { block: 15 },
    'Редгард': { stamina: 30 }
};

class Database {
    constructor() {
        this._migrationsChecked = false;
    }

    /**
     * Проверяет и логирует статус миграций БД
     */
    async checkMigrations() {
        try {
            logger.info('🔍 Проверка миграций базы данных...');
            const { data: migrations, error } = await supabase
                .from('_migrations')
                .select('name');

            if (error) {
                if (error.code === 'PGRST116' || error.message.includes('relation "_migrations" does not exist')) {
                    logger.warn('⚠️ ТАБЛИЦА МИГРАЦИЙ НЕ НАЙДЕНА. Пожалуйста, выполните sql из server/migrations/001_initial_schema.sql в Supabase Dashboard!');
                    return;
                }
                throw error;
            }

            const migrationsDir = path.join(__dirname, 'migrations');
            if (!fs.existsSync(migrationsDir)) return;

            const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
            const applied = (migrations || []).map(m => m.name);

            files.forEach(file => {
                if (!applied.includes(file)) {
                    logger.warn(`🚀 НАЙДЕНА НОВАЯ МИГРАЦИЯ: ${file}. Пожалуйста, примените её в Supabase.`);
                }
            });
            
            logger.info('✅ Все доступные миграции проверены.');
        } catch (err) {
            logger.error({ error: err.message }, 'Migration check failed');
        }
    }

    /**
     * Получает персонажа по имени пользователя (без автосоздания)
     */
    async getCharacterByUsername(username) {
        const { data, error } = await supabase
            .from('characters')
            .select('*')
            .eq('username', username)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null; // Не найден — не ошибка
            logger.error({ username, error }, 'Error fetching character by username');
            throw error;
        }
        return data;
    }

    /**
     * Создает нового персонажа с выбором расы и внешности
     */
    async createCharacter(username, race = 'Nord', appearance = {}, stats = {}) {
        logger.info({ username, race }, 'Creating new character with race/appearance');
        const { data, error } = await supabase
            .from('characters')
            .insert([{
                username,
                race,
                appearance,
                hp: 100,
                stamina: 100,
                max_hp: 100,
                level: 1,
                exp: 0,
                gold: 0,
                strength: stats.strength || 10,
                dexterity: stats.dexterity || 10,
                constitution: stats.constitution || 10,
                luck: stats.luck || 10,
                physical_defense: 5,
                evasion: 5,
                block_chance: 5,
                accuracy: 10,
                active_buffs: []
            }])
            .select()
            .single();
        
        if (error) {
            logger.error({ username, error }, 'Error creating new character');
            throw error;
        }
        return data;
    }

    /**
     * Получает или создает персонажа (Legacy support)
     */
    async getOrCreateCharacter(username) {
        let character = await this.getCharacterByUsername(username);

        if (!character) {
            return await this.createCharacter(username, 'Nord', {});
        }

        return character;
    }

    /**
     * Получает персонажа по ID
     */
    async getCharacterById(id) {
        const { data, error } = await supabase
            .from('characters')
            .select('*')
            .eq('id', id)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') return null; // Не найден — не ошибка
            logger.error({ id, error }, 'Error fetching character by ID');
            throw error;
        }
        return data;
    }

    /**
     * Рассчитывает итоговые характеристики персонажа с учетом экипировки
     */
    async getEffectiveStats(characterId) {
        try {
            const char = await this.getCharacterById(characterId);
            if (!char) return null;

            const { data: items, error } = await supabase
                .from('inventory')
                .select('item_data')
                .eq('character_id', characterId)
                .eq('is_equipped', true);
            
            if (error) throw error;

            const now = Date.now();
            const activeBuffs = char.active_buffs || [];

            // Фильтруем активные баффы (теперь по количеству ходов)
            const validBuffs = activeBuffs.filter(b => (b.turns_left !== undefined ? b.turns_left > 0 : b.expires > now));
            const expiredBuffs = activeBuffs.filter(b => (b.turns_left !== undefined ? b.turns_left <= 0 : b.expires <= now));
            
            // Если есть просроченные баффы — чистим
            if (expiredBuffs.length > 0) {
                this.updateCharacter(characterId, { active_buffs: validBuffs }).catch(e => logger.error({ characterId, error: e }, "Failed to clean expired buffs"));
            }

            let bonusHp = 0;
            let bonusDamage = 0;
            let bonusDodge = 0;
            let bonusTrade = 0;
            let bonusCrit = 0;
            let bonusVamp = 0;
            // Проклятия
            let curseDrain = 0;    // hp_drain: передаётся в combat.js для обработки
            let curseTradeDebuff = 0; // trade: штраф к цене продажи
            let curseDmgDebuff = 0;   // fragile: штраф к урону
            
            // Дополнительные модификаторы от баффов (эликсиры)
            let buffStrength = 0;
            let buffDexterity = 0;
            let buffConstitution = 0;
            let buffLuck = 0;
            let buffDefense = 0;
            let buffAccuracy = 0;
            let buffCrit = 0;
            let buffVamp = 0;
            let buffDodge = 0;

            (items || []).forEach(item => {
                const s = item.item_data.stats || {};
                const isCursed = item.item_data.cursed || false;
                if (s.hp) bonusHp += s.hp;
                if (s.dmg) bonusDamage += s.dmg;
                if (s.dodge) bonusDodge += s.dodge;
                if (s.crit) bonusCrit += s.crit;
                if (s.vamp) bonusVamp += s.vamp;
                // Проклятые предметы: отрицательные бонусы отдельно, положительные — в общий пул
                if (isCursed) {
                    if (s.hp_drain) curseDrain += s.hp_drain;
                    if (s.trade && s.trade < 0) curseTradeDebuff += Math.abs(s.trade);
                    if (s.fragile) curseDmgDebuff += Math.abs(s.fragile || 0);
                } else {
                    if (s.trade) bonusTrade += s.trade;
                }
            });
            
            validBuffs.forEach(b => {
                if (b.stat === 'strength') buffStrength += b.value;
                if (b.stat === 'dexterity') buffDexterity += b.value;
                if (b.stat === 'constitution') buffConstitution += b.value;
                if (b.stat === 'luck') buffLuck += b.value;
                if (b.stat === 'physical_defense') buffDefense += b.value;
                if (b.stat === 'accuracy') buffAccuracy += b.value;
                if (b.stat === 'crit') buffCrit += b.value;
                if (b.stat === 'vamp') buffVamp += b.value;
                if (b.stat === 'dodge') buffDodge += b.value;
            });

            const finalStr = (char.strength || 10) + buffStrength;
            const finalDex = (char.dexterity || 10) + buffDexterity;
            const finalCon = (char.constitution || 10) + buffConstitution;
            const finalLuck = (char.luck || 10) + buffLuck;
            const finalDef = (char.physical_defense || 5) + buffDefense;

            const rB = RACE_BONUSES[char.race] || {};
            const dmgMult = rB.damage_mult || 1.0;
            const hpMult = rB.hp_mult || 1.0;
            const blockBonus = rB.block || 0;
            const critBonus = rB.crit || 0;
            const staminaBonus = rB.stamina || 0;
            
            // Применяем штрафы проклятий: уменьшают положительные бонусы
            const tradeBonus = Math.max(0, (bonusTrade || 0) + (finalLuck / 2) - curseTradeDebuff);
            const totalCrit = (finalLuck / 2) + bonusCrit + critBonus + buffCrit;
            const totalDodge = (char.evasion || 5) + finalDex / 2 + bonusDodge + buffDodge;
            const totalVamp = bonusVamp + buffVamp + (finalDex * 0.1);

            return {
                ...char,
                active_buffs: validBuffs,
                base_max_hp: char.max_hp,
                bonusHp, bonusDamage, bonusDodge, bonusCrit, bonusVamp, bonusTrade,
                curse_drain: curseDrain,       // проклятие: утечка HP за ход в бою
                effective_max_hp: Math.floor((char.max_hp + bonusHp + (finalCon * 2)) * hpMult),
                effective_hp: Math.min(char.hp, Math.floor((char.max_hp + bonusHp + (finalCon * 2)) * hpMult)),
                effective_damage: Math.floor(((char.base_damage || 0) + finalStr + bonusDamage - curseDmgDebuff) * dmgMult),
                effective_dodge: totalDodge,
                effective_crit: totalCrit,
                effective_block: (char.block_chance || 5) + (finalDef / 2) + blockBonus,
                effective_max_stamina: (char.max_stamina || 100) + staminaBonus + (finalStr * 0.5),
                effective_trade: tradeBonus,
                effective_accuracy: (char.accuracy || 10) + buffAccuracy,
                effective_vamp: totalVamp,
                gold_find_mult: rB.gold_mult || 1.0,
                exp_find_mult: rB.exp_mult || 1.0
            };
        } catch (error) {
            logger.error({ characterId, error }, 'Error calculating effective stats');
            throw error;
        }
    }

    /**
     * Обновляет статы персонажа
     */
    async updateCharacter(id, updates) {
        const { data, error } = await supabase
            .from('characters')
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') return null;
            logger.error({ id, updates, error }, 'Error updating character stats');
            throw error;
        }
        return data;
    }

    /**
     * Возвращает весь инвентарь персонажа
     */
    async getInventory(characterId) {
        const { data, error } = await supabase
            .from('inventory')
            .select('*')
            .eq('character_id', characterId);
        
        if (error) {
            logger.error({ characterId, error }, 'Error fetching inventory');
            throw error;
        }
        return data;
    }

    /**
     * Возвращает конкретный предмет из инвентаря
     */
    async getItem(itemId, characterId) {
        const { data, error } = await supabase
            .from('inventory')
            .select('*')
            .eq('id', itemId)
            .eq('character_id', characterId)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') return null; // Предмет уже мог быть удален (гонка)
            logger.error({ itemId, characterId, error }, 'Error fetching item');
            throw error;
        }
        return data;
    }

    /**
     * Возвращает список всей надетой экипировки
     */
    async getEquippedItems(characterId) {
        const { data, error } = await supabase
            .from('inventory')
            .select('*')
            .eq('character_id', characterId)
            .eq('is_equipped', true);
        
        if (error) {
            logger.error({ characterId, error }, 'Error fetching equipped items');
            throw error;
        }
        return data;
    }

    /**
     * Меняет статус экипировки предмета
     */
    async setItemEquipped(itemId, isEquipped) {
        const { data, error } = await supabase
            .from('inventory')
            .update({ is_equipped: isEquipped })
            .eq('id', itemId)
            .select()
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') return null;
            logger.error({ itemId, isEquipped, error }, 'Error setting item equipment state');
            throw error;
        }
        return data;
    }

    /**
     * Добавляет предмет в инвентарь (Лут)
     * Лимит: MAX_INVENTORY_SLOTS неэкипированных предметов
     */
    async addLoot(characterId, lootData) {
        const MAX_INVENTORY_SLOTS = 20;

        // Считаем только неэкипированные предметы (экипировка слоты не занимает)
        const { count, error: countError } = await supabase
            .from('inventory')
            .select('id', { count: 'exact', head: true })
            .eq('character_id', characterId)
            .eq('is_equipped', false);
        
        if (countError) {
            logger.error({ characterId, error: countError }, 'Error counting inventory slots');
            throw countError;
        }

        if (count >= MAX_INVENTORY_SLOTS) {
            logger.warn({ characterId, count }, 'Inventory full, cannot add loot');
            throw new Error(`Инвентарь переполнен! Максимум ${MAX_INVENTORY_SLOTS} предметов. Продайте или выбросьте что-нибудь.`);
        }

        const { data, error } = await supabase
            .from('inventory')
            .insert([{
                character_id: characterId,
                item_data: lootData,
                is_equipped: false,
                slot_type: lootData.type === 'potion' ? null : lootData.type
            }])
            .select()
            .single();
        
        if (error) {
            logger.error({ characterId, lootData, error }, 'Error adding loot to inventory');
            throw error;
        }
        return data;
    }

    /**
     * Удаляет предмет из инвентаря (при смерти или продаже)
     */
    async deleteItem(itemId) {
        const { error } = await supabase
            .from('inventory')
            .delete()
            .eq('id', itemId);
        
        if (error) {
            logger.error({ itemId, error }, 'Error deleting item');
            throw error;
        }
        return true;
    }

    /**
     * Сохраняет важное игровое событие в таблицу аудита
     */
    async saveAuditLog(characterId, eventType, details = {}) {
        try {
            const { error } = await supabase
                .from('audit_logs')
                .insert([{ 
                    character_id: characterId, 
                    event_type: eventType, 
                    details: details 
                }]);
            
            if (error) throw error;
        } catch (err) {
            logger.error({ characterId, eventType, error: err.message }, 'Failed to save audit log');
        }
    }
}

module.exports = new Database();
