// Utilidades de promesas: timeouts y reintentos.
const logger = require('../../logger');

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

module.exports = { delay, withTimeout, withRetry };
