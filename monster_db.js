const { ZONES } = require('./zones_db');

const DB = {
  zones: ZONES,
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
    'attack':       { name: 'Атака',            mult: 1.0, type: 'hit'  },
    'heavy_hit':    { name: 'Мощный удар',       mult: 1.5, type: 'hit', isCrit: true },
    'bite':         { name: 'Укус',              mult: 1.2, type: 'hit'  },
    'heal':         { name: 'Лечение',           mult: 0.25,type: 'heal' },
    'fire_ball':    { name: 'Огненный шар',      mult: 1.4, type: 'hit'  },
    'frost_strike': { name: 'Ледяной удар',      mult: 1.1, type: 'hit'  },
    'drain':        { name: 'Похищение сил',     mult: 0.8, type: 'drain'},
    'summon':       { name: 'Призыв миньона',    mult: 0.0, type: 'summon'},
    'roar':         { name: 'Устрашающий рык',   mult: 0.5, type: 'debuff'}
};

const MONSTER_ARCHETYPES = {
    'Волк':                   ['attack', 'bite'],
    'Скелет':                 ['attack', 'heavy_hit'],
    'Медведь':                ['attack', 'heavy_hit', 'bite'],
    'Ходячий Скелет-Маг':    ['fire_ball', 'frost_strike', 'heal'],
    'Драугр':                 ['attack', 'heavy_hit'],
    'Ледяной Атронах':        ['frost_strike', 'heavy_hit'],
    'Мать дымка':             ['drain', 'heal', 'frost_strike'],
    'Лич':                    ['fire_ball', 'drain', 'heal'],
    'Разбойник':              ['attack', 'heavy_hit'],
    'Тролль':                 ['attack', 'heavy_hit', 'roar'],
    'Снежный тролль':         ['attack', 'heavy_hit', 'frost_strike'],
    'Саблезуб':               ['attack', 'bite', 'roar'],
    'Пещерный медведь':       ['attack', 'heavy_hit', 'bite'],
    'Гигант':                 ['heavy_hit', 'roar'],
    'Дремора':                ['attack', 'fire_ball', 'heavy_hit'],
    'Фалмер':                 ['attack', 'bite', 'frost_strike'],
    'Фалмер-шаман':           ['frost_strike', 'heal', 'drain'],
    'Двемерский Центурион':   ['heavy_hit', 'roar', 'fire_ball'],
    'Двемерская сфера':       ['attack', 'frost_strike'],
    'Драконий Жрец':          ['fire_ball', 'drain', 'heal', 'summon'],
    'Древний Дракон':         ['fire_ball', 'heavy_hit', 'roar'],
    'Владыка Вампиров':       ['drain', 'heal', 'attack'],
    'Спригган':               ['attack', 'heal', 'summon'],
    'Ворожея':                ['frost_strike', 'fire_ball', 'drain'],
    'Некромант':              ['drain', 'heal', 'summon'],
    'Форсворн':               ['attack', 'heavy_hit'],
    'Болотный мертвец':       ['attack', 'drain'],
    'Агент Талмора':          ['attack', 'heavy_hit'],
    'Корус-жнец':             ['drain', 'attack', 'frost_strike'],
    'Искатель':               ['drain', 'frost_strike'],
    'Мамонт':                 ['heavy_hit', 'roar'],
    'Лось':                   ['attack', 'roar'],
    'Кролик':                 ['attack'],
    'Злокрыс':                ['attack', 'bite'],
    'Грязевой краб':          ['attack'],
    'Бандит':                 ['attack', 'heavy_hit'],
    'Изгой':                  ['attack', 'heavy_hit'],
    'Морозный Паук':          ['bite', 'frost_strike'],
    'Ледяное привидение':     ['frost_strike', 'drain'],
    'Драугр-военачальник':    ['attack', 'heavy_hit', 'roar'],
    'Фалмер-наёмник':         ['attack', 'frost_strike'],
    'Фалмер-теневик':         ['attack', 'bite'],
};

function spawnMonster(zoneId = 1) {
    const zone = DB.zones[zoneId];
    if (!zone) return null;

    const isBoss = (Math.random() * 100) <= DB.boss.chance;

    const rawHp    = Math.floor(Math.random() * (zone.hp.max  - zone.hp.min  + 1)) + zone.hp.min;
    const rawExp   = Math.floor(Math.random() * (zone.exp.max - zone.exp.min + 1)) + zone.exp.min;
    const rawGold  = Math.floor(Math.random() * (zone.gold.max- zone.gold.min+ 1)) + zone.gold.min;
    const baseName = zone.monsters[Math.floor(Math.random() * zone.monsters.length)];

    const archetypeAbilities = MONSTER_ARCHETYPES[baseName] || ['attack'];
    const monsterAbilities   = archetypeAbilities.map(id => ({ id, ...ABILITY_REGISTRY[id] }));

    let monster = {
        name: baseName,
        isBoss: false,
        hp: rawHp,
        maxHp: rawHp,
        damageMin: zone.dmg.min,
        damageMax: zone.dmg.max,
        dodge: zone.dodge,
        exp: rawExp,
        gold: rawGold,
        loot_chance: zone.loot_chance,
        loot_tier: zone.tier_max,
        abilities: monsterAbilities
    };

    if (isBoss) {
        const pre = DB.boss.prefixes[Math.floor(Math.random() * DB.boss.prefixes.length)];
        monster.name     = `${pre} ${baseName} 💀`;
        monster.isBoss   = true;
        monster.hp       = Math.floor(rawHp * DB.boss.hp_mult);
        monster.maxHp    = monster.hp;
        monster.damageMin= Math.floor(zone.dmg.min * DB.boss.dmg_mult);
        monster.damageMax= Math.floor(zone.dmg.max * DB.boss.dmg_mult);
        monster.exp      = Math.floor(rawExp  * DB.boss.exp_mult);
        monster.gold     = Math.floor(rawGold * DB.boss.gold_mult);
        monster.loot_chance = DB.boss.loot_chance;
        monster.loot_tier   = Math.min(5, zone.tier_max + DB.boss.tier_bonus);
    }

    return monster;
}

module.exports = { spawnMonster, ZONES: DB.zones };
