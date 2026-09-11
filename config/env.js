// Carga opcional de variables de entorno desde un archivo `.env` en la raíz
// del proyecto. Sin dependencias (el proyecto es cero-dependencias).
//
// Formato: KEY=VALUE (una por línea, comentarios con #, valores con o sin
// comillas). Las variables ya definidas en el entorno real NO se sobrescriben.
//
// Este módulo debe requerirse ANTES que cualquier otro que lea process.env en
// tiempo de carga (ver index.js).
const fs = require('fs');
const path = require('path');

// Convierte el contenido de un .env en un objeto { KEY: VALUE }.
function parseDotEnv(content) {
    const result = {};
    const lines = String(content || '').split(/\r?\n/);
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (!key) continue;

        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}

// Aplica al process.env las variables del archivo (si aún no están definidas).
function loadEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const parsed = parseDotEnv(fs.readFileSync(filePath, 'utf8'));
        for (const [key, value] of Object.entries(parsed)) {
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch (err) {
        // Un .env con problemas no debe romper el arranque del bot.
        console.error('Error leyendo .env:', err.message);
    }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

module.exports = { parseDotEnv, loadEnvFile };