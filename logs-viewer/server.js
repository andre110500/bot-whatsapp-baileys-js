// Visor web de logs (JSON Lines) sin dependencias externas.
//
// Patrón probado estilo "log explorer" (tipo Grafana/pino):
//   - API HTTP de SOLO LECTURA sobre los archivos logs/bot-YYYY-MM-DD.jsonl
//     que genera logger.js.
//   - Frontend: una sola página estática (index.html) con filtros por
//     fecha, rango horario, evento (con wildcard), nivel, módulo y búsqueda.
//
// Uso:
//   LOGS_UI_HOST=127.0.0.1 LOGS_UI_PORT=9888 node logs-viewer/server.js
//
//   Bindeado a 127.0.0.1 por defecto: para verlo desde el celular en la
//   misma red usar LOGS_UI_HOST=0.0.0.0.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const HOST = process.env.LOGS_UI_HOST || '127.0.0.1';
const PORT = parseInt(process.env.LOGS_UI_PORT || '9888', 10);
const DEFAULT_LIMIT = 1000;
const MAX_RESULTS = 5000;
const MAX_CACHE = 90;

const cache = new Map(); // date -> { key, rows, facets }

function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function listDates() {
    if (!fs.existsSync(LOGS_DIR)) return [];
    const out = [];
    for (const name of fs.readdirSync(LOGS_DIR)) {
        const m = name.match(/^bot-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        const file = path.join(LOGS_DIR, name);
        try {
            const st = fs.statSync(file);
            out.push({ date: m[1], file: name, size: st.size, mtimeMs: st.mtimeMs });
        } catch (err) { /* archivo inaccesible: se omite */ }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
}

function computeFacets(rows) {
    const counts = (key) => {
        const m = new Map();
        for (const r of rows) {
            const v = r[key];
            if (v == null) continue;
            m.set(v, (m.get(v) || 0) + 1);
        }
        return Array.from(m.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
    };
    return { events: counts('event'), mods: counts('mod'), levels: counts('level') };
}

function loadDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const file = path.join(LOGS_DIR, `bot-${date}.jsonl`);
    if (!fs.existsSync(file)) return null;

    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(date);
    if (hit && hit.key === key) return hit;

    const text = fs.readFileSync(file, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const o = JSON.parse(t);
            if (o && typeof o === 'object' && typeof o.ts === 'string') rows.push(o);
        } catch (err) { /* línea corrupta: se omite */ }
    }

    const entry = { key, rows, facets: computeFacets(rows) };
    cache.set(date, entry);
    if (cache.size > MAX_CACHE) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
    }
    return entry;
}

function toRow(o) {
    const { ts, level, mod, event, reqId, ...fields } = o;
    return { ts, level, mod, event, reqId, fields };
}

function parseCSV(value) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function matchToken(token, value) {
    if (typeof value !== 'string') return false;
    if (token.endsWith('*')) {
        const prefix = token.slice(0, -1);
        return value.startsWith(prefix);
    }
    return value === token;
}

function queryLogs(params, data, date) {
    const events = params.get('events');
    const levels = params.get('levels');
    const mods = params.get('mods');
    const from = /^\d{2}:\d{2}$/.test(params.get('from') || '') ? params.get('from') : '';
    const to = /^\d{2}:\d{2}$/.test(params.get('to') || '') ? params.get('to') : '';
    const search = (params.get('search') || '').trim();
    const limitRaw = parseInt(params.get('limit') || '', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_RESULTS) : DEFAULT_LIMIT;

    const evTokens = events ? parseCSV(events) : null;
    const lvTokens = levels ? parseCSV(levels) : null;
    const mdTokens = mods ? parseCSV(mods) : null;

    let rows = data.rows;
    if (evTokens) rows = rows.filter((r) => evTokens.some((t) => matchToken(t, r.event)));
    if (lvTokens) rows = rows.filter((r) => lvTokens.some((t) => matchToken(t, r.level)));
    if (mdTokens) rows = rows.filter((r) => mdTokens.some((t) => matchToken(t, r.mod)));
    if (from || to) {
        rows = rows.filter((r) => {
            const hm = typeof r.ts === 'string' ? r.ts.slice(11, 16) : '';
            return (!from || hm >= from) && (!to || hm <= to);
        });
    }
    if (search) {
        const needle = search.toLowerCase();
        rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
    }

    const count = rows.length;
    const result = rows.slice(0, limit).map(toRow);
    return {
        date,
        file: data.file,
        total: data.rows.length,
        count,
        limit,
        truncated: count > limit,
        rows: result,
        facets: data.facets
    };
}

function serveIndex(res) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
        if (err) {
            sendJSON(res, 500, { error: 'index_not_found' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': buf.length
        });
        res.end(buf);
    });
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
        sendJSON(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    if (p === '/' || p === '/index.html') {
        serveIndex(res);
        return;
    }
    if (p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (p === '/api/dates') {
        sendJSON(res, 200, { dates: listDates() });
        return;
    }
    if (p === '/api/logs') {
        const param = (key) => u.searchParams.get(key);
        const date = param('date');
        if (!date) {
            sendJSON(res, 400, { error: 'missing_date' });
            return;
        }
        const data = loadDate(date);
        if (!data) {
            sendJSON(res, 404, { error: 'no_logs_for_date', date });
            return;
        }
        sendJSON(res, 200, queryLogs(u.searchParams, data, date));
        return;
    }

    sendJSON(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`Visor de logs disponible en ${url}`);
    console.log('Cerrar con Ctrl+C.');
    if (process.env.LOGS_UI_NO_OPEN === '1') return;
    try {
        const cmd = process.platform === 'win32'
            ? `start "" "${url}"`
            : process.platform === 'darwin'
                ? `open "${url}"`
                : `xdg-open "${url}" >/dev/null 2>&1`;
        exec(cmd, () => {});
    } catch (err) { /* no abrir el navegador no es fatal */ }
});