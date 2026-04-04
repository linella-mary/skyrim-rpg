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

// Функция рассылки всем
function broadcast(jsonData) {
    const message = JSON.stringify(jsonData);
    
    // Сохраняем сообщение в историю, если это сообщение чата
    if (jsonData.event === 'chat_message_received') {
        chatHistory.push(jsonData);
        if (chatHistory.length > 50) chatHistory.shift();
    }

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
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
const combat = new CombatEngine(broadcast, sendToSpecificClient);
const commandHandler = new CommandHandler(broadcast, sendToSpecificClient, combat);

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
                const character = await db.getOrCreateCharacter(parsed.username);

                ws.characterId = character.id;
                ws.username = character.username;
                
                // Если был таймер на удаление боя для этого игрока — отменяем его
                if (disconnectTimers.has(ws.characterId)) {
                    logger.info({ username: ws.username }, 'Reconnected session, canceling battle cleanup');
                    clearTimeout(disconnectTimers.get(ws.characterId));
                    disconnectTimers.delete(ws.characterId);
                }

                logger.info({ username: character.username, charId: character.id }, 'User logged in');

                const effective = await db.getEffectiveStats(ws.characterId);
                
                ws.send(JSON.stringify({
                    event: 'login_success',
                    data: {
                        username: effective.username,
                        stamina: effective.stamina,
                        hp: effective.effective_hp, // Используем итоговое HP
                        max_hp: effective.effective_max_hp,
                        level: effective.level,
                        exp: effective.exp || 0,
                        gold: effective.gold || 0,
                        body_state: effective.body_state
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
                    combat.sendBattleState(ws.characterId);
                } else {
                    logger.info({ username: ws.username }, 'No active battle detected at login.');
                }
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
            logger.info({ username: ws.username }, 'Client disconnected. Waiting 60s before cleaning up.');
            
            // Не удаляем бой мгновенно, даем шанс на реконнект (Grace Period)
            const timer = setTimeout(() => {
                logger.info({ username: ws.username }, 'Grace period expired, cleaning up battle');
                combat.cleanupBattle(ws.characterId);
                disconnectTimers.delete(ws.characterId);
            }, 60000); 

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
                const char = await db.getCharacterById(client.characterId);
                if (!char) continue;

                const maxHp = char.max_hp || 100;
                const currentHp = char.hp || 0;
                const currentStamina = char.stamina || 0;

                const regenHp = Math.max(1, Math.floor(maxHp * 0.05));
                const regenStam = 10;

                const newHp = Math.min(maxHp, currentHp + regenHp);
                const newStamina = Math.min(100, currentStamina + regenStam);
                
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
                    username: char.username,
                    hp: newHp,
                    stamina: newStamina
                });
            } catch (err) {
                logger.error({ charId: client.characterId, error: err }, 'Regen error');
            }
        }
    }
}, 5000);

server.listen(PORT, async () => {
    logger.info('========================================');
    logger.info(`🚀 Сервер Skyrim RPG запущен! ПОРТ: ${PORT}`);
    logger.info('⚔️ Модульная архитектура + Логирование активированы.');
    logger.info('========================================');
    
    // ПРИНУДИТЕЛЬНАЯ ПРОВЕРКА БД ПРИ СТАРТЕ
    await db.checkMigrations();
});
