// Manejo de mensajes entrantes: respuestas automáticas de alias, aviso de
// cierre fuera de horario, y bienvenida con imágenes + timer de alerta.
const clock = require('../../clock');
const logger = require('../../logger');
const state = require('../../state');
const { serializeError } = require('../utils/errors');
const { delay, withTimeout } = require('../utils/promises');
const { getMessageBody, getMessageSummary } = require('../utils/messages');
const { getContactInfo } = require('../store');
const { shouldIgnoreBasicMessage } = require('../filters');
const { reproducirAlarma } = require('../alarm');
const { isBusinessHours, minutesUntilOpen, formatDuration } = require('../../config/schedule');
const { WELCOME_MESSAGE } = require('../../config/messages');
const {
    recordConversationReply,
    handleAutoReplyWithTimeout,
    lastAliasGivenTime,
    lastClosedNoticeTime,
    CLOSED_NOTICE_COOLDOWN_MS
} = require('../conversation');
const {
    shouldIgnoreWelcomeMessage,
    loadWelcomeMedia,
    WELCOME_IMAGE_ITEMS,
    WELCOME_ALERT_TIMEOUT
} = require('../welcome');

const logMessage = logger.child('message');
const logWelcome = logger.child('welcome');

function generateReqId() {
    return require('../../logger').generateReqId();
}

async function handleIncomingMessage(message, upsertType, reqId = null) {
    if (upsertType !== 'notify') {
        logMessage.debug('message_skipped_upsert_type', {
            userId: message.key && message.key.remoteJid,
            upsertType,
            timestamp: message.messageTimestamp
        });
        return;
    }

    const logId = reqId || generateReqId();
    const { ignore, chat } = await shouldIgnoreBasicMessage(message, logId);
    logMessage.withReqId(logId).debug('incoming_filter_decision', { ignore, chatFound: !!chat });
    if (ignore) return;

    const userId = message.key.remoteJid;
    const contactInfo = await getContactInfo(userId);
    const summaryObj = getMessageSummary(message);
    const summaryStr = `[${summaryObj.type.toUpperCase()}] ${summaryObj.shortBody}`;
    logMessage.withReqId(logId).info('message_received', { userId, contactInfo, summary: summaryStr, summaryDetails: summaryObj });

    // BLOQUEO DE CONCURRENCIA PARA MENSAJES MULTIPLES SIMULTANEOS
    if (state.processingUsers.has(userId)) {
        logMessage.withReqId(logId).warn('ignore_duplicate_message', { contactInfo, summary: summaryStr });
        return;
    }
    state.processingUsers.add(userId);

    try {
        const body = getMessageBody(message);
        const bodyLower = body.toLowerCase();

        // --- FUERA DE HORARIO: no se responde nada automaticamente, solo se
        // avisa que cerramos y cuánto falta para abrir (también ante pedidos
        // de la página "*Orden*", que llegan fuera de horario) ---
        if (!isBusinessHours()) {
            const now = clock.nowMs();
            const lastNotice = lastClosedNoticeTime.get(userId) || 0;
            if (now - lastNotice >= CLOSED_NOTICE_COOLDOWN_MS) {
                lastClosedNoticeTime.set(userId, now);
                const mins = minutesUntilOpen();
                const text = `Hola! Estamos cerrados 😴\nAbrimos en ${formatDuration(mins)} (${clock.nowDate().toLocaleDateString()} ${clock.nowDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).\nPedinos cuando estemos de nuevo en https://latentacion.ar/catalogo/ 🌮`;
                await withTimeout(state.sock.sendMessage(userId, { text }, { quoted: message }), 20000, 'sendClosedNotice');
                logMessage.withReqId(logId).info('sent_closed_notice', {
                    contactInfo,
                    minutesUntilOpen: mins
                });
            }
            return;
        }

        // --- Ignorar a pedidos de la pagina (mensaje que empieza con "*Orden*") ---
        if (body.startsWith('*Orden*')) {
            return;
        }

        // --- RESPUESTA AUTOMATICA DE ALIAS ---
        if (!message.key.fromMe && (/tra(ns|s|n)(ferencia|fiero|fiere|ferir|fe)|trasn(ferencia|fiero|fiere|ferir|fe)|\bmp\b|\balias+\b/i.test(bodyLower) || bodyLower.includes('mercado pago'))) {
            const wasSent = await handleAutoReplyWithTimeout(
                userId,
                lastAliasGivenTime,
                userId,
                'sent_transfer_data',
                5000,
                async () => {
                    await withTimeout(state.sock.sendMessage(userId, { text: 'latentacion.ar' }, { quoted: message }), 20000, 'sendAlias1');
                    await withTimeout(state.sock.sendMessage(userId, { text: 'a nombre de carito llerena' }), 20000, 'sendAlias2');
                },
                logId
            );
            // Cortamos acá, si pidió el alias no le enviamos el menú de bienvenida de nuevo
            if (wasSent) return;
        }

        // --- MENSAJE DE BIENVENIDA ---
        if (await shouldIgnoreWelcomeMessage(userId, message, chat, logId)) return;

        await delay(10000);
        await withTimeout(state.sock.sendMessage(userId, { text: WELCOME_MESSAGE }, { quoted: message }), 20000, 'sendWelcome');
        recordConversationReply(userId, clock.nowMs());
        const logWelcomeReq = logWelcome.withReqId(logId);
        logWelcomeReq.info('sent_welcome_message', { contactInfo });
        await delay(1000);

        try {
            for (const item of WELCOME_IMAGE_ITEMS) {
                logWelcomeReq.info('welcome_image_send_start', {
                    contactInfo,
                    label: item.label,
                    url: item.url,
                    to: userId
                });

                const media = await loadWelcomeMedia(item, logId);
                logWelcomeReq.info('welcome_image_loaded', {
                    contactInfo,
                    label: item.label,
                    mimetype: media.mimetype,
                    dataLength: media.buffer ? media.buffer.length : 0,
                    fromCache: state.welcomeMediaCache.has(item.url)
                });
                logWelcomeReq.info('welcome_image_send_attempt', {
                    contactInfo,
                    label: item.label
                });
                await withTimeout(state.sock.sendMessage(userId, { image: media.buffer, caption: item.caption, mimetype: media.mimetype }), 30000, 'sendImage');
                logWelcomeReq.info('welcome_image_sent', {
                    contactInfo,
                    label: item.label
                });

                if (item.delayAfterMs > 0) {
                    await delay(item.delayAfterMs);
                }
            }
        } catch (err) {
            logWelcomeReq.error('welcome_images_error', {
                contactInfo,
                error: err.message,
                errorDetails: serializeError(err)
            });
        }

        // --- INICIO: Timer de alerta de 4 minutos sin respuesta del dueño ---
        if (state.welcomeTimers.has(userId)) {
            clearTimeout(state.welcomeTimers.get(userId));
            logWelcomeReq.info('welcome_timer_restarted', {
                contactInfo,
                userId,
                reason: 'new_message_received_before_timeout'
            });
        }

        const alertContactInfo = contactInfo;
        const alertTimer = setTimeout(() => {
            logWelcomeReq.warn('welcome_no_response_alert', { contactInfo: alertContactInfo, userId });

            reproducirAlarma();
            state.welcomeTimers.delete(userId);
        }, WELCOME_ALERT_TIMEOUT);

        logWelcomeReq.info('welcome_timer_started', {
            contactInfo: alertContactInfo,
            userId,
            timeoutMs: WELCOME_ALERT_TIMEOUT
        });
        state.welcomeTimers.set(userId, alertTimer);
        // --- FIN: Timer de alerta ---
    } catch (error) {
        logMessage.withReqId(logId).error('error_processing_message', { error: error.message });
    } finally {
        state.processingUsers.delete(userId);
    }
}

module.exports = { handleIncomingMessage };
