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

const { boot } = require('./src/baileys');
const { getScheduleForDate } = require('./config/schedule');
const { isBusinessHours, formatDateKey, shiftDateByDays, isHoliday } = require('./config/schedule');
const { normalizeNumberVariants, normalizeAutoMuteChatId } = require('./config/contacts');
const { getMessageBody, getMessageType } = require('./src/utils/messages');
const { isGroupJid, isMutedChat, loadLastMessages, upsertMessagesCache } = require('./src/store');
const { autoMuteContactMatches } = require('./src/auto-mute');

if (require.main === module) {
    boot().catch(err => {
        require('./logger').child('client').error('initialization_error', { error: err.message });
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
