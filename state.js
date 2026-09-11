// Estado mutable compartido por todos los módulos.
//
// Cuando el código vivía en un único index.js, estas variables se compartían
// por cierre. Al separar en módulos, las movemos a este singleton para que
// handlers, auto-mute, baileys y demás lean/escriban el mismo estado sin
// necesidad de pasar el objeto `sock` ni las colecciones por argumento.

const state = {
    // Baileys
    B: null,
    sock: null,
    baileysVersion: null,
    reconnectAttempt: 0,

    // Concurrencia de mensajes y timers de bienvenida
    processingUsers: new Set(),
    welcomeTimers: new Map(),

    // Ids de mensajes que envió el propio bot (con timestamp). Sirve para que
    // el handler de salientes distinga una respuesta del dueño (cancela el
    // timer de alerta) de un eco del propio bot (no debe cancelarlo).
    botSentMessageIds: new Map(),

    // Alarma local
    alarmaSonando: false,

    // QR por Telegram (rate-limit)
    lastTelegramQrSentAt: 0,

    // Auto-mute
    autoMuteRetryTimeout: null,
    lastAutoMuteBusinessHours: null,
    autoMuteSyncIntervalId: null,
    resolvedMuteChatIds: [],

    // Caché de media de bienvenida
    welcomeMediaCache: new Map(),

    // Tiempo de arranque (para métricas)
    startTime: 0
};

module.exports = state;
