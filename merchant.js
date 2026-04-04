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
            } while (item.rarity_name === 'Epic' || item.rarity_name === 'Legendary' && attempts < 20);

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

    getStock(characterId) {
        if (!this.stocks.has(characterId)) {
            return this.generateStock(characterId);
        }
        return this.stocks.get(characterId);
    }

    /**
     * Покупка предмета
     */
    async buyItem(ws, itemIndex) {
        const characterId = ws.characterId;
        const stock = this.getStock(characterId);

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
        const tradeBonus = (effective.bonusTrade || 0) / 100;
        
        // Базовая цена выкупа 50% + бонус за навык торговли (каждый 1 стат = +1%)
        const sellMultiplier = Math.min(1.0, 0.5 + tradeBonus);
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
