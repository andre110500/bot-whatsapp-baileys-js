// Estado de conversación persistente (regla de las 4 horas) y rate-limits de
// respuestas automáticas (alias, despedida, aviso de cierre).
const fs = require('fs');
const path = require('path');
const clock = require('../../clock');
const logger = require('../../logger');
const { getContactInfo } = require('../store');

const log = logger.child('conversation');

const CONVERSATION_TIMEOUT = 4 * 60 * 60 * 1000; // 4 horas

// Cooldown para el aviso de "cerramos por hoy" (fuera de horario laboral),
// para no spamear al usuario que manda varios mensajes seguidos.
const CLOSED_NOTICE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hora

// Mapas para rate-limit de respuestas automáticas
const lastAliasGivenTime = new Map();
const lastFarewellGivenTime = new Map();
const lastClosedNoticeTime = new Map();

// Última respuesta saliente por chat. Fuente alternativa para respetar la
// ventana de cuatro horas. Se usan timestamps reales porque durante la
// sincronización inicial Baileys puede entregar mensajes antiguos.
const lastConversationReplyTime = new Map();
const CONVERSATION_STATE_DIR = path.join(__dirname, '..', '..', 'runtime-data');
const CONVERSATION_STATE_FILE = path.join(CONVERSATION_STATE_DIR, 'conversation-replies.json');
const OUTGOING_CONVERSATION_TYPES = new Set(['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker']);

function persistConversationReplyTimes() {
    try {
        fs.mkdirSync(CONVERSATION_STATE_DIR, { recursive: true });
        const state = Object.fromEntries(lastConversationReplyTime);
        const temporaryFile = `${CONVERSATION_STATE_FILE}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(temporaryFile, CONVERSATION_STATE_FILE);
    } catch (error) {
        log.error('conversation_state_save_error', { error: error.message });
    }
}

function recordConversationReply(chatId, replyTime = clock.nowMs()) {
    if (!chatId || !Number.isFinite(replyTime) || replyTime <= 0) return;

    const previousReplyTime = lastConversationReplyTime.get(chatId) || 0;
    if (replyTime <= previousReplyTime) return;

    lastConversationReplyTime.set(chatId, replyTime);
    persistConversationReplyTimes();
}

function loadConversationReplyTimes() {
    try {
        if (!fs.existsSync(CONVERSATION_STATE_FILE)) return;

        const storedState = JSON.parse(fs.readFileSync(CONVERSATION_STATE_FILE, 'utf8'));
        const nowMs = clock.nowMs();
        const oldestUsefulReply = nowMs - CONVERSATION_TIMEOUT;
        for (const [chatId, replyTimeValue] of Object.entries(storedState)) {
            const replyTime = Number(replyTimeValue);
            // Se descartan entradas viejas Y entradas con hora futura (por
            // ejemplo, guardadas mientras el reloj de la PC estaba desfasado).
            if (Number.isFinite(replyTime) && replyTime >= oldestUsefulReply && replyTime <= nowMs + 60000) {
                lastConversationReplyTime.set(chatId, replyTime);
            }
        }
        log.info('conversation_state_loaded', { entries: lastConversationReplyTime.size });
    } catch (error) {
        log.error('conversation_state_load_error', { error: error.message });
    }
}

function removeConversationReply(chatId) {
    if (!lastConversationReplyTime.has(chatId)) return;
    lastConversationReplyTime.delete(chatId);
    persistConversationReplyTimes();
}

// Envía una acción automática respetando el cooldown de la respuesta.
// Devuelve true si se envió, false si estaba en cooldown.
async function handleAutoReplyWithTimeout(targetId, mapToUse, contactJid, logEventName, delayMs, sendAction, reqId = null) {
    const logMessage = logger.child('message');
    const now = clock.nowMs();
    const lastTime = mapToUse.get(targetId) || 0;

    if (now - lastTime >= CONVERSATION_TIMEOUT) {
        mapToUse.set(targetId, now);

        if (delayMs > 0) {
            await require('../utils/promises').delay(delayMs);
        }

        await sendAction();
        const contactInfo = await getContactInfo(contactJid);
        logMessage.withReqId(reqId).info(logEventName, { contactInfo });

        return true;
    }
    return false;
}

// Carga inicial del estado persistente al arrancar.
loadConversationReplyTimes();

module.exports = {
    CONVERSATION_TIMEOUT,
    CLOSED_NOTICE_COOLDOWN_MS,
    OUTGOING_CONVERSATION_TYPES,
    lastAliasGivenTime,
    lastFarewellGivenTime,
    lastClosedNoticeTime,
    lastConversationReplyTime,
    recordConversationReply,
    removeConversationReply,
    handleAutoReplyWithTimeout,
    loadConversationReplyTimes
};
