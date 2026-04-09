const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// Исправление кодировки для Windows (кракозябры в консоли)
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001');
    } catch (e) {
        // Игнорируем ошибки, если chcp недоступен
    }
}

const db = require('./database');
const CombatEngine = require('./combat');
const CommandHandler = require('./commandHandler');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/ping', (req, res) => res.json({ status: 'ok', message: 'Server is alive' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Хранилище последних 50 сообщений чата
const chatHistory = [];

// Функция рассылки (теперь поддерживает фильтрацию по комнате)
function broadcast(jsonData, room = null) {
    const message = JSON.stringify(jsonData);
    
    // Сохраняем сообщение в историю, если это сообщение чата
    if (jsonData.event === 'chat_message_received') {
        chatHistory.push(jsonData);
        if (chatHistory.length > 50) chatHistory.shift();
    }

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Если комната не указана — шлем всем. Если указана — только тем, кто в ней.
            if (room === null || client.room === room) {
                client.send(message);
            }
        }
    });
}

// Функция отправки конкретному клиенту
function sendToSpecificClient(characterId, jsonData) {
    const message = JSON.stringify(jsonData);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client.characterId === characterId) {
            client.send(message);
            break;
        }
    }
}

// Инициализация боевого движка и обработчика команд
const combat = new CombatEngine(broadcast, sendToSpecificClient, wss.clients);
const commandHandler = new CommandHandler(broadcast, sendToSpecificClient, combat);

/**
 * Общая логика успешного входа (для login и create_character)
 */
async function handleLoginSuccess(ws, character) {
    ws.characterId = character.id;
    ws.username = character.username;
    ws.body_state = character.body_state || 'human';
    
    // Инициализация комнаты и позиции для социальных взаимодействий
    ws.room = 'global';
    ws.x = 800;
    ws.y = 450;
    
    // Если был таймер на удаление боя для этого игрока — отменяем его
    if (disconnectTimers.has(ws.characterId)) {
        logger.info({ username: ws.username }, 'Reconnected session, canceling battle cleanup');
        clearTimeout(disconnectTimers.get(ws.characterId));
        disconnectTimers.delete(ws.characterId);
    }

    logger.info({ username: character.username, charId: character.id }, 'User successfully authenticated');

    const effective = await db.getEffectiveStats(ws.characterId);
    
    ws.send(JSON.stringify({
        event: 'login_success',
        data: {
            username: effective.username,
            stamina: effective.stamina,
            hp: effective.effective_hp,
            max_hp: effective.effective_max_hp,
            level: effective.level,
            exp: effective.exp || 0,
            gold: effective.gold || 0,
            body_state: effective.body_state,
            race: effective.race,
            appearance: effective.appearance
        }
    }));

    // ОТПРАВКА ИСТОРИИ ЧАТА ПРИ ВХОДЕ
    if (chatHistory.length > 0) {
        chatHistory.forEach(msg => {
            ws.send(JSON.stringify(msg));
        });
    }

    // Если игрок в бою — принудительно отправляем ему стейт боя для ресинхронизации
    if (combat.activeBattles.has(ws.characterId)) {
        logger.info({ username: ws.username, charId: ws.characterId }, 'Active battle detected during login. Forcing resync.');
        // Небольшая задержка, чтобы клиент успел инициализировать сцены после login_success
        setTimeout(() => {
            combat.sendToClientFn(ws.characterId, { event: "chat_broadcast", sender: "Бой", type: "system", text: "Переподключение к сражению..." });
            combat.sendBattleState(ws.characterId);
        }, 1000);
    } else {
        // Уведомляем клиент, что боя нет
        ws.send(JSON.stringify({ event: 'combat_ended', reason: 'no_battle' }));
    }
}

// Хранилище таймеров на удаление боя при дисконнекте
const disconnectTimers = new Map();

wss.on('connection', (ws) => {
    logger.info('Client connected');

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            
            // --- HEARTBEAT ---
            if (parsed.action === 'heartbeat_ping') {
                ws.send(JSON.stringify({ event: 'heartbeat_pong' }));
                return;
            }
            
            // --- ЛОГИКА АВТОРИЗАЦИИ ---
            if (parsed.action === 'login' && parsed.username) {
                const character = await db.getCharacterByUsername(parsed.username);
                
                if (!character) {
                    logger.info({ username: parsed.username }, 'Login failed: Character not found');
                    ws.send(JSON.stringify({ event: 'login_failed', reason: 'not_found' }));
                    return;
                }

                await handleLoginSuccess(ws, character);
                return;
            }

            // --- СОЗДАНИЕ ПЕРСОНАЖА ---
            if (parsed.action === 'create_character' && parsed.username) {
                const existing = await db.getCharacterByUsername(parsed.username);
                if (existing) {
                    ws.send(JSON.stringify({ event: 'creation_failed', reason: 'name_taken' }));
                    return;
                }

                const newChar = await db.createCharacter(
                    parsed.username, 
                    parsed.race || 'Nord', 
                    parsed.appearance || {},
                    parsed.stats || {}
                );

                await handleLoginSuccess(ws, newChar);
                return;
            }

            // --- ЛОГИКА КОМНАТ И ПЕРЕМЕЩЕНИЯ ---
            if (parsed.action === 'join_room' && parsed.room) {
                ws.room = parsed.room;
                logger.info({ username: ws.username, room: ws.room }, 'Player joined room');
                
                // Получаем актуальные характеристики игрока
                const stats = await db.getEffectiveStats(ws.characterId);
                const playerInfo = {
                    username: ws.username,
                    x: ws.x,
                    y: ws.y,
                    body_state: ws.body_state || 'human',
                    level: stats.level,
                    hp: stats.effective_hp,
                    max_hp: stats.effective_max_hp,
                    exp: stats.exp,
                    stamina: stats.stamina,
                    gold: stats.gold,
                    damage: stats.effective_damage,
                    dodge: stats.effective_dodge
                };

                // Оповещаем остальных в комнате о входе игрока
                broadcast({
                    event: 'player_joined',
                    ...playerInfo
                }, ws.room);

                // Собираем список игроков + NPC комнаты
                const playersInRoom = [];
                
                // --- СТАТИЧЕСКИЕ NPC ДЛЯ ТАВЕРНЫ ---
                if (ws.room === 'tavern') {
                    playersInRoom.push({
                        username: "Бармен Эрик",
                        is_npc: true,
                        x: 420,  // Координаты за стойкой
                        y: 350,
                        body_state: 'human',
                        level: 50,
                        hp: 1000,
                        max_hp: 1000,
                        gold: 9999
                    });
                }

                for (const client of wss.clients) {
                    if (client.readyState === WebSocket.OPEN && client.room === ws.room) {
                        const cStats = await db.getEffectiveStats(client.characterId);
                        playersInRoom.push({
                            username: client.username,
                            x: client.x,
                            y: client.y,
                            body_state: client.body_state || 'human',
                            level: cStats.level,
                            hp: cStats.effective_hp,
                            max_hp: cStats.effective_max_hp,
                            exp: cStats.exp,
                            stamina: cStats.stamina,
                            gold: cStats.gold,
                            damage: cStats.effective_damage,
                            dodge: cStats.effective_dodge
                        });
                    }
                }
                ws.send(JSON.stringify({ event: 'players_list', players: playersInRoom }));
                return;
            }

            if (parsed.action === 'move' && parsed.x !== undefined && parsed.y !== undefined) {
                ws.x = parsed.x;
                ws.y = parsed.y;
                
                // Рассылаем всем в комнате (включая себя для подтверждения)
                broadcast({
                    event: 'player_moved',
                    username: ws.username,
                    x: ws.x,
                    y: ws.y
                }, ws.room);
                return;
            }
            
            // --- ЛОГИКА КОМАНД ---
            await commandHandler.handle(ws, parsed);

        } catch (error) {
            logger.error({ error: error.message }, 'Error processing packet');
            ws.send(JSON.stringify({ event: 'error', message: 'Внутренняя ошибка сервера' }));
        }
    });

    ws.on('close', () => {
        if (ws.characterId) {
            logger.info({ username: ws.username }, 'Client disconnected. Waiting 120s before cleaning up.');
            
            // Если игрок был в комнате — уведомляем остальных
            if (ws.room) {
                broadcast({ event: 'player_left', username: ws.username }, ws.room);
            }
            
            // Не удаляем бой мгновенно, даем шанс на реконнект (Grace Period: 120с)
            const timer = setTimeout(() => {
                logger.info({ username: ws.username }, 'Grace period expired, cleaning up battle');
                combat.cleanupBattle(ws.characterId);
                disconnectTimers.delete(ws.characterId);
            }, 120000); 

            disconnectTimers.set(ws.characterId, timer);
        } else {
            logger.info('Anonymous client disconnected');
        }
    });
});

// --- ГЛОБАЛЬНАЯ РЕГЕНЕРАЦИЯ (Heartbeat) ---
// Храним последнее отправленное состояние для оптимизации трафика (Throttling)
const lastSentStats = new Map();

setInterval(async () => {
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client.characterId) {
            if (combat.activeBattles.has(client.characterId)) continue;

            try {
                const effective = await db.getEffectiveStats(client.characterId);
                if (!effective) continue;

                const maxHp = effective.effective_max_hp || 100;
                const maxStamina = effective.effective_max_stamina || 100;
                const currentHp = effective.hp || 0;
                const currentStamina = effective.stamina || 0;
                const isSitting = (client.body_state === 'sitting');

                // БАЗОВАЯ РЕГЕНЕРАЦИЯ (х3 если сидишь)
                let regenHp = Math.max(1, Math.floor(maxHp * 0.05));
                let regenStam = 10;
                
                if (isSitting) {
                    regenHp *= 3;
                    regenStam *= 3;
                    logger.info({ username: effective.username }, 'Resting bonus applied (Sitting)');
                }

                const newHp = Math.min(maxHp, currentHp + regenHp);
                const newStamina = Math.min(maxStamina, currentStamina + regenStam);
                
                // ПРОПУСКАЕМ ОТПРАВКУ, ЕСЛИ НИЧЕГО НЕ ИЗМЕНИЛОСЬ (Throttling)
                const last = lastSentStats.get(client.characterId) || {};
                const hasChanged = newHp !== last.hp || newStamina !== last.stamina;

                if (!hasChanged) continue;

                // Обновляем в БД только если значения ВЫРОСЛИ
                if (newHp > currentHp || newStamina > currentStamina) {
                    await db.updateCharacter(client.characterId, { hp: newHp, stamina: newStamina });
                }
                
                // Сохраняем стейт в кэше трафика
                lastSentStats.set(client.characterId, { hp: newHp, stamina: newStamina });

                sendToSpecificClient(client.characterId, {
                    event: 'stat_update',
                    username: effective.username,
                    hp: newHp,
                    max_hp: maxHp,
                    stamina: newStamina,
                    effective_max_stamina: maxStamina
                });
            } catch (err) {
                logger.error({ charId: client.characterId, error: err }, 'Regen error');
            }
        }
    }
}, 5000);

// --- АТМОСФЕРА ---

// --- АТМОСФЕРА ТАВЕРНЫ ---
const tavernAtmosphere = [
    "В очаге уютно потрескивают дрова, наполняя зал теплом.",
    "Эрик лениво протирает стойку старым полотенцем.",
    "Где-то в углу таверны доносится приглушенный смех.",
    "За окном на мгновение завывает холодный скайримский ветер.",
    "Запах жареной оленины разносится по всей таверне.",
    "Кто-то из посетителей уронил монету, послышался звон."
];

setInterval(() => {
    const msg = tavernAtmosphere[Math.floor(Math.random() * tavernAtmosphere.length)];
    broadcast({
        event: 'chat_broadcast',
        sender: 'Окружение',
        text: msg,
        type: 'system'
    }, 'tavern');
}, 120000); // Каждые 2 минуты

server.listen(PORT, async () => {
    logger.info('========================================');
    logger.info(`🚀 Сервер Skyrim RPG запущен! ПОРТ: ${PORT}`);
    logger.info('⚔️ Модульная архитектура + Логирование активированы.');
    logger.info('========================================');
    
    // ПРИНУДИТЕЛЬНАЯ ПРОВЕРКА БД ПРИ СТАРТЕ
    await db.checkMigrations();
});
