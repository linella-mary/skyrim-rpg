const { generateLoot } = require('./loot_gen');
const db = require('./database');
const logger = require('./logger');

class MerchantService {
    constructor() {
        this.stocks = new Map(); // characterId -> Array of items
    }

    /**
     * Генерирует ассортимент для конкретного игрока
     * Ограничение: только Common (0), Uncommon (1), Rare (2)
     */
    generateStock(characterId) {
        const stock = [];
        const count = 6;

        for (let i = 0; i < count; i++) {
            let item;
            let attempts = 0;
            
            // Пытаемся сгенерировать предмет нужной редкости (не выше Rare)
            do {
                item = generateLoot(3); // Ограничиваем тир до 3 для магазина
                attempts++;
            } while ((item.rarity_name === 'Epic' || item.rarity_name === 'Legendary') && attempts < 20);

            // Если все равно выпадает Epic/Legendary (шанс мал, но вдруг) — принудительно ставим Rare
            if (item.rarity_name === 'Epic' || item.rarity_name === 'Legendary') {
                item.rarity_name = 'Rare';
                item.rarity_color = '#0070dd';
            }

            stock.push(item);
        }

        this.stocks.set(characterId, stock);
        return stock;
    }

    getStock(characterId, type = "general") {
        const key = type === "bar" ? characterId + "_bar" : characterId;
        const DB = require('./item_db');
        
        // ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ БАРА (если состав изменился или статы пустые)
        if (type === "bar" && this.stocks.has(key)) {
            const current = this.stocks.get(key);
            const hasNonPotions = current.some(i => i.type !== "potion");
            
            // Проверяем, есть ли у зелий реальные статы (кроме hpDur)
            // У старых зелий был только hpDur. У новых есть либо strength, либо constitution и т.д.
            const isOutdated = current.every(i => Object.keys(i.stats || {}).length <= 1);
            
            const expectedCount = (DB.type_potion || []).length;
            
            if (hasNonPotions || current.length !== expectedCount || isOutdated) {
                this.stocks.delete(key);
                logger.info({ characterId, isOutdated }, 'Forcing Bar stock refresh (outdated or invalid)');
            }
        }

        if (!this.stocks.has(key)) {
            return type === "bar" ? this.generateBarStock(characterId) : this.generateStock(characterId);
        }
        return this.stocks.get(key);
    }

    /**
     * Генерирует ассортимент только из зелий для бара
     */
    generateBarStock(characterId) {
        const DB = require('./item_db');
        const stock = [];
        const potions = DB.type_potion;
        
        for (const name of potions) {
            const effect = DB.potion_effects[name];
            
            // Создаем объект зелья на основе базы
            const item = {
                name: name,
                type: "potion",
                tier: 1,
                price: 50, // Базовая цена в таверне
                stats: effect ? { [effect.stat]: effect.value, turns_left: effect.duration } : { turns_left: 10 },
                rarity_name: "Common",
                rarity_color: "#808080"
            };
            
            // Специальные цены/статы для элиток (перекрываем базовые)
            if (name.includes("Кровь")) { item.price = 150; item.tier = 3; item.rarity_name = "Uncommon"; item.rarity_color = "#1eff00"; }
            if (name.includes("Удачи")) { item.price = 200; item.tier = 2; item.rarity_name = "Rare"; item.rarity_color = "#0070dd"; }
            if (name.includes("Стойкости") || name.includes("Кожи")) { item.price = 120; item.tier = 2; }
            if (name.includes("Берсерка") || name.includes("Точности")) { item.price = 180; item.tier = 3; item.rarity_name = "Rare"; item.rarity_color = "#0070dd"; }
            if (name.includes("Отражения") || name.includes("Вампира")) { item.price = 250; item.tier = 3; item.rarity_name = "Legendary"; item.rarity_color = "#ff8000"; }
            
            stock.push(item);
        }
        
        const key = characterId + "_bar";
        this.stocks.set(key, stock);
        return stock;
    }

    /**
     * Покупка предмета
     */
    async buyItem(ws, itemIndex, shopType = "general") {
        const characterId = ws.characterId;
        const stock = this.getStock(characterId, shopType);

        if (itemIndex < 0 || itemIndex >= stock.length) {
            throw new Error('Предмет не найден на прилавке');
        }

        const item = stock[itemIndex];
        const character = await db.getCharacterById(characterId);

        if (character.gold < item.price) {
            throw new Error('Недостаточно золота для покупки');
        }

        // Транзакция
        await db.updateCharacter(characterId, { gold: character.gold - item.price });
        await db.addLoot(characterId, item);
        
        // ЛОГИРОВАНИЕ В БД (АУДИТ)
        await db.saveAuditLog(characterId, 'buy', { 
            item: item.name, 
            price: item.price,
            rarity: item.rarity_name
        });

        // Убираем предмет из стока (или оставляем, если это бесконечный запас, но тут уникальные)
        stock.splice(itemIndex, 1);
        
        logger.info({ username: ws.username, item: item.name }, 'Item bought from merchant');
        return { item, newGold: character.gold - item.price };
    }

    /**
     * Продажа предмета
     */
    async sellItem(ws, inventoryItemId) {
        const characterId = ws.characterId;
        const sellId = inventoryItemId;
        const inventoryItem = await db.getItem(sellId, characterId);

        if (!inventoryItem) {
            throw new Error('Предмет не найден в вашем инвентаре');
        }

        if (inventoryItem.is_equipped) {
            throw new Error('Сначала снимите предмет, чтобы продать его');
        }

        const effective = await db.getEffectiveStats(characterId);
        const tradeBonus = (effective.effective_trade || 0) / 100;
        const goldMult = effective.gold_find_mult || 1.0;
        
        // Базовая цена выкупа 50% + бонус за навык торговли (каждый 1 пункт = +0.5%)
        // Множитель золота (например Имперец) увеличивает итоговую сумму
        const sellMultiplier = Math.min(0.95, (0.5 + tradeBonus / 200) * goldMult);
        const sellPrice = Math.floor((inventoryItem.item_data.price || 0) * sellMultiplier);
        
        const character = await db.getCharacterById(characterId);

        // Транзакция
        await db.updateCharacter(characterId, { gold: character.gold + sellPrice });
        await db.deleteItem(sellId);

        // ЛОГИРОВАНИЕ В БД (АУДИТ)
        await db.saveAuditLog(characterId, 'sell', { 
            item: inventoryItem.item_data.name, 
            price: sellPrice 
        });

        logger.info({ username: ws.username, item: inventoryItem.item_data.name, sellPrice }, 'Item sold to merchant');
        return { price: sellPrice, newGold: character.gold + sellPrice };
    }
}

module.exports = new MerchantService();
