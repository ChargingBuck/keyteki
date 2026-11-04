// Aemberforge hub: Keyteki's lobby and game node in one Node process, for hosts with one app port and no Redis
// (e.g. Winhost's iisnode). Run: `NODE_APP_INSTANCE=node node server/hub.js`.
//
//   REDIS_URL        defaults to 'memory' here: an in-process stand-in (services/MemoryRedis.js) instead of Redis
//   PORT             where the HTTP server listens (iisnode passes a named pipe)
//   HOST             the public host name players connect to (the game node advertises it in the handoff)
//   PUBLIC_PORT      the public port, if not PORT (443 behind IIS with HTTPS; 80 without)
//   PUBLIC_PROTOCOL  'https' when TLS ends at IIS, else unset
//   SERVER           the game node's name; its socket.io lives at /<SERVER>/socket.io next to the lobby's /socket.io
//   INVITE_CODE      the code friends need to sign up (required when NODE_ENV=production)
//   CHAT_RETENTION_DAYS  lobby chat older than this is deleted; defaults to 30 here (0 keeps everything)
//   PUBLIC_URL       the address used in emails (password reset), e.g. https://aemberforge.nerdroomsoftware.net
//
// The lobby's own web client is off: players use the Aemberforge app.

process.env.REDIS_URL = process.env.REDIS_URL || 'memory';
process.env.CHAT_RETENTION_DAYS = process.env.CHAT_RETENTION_DAYS || '30';

const runServer = require('./index');
const GameServer = require('./gamenode/gameserver');
const logger = require('./log');
const ConfigService = require('./services/ConfigService');
const { inviteCodeRequired } = require('./services/InviteCode');
const { startChatRetention } = require('./services/ChatRetention');

const configService = new ConfigService();

// A hub on the internet must not take open sign-ups.
if (!inviteCodeRequired(configService.getValueForSection('lobby', 'inviteCode'))) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('Hub not started: set INVITE_CODE (sign-up is invite-only in production)');
        process.exit(1);
    }
    logger.warn('No INVITE_CODE set: anyone can sign up (fine for local development only)');
}

// A stray rejected promise from a socket or HTTP handler should not take the whole hub down.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
});

runServer({ webClient: false })
    .then(({ httpServer }) => {
        // After the lobby is up (its game router is listening for nodes and the card cache is filled), so the node's
        // hello and its card load find them.
        new GameServer({ httpServer });
        startChatRetention({
            db: require('./db'),
            days: configService.getValueForSection('lobby', 'chatRetentionDays'),
            logger
        });
        logger.info('Aemberforge hub: lobby and game node running in one process');
    })
    .catch((err) => {
        logger.error('Hub failed to start', err);
        process.exit(1);
    });
