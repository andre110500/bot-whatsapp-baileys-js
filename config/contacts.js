// Contactos de negocio: números a auto-mutear y números a ignorar,
// más utilidades de normalización de números / IDs de chat.

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

// Devuelve las variantes del número (con y sin el 9 de Argentina).
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

module.exports = {
    AUTO_MUTE_CONTACTS,
    IGNORED_NUMBERS,
    normalizeNumberVariants,
    normalizeAutoMuteChatId
};
