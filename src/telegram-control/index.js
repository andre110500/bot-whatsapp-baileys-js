// Control del bot de WhatsApp desde Telegram.
//
// Corre en un PROGRAMA PROPIO (app de PM2 whatsapp-bot-telegram-control), no
// dentro del bot de WhatsApp. Eso permite que las órdenes se confirmen aunque
// el bot de WhatsApp esté apagado o caído:
//   - Si el bot de WhatsApp está ONLINE (heartbeat fresco), la orden se escribe
//     en runtime-data/override.json y el bot la toma en ~30s.
//   - Si el bot está APAGADO/CAÍDO, la orden NO se aplica ni queda en cola:
//     se responde "❌ No se pudo aplicar" y no se toca el archivo.
//   - Las órdenes que lleguen con mucha demora (replay de un getUpdates viejo
//     tras un reinicio del control) se ignoran, para no aplicarlas fuera de
//     tiempo.
//
// Comandos: /abrir /cerrar /auto /estado (+ botones inline equivalentes).
const telegram = require('../../telegram');
const state = require('../../state');
const logger = require('../../logger');
const clock = require('../../clock');
const heartbeat = require('../heartbeat');
const { readOverrideFile, writeOverrideFile } = require('./override');
const { getScheduleForDate, isBusinessHours } = require('../../config/schedule');

const log = logger.child('telegram-control');

const LONG_POLL_TIMEOUT_SECONDS = 50;
const REVERT_CHECK_INTERVAL_MS = 60 * 1000;
// Una orden de texto más vieja que esto al llegar al control se descarta:
// evita aplicar a destiempo órdenes que quedaron en cola en Telegram (p.ej.
// el getUpdates arrancó de cero tras un reinicio del control).
const STALE_UPDATE_THRESHOLD_SECONDS = 120;

// Botones del menú de control. Solo se ofrece la acción que tiene sentido:
// si ya está abierto no hay botón "Abrir ahora" (y viceversa con "Cerrar").
function menuButtons() {
    const abierto = isBusinessHours();
    const firstRow = [];
    if (!abierto) firstRow.push({ text: '🔓 Abrir ahora', callback_data: 'abrir' });
    if (abierto) firstRow.push({ text: '🔒 Cerrar ahora', callback_data: 'cerrar' });
    return [
        firstRow,
        [{ text: '🔄 Automático', callback_data: 'auto' }, { text: '📊 Estado', callback_data: 'estado' }]
    ];
}

// ---------- override ----------

function setOverride(mode) {
    const override = { mode, updatedAt: Date.now(), source: 'telegram' };
    state.override = override;
    writeOverrideFile(override);
    log.info('override_set', { mode });
}

// Trae el archivo a memoria si cambió (el bot pudo revertir solo o el archivo
// puede haber quedado distinto tras un reinicio).
function refreshFromFile() {
    const persisted = readOverrideFile();
    if (persisted && persisted.mode !== state.override.mode) {
        state.override = persisted;
        log.info('override_reloaded', { mode: persisted.mode });
    }
}

function botOnline() {
    return heartbeat.monitorStatus().state === 'up';
}

// ---------- construcción de mensajes ----------

function formatSchedule() {
    const now = clock.nowDate();
    const schedule = getScheduleForDate(now);
    const start = `${String(Math.floor(schedule.start / 60)).padStart(2, '0')}:${String(schedule.start % 60).padStart(2, '0')}`;
    const endHour = Math.floor(schedule.end / 60) % 24;
    const endMin = schedule.end % 60;
    const end = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;
    return `Hoy: ${start} → ${end}`;
}

function currentStateText() {
    refreshFromFile();
    const { isOverridden } = require('../../config/schedule');
    const mode = state.override.mode;
    const abierto = isBusinessHours();
    const modeLabel = mode === 'open' ? 'abierto manual' : mode === 'closed' ? 'cerrado manual' : 'automático';

    return [
        '📊 Estado del bot',
        '',
        formatSchedule(),
        '',
        `Ahora: ${abierto ? '✅ ABIERTO' : '🔴 CERRADO'}`,
        `Modo: ${modeLabel}`,
        isOverridden() ? '⏰ Respecto al horario: override manual' : '⏰ Siguiendo el horario normal',
        '',
        `Bot de WhatsApp: ${botOnline() ? '✅ online' : '🔴 apagado o caído'}`
    ].join('\n');
}

const actionDescriptions = {
    abrir: '🔓 Abierto manualmente: el bot responde como si estuviera en horario.',
    cerrar: '🔒 Cerrado manualmente: el bot no responde pedidos, aunque sea horario.',
    auto: '🔄 Horario automático restaurado.'
};

const rejectionNotes = {
    rejected_offline: '❌ No se pudo aplicar la orden: el bot de WhatsApp está apagado o caído. La orden NO quedó pendiente; mandala de nuevo cuando el bot esté online.',
    rejected_stale: '❌ No se pudo aplicar la orden: llegó con mucha demora y no se aplican órdenes que quedaron pendientes. Enviá la orden de nuevo.'
};

function buildStatusMessage(action, note) {
    const lines = [];
    if (note) {
        lines.push(note, '');
    }
    if (action && actionDescriptions[action]) {
        lines.push(actionDescriptions[action], '');
    }
    lines.push(currentStateText());
    return lines.join('\n');
}

async function sendControlReply(action, result) {
    const note = result === 'rejected_offline' ? rejectionNotes.rejected_offline
        : result === 'rejected_stale' ? rejectionNotes.rejected_stale
        : null;
    const text = buildStatusMessage(result === 'applied' ? action : null, note);
    try {
        await telegram.sendCommandMenu(text, menuButtons());
    } catch (error) {
        log.error('control_reply_error', { error: error.message });
    }
}

// ---------- manejo de updates ----------

function isOwnerUpdate(update) {
    let chatId;
    if (update.message) chatId = update.message.chat && update.message.chat.id;
    if (update.callback_query) chatId = update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id;
    // Telegram devuelve el id como número; el env lo carga como string: comparar
    // normalizado para no descartar todas las órdenes (bug: chatId === CHAT_ID).
    return chatId != null && String(chatId) === String(telegram.getOwnerChatId());
}

function commandFromText(text) {
    if (typeof text !== 'string') return null;
    const match = /^\/(\w+)/.exec(text.trim());
    return match ? match[1].toLowerCase() : null;
}

function normalizeAction(command) {
    if (command === 'abrir' || command === 'open' || command === 'abierto') return 'abrir';
    if (command === 'cerrar' || command === 'close' || command === 'cerrado') return 'cerrar';
    if (command === 'auto' || command === 'automatico' || command === 'automatic') return 'auto';
    if (command === 'estado' || command === 'state' || command === 'status' || command === 'info') return 'estado';
    return null;
}

function manageMessageDate(message) {
    return typeof message.date === 'number' ? message.date : null;
}

// Para un /comando de texto, la fecha es la del envío: sirve para descartar
// replays viejos. Para los botones NO se usa esta fecha: el message.date del
// contenedor (p.ej. el /estado de hace horas) no indica cuándo se apretó el
// botón, así que el callback se trata siempre como acción "en vivo".
function isStaleUpdate(update) {
    if (!update || !update.message) return false;
    const ts = manageMessageDate(update.message);
    if (ts === null) return false;
    return Math.floor(Date.now() / 1000) - ts > STALE_UPDATE_THRESHOLD_SECONDS;
}

async function handleMessage(message) {
    const text = message.text || '';
    const command = commandFromText(text);

    if (command === 'start') {
        await sendControlReply(null);
        return;
    }

    const action = normalizeAction(command);
    if (action) {
        const result = applyAction(action, 'command', { stale: isStaleUpdate({ message }) });
        await sendControlReply(action, result);
    } else if (text.trim()) {
        await sendControlReply(null);
    }
}

async function handleCallback(callbackQuery) {
    const action = normalizeAction(callbackQuery.data);
    if (!action) return;

    const result = applyAction(action, 'button', {});
    const toast = result === 'rejected_offline' ? '❌ No se pudo aplicar (bot caído)'
        : result === 'rejected_stale' ? '❌ No se pudo aplicar (orden vieja)'
        : action === 'abrir' ? '✅ Orden: abrir'
        : action === 'cerrar' ? '✅ Orden: cerrar'
        : action === 'auto' ? '✅ Orden: automático'
        : '📊 Estado';
    try {
        await telegram.answerCallbackQuery(callbackQuery.id, toast);
    } catch (error) {
        log.error('answer_callback_error', { error: error.message });
    }
    await sendControlReply(action, result);
}

function applyAction(action, source, context) {
    log.info('command_received', { action, source });
    if (action === 'estado') return 'readonly';
    if (context && context.stale) {
        log.warn('command_rejected', { action, source, reason: 'stale' });
        return 'rejected_stale';
    }
    if (!botOnline()) {
        log.warn('command_rejected', { action, source, reason: 'offline' });
        return 'rejected_offline';
    }
    if (action === 'abrir') {
        setOverride('open');
    } else if (action === 'cerrar') {
        setOverride('closed');
    } else if (action === 'auto') {
        setOverride('auto');
    }
    log.info('command_applied', { action, source });
    return 'applied';
}

// ---------- polling ----------

let polling = false;

async function pollLoop() {
    let offset = 0;

    while (polling) {
        try {
            const updates = await telegram.getUpdates(offset, LONG_POLL_TIMEOUT_SECONDS);
            for (const update of Array.isArray(updates) ? updates : []) {
                if (update.update_id >= offset) offset = update.update_id + 1;
                if (!isOwnerUpdate(update)) continue;

                try {
                    if (update.callback_query) {
                        await handleCallback(update.callback_query);
                    } else if (update.message) {
                        await handleMessage(update.message);
                    }
                } catch (err) {
                    log.error('update_handling_error', { error: err.message });
                }
            }
        } catch (error) {
            log.warn('poll_error', { error: error.message });
            if (/409/i.test(error.message)) {
                log.error('poll_conflict', { hint: 'Otro proceso está consumiendo getUpdates' });
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

// Cada minuto, si el override ya quedó igual al horario normal, se revierte
// solo a 'auto' y se persiste.
async function revertLoop() {
    while (polling) {
        await new Promise((resolve) => setTimeout(resolve, REVERT_CHECK_INTERVAL_MS));
        try {
            refreshFromFile();
            const { revertOverrideIfMatches } = require('../../config/schedule');
            if (revertOverrideIfMatches()) {
                writeOverrideFile(state.override);
                log.info('override_auto_reverted');
                await sendControlReply(null);
            }
        } catch (error) {
            log.error('revert_check_error', { error: error.message });
        }
    }
}

function start() {
    if (!telegram.isConfigured()) {
        log.warn('control_disabled', { reason: 'telegram_not_configured' });
        return;
    }
    if (polling) return;

    refreshFromFile();
    if (state.override.mode === 'auto' && !state.override.updatedAt) {
        state.override = readOverrideFile() || { mode: 'auto', updatedAt: 0, source: null };
    }

    // Verificación inicial: revertir un override que ya quedó obsoleto.
    try {
        const { revertOverrideIfMatches } = require('../../config/schedule');
        if (revertOverrideIfMatches()) writeOverrideFile(state.override);
    } catch (error) {
        log.error('initial_revert_error', { error: error.message });
    }

    polling = true;
    pollLoop();
    void revertLoop();
    log.info('control_started');
}

module.exports = { start };