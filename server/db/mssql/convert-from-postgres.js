// Aemberforge: build the SQL Server schema from a live Keyteki Postgres database (all migrations applied), and
// optionally copy its data across. Writes the generated T-SQL to schema.sql next to this file (used to set up
// Winhost's database), then applies it.
//
//   node server/db/mssql/convert-from-postgres.js --pg postgres://keyteki:pw@localhost:54320/keyteki \
//        --mssql ../devservices/mssql-app.json [--data] [--drop]
//
//   --data  copy the rows too (card names in English only)
//   --drop  drop the existing tables on the SQL Server side first (the target database must be a scratch one)
//
// Type mapping: integer -> INT, boolean -> BIT, timestamp -> DATETIME2(3), jsonb -> NVARCHAR(MAX), text -> NVARCHAR(MAX)
// or NVARCHAR(450) when it is part of a key or index (SQL Server can't index MAX columns). Unique indexes on nullable
// columns become filtered indexes (WHERE col IS NOT NULL), since SQL Server allows only one NULL in a unique index.
// Foreign keys keep ON DELETE CASCADE unless SQL Server rejects it (multiple cascade paths); then NO ACTION.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const sql = require('mssql');

const args = process.argv.slice(2);
const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

const PG_URL = arg('--pg');
const MSSQL_FILE = arg('--mssql');
if (!PG_URL || !MSSQL_FILE) {
    console.error(
        'usage: --pg <postgres url> --mssql <json with server, port, database, user, password> [--data] [--drop]'
    );
    process.exit(2);
}

/** Only English card names: the hub is English only. */
const ROW_FILTERS = { CardLocaleNames: `"Locale" = 'en'` };

const q = (name) => `[${name.replace(/]/g, ']]')}]`;

async function main() {
    const pg = new Client({ connectionString: PG_URL });
    await pg.connect();
    const cfg = JSON.parse(fs.readFileSync(MSSQL_FILE, 'utf8'));
    const ms = await sql.connect({
        server: cfg.server,
        port: cfg.port || 1433,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        options: { encrypt: cfg.encrypt ?? false, trustServerCertificate: true },
        requestTimeout: 120000
    });

    // ---- introspect Postgres
    const cols = (
        await pg.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, ordinal_position
            FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)
    ).rows;
    const tables = [...new Set(cols.map((c) => c.table_name))];
    const indexes = (
        await pg.query(`SELECT t.relname AS tbl, i.relname AS idx, ix.indisunique AS uniq, ix.indisprimary AS pk,
                array_agg(a.attname::text ORDER BY k.n) AS cols
            FROM pg_index ix
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_namespace ns ON ns.oid = t.relnamespace
            CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
            WHERE ns.nspname = 'public'
            GROUP BY t.relname, i.relname, ix.indisunique, ix.indisprimary`)
    ).rows;
    const fks = (
        await pg.query(`SELECT c.conname AS name, t.relname AS tbl, rt.relname AS ref, c.confdeltype AS del,
                (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
                (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_class rt ON rt.oid = c.confrelid
            JOIN pg_namespace ns ON ns.oid = t.relnamespace
            WHERE c.contype = 'f' AND ns.nspname = 'public'`)
    ).rows;

    // Text columns that take part in a key or index must be bounded to be indexable.
    const keyed = new Set();
    for (const ix of indexes) {
        for (const c of ix.cols) {
            keyed.add(`${ix.tbl}.${c}`);
        }
    }
    for (const fk of fks) {
        for (const c of fk.cols) {
            keyed.add(`${fk.tbl}.${c}`);
        }
        for (const c of fk.refcols) {
            keyed.add(`${fk.ref}.${c}`);
        }
    }

    const typeOf = (c) => {
        switch (c.data_type) {
            case 'integer':
                return 'INT';
            case 'bigint':
                return 'BIGINT';
            case 'boolean':
                return 'BIT';
            case 'timestamp without time zone':
            case 'timestamp with time zone':
                return 'DATETIME2(3)';
            case 'jsonb':
            case 'json':
                return 'NVARCHAR(MAX)';
            case 'text':
            case 'character varying':
                return keyed.has(`${c.table_name}.${c.column_name}`)
                    ? 'NVARCHAR(450)'
                    : 'NVARCHAR(MAX)';
            default:
                throw new Error(`unmapped type ${c.data_type} (${c.table_name}.${c.column_name})`);
        }
    };
    const defaultOf = (c) => {
        const d = c.column_default;
        if (d === null || c.is_identity === 'YES') {
            return '';
        }
        if (d === 'true') {
            return ' DEFAULT 1';
        }
        if (d === 'false') {
            return ' DEFAULT 0';
        }
        const str = d.match(/^'(.*)'::\w+/);
        if (str) {
            return ` DEFAULT N'${str[1].replace(/'/g, "''")}'`;
        }
        if (/^now\(\)|CURRENT_TIMESTAMP/i.test(d)) {
            return ' DEFAULT SYSUTCDATETIME()';
        }
        if (/^-?\d+(\.\d+)?$/.test(d)) {
            return ` DEFAULT ${d}`;
        }
        throw new Error(`unmapped default ${d} (${c.table_name}.${c.column_name})`);
    };

    // ---- DDL
    const ddlTables = [];
    for (const t of tables) {
        const tc = cols.filter((c) => c.table_name === t);
        const pk = indexes.find((i) => i.tbl === t && i.pk);
        const lines = tc.map(
            (c) =>
                `    ${q(c.column_name)} ${typeOf(c)}${
                    c.is_identity === 'YES' ? ' IDENTITY(1,1)' : ''
                } ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}${defaultOf(c)}`
        );
        if (pk) {
            lines.push(`    CONSTRAINT ${q(pk.idx)} PRIMARY KEY (${pk.cols.map(q).join(', ')})`);
        }
        ddlTables.push(`CREATE TABLE ${q(t)} (\n${lines.join(',\n')}\n);`);
    }
    const nullable = (t, c) =>
        cols.find((x) => x.table_name === t && x.column_name === c)?.is_nullable === 'YES';
    const ddlIndexes = indexes
        .filter((i) => !i.pk)
        .map((i) => {
            const nulls = i.uniq ? i.cols.filter((c) => nullable(i.tbl, c)) : [];
            const where = nulls.length
                ? ` WHERE ${nulls.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')}`
                : '';
            return `CREATE ${i.uniq ? 'UNIQUE ' : ''}INDEX ${q(i.idx)} ON ${q(i.tbl)} (${i.cols
                .map(q)
                .join(', ')})${where};`;
        });
    const delRule = { c: 'CASCADE', n: 'SET NULL', a: 'NO ACTION', r: 'NO ACTION', d: 'NO ACTION' };
    const fkDdl = (fk, rule) =>
        `ALTER TABLE ${q(fk.tbl)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.cols
            .map(q)
            .join(', ')}) REFERENCES ${q(fk.ref)} (${fk.refcols
            .map(q)
            .join(', ')}) ON DELETE ${rule};`;

    // ---- apply
    if (flag('--drop')) {
        // Foreign keys first, then the tables.
        await ms.request().query(`DECLARE @s NVARCHAR(MAX) = N'';
            SELECT @s += N'ALTER TABLE ' + QUOTENAME(OBJECT_NAME(parent_object_id)) + N' DROP CONSTRAINT ' + QUOTENAME(name) + N';' FROM sys.foreign_keys;
            EXEC sp_executesql @s;
            SET @s = N'';
            SELECT @s += N'DROP TABLE ' + QUOTENAME(name) + N';' FROM sys.tables;
            EXEC sp_executesql @s;`);
        console.log('dropped existing tables');
    }
    for (const d of ddlTables) {
        await ms.request().batch(d);
    }
    console.log(`created ${ddlTables.length} tables`);

    if (flag('--data')) {
        for (const t of tables) {
            const tc = cols.filter((c) => c.table_name === t);
            const where = ROW_FILTERS[t] ? ` WHERE ${ROW_FILTERS[t]}` : '';
            const rows = (await pg.query(`SELECT * FROM "${t}"${where}`)).rows;
            if (!rows.length) {
                continue;
            }
            const identity = tc.some((c) => c.is_identity === 'YES');
            // Batches under SQL Server's 2100-parameter limit.
            const per = Math.max(1, Math.floor(2000 / tc.length));
            for (let i = 0; i < rows.length; i += per) {
                const batch = rows.slice(i, i + per);
                const r = ms.request();
                const values = batch.map(
                    (row, bi) =>
                        `(${tc
                            .map((c, ci) => {
                                const name = `p${bi}_${ci}`;
                                let v = row[c.column_name];
                                if (
                                    v !== null &&
                                    (c.data_type === 'jsonb' || c.data_type === 'json')
                                ) {
                                    v = JSON.stringify(v);
                                }
                                r.input(name, v);
                                return `@${name}`;
                            })
                            .join(', ')})`
                );
                const insert = `INSERT INTO ${q(t)} (${tc
                    .map((c) => q(c.column_name))
                    .join(', ')}) VALUES ${values.join(', ')};`;
                await r.batch(
                    identity
                        ? `SET IDENTITY_INSERT ${q(t)} ON; ${insert} SET IDENTITY_INSERT ${q(
                              t
                          )} OFF;`
                        : insert
                );
            }
            console.log(`copied ${rows.length} rows into ${t}${where ? ' (English only)' : ''}`);
        }
    }

    for (const d of ddlIndexes) {
        await ms.request().batch(d);
    }
    console.log(`created ${ddlIndexes.length} indexes`);
    const ddlFks = [];
    for (const fk of fks) {
        const rule = delRule[fk.del] ?? 'NO ACTION';
        try {
            await ms.request().batch(fkDdl(fk, rule));
            ddlFks.push(fkDdl(fk, rule));
        } catch (e) {
            // SQL Server refuses some cascades (e.g. multiple cascade paths): keep the key, without the cascade.
            if (rule === 'NO ACTION') {
                throw e;
            }
            console.warn(
                `  ${fk.name}: ON DELETE ${rule} refused (${
                    e.message.split('.')[0]
                }); using NO ACTION`
            );
            await ms.request().batch(fkDdl(fk, 'NO ACTION'));
            ddlFks.push(fkDdl(fk, 'NO ACTION'));
        }
    }
    console.log(`created ${ddlFks.length} foreign keys`);

    const out = path.join(__dirname, 'schema.sql');
    fs.writeFileSync(
        out,
        [
            '-- Keyteki schema for SQL Server (2022, compatibility level 160), generated by convert-from-postgres.js',
            '-- from a Postgres database with all Keyteki migrations applied. Run in an empty database.',
            'SET QUOTED_IDENTIFIER ON;',
            '',
            ...ddlTables,
            '',
            ...ddlIndexes,
            '',
            ...ddlFks,
            ''
        ].join('\n')
    );
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
    await pg.end();
    await ms.close();
}

main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
