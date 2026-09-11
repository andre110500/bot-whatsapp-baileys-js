// Horario laboral y feriados.
//
// Horarios (día 0 = domingo):
//   - Lunes a Jueves: 20:00 → 00:30
//   - Viernes:          20:00 → 01:00
//   - Sábado:           13:00 → 01:00
//   - Domingo:          13:00 → 00:30
// Los `end` mayores a 24*60 indican que la sesión cruza la medianoche.
const clock = require('../clock');
const holidays = require('../holidays-2026.json');
const { isTestMode } = require('./index');
const state = require('../state');

// Días considerados fin de semana (para decidir horario en feriados).
function isWeekendDay(dayNumber) {
    return dayNumber === 0 || dayNumber === 6;
}

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
        const isTomorrowWeekend = isWeekendDay(tomorrowDay);

        return isHoliday(tomorrow) || isTomorrowWeekend ? schedule[6] : schedule[0];
    }

    return schedule[date.getDay()];
}

function isBusinessHours() {
    if (isTestMode()) return true;

    // Override manual (Telegram): fuerza abierto o cerrado.
    const override = state.override;
    if (override && override.mode === 'open') return true;
    if (override && override.mode === 'closed') return false;

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

// true si hay un override manual activo (abierto o cerrado), sin importar cuál.
function isOverridden() {
    const override = state.override;
    return Boolean(override && override.mode !== 'auto');
}

// Estado efectivo considerando el horario normal Y el override:
//   'open' | 'closed'
function isOpenEffectively() {
    return isBusinessHours();
}

// Si el override manual ya coincide con el horario normal (p.ej. forzaste
// "abrir" y ya llegó la hora normal de abrir), se revierte solo a 'auto'.
// El módulo de control por Telegram es el encargado de persistir el cambio.
function revertOverrideIfMatches() {
    const override = state.override;
    if (!override || override.mode === 'auto') return false;

    // Expiración por sesión: si la sesión para la que se dio la orden ya
    // terminó, el override muere aunque la PC haya estado apagada durante el
    // momento exacto del cierre oficial (nadie observó el instante en que el
    // horario normal alcanzó al estado forzado).
    if (override.expiresAt && Date.now() > override.expiresAt) {
        state.override = { mode: 'auto', updatedAt: Date.now(), source: 'auto-revert' };
        return true;
    }

    const now = clock.nowDate();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hour * 60 + minutes;
    const today = getScheduleForDate(now);
    const yesterday = getScheduleForDate(shiftDateByDays(now, -1));
    const isOpenToday = currentTimeMinutes >= today.start;
    const isOpenFromYesterday = currentTimeMinutes < (yesterday.end - 24 * 60);
    const scheduledOpen = isOpenToday || isOpenFromYesterday;

    const overrideOpen = override.mode === 'open';
    if (overrideOpen === scheduledOpen) {
        state.override = { mode: 'auto', updatedAt: Date.now(), source: 'auto-revert' };
        return true;
    }
    return false;
}

// Calcula el momento (ms) en que expira un override dado en `date`:
//   - si hay una sesión de ayer que sigue abierta cruzando la medianoche,
//     expira al final de ESA sesión;
//   - en cualquier otro caso expira al final del turno de hoy (ya sea que hoy
//     ya abrió, o que vaya a abrir más tarde: la próxima sesión es siempre la
//     de hoy).
// Garantiza que una orden manual no pueda sobrevivir más allá del turno al que
// pertenece, caiga o no la PC durante el cierre oficial.
function computeOverrideExpiry(date = new Date()) {
    const currentTimeMinutes = date.getHours() * 60 + date.getMinutes();
    const today = getScheduleForDate(date);
    const yesterday = getScheduleForDate(shiftDateByDays(date, -1));
    const dayStart0 = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

    const endsAfterMidnight = yesterday.end - 24 * 60;

    let endMs;
    if (currentTimeMinutes < endsAfterMidnight) {
        // turno de ayer que sigue despachando hoy de madrugada
        endMs = dayStart0 + endsAfterMidnight * 60 * 1000;
    } else {
        // turno de hoy (hoy.end puede pasar de 24 h: 25:00 = 01:00 del día
        // siguiente). Si el negocio está cerrado, la próxima sesión que abrirá
        // es la de hoy, así que el override expira al cierre de ese turno.
        endMs = dayStart0 + today.end * 60 * 1000;
    }
    return endMs;
}

// Cantidad de minutos restantes hasta que abra el negocio (se llama solo
// cuando isBusinessHours() es false). La apertura siempre es today.start, ya
// que cuando está cerrado nunca hay sesión abierta de ayer pasando de hora.
function minutesUntilOpen() {
    const now = clock.nowDate();
    const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
    const today = getScheduleForDate(now);
    const until = today.start - currentTimeMinutes;
    return until > 0 ? until : 0;
}

// Formatea una cantidad de minutos como "X h Y min" (legible en un mensaje).
function formatDuration(totalMinutes) {
    const total = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (hours > 0 && minutes > 0) return `${hours} h ${minutes} min`;
    if (hours > 0) return `${hours} h`;
    return `${minutes} min`;
}

module.exports = {
    formatDateKey,
    shiftDateByDays,
    isHoliday,
    getScheduleForDate,
    isBusinessHours,
    isOverridden,
    isOpenEffectively,
    revertOverrideIfMatches,
    computeOverrideExpiry,
    minutesUntilOpen,
    formatDuration
};
