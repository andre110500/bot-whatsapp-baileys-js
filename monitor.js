// Monitor de vida del bot (app hermana bajo PM2).
//
// La instancia del bot escribe su heartbeat en runtime-data/.alive cada 10s.
// Este proceso, que NO se detiene cuando se detiene el bot, detecta que el
// heartbeat quedó viejo (>60s) y avisa por Telegram que el bot se apagó o se
// cayó. Cubre los casos que el propio bot no puede avisar:
//   - pm2 stop whatsapp-bot-baileys (el proceso muere sin chance de escribir)
//   - crash sin reinicio (se agotó max_restarts)
//
// En el primer chequeo no notifica: si el bot ya estaba caído cuando arrancó
// el monitor, no corresponde avisar.
require('./config/env');

const telegram = require('./telegram');
const { monitorStatus } = require('./src/heartbeat');
const logger = require('./logger');

const log = logger.child('monitor');

const POLL_MS = 15 * 1000;

let lastState = null;

function tick() {
    const status = monitorStatus();
    if (lastState === 'up' && status.state === 'down') {
        log.warn('monitor_bot_down', status);
        telegram.notifyShutdown('El proceso no responde (se apagó o se cayó).');
    }
    lastState = status.state;
}

tick();
setInterval(tick, POLL_MS);