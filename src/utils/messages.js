// Conversión de mensajes de Baileys (proto) a texto / tipo.

// Antigüedad máxima de un mensaje al llegar: por encima se considera reenvío
// del server (sincronización al encender o drenaje de backlog de Baileys 7.x)
// y NO debe disparar ninguna respuesta. Se compara contra la hora de llegada,
// no contra startTime: el backlog peligroso llega con timestamp posterior al
// arranque pero entregado ~15 minutos tarde. Configurable vía env.
const OLD_MESSAGE_MAX_AGE_MS = (parseInt(process.env.OLD_MESSAGE_MAX_AGE_MINUTES, 10) || 10) * 60 * 1000;

// Convierte messageTimestamp (número de segundos, string, Date o Long de
// Baileys) a segundos. El Long { low, high, unsigned } rompe Number() -> NaN,
// por lo que requiere conversión explícita.
function getMessageTimestampSeconds(messageTimestamp) {
    if (messageTimestamp == null) return NaN;
    if (typeof messageTimestamp === 'number') return Number.isFinite(messageTimestamp) ? messageTimestamp : NaN;
    if (typeof messageTimestamp === 'string') {
        const n = Number(messageTimestamp);
        return Number.isFinite(n) ? n : NaN;
    }
    if (messageTimestamp instanceof Date) return Math.floor(messageTimestamp.getTime() / 1000);
    if (typeof messageTimestamp === 'object') {
        if (typeof messageTimestamp.toNumber === 'function') {
            return messageTimestamp.toNumber();
        }
        if (Number.isFinite(messageTimestamp.low)) {
            const low = messageTimestamp.low >>> 0;
            const high = Number(messageTimestamp.high) || 0;
            return high * 4294967296 + low;
        }
    }
    return NaN;
}

function getMessageBody(msg) {
    const content = msg && msg.message;
    if (!content) return '';
    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage && content.extendedTextMessage.text) return content.extendedTextMessage.text;
    if (content.imageMessage && content.imageMessage.caption) return content.imageMessage.caption;
    if (content.videoMessage && content.videoMessage.caption) return content.videoMessage.caption;
    if (content.documentMessage && content.documentMessage.caption) return content.documentMessage.caption;
    return '';
}

function getMessageType(msg) {
    const content = msg && msg.message;
    if (!content) return 'unknown';
    if (content.conversation || content.extendedTextMessage) return 'chat';
    if (content.imageMessage) return 'image';
    if (content.videoMessage) return 'video';
    if (content.audioMessage) return content.audioMessage.ptt ? 'ptt' : 'audio';
    if (content.stickerMessage) return 'sticker';
    if (content.documentMessage) return 'document';
    return 'other';
}

function getMessageSummary(msg) {
    const body = getMessageBody(msg) || '';
    const shortBody = body.length > 20 ? body.substring(0, 20) + '...' : body;
    return {
        type: getMessageType(msg),
        shortBody: shortBody
    };
}

module.exports = {
    OLD_MESSAGE_MAX_AGE_MS,
    getMessageTimestampSeconds,
    getMessageBody,
    getMessageType,
    getMessageSummary
};
