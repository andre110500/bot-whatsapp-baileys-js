# Bot de WhatsApp — versión Baileys

Migración del bot de `whatsapp-web.js` a **Baileys** (`@whiskeysockets/baileys` 6.7.24). Misma lógica de negocio, sin Chromium/puppeteer: se conecta por WebSocket directo, mucho menos consumo de recursos y sin los deslogueos asociados a la regresión del renderer.

## Requisitos

- **Node.js >= 20** (Baileys 6.7.24 bloquea la instalación en Node 18). El proyecto instala **Node v20.20.2 a nivel proyecto** en `node_modules/.bin` (devDependency `node-win-x64`), así que `npm start`/`npm test` usan ese Node local sin tocar la versión global. En el servidor instalar Node 20 LTS.
- Windows (usa PowerShell para la alarma local).

## Instalación

```bash
npm install
```

> El repositorio incluye un `.npmrc` con `ignore-scripts=true`: evita que Baileys (que exige Node 20) falle durante la instalación cuando el Node global es 18. El binario local de Node se baja solo como parte del `npm install`.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token del bot de BotFather para alertas de logout y QR. |
| `TELEGRAM_CHAT_ID` | ID del chat/telegram donde se envían las alertas. |
| `LOG_LEVEL` | `DEBUG` (default), `INFO`, `WARN`, `ERROR`. |
| `BAILEYS_LOG_LEVEL` | Nivel del logger interno de Baileys. Default `silent` (usar `warn`/`error` para debuggear conexión). |
| `TEST_MODE` | `1` = modo prueba de bienvenida: el bot responde la bienvenida en cualquier circunstancia (no bloquea por horario ni por la regla de las 4 horas). Ideal para probar fuera de horario de trabajo. |
| `DISABLE_AUTO_MUTE` | `1` apaga el auto-mute/desmute por horario comercial. Solo para probar. |
| `DISABLE_OLD_MESSAGE_SYNC` | `1` ignora el historial de WhatsApp (mensajes viejos) y solo usa mensajes nuevos en vivo. Solo para probar. |

> **Importante:** `TEST_MODE` y las variables `DISABLE_*` están pensadas solo para probar el bot en desarrollo. En producción (servidor) no definirlas. Al arrancar, el bot loguea `test_mode_active` si alguna está activa.

## Uso

```bash
npm start          # arranca el bot (muestra QR en consola)
npm test           # chequeo de sintaxis + smoke test de la lógica
```

La sesión se guarda en `auth_info/` (reemplaza a `.wwebjs_auth`). La primera vez hay que escanear el QR (también se guarda en `auth_info/qr.svg` y se envía por Telegram si está configurado).

### PM2

```bash
pm2 start ecosystem.config.js     # usa el Node v20 local del proyecto (no el global)
pm2 save                          # persiste la lista para restaurarla al encender la PC
pm2 logs whatsapp-bot-baileys
pm2 restart whatsapp-bot-baileys  # reiniciar
pm2 delete whatsapp-bot-baileys   # detener y quitar
```

- `ecosystem.config.js` apunta el intérprete al Node v20 instalado a nivel proyecto (`node_modules/node-win-x64/bin/node.exe`), así Baileys corre con Node 20 aunque el Node global sea 18. En servidores sin el binario local (ej. Linux) cae al `node` global; ahí instalar Node 20 LTS.
- **Auto-inicio en Windows**: se usa `pm2-windows-startup` (`pm2 save` al final; al encender la PC se ejecuta `pm2 resurrect`). En servidores Linux: `pm2 startup` + `pm2 save`.

## Qué replica del bot original

- **Bienvenida**: mensaje de texto + 5 imágenes de menú (con caché de descarga), solo en horario comercial y solo si no hubo respuesta propia en las últimas **4 horas** (regla persistida en `runtime-data/conversation-replies.json`).
- **Despedida**: al detectar frases tipo "ahí va"/"ahí sale" en los mensajes del dueño, envía el mensaje de agradecimiento (rate-limit de 4 h).
- **Alias/transferencia**: si el cliente menciona alias/mercado pago, responde con `latentacion.ar` y `a nombre de carito llerena`.
- **Horarios con feriados**: `holidays-2026.json`, turnos que cruzan la medianoche (ej. viernes hasta la 01:00).
- **Auto-mute**: silencia `AUTO_MUTE_CONTACTS` durante el horario comercial y los desmutea fuera (sync cada 60 s con reintento a los 60 s ante errores).
- **Números ignorados**: `IGNORED_NUMBERS` no recibe respuestas.
- **Alarma local**: suena `sonido.mp3` si pasan 4 minutos sin respuesta del dueño tras un welcome.
- **Alertas Telegram**: aviso de logout y QR remoto (PNG), con throttle de 10 s.

## Diferencias técnicas respecto a whatsapp-web.js

| Concepto | wwebjs | Baileys (este bot) |
|---|---|---|
| Sesión | `.wwebjs_auth` (Chromium) | `auth_info/` (Multi-File Auth) |
| Buscar chat | `client.getChats()` / `getNumberId()` | Mini-store en memoria + `sock.onWhatsApp()` |
| Historial | `chat.fetchMessages()` | Mini-store alimentado por `messages.upsert` / `messaging-history.set` |
| Mute | `client.muteChat()` | `sock.chatModify({ mute: 7d })` / `{ mute: null }` |
| QR | evento `qr` | `connection.update` (campo `qr`) |
| Logout | evento `disconnected` (reason `LOGOUT`) | `connection.update` cerrado con `DisconnectReason.loggedOut` (401) |
| Reconexión | automática | Manual con backoff exponencial (3 s → 30 s) |

- **Baileys 6.7.24 es ESM-only**: se carga con `import()` dinámico desde CommonJS (por eso `index.js` sigue siendo `.js` CJS y reutiliza `logger.js`, `telegram.js`, `messages.js` sin cambios).
- No existe el bug `"r"` de wwebjs: no hay circuit breaker, pero se conservan `withTimeout()`/`withRetry()` para que ninguna llamada cuelgue el proceso.
- Al desloguearse, el bot **borra `auth_info/` y arranca de nuevo** para generar un QR nuevo y re-vincular el dispositivo (el QR se envía por Telegram).

## Archivos

- `index.js` — bot principal (toda la lógica).
- `logger.js`, `telegram.js`, `messages.js`, `holidays-2026.json`, `sonido.mp3` — reutilizados del bot original.
- `test-smoke.js` — smoke test de horarios, números y proto de mensajes.
