// Heartbeat de vida del bot (runtime-data/.alive).
//
// En Windows PM2 mata el proceso con taskkill sin mandar señales, así que un
// handler de SIGINT/SIGTERM no alcanza para avisar el apagado. Solución:
//   - startHeartbeat(): el bot escribe su estado cada 10s.
//   - previousInstanceWasRunning(): un arranque nuevo detecta que la instancia
//     anterior estaba viva hace un momento (fue un reinicio) y avisa "apagado".
//   - markCleanStop(): el cierre ordenado (SIGINT en Linux) marca el archivo
//     para que la próxima instancia NO repita el aviso.
//   - monitorStatus(): lo usa monitor.js (app hermana) para avisar cuando el
//     bot se queda caído (pm2 stop / crash sin reinicio).
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const log = logger.child('heartbeat');

const ALIVE_DIR = path.join(__dirname, '..', 'runtime-data');
const ALIVE_FILE = path.join(ALIVE_DIR, '.alive');

// Ventana en la que una instancia anterior se considera "recién viva".
const RESTART_WINDOW_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 10 * 1000;

function readAlive() {
    try {
        if (!fs.existsSync(ALIVE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(ALIVE_FILE, 'utf8'));
        if (!parsed || typeof parsed.updatedAt !== 'number' || typeof parsed.pid !== 'number') return null;
        return parsed;
    } catch (error) {
        log.error('alive_read_error', { error: error.message });
        return null;
    }
}

function writeAlive(payload) {
    try {
        fs.mkdirSync(ALIVE_DIR, { recursive: true });
        const temporaryFile = `${ALIVE_FILE}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify(payload), 'utf8');
        fs.renameSync(temporaryFile, ALIVE_FILE);
    } catch (error) {
        log.error('alive_write_error', { error: error.message });
    }
}

function startHeartbeat() {
    const payload = { pid: process.pid, startedAt: Date.now(), updatedAt: Date.now() };
    writeAlive(payload);
    setInterval(() => {
        payload.updatedAt = Date.now();
        writeAlive(payload);
    }, HEARTBEAT_INTERVAL_MS).unref();
}

// Marca un cierre ordenado (recibimos SIGINT/SIGTERM, ej. Linux): la próxima
// instancia no debe volver a avisar "apagado" porque este proceso ya lo hizo.
function markCleanStop() {
    writeAlive({ pid: 0, startedAt: 0, updatedAt: Date.now() });
}

// true si la instancia anterior estaba viva hace poco y no fuimos nosotros:
// significa que el proceso se reinició (todos los casos de PM2 en Windows).
function previousInstanceWasRunning() {
    const alive = readAlive();
    if (!alive) return false;
    if (!alive.pid || alive.pid === process.pid) return false;
    return Date.now() - alive.updatedAt <= RESTART_WINDOW_MS;
}

// Estado para monitor.js: 'up' si el heartbeat está fresco, 'down' si no.
function monitorStatus(nowMs = Date.now()) {
    const alive = readAlive();
    if (!alive) return { state: 'down' };
    return {
        state: nowMs - alive.updatedAt <= RESTART_WINDOW_MS ? 'up' : 'down',
        pid: alive.pid,
        ageMs: nowMs - alive.updatedAt
    };
}

module.exports = {
    startHeartbeat,
    markCleanStop,
    previousInstanceWasRunning,
    monitorStatus
};