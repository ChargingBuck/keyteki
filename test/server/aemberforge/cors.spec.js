const {
    createOriginCheck,
    corsMiddleware,
    socketCors,
    normalise
} = require('../../../server/services/Cors');

function run(middleware, { origin, path = '/api/decks', method = 'GET', requestHeaders } = {}) {
    const headers = {};
    const res = {
        statusCode: 200,
        ended: false,
        setHeader: (k, v) => (headers[k.toLowerCase()] = v),
        append: (k, v) => (headers[k.toLowerCase()] = v),
        status(code) {
            this.statusCode = code;
            return this;
        },
        end() {
            this.ended = true;
        }
    };
    let nextCalled = false;
    const req = {
        method,
        path,
        headers: {
            ...(origin ? { origin } : {}),
            ...(requestHeaders ? { 'access-control-request-headers': requestHeaders } : {})
        }
    };
    middleware(req, res, () => (nextCalled = true));
    return { headers, res, nextCalled };
}

describe('Cors', function () {
    describe('origin check', function () {
        it('allows the desktop app on every platform, in production too', function () {
            const allowed = createOriginCheck({ production: true });
            expect(allowed('http://tauri.localhost')).toBe(true);
            expect(allowed('https://tauri.localhost')).toBe(true);
            expect(allowed('tauri://localhost')).toBe(true);
        });

        it('refuses other sites, and localhost in production', function () {
            const allowed = createOriginCheck({ production: true });
            expect(allowed('https://evil.example')).toBe(false);
            expect(allowed('http://localhost:5173')).toBe(false);
            expect(allowed('null')).toBe(false);
            expect(allowed(undefined)).toBe(false);
        });

        it('allows any localhost port outside production', function () {
            const allowed = createOriginCheck({ production: false });
            expect(allowed('http://localhost:5173')).toBe(true);
            expect(allowed('http://127.0.0.1:4000')).toBe(true);
            expect(allowed('https://evil.example')).toBe(false);
        });

        it('adds configured origins (comma-separated or a list), ignoring case and trailing slashes', function () {
            const allowed = createOriginCheck({
                extra: ' http://localhost:5173/ , https://Friend.example ',
                production: true
            });
            expect(allowed('http://localhost:5173')).toBe(true);
            expect(allowed('https://friend.example')).toBe(true);
            expect(
                createOriginCheck({ extra: ['https://a.example'], production: true })(
                    'https://a.example'
                )
            ).toBe(true);
        });

        it('normalises origins', function () {
            expect(normalise('HTTPS://Example.com/path')).toBe('https://example.com');
            expect(normalise('tauri://localhost')).toBe('tauri://localhost');
            expect(normalise('not a url')).toBeUndefined();
        });
    });

    describe('middleware', function () {
        const mw = corsMiddleware(createOriginCheck({ production: true }));

        it('echoes an allowed origin on the API', function () {
            const { headers, nextCalled } = run(mw, { origin: 'http://tauri.localhost' });
            expect(headers['access-control-allow-origin']).toBe('http://tauri.localhost');
            expect(headers.vary).toBe('Origin');
            expect(nextCalled).toBe(true);
        });

        it('adds nothing for a refused origin, or a request with no Origin', function () {
            expect(run(mw, { origin: 'https://evil.example' }).headers).toEqual({});
            expect(run(mw, {}).headers).toEqual({});
        });

        it('answers preflight requests itself', function () {
            const { headers, res, nextCalled } = run(mw, {
                origin: 'http://tauri.localhost',
                method: 'OPTIONS',
                requestHeaders: 'authorization,content-type'
            });
            expect(res.statusCode).toBe(204);
            expect(res.ended).toBe(true);
            expect(nextCalled).toBe(false);
            expect(headers['access-control-allow-headers']).toBe('authorization,content-type');
            expect(headers['access-control-allow-methods']).toMatch(/POST/);
        });

        it('marks images readable by anyone even without an Origin (so every cached copy has it)', function () {
            const { headers, nextCalled } = run(mw, { path: '/img/house/logos.png' });
            expect(headers['access-control-allow-origin']).toBe('*');
            expect(nextCalled).toBe(true);
            const pre = run(mw, {
                origin: 'http://tauri.localhost',
                path: '/img/cards/x.png',
                method: 'OPTIONS'
            });
            expect(pre.res.statusCode).toBe(204);
        });

        it('serves public files to anyone with the same answer (Cloudflare caches them)', function () {
            const a = run(mw, { origin: 'https://evil.example', path: '/img/cards/valdr.png' });
            expect(a.headers['access-control-allow-origin']).toBe('*');
            expect(a.headers.vary).toBeUndefined();
        });
    });

    it('gives socket.io the same allow-list, and allows connections without an Origin', function () {
        const { origin } = socketCors(createOriginCheck({ production: true }));
        const answer = (o) => {
            let result;
            origin(o, (err, ok) => (result = ok));
            return result;
        };
        expect(answer('http://tauri.localhost')).toBe(true);
        expect(answer(undefined)).toBe(true);
        expect(answer('https://evil.example')).toBe(false);
    });
});
