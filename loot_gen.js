const DB = require('./item_db');

function rand(min, max) { 
    return Math.floor(Math.random() * (max - min + 1)) + min; 
}
function randArr(arr) { 
    return arr[Math.floor(Math.random() * arr.length)]; 
}

function generateLoot(maxZoneTier = 5) {
    const types = ["weapon", "armor", "jewel", "offhand", "potion"];
    const type = randArr(types);
    
    // Определение тира предмета (от 1 до 5)
    let rollTier = rand(1, 100);
    let t = 1;
    if (rollTier > 40) t = 2;
    if (rollTier > 75) t = 3;
    if (rollTier > 90) t = 4;
    if (rollTier > 96) t = 5;
    
    // Ограничиваем тир уровнем текущей локации
    if (t > maxZoneTier) t = maxZoneTier;
    
    const baseName = randArr(DB[`type_${type}`]);
    const matName = type === "potion" ? `Ур. ${t}` : randArr(DB.mat[t]);
    const fullName = `${baseName} (${matName})`;
    const mult = DB.mult[t];

    let item = {
        name: fullName,
        type: type,
        tier: t,
        price: rand(DB.cost_min[t], DB.cost_max[t]),
        stats: {}
    };

    // Базовые характеристики по типу
    if (type === "weapon") item.stats.dmg = rand(DB.base_weapon.min, DB.base_weapon.max) * mult;
    if (type === "armor") item.stats.hp = rand(DB.base_armor.min, DB.base_armor.max) * mult;
    
    if (type === "offhand") {
        item.stats.hp = rand(DB.base_offhand.min, DB.base_offhand.max) * mult;
        if (baseName === "Стилет") item.stats.crit = rand(5, 15);
        if (baseName === "Щит" || baseName === "Тарч") item.stats.dodge = rand(3, 10);
    }
    
    if (type === "potion") {
        item.stats.dmg = rand(DB.potion_buff.min, DB.potion_buff.max) * mult;
        item.stats.hpDur = rand(DB.potion_dur.min, DB.potion_dur.max);
    }

    // Редкость (количество доп. свойств от 0 до 4)
    let rarityStars = 0;
    if (type !== "potion") {
        let rl = rand(1, 100);
        if (rl > 60) rarityStars = 1;
        if (rl > 85) rarityStars = 2;
        if (rl > 96) rarityStars = 3;
        if (rl === 100) rarityStars = 4;
    }
    
    const rarityData = [
        { name: "Common", color: "#808080", marker: '⚪', mult: 1.0 },
        { name: "Uncommon", color: "#1eff00", marker: '🟢', mult: 1.1 },
        { name: "Rare", color: "#0070dd", marker: '🔵', mult: 1.25 },
        { name: "Epic", color: "#a335ee", marker: '🟣', mult: 1.4 },
        { name: "Legendary", color: "#ff8000", marker: '🟡', mult: 1.6 }
    ];

    const rarity = rarityData[rarityStars];
    item.rarity_name = rarity.name;
    item.rarity_color = rarity.color;
    item.rarity_marker = rarity.marker;

    // Применяем множитель редкости к основным статам
    if (item.stats.dmg) item.stats.dmg = Math.floor(item.stats.dmg * rarity.mult);
    if (item.stats.hp) item.stats.hp = Math.floor(item.stats.hp * rarity.mult);

    // Увеличение цены от редкости
    item.price = Math.floor(item.price * (rarityStars + 1) * rarity.mult);

    // Добавление магических свойств
    if (rarityStars >= 1) {
        let r1 = rand(1, 3);
        if (r1 === 1) item.stats.crit = (item.stats.crit || 0) + Math.floor(rand(DB.fx_crit.min, DB.fx_crit.max) * mult * rarity.mult);
        if (r1 === 2) item.stats.vamp = (item.stats.vamp || 0) + Math.floor(rand(DB.fx_vamp.min, DB.fx_vamp.max) * mult * rarity.mult);
        if (r1 === 3) item.stats.dodge = (item.stats.dodge || 0) + Math.floor(rand(DB.fx_dodge.min, DB.fx_dodge.max) * mult * rarity.mult);
    }
    if (rarityStars >= 2) item.stats.trade = Math.floor(rand(DB.fx_trade.min, DB.fx_trade.max) * rarity.mult);

    // Шанс проклятия (10%)
    if (type !== "potion" && rand(1, 100) <= 10) {
        let cR = rand(1, 2);
        if (cR === 1) item.stats.hp_drain = DB.curses.drain;
        if (cR === 2) item.stats.trade = DB.curses.trade;
        item.price = Math.round(item.price * 0.5);
        item.cursed = true;
    }

    return item;
}

module.exports = { generateLoot };
