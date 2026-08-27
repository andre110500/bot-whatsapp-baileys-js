// Descarga de buffers HTTP(S) con soporte de redirecciones.
const https = require('https');
const http = require('http');

function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;

        const doRequest = (currentUrl, redirectsLeft) => {
            const req = mod.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    const nextUrl = res.headers.location;
                    if (nextUrl.startsWith('/')) {
                        const parsed = new URL(currentUrl);
                        doRequest(`${parsed.protocol}//${parsed.host}${nextUrl}`, redirectsLeft - 1);
                    } else {
                        doRequest(nextUrl, redirectsLeft - 1);
                    }
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        buffer: Buffer.concat(chunks),
                        contentType: res.headers['content-type'] || 'image/jpeg'
                    });
                });
            });
            req.on('error', reject);
            req.setTimeout(20000, () => req.destroy(new Error('timeout_download')));
        };

        doRequest(url, 5);
    });
}

module.exports = { downloadBuffer };
