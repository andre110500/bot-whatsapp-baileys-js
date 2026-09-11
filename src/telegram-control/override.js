// Persistencia del override manual de horario (runtime-data/override.json).
// La usan dos procesos:
//   - El bot de WhatsApp (solo lee el archivo para tomar los cambios).
//   - El control por Telegram (escribe los comandos /abrir /cerrar /auto).
// El archivo es la única fuente de verdad compartida entre ambos.
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');

const log = logger.child('telegram-control');

const OVERRIDE_DIR = path.join(__dirname, '..', '..', 'runtime-data');
const OVERRIDE_FILE = path.join(OVERRIDE_DIR, 'override.json');

const VALID_MODES = ['auto', 'open', 'closed'];

function readOverrideFile() {
    try {
        if (!fs.existsSync(OVERRIDE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
        if (!parsed || !VALID_MODES.includes(parsed.mode)) return null;

        // Migración: los overrides viejos (sin expiresAt) se acotan a la sesión
        // en la que se dieron, igual que los nuevos.
        if (parsed.mode !== 'auto' && typeof parsed.expiresAt !== 'number') {
            const { computeOverrideExpiry } = require('../../config/schedule');
            const base = typeof parsed.updatedAt === 'number' ? new Date(parsed.updatedAt) : new Date();
            parsed.expiresAt = computeOverrideExpiry(base);
            log.info('override_expiry_backfilled', { mode: parsed.mode, expiresAt: parsed.expiresAt });
        }
        return parsed;
    } catch (error) {
        log.error('override_read_error', { error: error.message });
        return null;
    }
}

function writeOverrideFile(override) {
    try {
        fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
        const temporaryFile = `${OVERRIDE_FILE}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify(override, null, 2), 'utf8');
        fs.renameSync(temporaryFile, OVERRIDE_FILE);
    } catch (error) {
        log.error('override_write_error', { error: error.message });
    }
}

module.exports = {
    OVERRIDE_FILE,
    readOverrideFile,
    writeOverrideFile
};