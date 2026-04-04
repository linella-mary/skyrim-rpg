const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'ВАШ_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'ВАШ_SUPABASE_SERVICE_ROLE_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
     * Получает персонажа по имени пользователя или создает нового
     */
    async getOrCreateCharacter(username) {

        let { data: character, error } = await supabase
            .from('characters')
            .select('*')
            .eq('username', username)
            .single();

        if (error && error.code !== 'PGRST116') {
            logger.error({ username, error }, 'Error fetching character by username');
            throw error;
        }

        if (!character) {
            logger.info({ username }, 'Creating new character');
            const { data: newCharacter, error: insertError } = await supabase
                .from('characters')
                .insert([{ username: username }])
                .select()
                .single();
            
            if (insertError) {
                logger.error({ username, error: insertError }, 'Error creating new character');
                throw insertError;
            }
            character = newCharacter;
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

            let bonusHp = 0;
            let bonusDamage = 0;
            let bonusDodge = 0;
            let bonusTrade = 0;
            let bonusCrit = 0;
            let bonusVamp = 0;

            (items || []).forEach(item => {
                const s = item.item_data.stats || {};
                if (s.hp) bonusHp += s.hp;
                if (s.dmg) bonusDamage += s.dmg;
                if (s.dodge) bonusDodge += s.dodge;
                if (s.trade) bonusTrade += s.trade;
                if (s.crit) bonusCrit += s.crit;
                if (s.vamp) bonusVamp += s.vamp;
            });

            return {
                ...char,
                base_max_hp: char.max_hp,
                bonusHp,
                bonusDamage,
                bonusDodge,
                bonusTrade,
                bonusCrit,
                bonusVamp,
                effective_max_hp: char.max_hp + bonusHp,
                effective_hp: Math.min(char.hp, char.max_hp + bonusHp),
                effective_damage: (char.base_damage || 5) + bonusDamage,
                effective_dodge: 10 + bonusDodge
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
            logger.error({ itemId, isEquipped, error }, 'Error setting item equipment state');
            throw error;
        }
        return data;
    }

    /**
     * Добавляет предмет в инвентарь (Лут)
     */
    async addLoot(characterId, lootData) {
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
