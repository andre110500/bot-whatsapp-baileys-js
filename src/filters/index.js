// Filtros básicos: decide si un mensaje entrante debe ignorarse directamente
// (números ignorados, mensajes viejos, grupos, canales, chats muteados, etc.).
const clock = require('../../clock');
const logger = require('../../logger');
const { IGNORED_NUMBERS, normalizeNumberVariants } = require('../../config/contacts');
const { isTestMode } = require('../../config/index');
const { getChatFromStore, isGroupJid, isMutedChat, getContactInfo } = require('../store');
const {
    OLD_MESSAGE_MAX_AGE_MS,
    getMessageTimestampSeconds,
    getMessageType,
    getMessageSummary
} = require('../utils/messages');
const { CHAT_IMAGE_PTT_STICKER } = require('../welcome');

const logMessage = logger.child('message');

async function shouldIgnoreBasicMessage(message, reqId = null) {
    const log = logMessage.withReqId(reqId);
    const reasonsToIgnore = [];
    const userId = message.key.remoteJid;

    // Ignorar números de la lista IGNORED_NUMBERS
    const jidNumber = String(userId || '').split('@')[0];
    const contactVariants = normalizeNumberVariants(jidNumber);
    if (IGNORED_NUMBERS.some(n => contactVariants.includes(n))) {
        reasonsToIgnore.push('ignoredNumber');
    }

    // Ignorar mensajes antiguos que llegan por sincronización o por reenvíos
    // tardíos del server (Baileys 7.x drena el backlog como notify con
    // timestamps viejos, incluso minutos después de enviados). Un mensaje solo
    // se procesa si al llegar tiene menos de OLD_MESSAGE_MAX_AGE_MS de
    // antigüedad. Aplica en todos los modos, incluido TEST_MODE: sin esto el
    // bot responde a clientes por mensajes de hace 15 minutos.
    const timestampSec = getMessageTimestampSeconds(message.messageTimestamp);
    if (Number.isFinite(timestampSec) && timestampSec > 0 && clock.nowMs() - timestampSec * 1000 > OLD_MESSAGE_MAX_AGE_MS) {
        reasonsToIgnore.push('oldMessageSync');
    }

    // Si el mensaje viene de un canal (newsletter), lo marcamos para ignorar
    if (String(userId || '').endsWith('@newsletter')) {
        reasonsToIgnore.push('isNewsletter');
    }
    // Si el mensaje es una actualización de estado, lo marcamos para ignorar
    if (userId === 'status@broadcast') reasonsToIgnore.push('isStatus');

    let chat;
    // Únicamente si el mensaje NO fue marcado para ser ignorado arriba
    if (reasonsToIgnore.length === 0) {
        chat = getChatFromStore(userId);

        if (chat) {
            if (isGroupJid(userId)) reasonsToIgnore.push('chat_isGroup');
            if (isMutedChat(chat)) reasonsToIgnore.push('chat_isMuted');
            if (chat.archived === true) reasonsToIgnore.push('chat_isArchived');
        } else {
            // Fallback: verificar grupo por el formato del ID del mensaje
            if (isGroupJid(userId)) reasonsToIgnore.push('chat_isGroup (fallback)');
            // No podemos verificar muted/archived sin el chat, pero no descartamos el mensaje
        }

        if (!CHAT_IMAGE_PTT_STICKER.includes(getMessageType(message))) reasonsToIgnore.push(`message type is: ${getMessageType(message)}`);
    }

    if (reasonsToIgnore.length > 0) {
        const contactInfo = await getContactInfo(userId);
        const summaryObj = getMessageSummary(message);
        const summaryStr = `[${summaryObj.type.toUpperCase()}] ${summaryObj.shortBody}`;
        if (isTestMode()) {
            log.debug('ignore_basic_message', { contactInfo, summary: summaryStr, reasons: reasonsToIgnore });
        } else {
            log.warn('ignore_basic_message', { contactInfo, summary: summaryStr, reasons: reasonsToIgnore });
        }
        return { ignore: true, chat };
    }

    return { ignore: false, chat };
}

module.exports = { shouldIgnoreBasicMessage };
