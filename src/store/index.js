// Mini-store en memoria (reemplaza makeInMemoryStore, ausente en Baileys 6.7.24)
// y helpers de lectura sobre el chat/contacto.
const clock = require('../../clock');
const logger = require('../../logger');

const logContact = logger.child('contact');

const chatsCache = new Map();    // jid -> Chat
const contactsCache = new Map(); // jid -> Contact
const messagesCache = new Map(); // jid -> Map(msgId -> WAMessage)

function upsertChat(chat) {
    if (!chat || !chat.id) return;
    const prev = chatsCache.get(chat.id);
    chatsCache.set(chat.id, { ...(prev || {}), ...chat });
}

function upsertContacts(contacts) {
    if (!Array.isArray(contacts)) return;
    for (const c of contacts) {
        if (c && c.id) contactsCache.set(c.id, c);
    }
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

function chatsValues() {
    return Array.from(chatsCache.values());
}

function deleteChat(jid) {
    chatsCache.delete(jid);
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

module.exports = {
    chatsCache,
    contactsCache,
    messagesCache,
    upsertChat,
    upsertContacts,
    upsertMessagesCache,
    loadLastMessages,
    getChatFromStore,
    chatsValues,
    deleteChat,
    isGroupJid,
    isMutedChat,
    getContactInfo
};
