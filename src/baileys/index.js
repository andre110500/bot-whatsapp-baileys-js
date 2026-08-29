// Conexión con WhatsApp a través de Baileys: creación del socket, QR,
// reconexión, eventos y arranque (boot).
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const clock = require('../../clock');
const logger = require('../../logger');
const telegram = require('../../telegram');
const state = require('../../state');
const { withTimeout } = require('../utils/promises');
const { AUTH_DIR, BAILEYS_LOG_LEVEL, isDisableAutoMute, isDisableOldMessageSync, isTestMode } = require('../../config/index');
const { upsertChat, upsertContacts, upsertMessagesCache, deleteChat } = require('../store');
const { lastConversationReplyTime, removeConversationReply } = require('../conversation');
const { resolveMuteChatIds, syncAutoMutedContacts, startAutoMuteContactsSync } = require('../auto-mute');
const { handleIncomingMessage } = require('../handlers/incoming');
const { handleOutgoingMessage } = require('../handlers/outgoing');

const logClient = logger.child('client');
const logMessage = logger.child('message');
const logConversation = logger.child('conversation');

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
        if (now - state.lastTelegramQrSentAt > 10000) {
            state.lastTelegramQrSentAt = now;
            telegram.notifyQr(qr);
        }
    } catch (error) {
        logClient.error('qr_file_error', { error: error.message });
    }
}

function handleReady() {
    const totalTime = ((clock.nowMs() - state.startTime) / 1000).toFixed(1);
    logClient.info('client_ready', { totalTime: Number(totalTime) });

    if (!isDisableAutoMute()) {
        resolveMuteChatIds().then(() => startAutoMuteContactsSync());

        // Revisar cada 60 segundos si cambió el estado (abierto/cerrado) para mutear/desmutear.
        if (!state.autoMuteSyncIntervalId) {
            let muteSyncRunning = false;
            state.autoMuteSyncIntervalId = setInterval(async () => {
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
    if (state.autoMuteRetryTimeout) {
        clearTimeout(state.autoMuteRetryTimeout);
        state.autoMuteRetryTimeout = null;
        state.lastAutoMuteBusinessHours = null;
    }
    telegram.notifyLogout('LOGOUT');
    logClient.error('client_logged_out', { error: 'LOGOUT' });

    // Para re-vincular hay que descartar las credenciales y arrancar de nuevo:
    // así Baileys emite un QR nuevo (que también se envía por Telegram).
    resetToFreshPairing();
}

function resetToFreshPairing() {
    try {
        if (state.sock) state.sock.end(undefined);
    } catch (error) {
        logClient.debug('logout_end_error', { error: error.message });
    }
    state.sock = null;

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
        state.reconnectAttempt = 0;
        logClient.info('connection_open', { user: state.sock && state.sock.user ? state.sock.user.id : null });

        // Reforzar el modo "en segundo plano": Baileys marca 'available' al
        // conectar salvo que lo evitemos; si el celular vuelve a quedar mudo,
        // es esta presence la que lo reactiva.
        try {
            state.sock.sendPresenceUpdate('unavailable').catch(() => {});
        } catch (err) {
            logClient.debug('presence_unavailable_error', { error: err.message });
        }

        handleReady();
        return;
    }

    if (connection === 'close') {
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
            ? lastDisconnect.error.output.statusCode
            : undefined;
        const errorMessage = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : 'closed';

        logClient.error('client_disconnected', { error: errorMessage, statusCode });

        if (statusCode === state.B.DisconnectReason.loggedOut) {
            handleLoggedOut();
            return;
        }

        // Reconexión automática con backoff exponencial
        const delayMs = Math.min(3000 * Math.pow(2, state.reconnectAttempt), 30000);
        state.reconnectAttempt += 1;
        logClient.warn('client_reconnecting', { attempt: state.reconnectAttempt, delayMs });
        setTimeout(connect, delayMs);
    }
}

function bindSocketEvents(saveCreds) {
    state.sock.ev.on('creds.update', () => {
        if (state.sock) saveCreds();
    });

    state.sock.ev.on('connection.update', handleConnectionUpdate);

    state.sock.ev.on('messages.upsert', async ({ messages, type }) => {
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

    state.sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
        if (isDisableOldMessageSync()) return;
        if (Array.isArray(chats)) chats.forEach(upsertChat);
        if (Array.isArray(contacts)) upsertContacts(contacts);
        if (Array.isArray(messages)) upsertMessagesCache(messages);
    });

    state.sock.ev.on('chats.upsert', (chats) => {
        if (Array.isArray(chats)) chats.forEach(upsertChat);
    });

    state.sock.ev.on('chats.update', (chats) => {
        if (Array.isArray(chats)) chats.forEach(upsertChat);
    });

    state.sock.ev.on('contacts.upsert', (contacts) => {
        upsertContacts(contacts);
    });

    // Si el usuario elimina un chat, quitamos también el respaldo local
    state.sock.ev.on('chats.delete', (jids) => {
        const jidList = Array.isArray(jids) ? jids : [];
        jidList.forEach((chatId) => {
            deleteChat(chatId);
            if (lastConversationReplyTime.has(chatId)) {
                removeConversationReply(chatId);
                logConversation.info('conversation_state_removed_with_chat', { chatId });
            }
        });
    });
}

async function connect() {
    try {
        const { state: authState, saveCreds } = await state.B.useMultiFileAuthState(AUTH_DIR);

        state.sock = state.B.makeWASocket({
            version: state.baileysVersion,
            auth: authState,
            logger: pino({ level: BAILEYS_LOG_LEVEL }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '126.0.0.0'],
            // IMPORTANTE: con true WhatsApp trata al bot como sesión activa y
            // el celular deja de sonar las notificaciones (aparecen sin audio).
            // En false el bot corre como dispositivo en segundo plano y el
            // celular sigue avisando con sonido.
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        bindSocketEvents(saveCreds);
    } catch (err) {
        logClient.error('connect_error', { error: err.message });
        setTimeout(connect, 5000);
    }
}

async function boot() {
    try {
        state.B = await import('@whiskeysockets/baileys');
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
    state.startTime = clock.nowMs();

    try {
        const { version } = await withTimeout(state.B.fetchLatestBaileysVersion(), 20000, 'fetchLatestBaileysVersion');
        state.baileysVersion = version;
        logClient.info('baileys_version', { waVersion: version.join('.') });
    } catch (error) {
        logClient.warn('baileys_version_error', { error: error.message });
        state.baileysVersion = [2, 3000, 1017054665];
    }

    logClient.info('bot_starting');
    if (isTestMode() || isDisableAutoMute() || isDisableOldMessageSync()) {
        logClient.info('test_mode_active', {
            testMode: isTestMode(),
            autoMuteEnabled: !isDisableAutoMute(),
            oldMessageSyncEnabled: !isDisableOldMessageSync()
        });
    }
    connect();
}

module.exports = { boot };
