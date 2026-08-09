// Bot de WhatsApp migrado a Baileys (@whiskeysockets/baileys 6.7.24).
//
// Reemplaza a whatsapp-web.js manteniendo TODA la lógica de negocio del bot
// original: bienvenida con imágenes + regla de 4 horas, despedida, horarios
// con feriados (cruce de medianoche), auto-mute de contactos en horario
// comercial, números ignorados, alarma local y alertas por Telegram.
//
// Notas de migración:
// - Baileys 6.7.24 es ESM-only: se carga con import() dinámico desde CommonJS.
// - No trae makeInMemoryStore: se usa un mini-store propio alimentado por los
//   eventos (messages.upsert, messaging-history.set, chats.*, contacts.upsert).
// - La autenticación es por Multi-File (carpeta auth_info) en vez de Chromium.
// - No existe el bug "r" de wwebjs: no hay circuit breaker, pero se conservan
//   withTimeout/withRetry para que ninguna llamada cuelgue el proceso.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const holidays = require('./holidays-2026.json');
const logger = require('./logger');
const { generateReqId } = require('./logger');
const telegram = require('./telegram');
const clock = require('./clock');

// ---------------------------------------------------------------------------
// Configuración / constantes
// ---------------------------------------------------------------------------

const AUTH_DIR = path.join(__dirname, 'auth_info');
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || 'silent';

// TEST_MODE = "modo prueba de bienvenida": el bot responde la bienvenida en
// cualquier circunstancia. Hace solo dos cosas:
//   - isBusinessHours() siempre da true (no bloquea por horario)
//   - saltea la regla de las 4 horas (se puede probar la bienvenida seguido)
// DISABLE_AUTO_MUTE y DISABLE_OLD_MESSAGE_SYNC son independientes: apagan
// el auto-mute y la carga de historial respectivamente, y no se activan con
// TEST_MODE.
const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1';
const DISABLE_AUTO_MUTE = process.env.DISABLE_AUTO_MUTE === 'true' || process.env.DISABLE_AUTO_MUTE === '1';
const DISABLE_OLD_MESSAGE_SYNC = process.env.DISABLE_OLD_MESSAGE_SYNC === 'true' || process.env.DISABLE_OLD_MESSAGE_SYNC === '1';

// Variable global que indica si actualmente hay una alarma sonando.
let alarmaSonando = false;

// Última vez que se envió el QR por Telegram, para no spamear (el evento
// 'connection.update' dispara QR varias veces por segundo mientras no se vincula).
let lastTelegramQrSentAt = 0;

const logAlarm = logger.child('alarm');
const logMute = logger.child('mute');
const logWelcome = logger.child('welcome');
const logMessage = logger.child('message');
const logContact = logger.child('contact');
const logConversation = logger.child('conversation');
const logClient = logger.child('client');

function reproducirAlarma() {
    if (alarmaSonando) {
        logAlarm.warn('reproducir_alarma_ignored', {
            reason: 'alarm_already_running'
        });
        return;
    }

    alarmaSonando = true;

    const mp3Path = path.join(__dirname, 'sonido.mp3');
    logAlarm.info('reproducir_alarma_start', { path: mp3Path });

    const command = `powershell -NoProfile -Command "Start-Process '${mp3Path}'"`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            alarmaSonando = false;
            logAlarm.error('reproducir_alarma_error', {
                error: error.message,
                stderr,
                stdout
            });
            return;
        }

        logAlarm.info('reproducir_alarma_success', { stdout, stderr });

        setTimeout(() => {
            alarmaSonando = false;
            logAlarm.info('reproducir_alarma_released', {
                reason: 'alarm_cooldown_finished'
            });
        }, 15000);
    });
}

// ---------------------------------------------------------------------------
// Helpers de errores / utilidades
// ---------------------------------------------------------------------------

let startTime = clock.nowMs();

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

const serializeError = (error) => {
    if (!error) return { message: 'Unknown error' };

    const plainError = {
        name: error.name,
        message: error.message || String(error),
        stack: error.stack,
        code: error.code,
        type: error.type,
        status: error.status,
        statusCode: error.statusCode,
        errno: error.errno,
        syscall: error.syscall,
        cause: error.cause ? serializeError(error.cause) : undefined
    };

    for (const key of Object.keys(error)) {
        if (plainError[key] === undefined) {
            plainError[key] = error[key];
        }
    }

    return plainError;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Limita la duración de una operación: si la promesa no resuelve antes del
// tiempo límite, lanza un error de timeout. Es la defensa principal contra los
// colgados (red colgada, WS muerto, etc.).
function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`timeout_${label}`));
        }, ms);
    });
    promise.catch(() => {});
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

const logRetry = logger.child('retry');

async function withRetry(fn, operationName, userId, retries = 3, delayMs = 1000, timeoutMs = 15000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await withTimeout(fn(), timeoutMs, operationName);
        } catch (error) {
            if (i === retries - 1) throw error;
            logRetry.warn('retry_attempt', {
                operation: operationName,
                attempt: i + 1,
                userId,
                error: error.message
            });
            await delay(delayMs);
        }
    }
}

// ---------------------------------------------------------------------------
// Conversión de mensajes de Baileys (proto) a texto / tipo
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mini-store en memoria (reemplaza makeInMemoryStore, ausente en 6.7.24)
// ---------------------------------------------------------------------------

const chatsCache = new Map();    // jid -> Chat
const contactsCache = new Map(); // jid -> Contact
const messagesCache = new Map(); // jid -> Map(msgId -> WAMessage)

function upsertChat(chat) {
    if (!chat || !chat.id) return;
    const prev = chatsCache.get(chat.id);
    chatsCache.set(chat.id, { ...(prev || {}), ...chat });
}

function upsertMessagesCache(msgs) {
    if (!Array.isArray(msgs)) return;
    for (const m of msgs) {
        const jid = m && m.key && m.key.remoteJid;
        const id = m && m.key && m.key.id;
        if (!jid || !id) continue;
        if (!messagesCache.has(jid)) messagesCache.set(jid, new Map());
        messagesCache.get(jid).set(id, m);
    }
}

function loadLastMessages(jid, limit) {
    const map = messagesCache.get(jid);
    if (!map) return [];
    const arr = [];
    for (const m of map.values()) {
        const ts = Number(m && m.messageTimestamp);
        if (Number.isFinite(ts) && ts > 0) arr.push(m);
    }
    arr.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
    return arr.slice(-limit);
}

function getChatFromStore(jid) {
    return chatsCache.get(jid) || null;
}

function isGroupJid(jid) {
    return typeof jid === 'string' && /@g\.us$/.test(jid);
}

function isMutedChat(chat) {
    if (!chat) return false;
    const m = chat.muteEndTime !== undefined ? chat.muteEndTime : chat.mute;
    if (m === null || m === undefined) return false;
    const ms = typeof m === 'number' ? m : (m && typeof m.toNumber === 'function' ? m.toNumber() : 0);
    return ms > clock.nowMs();
}

// ---------------------------------------------------------------------------
// Estado de conversación persistente (regla de las 4 horas)
// ---------------------------------------------------------------------------

const CONVERSATION_TIMEOUT = 4 * 60 * 60 * 1000; // 4 horas

// Mapas para rate-limit de respuestas automáticas
const lastAliasGivenTime = new Map();
const lastFarewellGivenTime = new Map();

// Última respuesta saliente por chat. Fuente alternativa para respetar la
// ventana de cuatro horas. Se usan timestamps reales porque durante la
// sincronización inicial Baileys puede entregar mensajes antiguos.
const lastConversationReplyTime = new Map();
const CONVERSATION_STATE_DIR = path.join(__dirname, 'runtime-data');
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
        logConversation.error('conversation_state_save_error', { error: error.message });
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
        logConversation.info('conversation_state_loaded', { entries: lastConversationReplyTime.size });
    } catch (error) {
        logConversation.error('conversation_state_load_error', { error: error.message });
    }
}

loadConversationReplyTimes();

// ---------------------------------------------------------------------------
// Configuración de mutes / bienvenida / imágenes
// ---------------------------------------------------------------------------

const processingUsers = new Set();
const welcomeTimers = new Map();
const WELCOME_ALERT_TIMEOUT = 4 * 60 * 1000;
const CHAT_IMAGE_PTT_STICKER = ['chat', 'image', 'ptt', 'sticker'];

const AUTO_MUTE_CONTACTS = [
    "5493764796077",
    "5491153190359",
    "5491136293849"
];

const IGNORED_NUMBERS = [
    "5493764796077",
    "5491153190359",
    "5491136293849"
];

const AUTO_MUTE_RETRY_DELAY = 60 * 1000;
const AUTO_MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
let autoMuteRetryTimeout = null;
let lastAutoMuteBusinessHours = null;
let autoMuteSyncIntervalId = null;
let resolvedMuteChatIds = [];

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

const welcomeMediaCache = new Map();

// ---------------------------------------------------------------------------
// Normalización de números / resolución de IDs de chat
// ---------------------------------------------------------------------------

function normalizeNumberVariants(num) {
    const digits = (num || '').replace(/\D/g, '');
    const variants = [digits];
    if (digits.startsWith('549') && digits.length > 3) {
        variants.push('54' + digits.slice(3));
    } else if (digits.startsWith('54') && !digits.startsWith('549') && digits.length > 2) {
        variants.push('549' + digits.slice(2));
    }
    return variants;
}

function normalizeAutoMuteChatId(contact) {
    const value = String(contact || '').trim();
    if (!value) return null;
    if (value.includes('@')) return value;

    const digits = value.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : null;
}

function addResolvedMuteChatId(foundIds, chatId) {
    const normalizedChatId = normalizeAutoMuteChatId(chatId);
    if (normalizedChatId && !foundIds.includes(normalizedChatId)) {
        foundIds.push(normalizedChatId);
    }
}

function autoMuteContactMatches(contactNumber, configuredContact) {
    const contactVariants = normalizeNumberVariants(contactNumber || '');
    const configuredVariants = normalizeNumberVariants(configuredContact || '');
    return configuredVariants.some(variant => contactVariants.includes(variant));
}

async function resolveMuteChatIds() {
    const foundIds = [];

    // Primero en chats conocidos del mini-store
    for (const chat of chatsCache.values()) {
        if (isGroupJid(chat.id)) continue;
        const number = String(chat.id).split('@')[0];
        if (AUTO_MUTE_CONTACTS.some(n => autoMuteContactMatches(number, n))) {
            addResolvedMuteChatId(foundIds, chat.id);
        }
    }

    // Fallback con onWhatsApp para números sin chat cacheado
    for (const number of AUTO_MUTE_CONTACTS) {
        if (number.includes('@')) {
            addResolvedMuteChatId(foundIds, number);
            continue;
        }

        const alreadyFound = foundIds.some(id => autoMuteContactMatches(String(id).split('@')[0], number));
        if (alreadyFound) continue;

        try {
            const result = await withTimeout(sock.onWhatsApp(number), 10000, 'onWhatsApp');
            const entry = (Array.isArray(result) ? result : []).find(r => r && r.exists);
            if (entry && entry.jid) {
                addResolvedMuteChatId(foundIds, entry.jid);
            }
        } catch (e) {
            logMute.warn('auto_mute_resolve_error', {
                number,
                error: e.message
            });
        }
    }

    resolvedMuteChatIds = foundIds;
    if (resolvedMuteChatIds.length > 0) {
        logMute.info('auto_mute_ids_resolved', { count: resolvedMuteChatIds.length });
    }
}

// ---------------------------------------------------------------------------
// Horarios y feriados
// ---------------------------------------------------------------------------

function formatDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function shiftDateByDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function isHoliday(date) {
    const dateKey = formatDateKey(date);
    return holidays.some(holiday => holiday.date === dateKey);
}

function getScheduleForDate(date) {
    const schedule = {
        1: { start: 20 * 60 + 0, end: 24 * 60 + 30 },
        2: { start: 20 * 60 + 0, end: 24 * 60 + 30 },
        3: { start: 20 * 60 + 0, end: 24 * 60 + 30 },
        4: { start: 20 * 60 + 0, end: 24 * 60 + 30 },
        5: { start: 20 * 60 + 0, end: 25 * 60 + 0 },
        6: { start: 13 * 60 + 0, end: 25 * 60 + 0 },
        0: { start: 13 * 60 + 0, end: 24 * 60 + 30 }
    };

    if (isHoliday(date)) {
        const tomorrow = shiftDateByDays(date, 1);
        const tomorrowDay = tomorrow.getDay();
        const isTomorrowWeekend = tomorrowDay === 0 || tomorrowDay === 6;

        return isHoliday(tomorrow) || isTomorrowWeekend ? schedule[6] : schedule[0];
    }

    return schedule[date.getDay()];
}

function isBusinessHours() {
    if (TEST_MODE) return true;

    const now = clock.nowDate();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hour * 60 + minutes;

    const today = getScheduleForDate(now);
    const yesterday = getScheduleForDate(shiftDateByDays(now, -1));

    const isOpenToday = currentTimeMinutes >= today.start;
    const isOpenFromYesterday = currentTimeMinutes < (yesterday.end - 24 * 60);

    return isOpenToday || isOpenFromYesterday;
}

// ---------------------------------------------------------------------------
// Auto-mute en horario comercial
// ---------------------------------------------------------------------------

async function syncAutoMutedContacts(force = false) {
    const chatIds = resolvedMuteChatIds.filter(Boolean);

    if (chatIds.length === 0) return;

    const businessHours = isBusinessHours();
    if (!force && businessHours === lastAutoMuteBusinessHours) return;

    const action = businessHours ? 'mute' : 'unmute';
    let hadError = false;

    for (const chatId of chatIds) {
        try {
            const mod = businessHours ? { mute: AUTO_MUTE_DURATION_MS } : { mute: null };
            await withTimeout(sock.chatModify(mod, chatId), 10000, action);

            logMute.info('auto_mute_contact_synced', {
                chatId,
                action,
                isBusinessHours: businessHours,
                result: 'ok'
            });
        } catch (error) {
            hadError = true;
            logMute.error('auto_mute_contact_error', {
                chatId,
                action,
                isBusinessHours: businessHours,
                error: error.message
            });
        }
    }

    lastAutoMuteBusinessHours = hadError ? null : businessHours;
    return !hadError;
}

async function startAutoMuteContactsSync() {
    if (autoMuteRetryTimeout) {
        clearTimeout(autoMuteRetryTimeout);
        autoMuteRetryTimeout = null;
    }

    const success = await syncAutoMutedContacts(true);
    if (!success) {
        autoMuteRetryTimeout = setTimeout(() => {
            startAutoMuteContactsSync();
        }, AUTO_MUTE_RETRY_DELAY);
    }
}

// ---------------------------------------------------------------------------
// Carga de imágenes de bienvenida (con caché)
// ---------------------------------------------------------------------------

function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;

        const doRequest = (currentUrl, redirectsLeft) => {
            const req = mod.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    const nextUrl = res.headers.location;
                    if (nextUrl.startsWith('/')) {
                        const parsed = new URL(currentUrl);
                        doRequest(`${parsed.protocol}//${parsed.host}${nextUrl}`, redirectsLeft - 1);
                    } else {
                        doRequest(nextUrl, redirectsLeft - 1);
                    }
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        buffer: Buffer.concat(chunks),
                        contentType: res.headers['content-type'] || 'image/jpeg'
                    });
                });
            });
            req.on('error', reject);
            req.setTimeout(20000, () => req.destroy(new Error('timeout_download')));
        };

        doRequest(url, 5);
    });
}

async function loadWelcomeMedia(item, reqId = null, retries = 3) {
    const log = logWelcome.withReqId(reqId);

    const cachedMedia = welcomeMediaCache.get(item.url);
    if (cachedMedia) {
        return { buffer: cachedMedia.buffer, mimetype: cachedMedia.mimetype };
    }

    for (let i = 0; i < retries; i++) {
        try {
            const { buffer, contentType } = await withTimeout(downloadBuffer(item.url), 30000, 'downloadImage');
            welcomeMediaCache.set(item.url, { buffer, mimetype: contentType });
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

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------

async function getContactInfo(jid) {
    try {
        const contact = contactsCache.get(jid);
        const name = contact && (contact.name || contact.verifiedName || contact.notify || '');
        if (name && name.trim() !== '') {
            return name.substring(0, 20);
        }
        return String(jid).split('@')[0];
    } catch (error) {
        logContact.error('error_contact_info', { error: error.message });
        return String(jid).split('@')[0];
    }
}

// ---------------------------------------------------------------------------
// Lógica de decisión (bienvenida / despedida / rate limits)
// ---------------------------------------------------------------------------

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
        if (TEST_MODE) {
            log.debug('ignore_basic_message', { contactInfo, summary: summaryStr, reasons: reasonsToIgnore });
        } else {
            log.warn('ignore_basic_message', { contactInfo, summary: summaryStr, reasons: reasonsToIgnore });
        }
        return { ignore: true, chat };
    }

    return { ignore: false, chat };
}

async function shouldIgnoreWelcomeMessage(userId, message, chat, reqId = null) {
    const log = logWelcome.withReqId(reqId);
    const reasonsToIgnore = [];

    if (!isBusinessHours()) {
        reasonsToIgnore.push('outsideBusinessHours');
    }

    const now = clock.nowMs();
    const lastLocalReply = lastConversationReplyTime.get(userId) || 0;

    // En TEST_MODE no aplica la regla de las 4 horas: se puede probar la
    // bienvenida todas las veces que haga falta.
    if (!TEST_MODE && now - lastLocalReply < CONVERSATION_TIMEOUT) {
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

async function handleAutoReplyWithTimeout(targetId, mapToUse, contactJid, logEventName, delayMs, sendAction, reqId = null) {
    const now = clock.nowMs();
    const lastTime = mapToUse.get(targetId) || 0;

    if (now - lastTime >= CONVERSATION_TIMEOUT) {
        mapToUse.set(targetId, now);

        if (delayMs > 0) {
            await delay(delayMs);
        }

        await sendAction();
        const contactInfo = await getContactInfo(contactJid);
        logMessage.withReqId(reqId).info(logEventName, { contactInfo });

        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Handler de mensajes entrantes (equivale a client.on('message'))
// ---------------------------------------------------------------------------

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
    if (processingUsers.has(userId)) {
        logMessage.withReqId(logId).warn('ignore_duplicate_message', { contactInfo, summary: summaryStr });
        return;
    }
    processingUsers.add(userId);

    try {
        const body = getMessageBody(message);
        const bodyLower = body.toLowerCase();

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
                    await withTimeout(sock.sendMessage(userId, { text: 'latentacion.ar' }, { quoted: message }), 20000, 'sendAlias1');
                    await withTimeout(sock.sendMessage(userId, { text: 'a nombre de carito llerena' }), 20000, 'sendAlias2');
                },
                logId
            );
            // Cortamos acá, si pidió el alias no le enviamos el menú de bienvenida de nuevo
            if (wasSent) return;
        }

        // --- MENSAJE DE BIENVENIDA ---
        if (await shouldIgnoreWelcomeMessage(userId, message, chat, logId)) return;

        const { WELCOME_MESSAGE } = require('./messages');
        await delay(10000);
        await withTimeout(sock.sendMessage(userId, { text: WELCOME_MESSAGE }, { quoted: message }), 20000, 'sendWelcome');
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
                    fromCache: welcomeMediaCache.has(item.url)
                });
                logWelcomeReq.info('welcome_image_send_attempt', {
                    contactInfo,
                    label: item.label
                });
                await withTimeout(sock.sendMessage(userId, { image: media.buffer, caption: item.caption, mimetype: media.mimetype }), 30000, 'sendImage');
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
        if (welcomeTimers.has(userId)) {
            clearTimeout(welcomeTimers.get(userId));
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
            welcomeTimers.delete(userId);
        }, WELCOME_ALERT_TIMEOUT);

        logWelcomeReq.info('welcome_timer_started', {
            contactInfo: alertContactInfo,
            userId,
            timeoutMs: WELCOME_ALERT_TIMEOUT
        });
        welcomeTimers.set(userId, alertTimer);
        // --- FIN: Timer de alerta ---
    } catch (error) {
        logMessage.withReqId(logId).error('error_processing_message', { error: error.message });
    } finally {
        processingUsers.delete(userId);
    }
}

// ---------------------------------------------------------------------------
// Handler de mensajes salientes (equivale a client.on('message_create'))
// ---------------------------------------------------------------------------

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
                const { FAREWELL_MESSAGE } = require('./messages');
                await withTimeout(sock.sendMessage(chatId, { text: FAREWELL_MESSAGE || '¡Gracias por tu compra!' }), 20000, 'sendFarewell');
            },
            logId
        );
    }

    // Si hay un timer de alerta pendiente, el dueño ya respondió a tiempo
    if (welcomeTimers.has(chatId)) {
        clearTimeout(welcomeTimers.get(chatId));
        welcomeTimers.delete(chatId);
        const contactInfo = await getContactInfo(chatId);
        logWelcome.withReqId(logId).info('welcome_alert_cancelled', { contactInfo, chatId });
    }
}

// ---------------------------------------------------------------------------
// Socket / conexión / QR / reconexión
// ---------------------------------------------------------------------------

function handleQr(qr) {
    qrcode.generate(qr, { small: true });

    // Guardamos una versión visual para poder escanearla cuando el bot corre
    // sin consola visible.
    try {
        const QRCode = require('qrcode-terminal/vendor/QRCode');
        const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
        const visualQr = new QRCode(-1, QRErrorCorrectLevel.L);
        visualQr.addData(qr);
        visualQr.make();

        const cellSize = 8;
        const quietZone = 4;
        const moduleCount = visualQr.getModuleCount();
        const imageSize = (moduleCount + quietZone * 2) * cellSize;
        const cells = [];
        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                if (visualQr.modules[row][col]) {
                    cells.push(`<rect x="${(col + quietZone) * cellSize}" y="${(row + quietZone) * cellSize}" width="${cellSize}" height="${cellSize}"/>`);
                }
            }
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageSize}" height="${imageSize}" viewBox="0 0 ${imageSize} ${imageSize}"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join('')}</g></svg>`;
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        fs.writeFileSync(path.join(AUTH_DIR, 'qr.svg'), svg, 'utf8');

        const now = Date.now();
        if (now - lastTelegramQrSentAt > 10000) {
            lastTelegramQrSentAt = now;
            telegram.notifyQr(qr);
        }
    } catch (error) {
        logClient.error('qr_file_error', { error: error.message });
    }
}

function handleReady() {
    const totalTime = ((clock.nowMs() - startTime) / 1000).toFixed(1);
    logClient.info('client_ready', { totalTime: Number(totalTime) });

    if (!DISABLE_AUTO_MUTE) {
        resolveMuteChatIds().then(() => startAutoMuteContactsSync());

        // Revisar cada 60 segundos si cambió el estado (abierto/cerrado) para mutear/desmutear.
        if (!autoMuteSyncIntervalId) {
            let muteSyncRunning = false;
            autoMuteSyncIntervalId = setInterval(async () => {
                if (muteSyncRunning) return;
                muteSyncRunning = true;
                try {
                    await resolveMuteChatIds();
                    await syncAutoMutedContacts();
                } finally {
                    muteSyncRunning = false;
                }
            }, 60 * 1000);
        }
    }
}

function handleLoggedOut() {
    if (autoMuteRetryTimeout) {
        clearTimeout(autoMuteRetryTimeout);
        autoMuteRetryTimeout = null;
        lastAutoMuteBusinessHours = null;
    }
    telegram.notifyLogout('LOGOUT');
    logClient.error('client_logged_out', { error: 'LOGOUT' });

    // Para re-vincular hay que descartar las credenciales y arrancar de nuevo:
    // así Baileys emite un QR nuevo (que también se envía por Telegram).
    resetToFreshPairing();
}

function resetToFreshPairing() {
    try {
        if (sock) sock.end(undefined);
    } catch (error) {
        logClient.debug('logout_end_error', { error: error.message });
    }
    sock = null;

    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        logClient.info('auth_cleared_for_relink');
    } catch (error) {
        logClient.error('auth_clear_error', { error: error.message });
    }

    setTimeout(connect, 1000);
}

function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) handleQr(qr);

    if (connection === 'open') {
        reconnectAttempt = 0;
        logClient.info('connection_open', { user: sock && sock.user ? sock.user.id : null });
        handleReady();
        return;
    }

    if (connection === 'close') {
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
            ? lastDisconnect.error.output.statusCode
            : undefined;
        const errorMessage = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : 'closed';

        logClient.error('client_disconnected', { error: errorMessage, statusCode });

        if (statusCode === B.DisconnectReason.loggedOut) {
            handleLoggedOut();
            return;
        }

        // Reconexión automática con backoff exponencial
        const delayMs = Math.min(3000 * Math.pow(2, reconnectAttempt), 30000);
        reconnectAttempt += 1;
        logClient.warn('client_reconnecting', { attempt: reconnectAttempt, delayMs });
        setTimeout(connect, delayMs);
    }
}

function bindSocketEvents(saveCreds) {
    sock.ev.on('creds.update', () => {
        if (sock) saveCreds();
    });

    sock.ev.on('connection.update', handleConnectionUpdate);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        upsertMessagesCache(messages);
        for (const message of messages || []) {
            const jid = message && message.key && message.key.remoteJid;
            if (!jid) continue;

            logMessage.debug('message_upsert_event', {
                upsertType: type,
                jid,
                fromMe: !!(message.key && message.key.fromMe),
                timestamp: message.messageTimestamp
            });

            try {
                if (message.key.fromMe) {
                    await handleOutgoingMessage(message, type);
                } else {
                    await handleIncomingMessage(message, type);
                }
            } catch (err) {
                logMessage.error('message_handler_error', {
                    jid,
                    upsertType: type,
                    error: err && err.message
                });
            }
        }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
        if (DISABLE_OLD_MESSAGE_SYNC) return;
        if (Array.isArray(chats)) chats.forEach(upsertChat);
        if (Array.isArray(contacts)) contacts.forEach(c => { if (c && c.id) contactsCache.set(c.id, c); });
        if (Array.isArray(messages)) upsertMessagesCache(messages);
    });

    sock.ev.on('chats.upsert', (chats) => {
        if (Array.isArray(chats)) chats.forEach(upsertChat);
    });

    sock.ev.on('chats.update', (chats) => {
        if (Array.isArray(chats)) chats.forEach(upsertChat);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        if (Array.isArray(contacts)) contacts.forEach(c => { if (c && c.id) contactsCache.set(c.id, c); });
    });

    // Si el usuario elimina un chat, quitamos también el respaldo local
    sock.ev.on('chats.delete', (jids) => {
        const jidList = Array.isArray(jids) ? jids : [];
        jidList.forEach((chatId) => {
            chatsCache.delete(chatId);
            if (lastConversationReplyTime.has(chatId)) {
                lastConversationReplyTime.delete(chatId);
                persistConversationReplyTimes();
                logConversation.info('conversation_state_removed_with_chat', { chatId });
            }
        });
    });
}

async function connect() {
    try {
        const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);

        sock = B.makeWASocket({
            version: baileysVersion,
            auth: state,
            logger: pino({ level: BAILEYS_LOG_LEVEL }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '126.0.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        bindSocketEvents(saveCreds);
    } catch (err) {
        logClient.error('connect_error', { error: err.message });
        setTimeout(connect, 5000);
    }
}

let B = null;
let sock = null;
let baileysVersion = null;
let reconnectAttempt = 0;

async function boot() {
    try {
        B = await import('@whiskeysockets/baileys');
    } catch (error) {
        logClient.error('baileys_load_error', { error: error.message });
        process.exit(1);
    }

    // Sincronizar la hora real con internet (la PC puede tener el reloj
    // desfasado, lo que rompería horarios, feriados y el filtro de mensajes
    // viejos). Si falla, se sigue con la hora local y se reintenta después.
    try {
        await clock.syncClock();
        clock.startAutoSync();
        logClient.info('clock_synced', {
            offsetMs: clock.clockOffset(),
            serverTime: clock.nowDate().toISOString()
        });
    } catch (error) {
        logClient.warn('clock_sync_error', { error: error.message });
        clock.startAutoSync();
    }
    startTime = clock.nowMs();

    try {
        const { version } = await withTimeout(B.fetchLatestBaileysVersion(), 20000, 'fetchLatestBaileysVersion');
        baileysVersion = version;
        logClient.info('baileys_version', { waVersion: version.join('.') });
    } catch (error) {
        logClient.warn('baileys_version_error', { error: error.message });
        baileysVersion = [2, 3000, 1017054665];
    }

    logClient.info('bot_starting');
    if (TEST_MODE || DISABLE_AUTO_MUTE || DISABLE_OLD_MESSAGE_SYNC) {
        logClient.info('test_mode_active', {
            testMode: TEST_MODE,
            autoMuteEnabled: !DISABLE_AUTO_MUTE,
            oldMessageSyncEnabled: !DISABLE_OLD_MESSAGE_SYNC
        });
    }
    connect();
}

if (require.main === module) {
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
