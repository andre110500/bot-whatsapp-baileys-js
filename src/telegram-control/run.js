// Punto de entrada del control por Telegram (app PM2 independiente:
// whatsapp-bot-telegram-control). Corre aunque el bot de WhatsApp esté
// apagado; las órdenes se persisten en runtime-data/override.json.
require('../../config/env');

const { start } = require('./index');

start();