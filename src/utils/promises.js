// Utilidades de promesas: timeouts y reintentos.
const logger = require('../../logger');
const { isConnectionError } = require('./errors');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Limita la duración de una operación: si la promesa no resuelve antes del
// tiempo límite, lanza un error de timeout. Es la defensa principal contra los
// colgados (red colgada, WS muerto, etc.).
function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`timeout_${label}`));
        }, ms);
    });
    promise = Promise.resolve(promise);
    promise.catch(() => {});
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

const logRetry = logger.child('retry');

async function withRetry(fn, operationName, userId, retries = 3, delayMs = 1000, timeoutMs = 15000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await withTimeout(fn(), timeoutMs, operationName);
        } catch (error) {
            if (i === retries - 1) throw error;
            logRetry.warn('retry_attempt', {
                operation: operationName,
                attempt: i + 1,
                userId,
                error: error.message
            });
            await delay(delayMs);
        }
    }
}

// Espera hasta que el socket de Baileys esté abierto (conectado y
// autenticado) o hasta que venza el plazo. No escucha eventos: hace polling
// del ws, así funciona aunque el sock sea reemplazado por una reconexión.
async function waitForSocketOpen(timeoutMs = 20000, checkIntervalMs = 1000) {
    const state = require('../../state');
    const deadline = Date.now() + timeoutMs;
    const isOpen = () => {
        const sock = state.sock;
        if (!sock) return false;
        // readyState del WebSocket: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
        if (sock.ws && typeof sock.ws.readyState === 'number') {
            return sock.ws.readyState === 1;
        }
        return !!sock.user; // fallback: autenticado implica conexión abierta
    };
    while (Date.now() < deadline) {
        if (isOpen()) return true;
        await delay(checkIntervalMs);
    }
    return isOpen();
}

// Envía con reintento ante fallos de red (desconexión o timeout de envío).
// Reintenta solo cuando tiene sentido esperar la reconexión; los errores de
// otro tipo se propagan sin reintentar. Devuelve el resultado del sendMessage.
async function sendWithDisconnectRetry(sendFn, operationName, context = {}, options = {}) {
    const maxAttempts = options.maxAttempts || 3;
    const sendTimeoutMs = options.sendTimeoutMs || 20000;
    const connectTimeoutMs = options.connectTimeoutMs || 20000;
    const waitMs = options.waitMs || 2500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await withTimeout(sendFn(), sendTimeoutMs, operationName);
        } catch (error) {
            const connectionTrouble = isConnectionError(error) || /^timeout_/.test(String(error && error.message || ''));
            if (!connectionTrouble || attempt === maxAttempts) {
                if (connectionTrouble) {
                    logRetry.warn('send_failed_after_retries', {
                        operation: operationName,
                        attempt,
                        maxAttempts,
                        error: error && error.message,
                        ...context
                    });
                }
                throw error;
            }

            if (!(await waitForSocketOpen(connectTimeoutMs))) {
                logRetry.warn('send_aborted_no_connection', {
                    operation: operationName,
                    attempt,
                    error: error && error.message,
                    ...context
                });
                throw error;
            }

            logRetry.warn('send_retry_after_reconnect', {
                operation: operationName,
                attempt,
                error: error && error.message,
                ...context
            });
            await delay(waitMs);
        }
    }
}

module.exports = { delay, withTimeout, withRetry, waitForSocketOpen, sendWithDisconnectRetry };
