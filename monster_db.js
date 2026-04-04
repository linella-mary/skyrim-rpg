const DB = {
  zones: {
    1: {
      name: "Белый Берег",
      icon: "🌲",
      recLvl: 1,
      monsters: ["Волк", "Разбойник", "Скелет", "Морозный Паук", "Медведь", "Злокрыс", "Грязевой краб", "Бандит", "Изгой"],
      hp: { min: 30, max: 60 },
      dmg: { min: 3, max: 8 },
      dodge: 5,
      exp: { min: 10, max: 25 },
      gold: { min: 5, max: 20 },
      loot_chance: 35,
      tier_max: 2
    },
    2: {
      name: "Вьюжный Перевал",
      icon: "⛰️",
      recLvl: 3,
      monsters: ["Драугр", "Тролль", "Ледяной Атронах", "Саблезуб", "Ходячий Скелет-Маг", "Снежный тролль", "Ворожея", "Ледяное привидение", "Спригган", "Пещерный медведь"],
      hp: { min: 70, max: 140 },
      dmg: { min: 8, max: 18 },
      dodge: 10,
      exp: { min: 30, max: 70 },
      gold: { min: 20, max: 55 },
      loot_chance: 50,
      tier_max: 3
    },
    3: {
      name: "Чёрный Предел",
      icon: "🔥",
      recLvl: 7,
      monsters: ["Двемерский Центурион", "Дремора", "Лич", "Древний Дракон", "Владыка Вампиров", "Фалмер", "Корус-жнец", "Мать дымка", "Двемерская сфера", "Драугр-военачальник", "Фалмер-наёмник", "Фалмер-теневик", "Фалмер-шаман", "Искатель"],
      hp: { min: 150, max: 280 },
      dmg: { min: 18, max: 35 },
      dodge: 15,
      exp: { min: 80, max: 180 },
      gold: { min: 60, max: 150 },
      loot_chance: 65,
      tier_max: 5
    }
  },
  boss: {
    chance: 8,
    hp_mult: 2,
    dmg_mult: 1.5,
    exp_mult: 3,
    gold_mult: 3,
    loot_chance: 100,
    tier_bonus: 1,
    prefixes: ["Древний", "Проклятый", "Легендарный", "Зачарованный", "Бессмертный"]
  }
};

const ABILITY_REGISTRY = {
    'attack': { name: 'Атака', mult: 1.0, type: 'hit' },
    'heavy_hit': { name: 'Мощный удар', mult: 1.5, type: 'hit', isCrit: true },
    'bite': { name: 'Укус', mult: 1.2, type: 'hit' },
    'heal': { name: 'Лечение', mult: 0.25, type: 'heal' },
    'fire_ball': { name: 'Огненный шар', mult: 1.4, type: 'hit' },
    'frost_strike': { name: 'Ледяной удар', mult: 1.1, type: 'hit' },
    'drain': { name: 'Похищение сил', mult: 0.8, type: 'drain' }
};

const MONSTER_ARCHETYPES = {
    'Волк': ['attack', 'bite'],
    'Скелет': ['attack', 'heavy_hit'],
    'Медведь': ['attack', 'heavy_hit', 'bite'],
    'Ходячий Скелет-Маг': ['fire_ball', 'frost_strike', 'heal'],
    'Драугр': ['attack', 'heavy_hit'],
    'Ледяной Атронах': ['frost_strike', 'heavy_hit'],
    'Мать дымка': ['drain', 'heal', 'frost_strike'],
    'Лич': ['fire_ball', 'drain', 'heal'],
    'Разбойник': ['attack', 'heavy_hit']
};

function spawnMonster(zoneId = 1) {
    const zone = DB.zones[zoneId];
    if (!zone) return null;

    const isBoss = (Math.random() * 100) <= DB.boss.chance;
    
    // Бросок базовых статов
    const rawHp = Math.floor(Math.random() * (zone.hp.max - zone.hp.min + 1)) + zone.hp.min;
    const rawDmgMin = zone.dmg.min;
    const rawDmgMax = zone.dmg.max;
    const rawExp = Math.floor(Math.random() * (zone.exp.max - zone.exp.min + 1)) + zone.exp.min;
    const rawGold = Math.floor(Math.random() * (zone.gold.max - zone.gold.min + 1)) + zone.gold.min;

    const baseName = zone.monsters[Math.floor(Math.random() * zone.monsters.length)];
    
    // Привязка способностей
    const archetypeAbilities = MONSTER_ARCHETYPES[baseName] || ['attack'];
    const monsterAbilities = archetypeAbilities.map(id => ({ id, ...ABILITY_REGISTRY[id] }));

    let monster = {
        name: baseName,
        isBoss: false,
        hp: rawHp,
        maxHp: rawHp,
        damageMin: rawDmgMin,
        damageMax: rawDmgMax,
        dodge: zone.dodge,
        exp: rawExp,
        gold: rawGold,
        loot_chance: zone.loot_chance,
        loot_tier: zone.tier_max,
        abilities: monsterAbilities
    };

    if (isBoss) {
        const pre = DB.boss.prefixes[Math.floor(Math.random() * DB.boss.prefixes.length)];
        monster.name = `${pre} ${baseName} 💀`;
        monster.isBoss = true;
        monster.hp = Math.floor(rawHp * DB.boss.hp_mult);
        monster.maxHp = monster.hp;
        monster.damageMin = Math.floor(rawDmgMin * DB.boss.dmg_mult);
        monster.damageMax = Math.floor(rawDmgMax * DB.boss.dmg_mult);
        monster.exp = Math.floor(rawExp * DB.boss.exp_mult);
        monster.gold = Math.floor(rawGold * DB.boss.gold_mult);
        monster.loot_chance = DB.boss.loot_chance;
        monster.loot_tier = Math.min(5, zone.tier_max + DB.boss.tier_bonus);
    }
    
    return monster;
}

module.exports = { spawnMonster };
