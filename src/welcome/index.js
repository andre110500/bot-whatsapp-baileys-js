// Mensaje de bienvenida: media (imágenes de menú), caché, descarga y la
// lógica de decisión (regla de las 4 horas + historial).
const state = require('../../state');
const logger = require('../../logger');
const { isBusinessHours } = require('../../config/schedule');
const { isTestMode } = require('../../config/index');
const { CONVERSATION_TIMEOUT, lastConversationReplyTime } = require('../conversation');
const { loadLastMessages, getContactInfo } = require('../store');
const { getMessageSummary } = require('../utils/messages');
const { withTimeout, delay } = require('../utils/promises');
const { downloadBuffer } = require('../utils/http');
const { serializeError } = require('../utils/errors');

const logWelcome = logger.child('welcome');

const WELCOME_ALERT_TIMEOUT = 4 * 60 * 1000;
const CHAT_IMAGE_PTT_STICKER = ['chat', 'image', 'ptt', 'sticker'];

const WELCOME_IMAGE_ITEMS = [
    {
        label: 'menu-flavours-menu-1',
        url: 'https://res.cloudinary.com/dto1ctatc/image/upload/f_jpg,q_auto:good/menu-flavours-menu-1.jpg',
        caption: '📸 Sabores (Pág. 1) 🍦',
        delayAfterMs: 1000
    },
    {
        label: 'menu-flavours-menu-2',
        url: 'https://res.cloudinary.com/dto1ctatc/image/upload/f_jpg,q_auto:good/menu-flavours-menu-2.jpg',
        caption: '📸 Sabores (Pág. 2) 🍦',
        delayAfterMs: 1000
    },
    {
        label: 'menu-ice-cream-menu',
        url: 'https://res.cloudinary.com/dto1ctatc/image/upload/f_jpg,q_auto:good/menu-ice-cream-menu.jpg',
        caption: '🍨 Helado suelto',
        delayAfterMs: 0
    },
    {
        label: 'menu-frozen-treats-menu',
        url: 'https://res.cloudinary.com/dto1ctatc/image/upload/f_jpg,q_auto:good/menu-frozen-treats-menu.jpg',
        caption: '🍫 Postres',
        delayAfterMs: 0
    },
    {
        label: 'menu-drinks-cigarettes-menu-1',
        url: 'https://res.cloudinary.com/dto1ctatc/image/upload/f_jpg,q_auto:good/menu-drinks-cigarettes-menu-1.jpg',
        caption: '🥤 Bebidas y cigarrillos',
        delayAfterMs: 0
    }
];

const WELCOME_MEDIA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

async function loadWelcomeMedia(item, reqId = null, retries = 3) {
    const log = logWelcome.withReqId(reqId);

    const cachedMedia = state.welcomeMediaCache.get(item.url);
    if (cachedMedia && (Date.now() - cachedMedia.fetchedAt) < WELCOME_MEDIA_CACHE_TTL_MS) {
        return { buffer: cachedMedia.buffer, mimetype: cachedMedia.mimetype };
    }
    if (cachedMedia) {
        state.welcomeMediaCache.delete(item.url);
    }

    for (let i = 0; i < retries; i++) {
        try {
            const { buffer, contentType } = await withTimeout(downloadBuffer(item.url), 30000, 'downloadImage');
            state.welcomeMediaCache.set(item.url, { buffer, mimetype: contentType, fetchedAt: Date.now() });
            return { buffer, mimetype: contentType };
        } catch (err) {
            log.warn('welcome_image_load_retry_error', {
                label: item.label,
                url: item.url,
                attempt: i + 1,
                retries,
                error: serializeError(err)
            });

            if (i === retries - 1) throw err;

            log.debug('welcome_image_retrying', { label: item.label, attempt: i + 1, error: err.message });
            await delay(1000);
        }
    }
}

async function shouldIgnoreWelcomeMessage(userId, message, chat, reqId = null) {
    const log = logWelcome.withReqId(reqId);
    const reasonsToIgnore = [];

    if (!isBusinessHours()) {
        reasonsToIgnore.push('outsideBusinessHours');
    }

    const now = require('../../clock').nowMs();
    const lastLocalReply = lastConversationReplyTime.get(userId) || 0;

    // En TEST_MODE no aplica la regla de las 4 horas: se puede probar la
    // bienvenida todas las veces que haga falta.
    if (!isTestMode() && now - lastLocalReply < CONVERSATION_TIMEOUT) {
        reasonsToIgnore.push('activeConversationViaLocalReply');
        log.info('active_conversation_detected_locally', {
            userId,
            hoursSinceReply: ((now - lastLocalReply) / (1000 * 60 * 60)).toFixed(2)
        });
    }

    if (chat && !reasonsToIgnore.includes('activeConversationViaLocalReply')) {
        try {
            const lastMessages = loadLastMessages(userId, 10);

            if (!lastMessages || !Array.isArray(lastMessages)) {
                throw new Error("lastMessages is null or not an array");
            }

            const contactInfo = await getContactInfo(userId);
            log.debug('debug_history_analysis', { contactInfo, count: lastMessages.length });

            // Buscamos si hay algún mensaje reciente nuestro (del bot o enviado por la app manualmente)
            for (let i = lastMessages.length - 1; i >= 0; i--) {
                const recentMsg = lastMessages[i];
                if (!recentMsg || recentMsg.messageTimestamp === undefined) continue;

                try {
                    const summaryObj = getMessageSummary(recentMsg) || { type: 'unknown', shortBody: 'unknown' };
                    const msgSummary = `[${(summaryObj.type || 'unknown').toUpperCase()}] ${summaryObj.shortBody || 'unknown'}`;
                    const msgTimeMs = Number(recentMsg.messageTimestamp) * 1000;
                    const timeSinceMsg = now - msgTimeMs;
                    const hoursSinceMsg = (timeSinceMsg / (1000 * 60 * 60)).toFixed(2);

                    log.debug('debug_history_item', {
                        index: i,
                        fromMe: recentMsg.key.fromMe,
                        summary: msgSummary,
                        hoursAgo: hoursSinceMsg
                    });

                    // Si el mensaje fue enviado por nosotros (bot o App)
                    if (recentMsg.key.fromMe) {
                        const timeSinceOurReply = now - msgTimeMs;

                        // Si respondimos en menos de 4 horas, ignoramos el mensaje actual
                        if (msgTimeMs > 0 && timeSinceOurReply < CONVERSATION_TIMEOUT) {
                            const hoursSinceReply = (timeSinceOurReply / (1000 * 60 * 60)).toFixed(2);

                            log.info('active_conversation_detected', {
                                contactInfo,
                                msgSummary,
                                hoursSinceReply
                            });
                            reasonsToIgnore.push('activeConversationViaHistory');
                            break;
                        }
                    }
                } catch (innerError) {
                    log.error('error_processing_history_item', { error: innerError?.message || 'Unknown error', index: i });
                }
            }

            if (!reasonsToIgnore.includes('activeConversationViaHistory')) {
                log.debug('no_active_conversation_detected', { contactInfo });
            }
        } catch (error) {
            log.error('error_fetching_messages', { error: error?.message || 'Unknown error' });
            reasonsToIgnore.push('errorFetchingHistory');
        }
    } else if (!chat) {
        // chat es null (no está en el mini-store). No bloqueamos el welcome por eso.
        const contactInfo = await getContactInfo(userId);
        log.warn('skip_history_no_chat', { userId, contactInfo });
    }

    if (reasonsToIgnore.length > 0) {
        const contactInfo = await getContactInfo(userId);
        const summaryObj = getMessageSummary(message);
        const summaryStr = `[${summaryObj.type.toUpperCase()}] ${summaryObj.shortBody}`;

        log.info('ignore_welcome_message', { contactInfo, summary: summaryStr, reasons: reasonsToIgnore });
        return true;
    }

    return false;
}

module.exports = {
    WELCOME_ALERT_TIMEOUT,
    CHAT_IMAGE_PTT_STICKER,
    WELCOME_IMAGE_ITEMS,
    loadWelcomeMedia,
    shouldIgnoreWelcomeMessage
};
