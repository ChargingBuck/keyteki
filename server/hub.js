// Aemberforge hub: Keyteki's lobby and game node in one Node process, for hosts with one app port and no Redis
// (e.g. Winhost's iisnode). Run: `NODE_APP_INSTANCE=node node server/hub.js`.
//
//   REDIS_URL        defaults to 'memory' here: an in-process stand-in (services/MemoryRedis.js) instead of Redis
//   PORT             where the HTTP server listens (iisnode passes a named pipe)
//   HOST             the public host name players connect to (the game node advertises it in the handoff)
//   PUBLIC_PORT      the public port, if not PORT (443 behind IIS with HTTPS; 80 without)
//   PUBLIC_PROTOCOL  'https' when TLS ends at IIS, else unset
//   SERVER           the game node's name; its socket.io lives at /<SERVER>/socket.io next to the lobby's /socket.io
//
// The lobby's own web client is off: players use the Aemberforge app.

process.env.REDIS_URL = process.env.REDIS_URL || 'memory';

const runServer = require('./index');
const GameServer = require('./gamenode/gameserver');
const logger = require('./log');

// A stray rejected promise from a socket or HTTP handler should not take the whole hub down.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
});

runServer({ webClient: false })
    .then(({ httpServer }) => {
        // After the lobby is up (its game router is listening for nodes and the card cache is filled), so the node's
        // hello and its card load find them.
        new GameServer({ httpServer });
        logger.info('Aemberforge hub: lobby and game node running in one process');
    })
    .catch((err) => {
        logger.error('Hub failed to start', err);
        process.exit(1);
    });
