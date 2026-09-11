// Sincronización del override manual en el proceso del BOT de WhatsApp.
//
// El control por Telegram corre en un proceso aparte y escribe el override en
// runtime-data/override.json. Este módulo re-lee el archivo cada 30s para que
// el bot tome las órdenes (/abrir, /cerrar, /auto) al instante y además
// revierta solo cuando el horario normal alcanza al estado forzado.
const logger = require('../../logger');
const { readOverrideFile, writeOverrideFile } = require('./override');
const { revertOverrideIfMatches } = require('../../config/schedule');
const state = require('../../state');

const log = logger.child('telegram-control');

const SYNC_INTERVAL_MS = 30 * 1000;

function syncOverrideFromFile() {
    try {
        const persisted = readOverrideFile();
        if (persisted && persisted.mode !== state.override.mode) {
            state.override = persisted;
            log.info('override_synced', { mode: persisted.mode });
        }

        // Si el override ya queda igual al horario normal, vuelve a 'auto'.
        if (revertOverrideIfMatches()) {
            writeOverrideFile(state.override);
            log.info('override_synced_reverted');
        }
    } catch (error) {
        log.error('override_sync_error', { error: error.message });
    }
}

function startOverrideSync() {
    syncOverrideFromFile();
    setInterval(syncOverrideFromFile, SYNC_INTERVAL_MS).unref();
}

module.exports = { syncOverrideFromFile, startOverrideSync };