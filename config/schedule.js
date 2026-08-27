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
    minutesUntilOpen,
    formatDuration
};
