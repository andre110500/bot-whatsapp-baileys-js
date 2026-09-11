// Bot de WhatsApp migrado a Baileys (@whiskeysockets/baileys 6.7.24).
//
// Punto de entrada (bootstrap): arranca el bot y re-exporta utilidades para
// los tests. Toda la lógica está modularizada en:
//   - config/    → horarios, números, textos, env
//   - src/*      → lógica por dominio (welcome, auto-mute, handlers, baileys...)
//
// Notas de migración:
// - Baileys 6.7.24 es ESM-only: se carga con import() dinámico desde CommonJS.
// - No trae makeInMemoryStore: se usa un mini-store propio (src/store).
// - La autenticación es por Multi-File (carpeta auth_info) en vez de Chromium.

// Carga las variables de entorno desde .env (si existe) ANTES de requerir
// cualquier módulo que las lea en tiempo de carga (telegram, config, etc.).
require('./config/env');

const { boot } = require('./src/baileys');
const { getScheduleForDate } = require('./config/schedule');
const { isBusinessHours, formatDateKey, shiftDateByDays, isHoliday } = require('./config/schedule');
const { normalizeNumberVariants, normalizeAutoMuteChatId } = require('./config/contacts');
const { getMessageBody, getMessageType } = require('./src/utils/messages');
const { isGroupJid, isMutedChat, loadLastMessages, upsertMessagesCache } = require('./src/store');
const { autoMuteContactMatches } = require('./src/auto-mute');

if (require.main === module) {
    const telegram = require('./telegram');
    const logClient = require('./logger').child('client');

    // Cierre ordenado (funciona en Linux, donde PM2 entrega señales). En
    // Windows PM2 mata con taskkill sin señal: eso lo cubre el heartbeat +
    // monitor.js. Al marcar el cierre como limpio evitamos que la próxima
    // instancia repita el aviso de "apagado".
    function handleShutdown(signal) {
        logClient.warn('shutdown_signal', { signal });
        const { markCleanStop } = require('./src/heartbeat');
        markCleanStop();
        telegram.notifyShutdown().finally(() => process.exit(0));
    }
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    boot().catch(err => {
        logClient.error('initialization_error', { error: err.message });
        process.exit(1);
    });
} else {
    module.exports = {
        isBusinessHours,
        getScheduleForDate,
        isHoliday,
        formatDateKey,
        shiftDateByDays,
        normalizeNumberVariants,
        normalizeAutoMuteChatId,
        autoMuteContactMatches,
        getMessageBody,
        getMessageType,
        isGroupJid,
        isMutedChat,
        loadLastMessages,
        upsertMessagesCache
    };
}
