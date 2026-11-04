const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const ConfigService = require('./services/ConfigService');
const passport = require('passport');
const logger = require('./log.js');
const api = require('./api');
const fs = require('fs');
const path = require('path');
const http = require('http');

const passportJwt = require('passport-jwt');
const Sentry = require('@sentry/node');

const JwtStrategy = passportJwt.Strategy;
const ExtractJwt = passportJwt.ExtractJwt;

const UserService = require('./services/UserService.js');
const { corsMiddleware, originCheckFromConfig } = require('./services/Cors');

class Server {
    /**
     * @param {boolean} isDeveloping
     * @param {{ webClient?: boolean }} [options] webClient false (Aemberforge hub): API, sockets and /public only,
     *   no Keyteki web client (no Vite middleware in development, no dist/ in production).
     */
    constructor(isDeveloping, options = {}) {
        this.webClient = options.webClient !== false;
        this.configService = new ConfigService();

        this.userService = new UserService(this.configService);
        this.isDeveloping = isDeveloping;
        this.server = http.Server(app);
    }

    async init(options) {
        if (!this.isDeveloping) {
            Sentry.init({
                dsn: this.configService.getValue('sentryDsn'),
                release: process.env.VERSION || 'Local build',
                environment: process.env.NODE_ENV || 'production',
                integrations: [Sentry.expressIntegration({ app })]
            });
        }

        var opts = {};
        opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
        opts.secretOrKey = this.configService.getValue('secret');

        passport.use(
            new JwtStrategy(opts, (jwtPayload, done) => {
                this.userService
                    .getUserById(jwtPayload.id)
                    .then((user) => {
                        if (user && !user.disabled) {
                            return done(null, user.getWireSafeDetails());
                        }

                        return done(null, false);
                    })
                    .catch((err) => {
                        return done(err, false);
                    });
            })
        );
        app.use(passport.initialize());

        // Only trust the X-Forwarded-* headers added by our own reverse proxy (Traefik), so clients
        // can't spoof their IP address to get around bans and rate limits
        app.set('trust proxy', this.configService.getValueForSection('lobby', 'trustProxy') ?? 1);

        // Aemberforge: the desktop app calls the hub from its own origin (see services/Cors.js).
        app.use(corsMiddleware(originCheckFromConfig(this.configService)));

        app.use(bodyParser.json({ limit: '5mb' }));
        app.use(bodyParser.urlencoded({ extended: false }));

        api.init(app, options);

        // Aemberforge: images (cards, house icons, avatars) are kept by Cloudflare and the app's cache for 30 days, so
        // each is downloaded once. Their names change when their content does (uploaded avatars get a new name).
        app.use(
            express.static(__dirname + '/../public', {
                setHeaders: (res, filePath) => {
                    if (/[\\/]img[\\/]/.test(filePath)) {
                        res.setHeader('Cache-Control', 'public, max-age=2592000');
                    } else if (/[\\/]updates[\\/]latest\.json$/.test(filePath)) {
                        // The desktop app's update check: always the current file, never a cached copy.
                        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    } else if (/[\\/]updates[\\/]/.test(filePath)) {
                        // Installers are named by version, so a copy never goes stale.
                        res.setHeader('Cache-Control', 'public, max-age=2592000');
                    }
                }
            })
        );
        if (!this.isDeveloping && this.webClient) {
            app.use(express.static(__dirname + '/../dist'));
        }

        if (!this.webClient) {
            // Aemberforge hub: nothing else to serve.
        } else if (this.isDeveloping) {
            const { createViteMiddleware } = await import('./vite-dev.mjs');
            const { vite, templatePath } = await createViteMiddleware({
                root: path.join(__dirname, '..')
            });

            app.use(vite.middlewares);

            app.get('*', async (req, res, next) => {
                try {
                    const url = req.originalUrl;
                    const template = fs.readFileSync(templatePath, 'utf-8');
                    const html = await vite.transformIndexHtml(url, template);
                    res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
                } catch (err) {
                    vite.ssrFixStacktrace(err);
                    next(err);
                }
            });
        } else {
            app.get('*', (req, res) => {
                res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
            });
        }

        if (!this.isDeveloping) {
            Sentry.setupExpressErrorHandler(app);
        }

        // Define error middleware last
        app.use(function (err, req, res, next) {
            logger.error(err);

            if (!res.headersSent && req.xhr) {
                return res.status(500).send({ success: false });
            }

            next(err);
        });

        return this.server;
    }

    run() {
        let port =
            process.env.PORT || this.configService.getValueForSection('lobby', 'port') || 4000;

        this.server.listen(port, '0.0.0.0', function onStart(err) {
            if (err) {
                logger.error(err);
            }

            logger.info(
                `==> ?? Listening on port ${port}. Open up http://0.0.0.0:${port}/ in your browser.`
            );
        });
    }

    serializeUser(user, done) {
        if (user) {
            done(null, user.id);
        }
    }
}

module.exports = Server;
