// Aemberforge: the same interface as the Postgres module (query, queryTran, startTransaction, transaction, shutdown),
// on SQL Server. Chosen in ./index.js when `dbEngine` is 'mssql'. The services keep writing Postgres SQL; ./mssqlDialect
// translates it (parameters, booleans, LIMIT, RETURNING...). Uses the same connection settings: dbHost, dbPort,
// dbDatabase, dbUser, dbPassword (and dbEncrypt: true when the server requires TLS).

const sql = require('mssql');

const ConfigService = require('../services/ConfigService');
const logger = require('../log');
const { translate } = require('./mssqlDialect');

const configService = new ConfigService();

/** Columns Keyteki stores as JSON (jsonb in Postgres, NVARCHAR(MAX) here): parsed back into objects when read. */
const JSON_COLUMNS = new Set(['Stats', 'Data', 'Card']);

const POOL_CONFIG = {
    server: configService.getValue('dbHost'),
    port: Number(configService.getValue('dbPort')) || 1433,
    database: configService.getValue('dbDatabase'),
    user: configService.getValue('dbUser'),
    password: configService.getValue('dbPassword'),
    options: {
        encrypt: String(configService.getValue('dbEncrypt')) === 'true',
        trustServerCertificate: true,
        // Keyteki quotes its names ("Users"."Id"); SQL Server reads double quotes as identifiers with this on.
        enableQuotedIdentifier: true
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// The connection heals itself. If connecting fails (SQL Server briefly unreachable, e.g. right after a restart), the next
// query tries again (at most every RETRY_AFTER_MS) instead of failing forever; if a query fails because the connection
// broke, the pool is replaced and reads are retried once. Before this, one failed connect or a dropped connection on
// the hosted database meant nobody could sign in until the hub was restarted.
const RETRY_AFTER_MS = 5000;
let poolPromise;
let currentPool;
let lastFailure = 0;

function getPool() {
    if (poolPromise) {
        return poolPromise;
    }

    const wait = Math.max(0, lastFailure + RETRY_AFTER_MS - Date.now());
    const pool = new sql.ConnectionPool(POOL_CONFIG);
    pool.on('error', (err) => {
        logger.error('SQL Server connection pool error; reconnecting', err);
        discard(pool);
    });
    const attempt = (async () => {
        if (wait) {
            await new Promise((resolve) => setTimeout(resolve, wait));
        }

        await pool.connect();
        currentPool = pool;
        logger.info('Connected to SQL Server');
        return pool;
    })();
    poolPromise = attempt;
    attempt.catch((err) => {
        logger.error('Could not connect to SQL Server; will retry', err);
        lastFailure = Date.now();
        if (poolPromise === attempt) {
            poolPromise = undefined;
        }

        pool.close().catch(() => {});
    });
    return attempt;
}

/** Drops a broken pool so the next query opens a new one. */
function discard(pool = currentPool) {
    if (!pool) {
        return;
    }

    if (pool === currentPool) {
        currentPool = undefined;
        poolPromise = undefined;
    }

    pool.close().catch(() => {});
}

const CONNECTION_ERROR_CODES = new Set([
    'ESOCKET',
    'ECONNCLOSED',
    'ECONNRESET',
    'ENOTOPEN',
    'ENOCONN',
    'EINSTLOOKUP'
]);

/** A broken or unavailable connection (as opposed to an error in the query itself). */
function isConnectionError(err) {
    return (
        !!err &&
        (err.name === 'ConnectionError' ||
            CONNECTION_ERROR_CODES.has(err.code) ||
            /connection is closed|connection lost|socket hang up/i.test(String(err.message)))
    );
}

/** A JS value as a SQL Server parameter: objects and arrays as JSON text, large or fractional numbers typed. */
function bind(request, params) {
    for (let [name, value] of Object.entries(params)) {
        // moment (and similar) dates, which pg accepts as they are.
        if (value && typeof value === 'object' && typeof value.toDate === 'function') {
            value = value.toDate();
        }
        if (value === undefined || value === null) {
            request.input(name, value ?? null);
        } else if (value instanceof Date || Buffer.isBuffer(value)) {
            request.input(name, value);
        } else if (typeof value === 'object') {
            request.input(name, sql.NVarChar(sql.MAX), JSON.stringify(value));
        } else if (typeof value === 'number' && !Number.isInteger(value)) {
            request.input(name, sql.Float, value);
        } else if (typeof value === 'number' && Math.abs(value) > 2147483647) {
            request.input(name, sql.BigInt, value);
        } else if (typeof value === 'string') {
            request.input(name, sql.NVarChar(sql.MAX), value);
        } else {
            request.input(name, value);
        }
    }
}

function rows(result) {
    const recordset = result.recordset || [];
    for (const row of recordset) {
        for (const column of JSON_COLUMNS) {
            const v = row[column];
            if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
                try {
                    row[column] = JSON.parse(v);
                } catch {
                    /* not JSON after all: leave the text */
                }
            }
        }
    }
    return recordset;
}

async function run(request, text, params) {
    const t = translate(text, params);
    logger.debug(t.text, t.params);
    bind(request, t.params);
    try {
        return rows(await request.query(t.text));
    } catch (err) {
        logger.error(`SQL Server query failed: ${t.text}`);
        throw err;
    }
}

/** A transaction handle shaped like a pg client: COMMIT / ROLLBACK through queryTran, release() when done. */
class TransactionClient {
    constructor(transaction) {
        this.transaction = transaction;
        this.finished = false;
    }

    async query(text, params = []) {
        if (/^\s*BEGIN\s*;?\s*$/i.test(text)) {
            return [];
        }
        if (/^\s*COMMIT\s*;?\s*$/i.test(text)) {
            if (!this.finished) {
                await this.transaction.commit();
            }
            this.finished = true;
            return [];
        }
        if (/^\s*ROLLBACK\s*;?\s*$/i.test(text)) {
            if (!this.finished) {
                await this.transaction.rollback();
            }
            this.finished = true;
            return [];
        }
        return run(new sql.Request(this.transaction), text, params);
    }

    release() {}
}

module.exports = {
    dialect: 'mssql',
    query: async (text, params = []) => {
        try {
            return await run((await getPool()).request(), text, params);
        } catch (err) {
            if (!isConnectionError(err)) {
                throw err;
            }

            discard();
            // Reads are safe to repeat; a write might have gone through before the connection broke, so it isn't.
            if (!/^\s*(SELECT|WITH)\b/i.test(text)) {
                throw err;
            }

            logger.warn('SQL Server connection lost; retrying the query on a new connection');
            return run((await getPool()).request(), text, params);
        }
    },
    queryTran: async (client, text, params = []) => client.query(text, params),
    startTransaction: async () => {
        try {
            const transaction = new sql.Transaction(await getPool());
            await transaction.begin();
            return new TransactionClient(transaction);
        } catch (err) {
            if (isConnectionError(err)) {
                discard();
            }

            throw err;
        }
    },
    transaction: async (callback) => {
        const client = await module.exports.startTransaction();
        try {
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        }
    },
    shutdown: async () => {
        const pool = currentPool;
        discard();
        await pool?.close();
    },
    close: async () => {
        const pool = currentPool;
        discard();
        await pool?.close();
    }
};

// Connect at start-up, as before (failures are logged and retried by the next query).
getPool().catch(() => {});
