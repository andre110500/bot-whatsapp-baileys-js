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

module.exports = {
    isTestMode,
    isDisableAutoMute,
    isDisableOldMessageSync,
    AUTH_DIR,
    BAILEYS_LOG_LEVEL
};
