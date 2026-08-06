const fs = require('fs');
const path = require('path');
const { nowDate } = require('./clock');

// Configuración de niveles de log
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

const COLORS = {
    DEBUG: '\x1b[90m', // Gris
    INFO: '\x1b[36m',  // Cian
    WARN: '\x1b[33m',  // Amarillo
    ERROR: '\x1b[31m', // Rojo
    RESET: '\x1b[0m'
};

// Se determina el nivel de log por defecto en base a la variable de entorno, si existe. Por defecto es DEBUG
// (se muestran todos los niveles; usar LOG_LEVEL=INFO o LOG_LEVEL=ERROR para reducir ruido).
const DEFAULT_LEVEL = process.env.LOG_LEVEL && LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] !== undefined 
    ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] 
    : LOG_LEVELS.DEBUG;

// Directorio donde se guardarán los archivos de log
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Genera un ID de correlación aleatorio de 5 caracteres
function generateReqId() {
    return Math.random().toString(36).substring(2, 7);
}

// Obtiene la marca de tiempo en formato ISO 8601 con el offset de la zona horaria local
function getLocalISOTime() {
    const d = nowDate();
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    const millis = pad(d.getMilliseconds(), 3);
    
    // Calcular el offset en minutos (getTimezoneOffset() devuelve minutos inversos a UTC)
    const tzo = -d.getTimezoneOffset();
    const dif = tzo >= 0 ? '+' : '-';
    const tzoHours = pad(Math.floor(Math.abs(tzo) / 60));
    const tzoMins = pad(Math.abs(tzo) % 60);
    
    // Retorna el formato: YYYY-MM-DDTHH:mm:ss.SSS±HH:mm
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${dif}${tzoHours}:${tzoMins}`;
}

// Obtiene la fecha y hora para imprimir en la consola (sin offset ni milisegundos para ser más legible)
function getConsoleTime() {
    const d = nowDate();
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Obtiene la ruta del archivo de log correspondiente al día actual
function getLogFileName() {
    const d = nowDate();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return path.join(logsDir, `bot-${dateStr}.jsonl`);
}

// Escribe el log tanto en consola como en el archivo
function writeLog(levelName, mod, reqId, event, details = {}) {
    const currentLevel = LOG_LEVELS[levelName];
    if (currentLevel < DEFAULT_LEVEL) return;

    const ts = getLocalISOTime();
    
    // Prepara el objeto JSON para agregar al archivo
    const logObj = {
        ts,
        level: levelName,
        mod,
        event,
        ...(reqId && { reqId }),
        ...details
    };
    
    try {
        // Escribe al final del archivo en formato JSON Lines
        fs.appendFileSync(getLogFileName(), JSON.stringify(logObj) + '\n');
    } catch (err) {
        console.error('Error escribiendo log al archivo:', err);
    }
    
    // Formatea el mensaje para imprimir en la consola
    const color = COLORS[levelName] || COLORS.RESET;
    const consoleTime = getConsoleTime();
    
    let consoleMsg = `${consoleTime} [${levelName}] [${mod}]`;
    if (reqId) consoleMsg += ` [${reqId}]`;
    consoleMsg += ` ${event}`;
    
    const detailsKeys = Object.keys(details);
    if (detailsKeys.length > 0) {
        const detailsStr = detailsKeys.map(k => {
            let val = details[k];
            // Si el valor es un objeto, intenta serializarlo
            if (typeof val === 'object' && val !== null) {
                try { val = JSON.stringify(val); } catch(e) { val = '[Object]'; }
            }
            return `${k}=${val}`;
        }).join(' | ');
        consoleMsg += ` | ${detailsStr}`;
    }
    
    // Muestra el mensaje en la consola con colores
    console.log(`${color}${consoleMsg}${COLORS.RESET}`);
}

// Rotación de logs: borra los archivos de log con más de 30 días de antigüedad
function rotateLogs() {
    try {
        if (!fs.existsSync(logsDir)) return;
        const files = fs.readdirSync(logsDir);
        const now = nowDate();
        const MAX_AGE_DAYS = 30;
        const MS_PER_DAY = 1000 * 60 * 60 * 24;
        
        files.forEach(file => {
            // Verifica que el nombre del archivo coincida con el patrón esperado
            const match = file.match(/^bot-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            if (match) {
                const fileDate = new Date(match[1]);
                const ageDays = (now - fileDate) / MS_PER_DAY;
                
                if (ageDays > MAX_AGE_DAYS) {
                    fs.unlinkSync(path.join(logsDir, file));
                    console.log(`${COLORS.DEBUG}Log rotado (borrado archivo viejo): ${file}${COLORS.RESET}`);
                }
            }
        });
    } catch (err) {
        console.error('Error rotando logs:', err);
    }
}

// Ejecuta la rotación al cargar el módulo
rotateLogs();
// Programa la rotación para ejecutarse cada 24 horas
setInterval(rotateLogs, 24 * 60 * 60 * 1000).unref(); // .unref() permite que el proceso finalice si esto es lo único pendiente

class Logger {
    constructor(mod, reqId = null) {
        this.mod = mod;
        this.reqId = reqId;
    }
    
    debug(event, details = {}) {
        writeLog('DEBUG', this.mod, this.reqId, event, details);
    }
    
    info(event, details = {}) {
        writeLog('INFO', this.mod, this.reqId, event, details);
    }
    
    warn(event, details = {}) {
        writeLog('WARN', this.mod, this.reqId, event, details);
    }
    
    error(event, details = {}) {
        writeLog('ERROR', this.mod, this.reqId, event, details);
    }
    
    // Crea una instancia hija de este logger con el mismo módulo pero asigna un ID de correlación
    withReqId(reqId = null) {
        return new Logger(this.mod, reqId || generateReqId());
    }
}

module.exports = {
    // Crea un logger hijo con el contexto de módulo
    child: (mod) => new Logger(mod),
    // Exporta la función para generar IDs de correlación
    generateReqId
};
