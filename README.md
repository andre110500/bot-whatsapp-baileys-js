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

Se pueden definir en un archivo **`.env`** en la raíz del proyecto (copiá `.env.example` y completá; `.env` está en `.gitignore`, no se sube al repo) o como variables del entorno/PM2. Si existen en ambos lados, gana la del entorno real. Se cargan al arrancar desde `config/env.js` (sin dependencias).

| Variable | Descripción |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token del bot de BotFather. Necesario para alertas, el monitor de apagado y el control por Telegram. |
| `TELEGRAM_CHAT_ID` | ID del chat de Telegram (tu chat personal). Es el único chat que recibe alertas y al que el control le obedece. |
| `WELCOME_ALERT_TIMEOUT` | Segundos de espera de respuesta del dueño tras un welcome antes de disparar la alarma local + el aviso 🔔 por Telegram. Default `240` (4 min). |
| `LOG_LEVEL` | `DEBUG` (default), `INFO`, `WARN`, `ERROR`. |
| `BAILEYS_LOG_LEVEL` | Nivel del logger interno de Baileys. Default `silent` (usar `warn`/`error` para debuggear conexión). |
| `TEST_MODE` | `1` = modo prueba de bienvenida: el bot responde la bienvenida en cualquier circunstancia (no bloquea por horario ni por la regla de las 4 horas). Ideal para probar fuera de horario de trabajo. |
| `DISABLE_AUTO_MUTE` | `1` apaga el auto-mute/desmute por horario comercial. Solo para probar. |
| `DISABLE_OLD_MESSAGE_SYNC` | `1` ignora el historial de WhatsApp (mensajes viejos) y solo usa mensajes nuevos en vivo. Solo para probar. |

> **Importante:** `TEST_MODE` y las variables `DISABLE_*` están pensadas solo para probar el bot en desarrollo. En producción (servidor) no definirlas. Al arrancar, el bot loguea `test_mode_active` si alguna está activa.

## Uso

```bash
npm start          # reinicia el bot vía PM2 (NO arranca una segunda instancia)
npm test           # chequeo de sintaxis + smoke test de la lógica
npm run logs:ui    # visor web de logs (http://127.0.0.1:9888)
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
- El archivo define **4 apps**: `whatsapp-bot-baileys` (bot), `whatsapp-bot-logs-ui` (visor web), `whatsapp-bot-apagado-monitor` (aviso de caída) y `whatsapp-bot-telegram-control` (control por Telegram, ver [Integración con Telegram](#integración-con-telegram-avisos--control)).
- **Auto-inicio en Windows**: se usa `pm2-windows-startup` (`pm2 save` al final; al encender la PC se ejecuta `pm2 resurrect`). En servidores Linux: `pm2 startup` + `pm2 save`. Todo lo que esté en ese momento corriendo queda en el "dump" y se restaura al iniciar la sesión; si querés que el control y el monitor también autostarteen, deben estar corriendo al hacer `pm2 save`.

## Visor de logs (web)

Interfaz web de solo lectura sobre los archivos `logs/bot-YYYY-MM-DD.jsonl` (JSON Lines que genera `logger.js`). Al estilo de un log explorer: filtros por fecha, rango horario, evento, módulo, nivel y búsqueda de texto, con presets rápidos (**Recibidos** = `message_received`, **Respuestas**, **Errores**), exportación CSV y auto-refresh. No agrega dependencias: usa el módulo `http` de Node (patrón API JSON + SPA vanilla).

```bash
npm run logs:ui    # arranca en http://127.0.0.1:9888 y abre el navegador
```

- Variable `LOGS_UI_HOST` / `LOGS_UI_PORT`: host y puerto. Por defecto solo escucha en `127.0.0.1`.
- Para verlo desde el celular en la misma red: `LOGS_UI_HOST=0.0.0.0 npm run logs:ui` (expone números de WhatsApp, usarlo con cuidado).
- Con PM2 queda levantado junto al bot: `pm2 start ecosystem.config.js` (app `whatsapp-bot-logs-ui`).
- La hora de los logs es la hora local del bot (ej. `message_received` a las `00:00`).

## Integración con Telegram (avisos + control)

El bot usa Telegram para **dos cosas**: avisarte cosas que pasan (notificaciones) y dejarte **darle órdenes** (control). Ambas corren, si así se configuró con `pm2 save`, como **procesos PM2 aparte del bot de WhatsApp**. Eso es a propósito: el control y el monitor quedan vivos aunque el bot de WhatsApp esté parado o caído, siempre que la PC siga encendida.

### Los tres procesos

| App (PM2) | Qué hace | Cuándo se inicia |
|---|---|---|
| `whatsapp-bot-baileys` | El bot de WhatsApp: conexión, welcome, horarios, respuestas. | Al prender la PC / iniciar sesión (via PM2) y con `pm2 start`. |
| `whatsapp-bot-telegram-control` | Escucha tus comandos y botones de Telegram y escribe el override de horario en `runtime-data/override.json`. | Ídem. Arranque con `pm2 start ecosystem.config.js --only whatsapp-bot-telegram-control`. |
| `whatsapp-bot-apagado-monitor` | Vigila el "heartbeat" (latido) del bot y te avisa por Telegram si se apaga o queda caído sin reiniciarse. | Ídem. Script `monitor.js`. |

> Las tres se levantan juntas al iniciar la sesión gracias a `pm2 save` + `pm2-windows-startup` (ver [PM2](#pm2)). La app de logs (`whatsapp-bot-logs-ui`) es opcional y no se requirió para esto.

### Notificaciones que te llegan al chat

| Evento | Qué te dice |
|---|---|
| Bot iniciado | ✅ *Bot de WhatsApp iniciado*. |
| Bot apagado **en reinicio** | ⏹️ aviso con contexto (lo manda el propio bot antes de caer; ej. tras `pm2 restart`). |
| Bot caído / parado | ⏹️ aviso de que no responde; lo manda el **monitor** (si el bot sale de forma limpia con `pm2 stop`, el monitor detecta que se apagó y no hay vuelta). |
| Pérdida de sesión / QR | ⚠️ aviso de logout + QR en imagen para re-vincular (throttle de 10 s). |
| Cliente sin respuesta | 🔔 aviso si enviaste un welcome y nadie te respondió en `WELCOME_ALERT_TIMEOUT` segundos (además suena `sonido.mp3`). |

### Órdenes que podés darle (desde tu chat)

| Comando / botón | Efecto |
|---|---|
| `/abrir` · 🔓 Abrir ahora | Fuerza el negocio **ABIERTO** aunque no sea horario comercial. |
| `/cerrar` · 🔒 Cerrar ahora | Fuerza **CERRADO** (mensajes reciben "Estamos cerrados…") aunque sea horario. |
| `/auto` · 🔄 Automático | Vuelve al horario normal automático. |
| `/estado` · 📊 Ver estado | Muestra el horario de hoy, si está abierto/cerrado, el modo actual y si el bot de WhatsApp está online/caído. |

El control **siempre** responde con el estado y los botones de acción, y solo le obedece a tu chat (`TELEGRAM_CHAT_ID`). El botón "Abrir ahora" solo se muestra si el estado está cerrado, y "Cerrar ahora" solo si está abierto (evita ofrecer una acción que ya no cambia nada).

### Cómo se conectan control ↔ bot

- Las órdenes de `abrir`/`cerrar`/`auto` **solo se aplican si el bot de WhatsApp está online** (heartbeat fresco). Si está apagado o caído, se responde **❌ No se pudo aplicar** y la orden **no queda en cola** (no se escribe nada en `override.json`).
- Las órdenes que lleguen con mucha demora (más de 2 min de viejas al llegar al control, p.ej. un replay del polling tras un reinicio) se **descartan** para no aplicar órdenes viejas fuera de tiempo; el mensaje te invita a reenviarla.
- Cuando se aplica, el control escribe el modo en `runtime-data/override.json`; el bot lo re-lee cada 30 s y aplica el cambio, y además guarda el estado persistido por si reinicia.
- El override **sobrevive reinicios** del bot y se revierte solo a `auto` cuando el horario normal alcanza al estado forzado (ej.: abriste a las 18:00 → a la apertura normal siguiente vuelve solo a automático).
- Cada orden manual lleva una **expiración por sesión**: muere al cierre oficial del turno al que pertenece (aunque la PC esté apagada durante ese cierre, al boot se revisa contra el vencimiento y se revierte sola). Ej.: "cerrar temprano" un viernes a las 21:00 expira sábado 01:00 aunque nunca se haya encendido la PC a esa hora. En `/estado` se muestra la hora de expiración.
- Aunque la orden llega por Telegram, el `override.json` está en la PC del bot: si la PC está apagada, la orden no puede aplicarse.

### Qué NO pueden hacer

- **No encienden la PC** y **no dejan órdenes en cola**. Si la PC está encendida pero el bot de WhatsApp está caído, el control te responde al instante **❌ No se pudo aplicar** (la orden no queda pendiente para más tarde). Si la PC está totalmente apagada nadie responde y la orden simplemente caduca (no se aplica cuando la PC vuelva).
- **No controlan WhatsApp en sí**: no mandan mensajes, no ven conversaciones ni leen el chat. Solo cambian el modo de horario del bot y te informan su estado.
- **No responden a otras personas**: los comandos de otro chat se ignoran, solo responden tu `TELEGRAM_CHAT_ID`.
- Dependen de que la **PC esté encendida y en sesión** (el auto-inicio corre al iniciar la sesión de Windows; ver [PM2](#pm2)).

## Qué replica del bot original

- **Bienvenida**: mensaje de texto + 5 imágenes de menú (con caché de descarga), solo en horario comercial y solo si no hubo respuesta propia en las últimas **4 horas** (regla persistida en `runtime-data/conversation-replies.json`).
- **Despedida**: al detectar frases tipo "ahí va"/"ahí sale" en los mensajes del dueño, envía el mensaje de agradecimiento (rate-limit de 4 h).
- **Alias/transferencia**: si el cliente menciona alias/mercado pago, responde con `latentacion.ar` y `a nombre de carito llerena`.
- **Horarios con feriados**: `holidays-2026.json`, turnos que cruzan la medianoche (ej. viernes hasta la 01:00).
- **Auto-mute**: silencia `AUTO_MUTE_CONTACTS` durante el horario comercial y los desmutea fuera (sync cada 60 s con reintento a los 60 s ante errores).
- **Números ignorados**: `IGNORED_NUMBERS` no recibe respuestas.
- **Alarma local**: suena `sonido.mp3` si pasan `WELCOME_ALERT_TIMEOUT` segundos (default 4 min) sin respuesta del dueño tras un welcome, y además envía el aviso 🔔 por Telegram.
- **Alertas Telegram**: aviso de logout y QR remoto (PNG), de iniciado/caído (via monitor), y el control por comandos — todo detallado en [Integración con Telegram](#integración-con-telegram-avisos--control).
- **Sonido en el celular**: el bot corre como dispositivo *en segundo plano* (`markOnlineOnConnect: false` + presence `unavailable` al conectar). Si se marcase como sesión activa, WhatsApp silenciaría las notificaciones del teléfono (aparecen sin sonido).

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
- `logs-viewer/` — visor web de logs (`server.js` + `index.html`), sin dependencias.
- `monitor.js` — app `whatsapp-bot-apagado-monitor`: vigila `runtime-data/.alive` (heartbeat) y avisa por Telegram si el bot queda caído.
- `src/heartbeat.js` — heartbeat del bot: escribe `.alive` cada 10 s y soporta apagado limpio (`markCleanStop`).
- `src/telegram-control/` — control por Telegram: `index.js` (polling + órdenes + botones), `run.js` (entrada de la app PM2), `override.js` (leer/escribir `runtime-data/override.json`), `sync.js` (el bot lo sincroniza cada 30 s).
