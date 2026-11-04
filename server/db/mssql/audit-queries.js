// Aemberforge: finds every SQL statement Keyteki's server code passes to db.query / db.queryTran, translates it with
// mssqlDialect, and asks SQL Server to compile it (names and syntax checked, nothing executed). Prints what fails, so
// it can be fixed by hand. Usage:
//   node server/db/mssql/audit-queries.js --mssql ../devservices/mssql-app.json [--verbose]
//
// Statements are read from the source with a JS parser: string literals, + concatenations and template literals.
// A ${...} inside a template becomes a placeholder parameter, and is reported, since it usually builds a VALUES list.

const fs = require('fs');
const path = require('path');
const espree = require('espree');
const sql = require('mssql');
const { translate } = require('../mssqlDialect');

const args = process.argv.slice(2);
const MSSQL_FILE = args[args.indexOf('--mssql') + 1];
const verbose = args.includes('--verbose');
const ROOT = path.join(__dirname, '..', '..', '..'); // the Keyteki checkout

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            return ['node_modules', 'game', 'db'].includes(e.name) ? [] : files(p);
        }
        return e.name.endsWith('.js') ? [p] : [];
    });
}

/** The SQL text of an argument node, or undefined if it isn't built from literals. */
function sqlOf(node, notes) {
    if (!node) {
        return undefined;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        let s = '';
        node.quasis.forEach((q, i) => {
            s += q.value.cooked;
            if (i < node.expressions.length) {
                notes.push('template expression');
                s += '__EXPR__';
            }
        });
        return s;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const l = sqlOf(node.left, notes);
        const r = sqlOf(node.right, notes);
        if (l === undefined || r === undefined) {
            notes.push('non-literal concatenation');
            return (l ?? '__EXPR__') + (r ?? '__EXPR__');
        }
        return l + r;
    }
    return undefined;
}

function collect() {
    const out = [];
    for (const file of files(path.join(ROOT, 'server'))) {
        const src = fs.readFileSync(file, 'utf8');
        if (!/db\.(query|queryTran)\(/.test(src)) {
            continue;
        }
        const ast = espree.parse(src, {
            ecmaVersion: require('espree').latestEcmaVersion,
            sourceType: 'script',
            loc: true
        });
        const walk = (n) => {
            if (!n || typeof n.type !== 'string') {
                return;
            }
            if (
                n.type === 'CallExpression' &&
                n.callee.type === 'MemberExpression' &&
                n.callee.object.name === 'db' &&
                ['query', 'queryTran'].includes(n.callee.property.name)
            ) {
                const argNode =
                    n.callee.property.name === 'queryTran' ? n.arguments[1] : n.arguments[0];
                const notes = [];
                const text = sqlOf(argNode, notes);
                out.push({ file: path.relative(ROOT, file), line: n.loc.start.line, text, notes });
            }
            for (const k of Object.keys(n)) {
                const v = n[k];
                if (Array.isArray(v)) {
                    v.forEach(walk);
                } else if (v && typeof v.type === 'string' && k !== 'parent') {
                    walk(v);
                }
            }
        };
        walk(ast);
    }
    return out;
}

async function main() {
    const cfg = JSON.parse(fs.readFileSync(MSSQL_FILE, 'utf8'));
    const pool = await sql.connect({
        server: cfg.server,
        port: cfg.port || 1433,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        options: { encrypt: cfg.encrypt ?? false, trustServerCertificate: true }
    });
    const found = collect();
    let ok = 0;
    const problems = [];
    for (const q of found) {
        if (q.text === undefined) {
            problems.push({
                ...q,
                error: 'SQL is not a literal (built at runtime): check by hand'
            });
            continue;
        }
        if (/^\s*(COMMIT|ROLLBACK|BEGIN)\s*;?\s*$/i.test(q.text)) {
            ok++;
            continue;
        }
        const n = Math.max(0, ...[...q.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        // Placeholder parameters: arrays for ANY(), else strings (the compile check doesn't need real values).
        const params = Array.from({ length: n }, (_, i) =>
            new RegExp(`ANY\\s*\\(\\s*\\$${i + 1}\\s*\\)`, 'i').test(q.text) ? [1, 2] : 'x'
        );
        let t;
        try {
            t = translate(q.text.replace(/__EXPR__/g, '@pexpr'), params);
        } catch (e) {
            problems.push({ ...q, error: e.message });
            continue;
        }
        // Compile only: SET NOEXEC ON parses and binds names without running. Parameters are declared as NVARCHAR.
        // Row counts (TOP / OFFSET / FETCH) must be integers.
        const counted = new Set(
            [...t.text.matchAll(/(?:TOP\s*\(|OFFSET|FETCH\s+NEXT)\s*@(p\w+)/gi)].map((m) => m[1])
        );
        const declares = [...new Set([...t.text.matchAll(/@(p[\w]+)/g)].map((m) => m[1]))]
            .map((p) => `DECLARE @${p} ${counted.has(p) ? 'INT' : 'NVARCHAR(4000)'};`)
            .join(' ');
        try {
            await pool.request().batch(`SET NOEXEC ON; ${declares} ${t.text}; SET NOEXEC OFF;`);
            ok++;
            if (verbose) {
                console.log(`ok  ${q.file}:${q.line}`);
            }
        } catch (e) {
            await pool
                .request()
                .batch('SET NOEXEC OFF;')
                .catch(() => {});
            problems.push({ ...q, error: e.message, translated: t.text });
        }
    }
    console.log(
        `${found.length} statements: ${ok} compile on SQL Server, ${problems.length} need attention\n`
    );
    for (const p of problems) {
        console.log(
            `${p.file}:${p.line}${
                p.notes.length ? ` [${[...new Set(p.notes)].join(', ')}]` : ''
            }\n  ${p.error.slice(0, 220)}`
        );
        if (verbose && p.translated) {
            console.log(`  -> ${p.translated.slice(0, 300)}`);
        }
    }
    await pool.close();
}

main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
