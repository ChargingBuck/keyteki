// Aemberforge: translates the Postgres SQL Keyteki's services write into SQL Server SQL, so the services can stay
// (almost) as upstream wrote them. Only mechanical differences are handled here; anything that needs real rewriting
// (ON CONFLICT upserts, LATERAL joins, json_agg...) throws, so it is fixed by hand where it is used.
//
// Handled:
//   $1, $2 ...                  -> @p1, @p2 ...
//   = ANY($n) with an array     -> IN (@pn_0, @pn_1, ...)   (empty array: IN (NULL), i.e. nothing matches)
//   true / false                -> 1 / 0
//   now(), current_date         -> SYSUTCDATETIME(), CAST(SYSUTCDATETIME() AS date)
//   random()                    -> NEWID()   (ORDER BY random() picks a random row)
//   RETURNING a, b              -> OUTPUT INSERTED.a, INSERTED.b   (DELETED. for DELETE)
//   LIMIT n [OFFSET m]          -> OFFSET m ROWS FETCH NEXT n ROWS ONLY when that SELECT has an ORDER BY, else TOP (n)
//   AS alias (unquoted)         -> AS "alias" lower-cased, because Postgres folds unquoted aliases to lower case and
//                                  the services read them that way (e.g. `COUNT(*) as count` -> row.count)
//   x || y                      -> x + y   (string concatenation)
//   COUNT(*) FILTER (WHERE c)   -> SUM(CASE WHEN c THEN 1 ELSE 0 END)
//   [LEFT] JOIN LATERAL (q) a ON true -> OUTER APPLY / CROSS APPLY (q) a
//   DELETE FROM t a USING t2 b WHERE  -> DELETE a FROM t a CROSS JOIN t2 b WHERE
// String literals ('...') and quoted identifiers ("...") are never touched.

const UNSUPPORTED = [
    /\bON\s+CONFLICT\b/i,
    /\bjson_agg\b/i,
    /\bjson_build_object\b/i,
    /\barray_agg\b/i,
    /\bILIKE\b/i,
    /\bDISTINCT\s+ON\b/i,
    /\bARRAY\s*\[/i,
    /\bunnest\s*\(/i,
    /\bstring_agg\b/i,
    /::\s*\w+/
];

const TYPE_WORDS = new Set([
    'int',
    'integer',
    'bigint',
    'smallint',
    'text',
    'date',
    'datetime',
    'datetime2',
    'varchar',
    'nvarchar',
    'char',
    'numeric',
    'decimal',
    'boolean',
    'bit',
    'float',
    'real',
    'time',
    'timestamp'
]);

class UnsupportedSqlError extends Error {}

/** Splits SQL into code and protected parts ('strings' and "identifiers"), so transforms only see code. */
function protect(text) {
    const saved = [];
    const code = text.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => {
        saved.push(m);
        return `\uE000${saved.length - 1}\uE000`;
    });
    return { code, restore: (s) => s.replace(/\uE000(\d+)\uE000/g, (_, i) => saved[Number(i)]) };
}

/** Index of the matching close paren for the open paren at `open` (code without strings). */
function closeOf(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') {
            depth++;
        } else if (code[i] === ')' && --depth === 0) {
            return i;
        }
    }
    return code.length;
}

/** [start, end) of the innermost parenthesised scope containing position `pos` (whole text at depth 0). */
function scopeOf(code, pos) {
    let depth = 0;
    for (let i = pos - 1; i >= 0; i--) {
        if (code[i] === ')') {
            depth++;
        } else if (code[i] === '(') {
            if (depth === 0) {
                return [i + 1, closeOf(code, i)];
            }
            depth--;
        }
    }
    return [0, code.length];
}

/** Text of a scope with nested parenthesised parts blanked out (so ORDER BY / SELECT of subqueries don't count). */
function flatten(code, start, end) {
    let out = '';
    let depth = 0;
    for (let i = start; i < end; i++) {
        const ch = code[i];
        if (ch === '(') {
            depth++;
            out += depth === 1 ? '(' : ' ';
        } else if (ch === ')') {
            out += depth === 1 ? ')' : ' ';
            depth--;
        } else {
            out += depth > 0 ? ' ' : ch;
        }
    }
    return out;
}

function translateLimits(code) {
    // Right to left, so earlier positions stay valid.
    const re = /\bLIMIT\s+(@p\d+|\d+)(?:\s+OFFSET\s+(@p\d+|\d+))?/gi;
    const hits = [...code.matchAll(re)].reverse();
    for (const m of hits) {
        const [start, end] = scopeOf(code, m.index);
        const flat = flatten(code, start, end);
        const limit = m[1];
        const offset = m[2];
        const hasOrder = /\bORDER\s+BY\b/i.test(flat.slice(0, m.index - start));
        if (hasOrder) {
            code =
                code.slice(0, m.index) +
                `OFFSET ${offset ?? 0} ROWS FETCH NEXT ${limit} ROWS ONLY` +
                code.slice(m.index + m[0].length);
        } else {
            if (offset) {
                throw new UnsupportedSqlError('OFFSET without ORDER BY');
            }
            const sel = /\bSELECT\b(\s+DISTINCT\b)?/i.exec(flat);
            if (!sel) {
                throw new UnsupportedSqlError('LIMIT without SELECT');
            }
            code = code.slice(0, m.index) + code.slice(m.index + m[0].length);
            const at = start + sel.index + sel[0].length;
            code = code.slice(0, at) + ` TOP (${limit})` + code.slice(at);
        }
    }
    return code;
}

/** COUNT(*) FILTER (WHERE cond) -> SUM(CASE WHEN cond THEN 1 ELSE 0 END) */
function translateFilter(code) {
    const re = /COUNT\s*\(\s*\*\s*\)\s*FILTER\s*\(\s*WHERE\b/i;
    let m;
    while ((m = re.exec(code))) {
        const open = code.indexOf('(', code.toUpperCase().indexOf('FILTER', m.index));
        const close = closeOf(code, open);
        const cond = code.slice(code.toUpperCase().indexOf('WHERE', open) + 5, close).trim();
        code = `${code.slice(0, m.index)}SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)${code.slice(
            close + 1
        )}`;
    }
    return code;
}

/** [LEFT] JOIN LATERAL (subquery) alias ON true -> OUTER APPLY / CROSS APPLY (subquery) alias */
function translateLateral(code) {
    const re = /\b(LEFT\s+(?:OUTER\s+)?)?JOIN\s+LATERAL\s*\(/i;
    let m;
    while ((m = re.exec(code))) {
        const open = m.index + m[0].length - 1;
        const close = closeOf(code, open);
        const tail = /^\s*(?:AS\s+)?(\w+)\s+ON\s+(?:true|1)\b/i.exec(code.slice(close + 1));
        if (!tail) {
            throw new UnsupportedSqlError('LATERAL join without "alias ON true"');
        }
        const apply = m[1] ? 'OUTER APPLY' : 'CROSS APPLY';
        code = `${code.slice(0, m.index)}${apply} ${code.slice(open, close + 1)} ${
            tail[1]
        }${code.slice(close + 1 + tail[0].length)}`;
    }
    return code;
}

/** DELETE FROM t a USING t2 b WHERE ... -> DELETE a FROM t a CROSS JOIN t2 b WHERE ... */
function translateDeleteUsing(code) {
    return code.replace(
        /^\s*DELETE\s+FROM\s+(\S+)\s+(\w+)\s+USING\s+([\s\S]+?)\s+WHERE\b/i,
        (_, table, alias, using) =>
            `DELETE ${alias} FROM ${table} ${alias} CROSS JOIN ${using} WHERE`
    );
}

function translateReturning(code) {
    const m = /\s+RETURNING\s+([\s\S]+?)\s*;?\s*$/i.exec(code);
    if (!m) {
        return code;
    }
    const body = code.slice(0, m.index);
    const kind = /^\s*(INSERT|UPDATE|DELETE)\b/i.exec(body)?.[1]?.toUpperCase();
    if (!kind) {
        throw new UnsupportedSqlError('RETURNING on an unknown statement');
    }
    const prefix = kind === 'DELETE' ? 'DELETED.' : 'INSERTED.';
    const output =
        'OUTPUT ' +
        m[1]
            .split(',')
            .map((c) => prefix + c.trim())
            .join(', ');
    if (kind === 'INSERT') {
        const head = /^\s*INSERT\s+INTO\s+\S+\s*(\([^()]*\))?/i.exec(body);
        return `${body.slice(0, head[0].length)} ${output} ${body.slice(head[0].length)}`;
    }
    if (kind === 'DELETE') {
        const head = /^\s*DELETE\s+FROM\s+\S+(\s+(?!WHERE\b)\w+)?/i.exec(body);
        return `${body.slice(0, head[0].length)} ${output} ${body.slice(head[0].length)}`;
    }
    // UPDATE: OUTPUT goes before the top-level WHERE (or FROM), else at the end.
    const flat = flatten(body, 0, body.length);
    const w = /\b(FROM|WHERE)\b/i.exec(
        flat.replace(/^\s*UPDATE\s+\S+\s+SET\b/i, (s) => ' '.repeat(s.length))
    );
    return w ? `${body.slice(0, w.index)}${output} ${body.slice(w.index)}` : `${body} ${output}`;
}

/**
 * @param {string} text Postgres SQL as Keyteki writes it
 * @param {any[]} params its $1.. parameters
 * @returns {{ text: string, params: Record<string, any> }} SQL Server SQL and named parameters p1..
 */
function translate(text, params = []) {
    const { code: raw, restore } = protect(text);
    for (const re of UNSUPPORTED) {
        if (re.test(raw)) {
            throw new UnsupportedSqlError(
                `needs a SQL Server version by hand (${re}): ${text.slice(0, 160)}`
            );
        }
    }
    let code = raw;
    const named = {};

    // = ANY($n) with an array parameter -> IN (...)
    code = code.replace(/=\s*ANY\s*\(\s*\$(\d+)\s*\)/gi, (_, n) => {
        const v = params[Number(n) - 1];
        if (!Array.isArray(v)) {
            throw new UnsupportedSqlError(`ANY($${n}) needs an array parameter`);
        }
        if (!v.length) {
            return 'IN (NULL)';
        }
        return `IN (${v
            .map((x, i) => {
                named[`p${n}_${i}`] = x;
                return `@p${n}_${i}`;
            })
            .join(', ')})`;
    });
    code = code.replace(/\$(\d+)/g, '@p$1');
    code = code.replace(/\bAS\s+([A-Za-z_]\w*)\b/gi, (m, alias) =>
        TYPE_WORDS.has(alias.toLowerCase()) ? m : `AS [${alias.toLowerCase()}]`
    );
    code = code.replace(/\btrue\b/gi, '1').replace(/\bfalse\b/gi, '0');
    code = code.replace(/\brandom\s*\(\s*\)/gi, 'NEWID()');
    code = code
        .replace(/\bnow\s*\(\s*\)/gi, 'SYSUTCDATETIME()')
        .replace(/\bcurrent_date\b/gi, 'CAST(SYSUTCDATETIME() AS date)');
    code = code.replace(/\|\|/g, '+');
    code = translateFilter(code);
    code = translateLateral(code);
    code = translateDeleteUsing(code);
    code = translateLimits(code);
    code = translateReturning(code);

    // Every $n still referenced as @pn (ANY() arrays were expanded into @pn_i above).
    params.forEach((v, i) => {
        if (new RegExp(`@p${i + 1}(?![\\d_])`).test(code)) {
            named[`p${i + 1}`] = v;
        }
    });
    return { text: restore(code), params: named };
}

module.exports = { translate, UnsupportedSqlError };
