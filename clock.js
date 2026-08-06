// Sincronización de hora con internet.
//
// La PC de desarrollo tiene el reloj desfasado (~3h adelantado), lo que rompe
// el cálculo de horario comercial/feriados, el filtro de mensajes viejos y el
// estado de mute. Para no depender del reloj local, este módulo obtiene la hora
// real leyendo el header HTTP "Date" (formato GMT, RFC 7231) de varios
// servidores conocidos y calcula un offset que se aplica a Date.now().
//
// clock.nowMs() / clock.nowDate() devuelven la hora "real" corregida.
const https = require('https');

const TIME_HOSTS = [
    { hostname: 'www.google.com', path: '/' },
    { hostname: 'www.cloudflare.com', path: '/' },
    { hostname: 'www.amazon.com', path: '/' }
];

const REQUEST_TIMEOUT_MS = 5000;
const RE_SYNC_INTERVAL_MS = 10 * 60 * 1000;

let clockOffsetMs = 0;
let syncingPromise = null;
let autoSyncInterval = null;

function fetchServerTimeMs(host) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: host.hostname,
                path: host.path,
                method: 'GET',
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'User-Agent': 'whatsapp-bot/1.0' }
            },
            (res) => {
                const dateHeader = res.headers && res.headers.date;
                res.resume();
                if (!dateHeader) {
                    reject(new Error(`sin header Date (${host.hostname})`));
                    return;
                }
                const serverTimeMs = Date.parse(dateHeader);
                if (Number.isNaN(serverTimeMs)) {
                    reject(new Error(`header Date invalido (${host.hostname})`));
                    return;
                }
                resolve(serverTimeMs);
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error(`timeout (${host.hostname})`));
        });
        req.end();
    });
}

async function fetchInternetTimeMs() {
    let lastError = null;
    for (const host of TIME_HOSTS) {
        try {
            return await fetchServerTimeMs(host);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('no se pudo obtener la hora de internet');
}

// Obtiene la hora de internet y calcula el offset. Si ya hay un sync en curso,
// devuelve la misma promesa (evita duplicados).
function syncClock() {
    if (!syncingPromise) {
        syncingPromise = fetchInternetTimeMs()
            .then((serverTimeMs) => {
                clockOffsetMs = serverTimeMs - Date.now();
            })
            .finally(() => {
                syncingPromise = null;
            });
    }
    return syncingPromise;
}

// Hora real corregida (epoch ms).
function nowMs() {
    return Date.now() + clockOffsetMs;
}

// Fecha/hora real corregida (para new Date() / getHours() local).
function nowDate() {
    return new Date(nowMs());
}

function clockOffset() {
    return clockOffsetMs;
}

// Re-sincroniza cada 10 minutos (el reloj de la PC puede volver a desfasarse).
function startAutoSync() {
    if (autoSyncInterval) return;
    autoSyncInterval = setInterval(() => {
        syncClock().catch(() => {});
    }, RE_SYNC_INTERVAL_MS);
    autoSyncInterval.unref();
}

module.exports = { syncClock, nowMs, nowDate, clockOffset, startAutoSync };
