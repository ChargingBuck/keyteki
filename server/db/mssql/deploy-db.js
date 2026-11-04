// Aemberforge: set up a hosted SQL Server database (Winhost) for the hub, from this PC.
//
//   node server/db/mssql/deploy-db.js --from ../devservices/mssql-app.json --to ../devservices/winhost-db.json
//        [--check]
//
//   1. If the target has no tables, creates them from schema.sql.
//   2. Copies the reference data the hub needs from the local SQL Server database: expansions, houses, roles, cards
//      and their (English) names. Only into empty tables, so it never overwrites anything; accounts, decks, games and
//      tokens are never copied.
//   --check  only report what is there and what would be done
//
// Both files: { "server", "port"?, "database", "user", "password", "encrypt"? }. The target connection is encrypted
// unless it says "encrypt": false.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const args = process.argv.slice(2);
const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const FROM = arg('--from');
const TO = arg('--to');
const CHECK = args.includes('--check');
if (!FROM || !TO) {
    console.error('usage: --from <local db json> --to <hosted db json> [--check]');
    process.exit(2);
}

/** Copied in this order (parents before children). */
const REFERENCE_TABLES = ['Expansions', 'Houses', 'Roles', 'Cards', 'CardLocaleNames'];
const ROW_FILTERS = { CardLocaleNames: `[Locale] = 'en'` };

const q = (name) => `[${name.replace(/]/g, ']]')}]`;

async function connect(file, defaultEncrypt) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pool = new sql.ConnectionPool({
        server: cfg.server,
        port: cfg.port || 1433,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        options: { encrypt: cfg.encrypt ?? defaultEncrypt, trustServerCertificate: true },
        requestTimeout: 300000
    });
    await pool.connect();
    return { pool, name: `${cfg.database} on ${cfg.server}` };
}

async function tableCounts(pool) {
    const r = await pool.request().query(`SELECT t.name, SUM(p.rows) AS n FROM sys.tables t
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY t.name`);
    return new Map(r.recordset.map((row) => [row.name, Number(row.n)]));
}

/** schema.sql as batches: one per CREATE / ALTER statement. */
function schemaStatements() {
    const text = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    return text
        .split(/;\s*\n/)
        .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
        .filter((s) => s && !/^SET\s+QUOTED_IDENTIFIER/i.test(s));
}

async function copyTable(source, target, table) {
    const cols = (
        await target
            .request()
            .input('t', table)
            .query(
                `SELECT name, is_identity FROM sys.columns WHERE object_id = OBJECT_ID(@t) ORDER BY column_id`
            )
    ).recordset;
    const where = ROW_FILTERS[table] ? ` WHERE ${ROW_FILTERS[table]}` : '';
    const rows = (
        await source
            .request()
            .query(`SELECT ${cols.map((c) => q(c.name)).join(', ')} FROM ${q(table)}${where}`)
    ).recordset;
    const identity = cols.some((c) => c.is_identity);
    // Batches under SQL Server's 2100-parameter limit, in one transaction per table.
    const per = Math.max(1, Math.floor(2000 / cols.length));
    const tx = new sql.Transaction(target);
    await tx.begin();
    try {
        if (identity) {
            await new sql.Request(tx).batch(`SET IDENTITY_INSERT ${q(table)} ON;`);
        }
        for (let i = 0; i < rows.length; i += per) {
            const r = new sql.Request(tx);
            const values = rows.slice(i, i + per).map(
                (row, bi) =>
                    `(${cols
                        .map((c, ci) => {
                            r.input(`p${bi}_${ci}`, row[c.name]);
                            return `@p${bi}_${ci}`;
                        })
                        .join(', ')})`
            );
            await r.batch(
                `INSERT INTO ${q(table)} (${cols
                    .map((c) => q(c.name))
                    .join(', ')}) VALUES ${values.join(', ')};`
            );
        }
        if (identity) {
            await new sql.Request(tx).batch(`SET IDENTITY_INSERT ${q(table)} OFF;`);
        }
        await tx.commit();
    } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
    }
    return rows.length;
}

async function main() {
    const source = await connect(FROM, false);
    const target = await connect(TO, true);
    console.log(`from: ${source.name}\nto:   ${target.name}${CHECK ? '  (check only)' : ''}`);

    let counts = await tableCounts(target.pool);
    if (counts.size === 0) {
        const statements = schemaStatements();
        if (CHECK) {
            console.log(`would create the schema (${statements.length} statements)`);
        } else {
            for (const s of statements) {
                await target.pool.request().batch(`SET QUOTED_IDENTIFIER ON; ${s};`);
            }
            console.log(`created the schema (${statements.length} statements)`);
            counts = await tableCounts(target.pool);
        }
    } else {
        console.log(`schema already there (${counts.size} tables)`);
    }

    for (const table of REFERENCE_TABLES) {
        const have = counts.get(table);
        if (have > 0) {
            console.log(`${table}: already has ${have} rows, left alone`);
        } else if (CHECK) {
            console.log(`${table}: would copy`);
        } else {
            const n = await copyTable(source.pool, target.pool, table);
            console.log(`${table}: copied ${n} rows${ROW_FILTERS[table] ? ' (English only)' : ''}`);
        }
    }

    const size = (
        await target.pool
            .request()
            .query(`SELECT SUM(a.used_pages) * 8 / 1024.0 AS mb FROM sys.allocation_units a`)
    ).recordset[0].mb;
    console.log(`target database: ${Number(size).toFixed(1)} MB used`);
    await source.pool.close();
    await target.pool.close();
}

main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
