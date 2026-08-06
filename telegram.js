// Alerta de logout + envío de QR por Telegram.
// Cero dependencias externas: usa https, zlib y el propio QR de qrcode-terminal.
// Configuración vía variables de entorno:
//   TELEGRAM_BOT_TOKEN  (token del bot de BotFather)
//   TELEGRAM_CHAT_ID    (ID del chat donde se envían las alertas)
// Si no están configuradas, notifyLogout() y notifyQr() no hacen nada.
const https = require('https');
const zlib = require('zlib');
const logger = require('./logger');

const log = logger.child('telegram');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function isConfigured() {
    return Boolean(BOT_TOKEN && CHAT_ID);
}

// ------------------ HTTP (Bot API) ------------------

function apiRequest(method, bodyBuf, contentType) {
    return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(bodyBuf)
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.ok) {
                        resolve(json.result);
                    } else {
                        reject(new Error(`Telegram API: ${(json && json.description) || data.slice(0, 200)}`));
                    }
                } catch (err) {
                    reject(new Error(`Respuesta inválida de Telegram: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}

function sendMessage(text) {
    const body = JSON.stringify({ chat_id: CHAT_ID, text });
    return apiRequest('sendMessage', body, 'application/json');
}

function sendPhoto(pngBuffer, caption) {
    const boundary = '----wabot' + Math.random().toString(16).slice(2);
    const enc = (s) => Buffer.from(s, 'utf8');

    const parts = [];
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`));
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="qr.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(pngBuffer);
    parts.push(enc(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    parts.push(enc(`--${boundary}--\r\n`));

    return apiRequest('sendPhoto', Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
}

// ------------------ Render de QR a PNG (sin dependencias) ------------------

let crcTable = null;
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// Reutiliza el mismo motor QR que usa qrcode-terminal para armar la matriz
// y la rasteriza a un PNG en escala de grises (1 byte por píxel).
function renderQrToPng(qr) {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

    const visualQr = new QRCode(-1, QRErrorCorrectLevel.L);
    visualQr.addData(qr);
    visualQr.make();

    const modules = visualQr.modules;
    const moduleCount = visualQr.getModuleCount();
    const cellSize = 8;
    const quietZone = 4;
    const size = (moduleCount + quietZone * 2) * cellSize;

    const rawRows = [];
    for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size); // 1 byte de filtro + 1 byte por píxel
        const moduleRow = Math.floor((y - quietZone * cellSize) / cellSize);
        for (let x = 0; x < size; x++) {
            const moduleCol = Math.floor((x - quietZone * cellSize) / cellSize);
            const dark = moduleRow >= 0 && moduleRow < moduleCount &&
                moduleCol >= 0 && moduleCol < moduleCount &&
                modules[moduleRow] && modules[moduleRow][moduleCol];
            row[1 + x] = dark ? 0 : 255;
        }
        rawRows.push(row);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 0;  // escala de grises
    ihdr[10] = 0; // compresión deflate
    ihdr[11] = 0; // filtro adaptativo off
    ihdr[12] = 0; // sin interlace

    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rawRows))),
        pngChunk('IEND', Buffer.alloc(0))
    ]);

    return png;
}

// ------------------ Notificaciones ------------------

// Avisa por Telegram que la sesión se deslogueó.
async function notifyLogout(reason) {
    if (!isConfigured()) return;
    const date = new Date().toLocaleString('es-AR');
    const text = `⚠️ El bot de WhatsApp se deslogueó\n\n` +
        `Hora: ${date}\n` +
        `Motivo: ${reason || 'desconocido'}\n\n` +
        `El bot sigue corriendo. Cuando WhatsApp genere el QR nuevo te lo envío por acá para re-vincular el dispositivo.`;
    try {
        await sendMessage(text);
        log.warn('telegram_logout_sent', { reason });
    } catch (error) {
        log.error('telegram_logout_error', { error: error.message });
    }
}

// Envía el QR como imagen PNG para poder vincular el dispositivo de forma remota.
async function notifyQr(qr) {
    if (!isConfigured()) return;
    try {
        const png = renderQrToPng(qr);
        await sendPhoto(png, '📲 Escaneá este QR para vincular el bot.\nExpira en ~1 minuto.');
        log.warn('telegram_qr_sent');
    } catch (error) {
        log.error('telegram_qr_error', { error: error.message });
    }
}

module.exports = {
    isConfigured,
    notifyLogout,
    notifyQr
};
