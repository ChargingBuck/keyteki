// Aemberforge: cross-origin access for the desktop app. The installed app's pages come from its own origin (Tauri:
// http(s)://tauri.localhost on Windows, tauri://localhost on macOS/Linux), so the hub has to allow that origin for
// its API and sockets. Logins use bearer tokens, never cookies, so no credentials are involved.
//
//   API (/api/...)      the request's Origin is echoed back only when it is allowed
//   files (/img/...)    "*": they are public, and Cloudflare caches them, so the answer must not depend on Origin
//   sockets             the same allow-list (only matters for HTTP long-polling; WebSockets are not CORS-checked)
//
// Allowed: the Tauri origins, anything in lobby.corsOrigins / CORS_ORIGINS (comma-separated, e.g. a dev web build),
// and, outside production, any localhost port.

const TAURI_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];

/** Normalises "https://Example.com/" to "https://example.com"; undefined if it isn't an origin. */
function normalise(origin) {
    if (typeof origin !== 'string' || origin.trim() === '') {
        return undefined;
    }

    try {
        const u = new URL(origin.trim());
        return u.origin === 'null'
            ? `${u.protocol}//${u.host}`.toLowerCase()
            : u.origin.toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * @param {object} options
 * @param {string | string[]} [options.extra] more origins (config lobby.corsOrigins, env CORS_ORIGINS)
 * @param {boolean} [options.production]
 */
function createOriginCheck({ extra, production } = {}) {
    const list = Array.isArray(extra) ? extra : String(extra || '').split(',');
    const allowed = new Set([...TAURI_ORIGINS, ...list].map(normalise).filter(Boolean));

    return function isAllowed(origin) {
        const o = normalise(origin);
        if (!o) {
            return false;
        }

        if (allowed.has(o)) {
            return true;
        }

        if (!production) {
            const host = new URL(o).hostname;
            return host === 'localhost' || host === '127.0.0.1';
        }

        return false;
    };
}

/** Express middleware: CORS headers for the API and public files, and answers to preflight requests. */
function corsMiddleware(isAllowed) {
    return function (req, res, next) {
        const origin = req.headers.origin;
        if (!origin) {
            return next();
        }

        if (!req.path.startsWith('/api/')) {
            // Public files (card images, avatars): readable by any page, same answer for everyone.
            res.setHeader('Access-Control-Allow-Origin', '*');
        } else if (isAllowed(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.append('Vary', 'Origin');
        } else {
            return next(); // no CORS headers: the browser blocks the response
        }

        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader(
                'Access-Control-Allow-Headers',
                req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
            );
            res.setHeader('Access-Control-Max-Age', '600');
            return res.status(204).end();
        }

        next();
    };
}

/** The `cors` option for a socket.io Server. */
function socketCors(isAllowed) {
    return {
        origin: (origin, callback) => callback(null, !origin || isAllowed(origin)),
        methods: ['GET', 'POST']
    };
}

/** The allow-list from a ConfigService: lobby.corsOrigins (env CORS_ORIGINS); localhost too outside production. */
function originCheckFromConfig(configService) {
    return createOriginCheck({
        extra: configService.getValueForSection('lobby', 'corsOrigins'),
        production: configService.getValue('env') === 'production'
    });
}

module.exports = {
    TAURI_ORIGINS,
    createOriginCheck,
    corsMiddleware,
    socketCors,
    normalise,
    originCheckFromConfig
};
