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

const pool = new sql.ConnectionPool({
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
});
const connected = pool.connect().catch((err) => {
    logger.error('Could not connect to SQL Server', err);
    throw err;
});

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
    query: async (text, params = []) => run((await connected).request(), text, params),
    queryTran: async (client, text, params = []) => client.query(text, params),
    startTransaction: async () => {
        const transaction = new sql.Transaction(await connected);
        await transaction.begin();
        return new TransactionClient(transaction);
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
        await pool.close();
    },
    close: async () => {
        await pool.close();
    }
};
