// Alarma local: reproduce un sonido cuando un cliente no responde el welcome
// dentro del tiempo límite.
const path = require('path');
const { exec } = require('child_process');
const logger = require('../../logger');
const state = require('../../state');

const log = logger.child('alarm');

function reproducirAlarma() {
    if (state.alarmaSonando) {
        log.warn('reproducir_alarma_ignored', {
            reason: 'alarm_already_running'
        });
        return;
    }

    state.alarmaSonando = true;

    const mp3Path = path.join(__dirname, '..', '..', 'sonido.mp3');
    log.info('reproducir_alarma_start', { path: mp3Path });

    const command = `powershell -NoProfile -Command "Start-Process '${mp3Path}'"`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            state.alarmaSonando = false;
            log.error('reproducir_alarma_error', {
                error: error.message,
                stderr,
                stdout
            });
            return;
        }

        log.info('reproducir_alarma_success', { stdout, stderr });

        setTimeout(() => {
            state.alarmaSonando = false;
            log.info('reproducir_alarma_released', {
                reason: 'alarm_cooldown_finished'
            });
        }, 15000);
    });
}

module.exports = { reproducirAlarma };
