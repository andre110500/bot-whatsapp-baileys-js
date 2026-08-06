// Smoke test de la lógica del bot (no conecta a WhatsApp).
// Ejecutar con Node 20+.
const assert = require('assert');
const m = require('./index');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
}

// --- getScheduleForDate (horarios con feriados) ---
// Miércoles 2026-02-25 (día hábil): horario normal de miércoles (20:00 - 24:30)
const wednesday = new Date(2026, 1, 25, 12, 0);
check('schedule weekday', () => {
    const s = m.getScheduleForDate(wednesday);
    assert.strictEqual(s.start, 20 * 60);
    assert.strictEqual(s.end, 24 * 60 + 30);
});

// Sábado 2026-02-28: 13:00 - 25:00
const saturday = new Date(2026, 1, 28, 12, 0);
check('schedule saturday', () => {
    const s = m.getScheduleForDate(saturday);
    assert.strictEqual(s.start, 13 * 60);
    assert.strictEqual(s.end, 25 * 60);
});

// Feriado: 1 de enero de 2026 (jueves). Mañana (2/1) es día hábil => domingo
const holiday = new Date(2026, 0, 1, 12, 0);
check('holiday thursday -> sunday schedule', () => {
    assert.strictEqual(m.isHoliday(holiday), true);
    const s = m.getScheduleForDate(holiday);
    assert.strictEqual(s.start, 13 * 60);
    assert.strictEqual(s.end, 24 * 60 + 30);
});

// --- normalizeNumberVariants ---
check('normalize 549 -> also 54', () => {
    assert.deepStrictEqual(m.normalizeNumberVariants('5493764796077'), ['5493764796077', '543764796077']);
});
check('normalize 54 -> also 549', () => {
    assert.deepStrictEqual(m.normalizeNumberVariants('543764796077'), ['543764796077', '5493764796077']);
});

// --- getMessageBody / getMessageType (proto de Baileys) ---
check('body conversation', () => {
    assert.strictEqual(m.getMessageBody({ message: { conversation: 'hola' } }), 'hola');
});
check('body extendedText', () => {
    assert.strictEqual(m.getMessageBody({ message: { extendedTextMessage: { text: 'qué tal' } } }), 'qué tal');
});
check('body image caption', () => {
    assert.strictEqual(m.getMessageBody({ message: { imageMessage: { caption: 'foto' } } }), 'foto');
});
check('type chat/image/ptt/sticker', () => {
    assert.strictEqual(m.getMessageType({ message: { conversation: 'x' } }), 'chat');
    assert.strictEqual(m.getMessageType({ message: { imageMessage: {} } }), 'image');
    assert.strictEqual(m.getMessageType({ message: { audioMessage: { ptt: true } } }), 'ptt');
    assert.strictEqual(m.getMessageType({ message: { stickerMessage: {} } }), 'sticker');
});

// --- jids ---
check('isGroupJid', () => {
    assert.strictEqual(m.isGroupJid('123@g.us'), true);
    assert.strictEqual(m.isGroupJid('54911@s.whatsapp.net'), false);
});

// --- isMutedChat ---
check('isMutedChat', () => {
    assert.strictEqual(m.isMutedChat({ muteEndTime: Date.now() + 10000 }), true);
    assert.strictEqual(m.isMutedChat({ muteEndTime: null }), false);
    assert.strictEqual(m.isMutedChat({}), false);
});

// --- loadLastMessages (mini-store) ---
check('loadLastMessages orden', () => {
    const now = Math.floor(Date.now() / 1000);
    m.upsertMessagesCache([
        { key: { remoteJid: 'x@s.whatsapp.net', id: '1', fromMe: true }, message: { conversation: 'viejo' }, messageTimestamp: now - 7200 },
        { key: { remoteJid: 'x@s.whatsapp.net', id: '2', fromMe: false }, message: { conversation: 'reciente' }, messageTimestamp: now - 60 },
        { key: { remoteJid: 'x@s.whatsapp.net', id: '3', fromMe: true }, message: { conversation: 'ultimo' }, messageTimestamp: now - 30 }
    ]);
    const last = m.loadLastMessages('x@s.whatsapp.net', 2);
    assert.strictEqual(last.length, 2);
    assert.strictEqual(last[1].key.id, '3');
    assert.strictEqual(last[0].key.id, '2');
});

console.log(`\n${passed} checks OK`);
