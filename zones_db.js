/**
 * zones_db.js — Единая база данных зон Скайрима
 *
 * Координаты соответствуют сетке карты A-J (X) × 1-10 (Y)
 * Tier 1 (зелёный) — уровни 1-4
 * Tier 2 (жёлтый) — уровни 4-7
 * Tier 3 (красный) — уровни 7+
 */

const ZONES = {
  1: {
    id: 1,
    name: "Вайтран",
    fullName: "Вайтран (Whiterun — равнины)",
    icon: "🌾",
    color: "#4CAF50",      // зелёный — Tier 1
    tier: 1,
    recLvl: 1,
    minLvl: 1,
    coordinates: "D5-G7",  // центр карты
    cities: [
      { name: "Вайтран", coord: "F6", icon: "🏰" },
      { name: "Айварстед", coord: "D6", icon: "🏘️" },
      { name: "Роривкстед", coord: "D7", icon: "🏘️" }
    ],
    monsters: ["Волк", "Разбойник", "Скелет", "Морозный Паук", "Медведь", "Злокрыс", "Грязевой краб", "Бандит", "Кролик", "Лось"],
    hp:   { min: 25, max: 55 },
    dmg:  { min: 3,  max: 7  },
    dodge: 5,
    exp:  { min: 10, max: 22 },
    gold: { min: 4,  max: 18 },
    loot_chance: 30,
    tier_max: 2,
    description: "Центральные равнины. Идеально для начинающих путешественников."
  },

  2: {
    id: 2,
    name: "Хьялмарк",
    fullName: "Хьялмарк (Hjaalmarch — болота/тундра)",
    icon: "☣️",
    color: "#8BC34A",      // светло-зелёный — Tier 1-2
    tier: 1,
    recLvl: 2,
    minLvl: 1,
    coordinates: "C4-E5",
    cities: [
      { name: "Морфал", coord: "D4", icon: "🏘️" }
    ],
    monsters: ["Волк", "Разбойник", "Скелет", "Морозный Паук", "Медведь", "Злокрыс", "Грязевой краб", "Болотный мертвец", "Лось"],
    hp:   { min: 35, max: 65 },
    dmg:  { min: 4,  max: 9  },
    dodge: 7,
    exp:  { min: 14, max: 30 },
    gold: { min: 6,  max: 22 },
    loot_chance: 35,
    tier_max: 2,
    description: "Заболоченная тундра. Туманы и трясины скрывают опасных тварей."
  },

  3: {
    id: 3,
    name: "Хаафингар",
    fullName: "Хаафингар (Haafingar — горы/побережье)",
    icon: "🏰",
    color: "#FFC107",      // жёлтый — Tier 2
    tier: 2,
    recLvl: 3,
    minLvl: 2,
    coordinates: "B2-D3",
    cities: [
      { name: "Солитьюд", coord: "C3", icon: "🏰", hasTavern: true }
    ],
    monsters: ["Драугр", "Тролль", "Саблезуб", "Снежный тролль", "Пещерный медведь", "Ворожея", "Агент Талмора", "Некромант"],
    hp:   { min: 60, max: 120 },
    dmg:  { min: 7,  max: 16  },
    dodge: 10,
    exp:  { min: 28, max: 60 },
    gold: { min: 18, max: 50 },
    loot_chance: 45,
    tier_max: 3,
    description: "Горная столичная область. Стражники Солитьюда рядом, но за стенами — хаос."
  },

  4: {
    id: 4,
    name: "Белый Берег",
    fullName: "Белый Берег (The Pale — тундра/побережье)",
    icon: "🏔️",
    color: "#FFC107",
    tier: 2,
    recLvl: 3,
    minLvl: 2,
    coordinates: "F3-I5",
    cities: [
      { name: "Данстар", coord: "F3", icon: "🏘️" }
    ],
    monsters: ["Драугр", "Снежный тролль", "Ледяной Атронах", "Морозный Паук", "Пещерный медведь", "Саблезуб", "Изгой", "Бандит"],
    hp:   { min: 65, max: 130 },
    dmg:  { min: 8,  max: 17  },
    dodge: 10,
    exp:  { min: 30, max: 65 },
    gold: { min: 20, max: 52 },
    loot_chance: 45,
    tier_max: 3,
    description: "Суровая северная тундра. Ледяные твари и драугры бродят по курганам."
  },

  5: {
    id: 5,
    name: "Предел",
    fullName: "Предел (The Reach — скалы/форсворны)",
    icon: "🏔️",
    color: "#FF9800",      // оранжевый — Tier 2-3
    tier: 2,
    recLvl: 4,
    minLvl: 3,
    coordinates: "A5-C8",
    cities: [
      { name: "Маркарт", coord: "A6", icon: "🏰", hasTavern: true }
    ],
    monsters: ["Драугр", "Тролль", "Форсворн", "Гигант", "Мамонт", "Ледяной Атронах", "Спригган", "Пещерный медведь", "Ворожея"],
    hp:   { min: 80, max: 160 },
    dmg:  { min: 10, max: 22  },
    dodge: 12,
    exp:  { min: 40, max: 90 },
    gold: { min: 25, max: 65 },
    loot_chance: 50,
    tier_max: 3,
    description: "Дикие скалистые земли. Форсворны и звери охраняют каждый перевал."
  },

  6: {
    id: 6,
    name: "Истмарк",
    fullName: "Истмарк (Eastmarch — вулканическая тундра)",
    icon: "🌋",
    color: "#FF9800",
    tier: 2,
    recLvl: 4,
    minLvl: 3,
    coordinates: "H6-J8",
    cities: [
      { name: "Виндхельм", coord: "H3", icon: "🏰", hasTavern: true }
    ],
    monsters: ["Драугр", "Тролль", "Ледяной Атронах", "Ходячий Скелет-Маг", "Снежный тролль", "Изгой", "Гигант", "Мамонт", "Некромант"],
    hp:   { min: 90, max: 170 },
    dmg:  { min: 11, max: 23  },
    dodge: 12,
    exp:  { min: 45, max: 95 },
    gold: { min: 28, max: 70 },
    loot_chance: 50,
    tier_max: 3,
    description: "Зона гейзеров и горячих источников. Древние мертвецы бродят у кратеров."
  },

  7: {
    id: 7,
    name: "Рифт",
    fullName: "Рифт (The Rift — осенние леса/бандиты)",
    icon: "🍂",
    color: "#FF9800",
    tier: 2,
    recLvl: 4,
    minLvl: 3,
    coordinates: "H8-J10",
    cities: [
      { name: "Рифтен", coord: "J9", icon: "🏰", hasTavern: true }
    ],
    monsters: ["Драугр", "Тролль", "Снежный тролль", "Пещерный медведь", "Изгой", "Спригган", "Ворожея", "Некромант", "Агент Талмора"],
    hp:   { min: 85, max: 165 },
    dmg:  { min: 10, max: 22  },
    dodge: 12,
    exp:  { min: 42, max: 90 },
    gold: { min: 26, max: 68 },
    loot_chance: 50,
    tier_max: 3,
    description: "Осенние леса и гнилые болота. Воры и твари делят эти земли."
  },

  8: {
    id: 8,
    name: "Фолкрит",
    fullName: "Фолкрит (Falkreath — густые леса)",
    icon: "🌲",
    color: "#FF9800",
    tier: 2,
    recLvl: 3,
    minLvl: 2,
    coordinates: "C8-G10",
    cities: [
      { name: "Фолкрит", coord: "E9", icon: "🏘️" },
      { name: "Хелген", coord: "F8", icon: "⚔️" }
    ],
    monsters: ["Тролль", "Саблезуб", "Пещерный медведь", "Спригган", "Ворожея", "Снежный тролль", "Драугр", "Некромант"],
    hp:   { min: 70, max: 140 },
    dmg:  { min: 8,  max: 18  },
    dodge: 10,
    exp:  { min: 32, max: 70 },
    gold: { min: 20, max: 55 },
    loot_chance: 48,
    tier_max: 3,
    description: "Плотные леса на юге. Природа здесь опасна как никогда."
  },

  9: {
    id: 9,
    name: "Винтерхолд",
    fullName: "Винтерхолд (Winterhold — ледяная пустошь/Коллегия)",
    icon: "❄️",
    color: "#F44336",      // красный — Tier 3
    tier: 3,
    recLvl: 6,
    minLvl: 5,
    coordinates: "F2-J4",
    cities: [
      { name: "Винтерхолд", coord: "H3", icon: "🏰" }
    ],
    monsters: ["Двемерский Центурион", "Лич", "Фалмер", "Корус-жнец", "Двемерская сфера", "Драугр-военачальник", "Фалмер-наёмник", "Фалмер-теневик", "Фалмер-шаман", "Искатель", "Ледяное привидение"],
    hp:   { min: 150, max: 280 },
    dmg:  { min: 18, max: 35  },
    dodge: 15,
    exp:  { min: 80, max: 180 },
    gold: { min: 60, max: 150 },
    loot_chance: 65,
    tier_max: 5,
    description: "Замёрзшие руины. Только опытные воины возвращаются живыми."
  },

  10: {
    id: 10,
    name: "Глотка Мира",
    fullName: "Глотка Мира (Throat of the World — вершина)",
    icon: "🐉",
    color: "#9C27B0",      // фиолетовый — элитная зона
    tier: 3,
    recLvl: 8,
    minLvl: 7,
    coordinates: "F7-H8",
    cities: [],
    monsters: ["Двемерский Центурион", "Дремора", "Лич", "Древний Дракон", "Владыка Вампиров", "Корус-жнец", "Мать дымка", "Драугр-военачальник", "Фалмер-шаман", "Искатель", "Драконий Жрец"],
    hp:   { min: 220, max: 400 },
    dmg:  { min: 25, max: 50  },
    dodge: 20,
    exp:  { min: 150, max: 300 },
    gold: { min: 100, max: 250 },
    loot_chance: 80,
    tier_max: 5,
    description: "Вершина мира. Драконы и жрецы охраняют древние секреты."
  }
};

/**
 * Определить зону по координатам карты (строка типа "F6")
 * Возвращает объект зоны или null
 */
function getZoneByCoord(coord) {
  if (!coord || coord.length < 2) return null;

  const GRID_X = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const cx = GRID_X.indexOf(coord.charAt(0));
  const cy = parseInt(coord.substring(1));
  if (cx === -1 || isNaN(cy)) return null;

  for (const zoneId of Object.keys(ZONES)) {
    const zone = ZONES[zoneId];
    const range = zone.coordinates;

    // Поддержка формата "A1" (одна клетка) и "A1-B2" (диапазон)
    if (range.includes("-")) {
      const parts = range.split("-");
      const sx = GRID_X.indexOf(parts[0].charAt(0));
      const sy = parseInt(parts[0].substring(1));
      const ex = GRID_X.indexOf(parts[1].charAt(0));
      const ey = parseInt(parts[1].substring(1));

      const xMin = Math.min(sx, ex);
      const xMax = Math.max(sx, ex);
      const yMin = Math.min(sy, ey);
      const yMax = Math.max(sy, ey);

      if (cx >= xMin && cx <= xMax && cy >= yMin && cy <= yMax) {
        return zone;
      }
    } else {
      const px = GRID_X.indexOf(range.charAt(0));
      const py = parseInt(range.substring(1));
      if (cx === px && cy === py) return zone;
    }
  }

  return null; // Неизвестная территория (море, граница)
}

/**
 * Получить город в указанной клетке карты
 */
function getCityByCoord(coord) {
  for (const zone of Object.values(ZONES)) {
    for (const city of (zone.cities || [])) {
      if (city.coord === coord) return { ...city, zone };
    }
  }
  return null;
}

module.exports = { ZONES, getZoneByCoord, getCityByCoord };
