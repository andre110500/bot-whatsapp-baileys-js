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

module.exports = { serializeError };
