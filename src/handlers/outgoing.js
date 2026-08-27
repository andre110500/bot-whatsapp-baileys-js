// Manejo de mensajes salientes: registro de la regla de las 4 horas y
// respuesta automática de despedida cuando el dueño avisa que sale el delivery.
const clock = require('../../clock');
const logger = require('../../logger');
const state = require('../../state');
const { withTimeout } = require('../utils/promises');
const { getMessageBody, getMessageType, getMessageTimestampSeconds, OLD_MESSAGE_MAX_AGE_MS } = require('../utils/messages');
const { getContactInfo } = require('../store');
const { handleAutoReplyWithTimeout, recordConversationReply, lastFarewellGivenTime, OUTGOING_CONVERSATION_TYPES } = require('../conversation');
const { FAREWELL_MESSAGE } = require('../../config/messages');

const logMessage = logger.child('message');
const logWelcome = logger.child('welcome');

function generateReqId() {
    return require('../../logger').generateReqId();
}

async function handleOutgoingMessage(message, upsertType, reqId = null) {
    const logId = reqId || generateReqId();
    const bodyLower = (getMessageBody(message) || '').toLowerCase();
    const chatId = message.key.remoteJid;

    // Registrar la respuesta saliente para la regla de las 4 horas
    if (chatId && OUTGOING_CONVERSATION_TYPES.has(getMessageType(message))) {
        // Al iniciar, Baileys puede entregar mensajes antiguos. Usamos su fecha
        // real para no convertirlos en una respuesta "recién enviada".
        const messageTime = getMessageTimestampSeconds(message.messageTimestamp) * 1000;
        const replyTime = Number.isFinite(messageTime) && messageTime > 0 ? messageTime : clock.nowMs();
        recordConversationReply(chatId, replyTime);
    }

    // No resucitar frases de despedida viejas que lleguen por sincronización
    const timestampSec = getMessageTimestampSeconds(message.messageTimestamp);
    if (!Number.isFinite(timestampSec) || clock.nowMs() - timestampSec * 1000 > OLD_MESSAGE_MAX_AGE_MS) return;

    // --- RESPUESTA AUTOMATICA DE DESPEDIDA ---
    if (/ah[ií]\s+(va( el deli)?|sali[oó]|sale)/i.test(bodyLower)) {
        await handleAutoReplyWithTimeout(
            chatId,
            lastFarewellGivenTime,
            chatId,
            'sent_farewell_message',
            0,
            async () => {
                await withTimeout(state.sock.sendMessage(chatId, { text: FAREWELL_MESSAGE || '¡Gracias por tu compra!' }), 20000, 'sendFarewell');
            },
            logId
        );
    }

    // Si hay un timer de alerta pendiente, el dueño ya respondió a tiempo
    if (state.welcomeTimers.has(chatId)) {
        clearTimeout(state.welcomeTimers.get(chatId));
        state.welcomeTimers.delete(chatId);
        const contactInfo = await getContactInfo(chatId);
        logWelcome.withReqId(logId).info('welcome_alert_cancelled', { contactInfo, chatId });
    }
}

module.exports = { handleOutgoingMessage };
