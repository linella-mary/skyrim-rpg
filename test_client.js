/**
 * Скрипт для тестирования сервера Skyrim RPG (Native WebSocket)
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

async function testServer() {
    console.log(`[HTTP] Отправка GET-запроса (пинг) на ${SERVER_URL}/ping...`);
    const startTime = performance.now();

    try {
        const response = await fetch(`${SERVER_URL}/ping`);
        const endTime = performance.now();
        const pingTime = (endTime - startTime).toFixed(2);

        if (response.ok) {
            console.log(`[HTTP] Успешно! Статус: ${response.status} ${response.statusText}. Пинг: ${pingTime}ms`);
            connectWebSocket();
        } else {
            console.error(`[HTTP] Ошибка: Сервер вернул статус ${response.status}`);
        }
    } catch (error) {
        console.error("[HTTP] Ошибка подключения. Сервер выключен?");
        console.error(error.message);
    }
}

function connectWebSocket() {
    console.log(`[WS] Попытка установить WebSocket соединение с ${WS_URL}...`);
    
    // Подключаемся к серверу через нативный ws
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log(`✅ Соединение с сервером установлено`);
    });

    ws.on('close', () => {
        console.log(`❌ Связь потеряна (Client disconnected)`);
    });

    ws.on('error', (error) => {
        console.error(`❌ Ошибка подключения WebSocket: ${error.message}`);
    });
}

// Запускаем тест
testServer();
