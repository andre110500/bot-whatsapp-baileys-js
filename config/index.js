// Configuración por variables de entorno.
const path = require('path');

// TEST_MODE = "modo prueba de bienvenida": el bot responde la bienvenida en
// cualquier circunstancia. Hace solo dos cosas:
//   - isBusinessHours() siempre da true (no bloquea por horario)
//   - saltea la regla de las 4 horas (se puede probar la bienvenida seguido)
// DISABLE_AUTO_MUTE y DISABLE_OLD_MESSAGE_SYNC son independientes: apagan
// el auto-mute y la carga de historial respectivamente, y no se activan con
// TEST_MODE.
function isTestMode() {
    return process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1';
}

function isDisableAutoMute() {
    return process.env.DISABLE_AUTO_MUTE === 'true' || process.env.DISABLE_AUTO_MUTE === '1';
}

function isDisableOldMessageSync() {
    return process.env.DISABLE_OLD_MESSAGE_SYNC === 'true' || process.env.DISABLE_OLD_MESSAGE_SYNC === '1';
}

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || 'silent';

// Timeout de la alarma "cliente sin respuesta": segundos vía WELCOME_ALERT_TIMEOUT
// (default 240 = 4 minutos).
function welcomeAlertTimeoutMs() {
    const value = Number(process.env.WELCOME_ALERT_TIMEOUT);
    if (Number.isFinite(value) && value > 0) return value * 1000;
    return 4 * 60 * 1000;
}

module.exports = {
    isTestMode,
    isDisableAutoMute,
    isDisableOldMessageSync,
    AUTH_DIR,
    BAILEYS_LOG_LEVEL,
    welcomeAlertTimeoutMs
};
