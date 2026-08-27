// Auto-mute de contactos en horario comercial: muta/desmuta los chats de los
// números configurados según el estado abierto/cerrado del negocio.
const state = require('../../state');
const logger = require('../../logger');
const { AUTO_MUTE_CONTACTS, normalizeNumberVariants, normalizeAutoMuteChatId } = require('../../config/contacts');
const { isBusinessHours } = require('../../config/schedule');
const { chatsValues, isGroupJid } = require('../store');
const { withTimeout } = require('../utils/promises');

const logMute = logger.child('mute');

const AUTO_MUTE_RETRY_DELAY = 60 * 1000;
const AUTO_MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

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
    const sock = state.sock;
    const foundIds = [];

    // Primero en chats conocidos del mini-store
    for (const chat of chatsValues()) {
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

    state.resolvedMuteChatIds = foundIds;
    if (state.resolvedMuteChatIds.length > 0) {
        logMute.info('auto_mute_ids_resolved', { count: state.resolvedMuteChatIds.length });
    }
}

async function syncAutoMutedContacts(force = false) {
    const sock = state.sock;
    const chatIds = state.resolvedMuteChatIds.filter(Boolean);

    if (chatIds.length === 0) return;

    const businessHours = isBusinessHours();
    if (!force && businessHours === state.lastAutoMuteBusinessHours) return;

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

    state.lastAutoMuteBusinessHours = hadError ? null : businessHours;
    return !hadError;
}

async function startAutoMuteContactsSync() {
    if (state.autoMuteRetryTimeout) {
        clearTimeout(state.autoMuteRetryTimeout);
        state.autoMuteRetryTimeout = null;
    }

    const success = await syncAutoMutedContacts(true);
    if (!success) {
        state.autoMuteRetryTimeout = setTimeout(() => {
            startAutoMuteContactsSync();
        }, AUTO_MUTE_RETRY_DELAY);
    }
}

module.exports = {
    resolveMuteChatIds,
    syncAutoMutedContacts,
    startAutoMuteContactsSync,
    autoMuteContactMatches
};
