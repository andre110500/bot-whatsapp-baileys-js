// Serialización de errores para logs estructurados.
const serializeError = (error) => {
    if (!error) return { message: 'Unknown error' };

    const plainError = {
        name: error.name,
        message: error.message || String(error),
        stack: error.stack,
        code: error.code,
        type: error.type,
        status: error.status,
        statusCode: error.statusCode,
        errno: error.errno,
        syscall: error.syscall,
        cause: error.cause ? serializeError(error.cause) : undefined
    };

    for (const key of Object.keys(error)) {
        if (plainError[key] === undefined) {
            plainError[key] = error[key];
        }
    }

    return plainError;
};

// Errores de red (mensaje, nombre y código). Sirve para decidir si vale la
// pena reintentar una operación después de esperar la reconexión, en vez de
// fallar en seco como pasaba con la bienvenida al caerse la conexión.
function isConnectionError(error) {
    if (!error) return false;
    const message = `${error.message || ''} ${error.name || ''}`.toLowerCase();
    const code = error.code !== undefined ? String(error.code).toUpperCase() : '';

    if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) {
        return true;
    }
    return /connection (closed|terminated|closing|reset|refused)/.test(message) ||
        /socket( is)? closed/.test(message) ||
        /websocket/.test(message) ||
        /network/i.test(message) ||
        /disconnect(ed|ion)?/.test(message);
}

module.exports = { serializeError, isConnectionError };
