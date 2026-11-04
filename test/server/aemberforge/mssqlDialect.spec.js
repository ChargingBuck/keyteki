const { translate, UnsupportedSqlError } = require('../../../server/db/mssqlDialect');

// Whitespace-insensitive comparison: the translator may leave extra spaces where it moves clauses.
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const sql = (text, params) => squash(translate(text, params).text);

describe('mssqlDialect.translate', function () {
    describe('parameters', function () {
        it('renames $n to @pn and names the values', function () {
            const t = translate('SELECT * FROM "Users" WHERE "Id" = $1 AND "Name" = $2', [7, 'x']);
            expect(squash(t.text)).toBe('SELECT * FROM "Users" WHERE "Id" = @p1 AND "Name" = @p2');
            expect(t.params).toEqual({ p1: 7, p2: 'x' });
        });

        it('does not confuse $1 with $10', function () {
            const params = Array.from({ length: 10 }, (_, i) => i + 1);
            const t = translate('SELECT $10, $1', params);
            expect(squash(t.text)).toBe('SELECT @p10, @p1');
            expect(t.params.p1).toBe(1);
            expect(t.params.p10).toBe(10);
            expect(t.params.p2).toBeUndefined();
        });

        it('expands = ANY($n) into an IN list', function () {
            const t = translate('SELECT * FROM "Cards" WHERE "Id" = ANY($1)', [['a', 'b']]);
            expect(squash(t.text)).toBe('SELECT * FROM "Cards" WHERE "Id" IN (@p1_0, @p1_1)');
            expect(t.params).toEqual({ p1_0: 'a', p1_1: 'b' });
        });

        it('matches nothing for ANY() of an empty array', function () {
            expect(sql('SELECT * FROM "Cards" WHERE "Id" = ANY($1)', [[]])).toBe(
                'SELECT * FROM "Cards" WHERE "Id" IN (NULL)'
            );
        });

        it('refuses ANY() without an array', function () {
            expect(() => translate('SELECT 1 WHERE 1 = ANY($1)', [5])).toThrow(UnsupportedSqlError);
        });
    });

    describe('literals and identifiers are left alone', function () {
        it('keeps string contents, including escaped quotes and keywords', function () {
            expect(sql("SELECT 'it''s true LIMIT 5 $1' AS x", [])).toBe(
                "SELECT 'it''s true LIMIT 5 $1' AS [x]"
            );
        });

        it('keeps quoted identifiers that look like keywords', function () {
            expect(sql('SELECT "true", "now" FROM "T"')).toBe('SELECT "true", "now" FROM "T"');
        });
    });

    describe('expressions', function () {
        it('turns booleans into bits', function () {
            expect(sql('UPDATE "Users" SET "Disabled" = true WHERE "Verified" = false')).toBe(
                'UPDATE "Users" SET "Disabled" = 1 WHERE "Verified" = 0'
            );
        });

        it('maps now(), current_date and random()', function () {
            expect(sql('SELECT now(), current_date FROM "T" ORDER BY random()')).toBe(
                'SELECT SYSUTCDATETIME(), CAST(SYSUTCDATETIME() AS date) FROM "T" ORDER BY NEWID()'
            );
        });

        it('turns || into +', function () {
            expect(sql(`SELECT "First" || ' ' || "Last" FROM "T"`)).toBe(
                `SELECT "First" + ' ' + "Last" FROM "T"`
            );
        });

        it('lower-cases unquoted aliases, as Postgres does', function () {
            expect(sql('SELECT COUNT(*) AS Count FROM "T"')).toBe(
                'SELECT COUNT(*) AS [count] FROM "T"'
            );
        });

        it('leaves CAST(... AS type) alone', function () {
            expect(sql('SELECT CAST("X" AS int) FROM "T"')).toBe(
                'SELECT CAST("X" AS int) FROM "T"'
            );
        });

        it('rewrites COUNT(*) FILTER (WHERE ...)', function () {
            expect(sql('SELECT COUNT(*) FILTER (WHERE "Won" = true) AS wins FROM "G"')).toBe(
                'SELECT SUM(CASE WHEN "Won" = 1 THEN 1 ELSE 0 END) AS [wins] FROM "G"'
            );
        });
    });

    describe('LIMIT', function () {
        it('becomes TOP without ORDER BY', function () {
            expect(sql('SELECT * FROM "T" WHERE "A" = $1 LIMIT 1', [1])).toBe(
                'SELECT TOP (1) * FROM "T" WHERE "A" = @p1'
            );
        });

        it('keeps DISTINCT before TOP', function () {
            expect(sql('SELECT DISTINCT "A" FROM "T" LIMIT 5')).toBe(
                'SELECT DISTINCT TOP (5) "A" FROM "T"'
            );
        });

        it('becomes OFFSET/FETCH with ORDER BY', function () {
            expect(sql('SELECT * FROM "T" ORDER BY "A" LIMIT $1 OFFSET $2', [10, 20])).toBe(
                'SELECT * FROM "T" ORDER BY "A" OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY'
            );
        });

        it('handles a LIMIT inside a subquery on its own', function () {
            expect(
                sql(
                    'SELECT * FROM "T" WHERE "Id" IN (SELECT "Id" FROM "U" LIMIT 3) ORDER BY "A" LIMIT 2'
                )
            ).toBe(
                'SELECT * FROM "T" WHERE "Id" IN (SELECT TOP (3) "Id" FROM "U" ) ORDER BY "A" OFFSET 0 ROWS FETCH NEXT 2 ROWS ONLY'
            );
        });

        it('refuses OFFSET without ORDER BY', function () {
            expect(() => translate('SELECT * FROM "T" LIMIT 1 OFFSET 1')).toThrow(
                UnsupportedSqlError
            );
        });
    });

    describe('RETURNING', function () {
        it('becomes OUTPUT INSERTED after the INSERT column list', function () {
            expect(sql('INSERT INTO "T" ("A", "B") VALUES ($1, $2) RETURNING "Id"', [1, 2])).toBe(
                'INSERT INTO "T" ("A", "B") OUTPUT INSERTED."Id" VALUES (@p1, @p2)'
            );
        });

        it('goes before WHERE in an UPDATE', function () {
            expect(sql('UPDATE "T" SET "A" = $1 WHERE "Id" = $2 RETURNING "Id", "A"', [1, 2])).toBe(
                'UPDATE "T" SET "A" = @p1 OUTPUT INSERTED."Id", INSERTED."A" WHERE "Id" = @p2'
            );
        });

        it('uses DELETED in a DELETE', function () {
            expect(sql('DELETE FROM "Messages" WHERE "PostedTime" < $1 RETURNING "Id"', [0])).toBe(
                'DELETE FROM "Messages" OUTPUT DELETED."Id" WHERE "PostedTime" < @p1'
            );
        });
    });

    describe('joins', function () {
        it('turns LEFT JOIN LATERAL ... ON true into OUTER APPLY', function () {
            expect(
                sql('SELECT * FROM "U" u LEFT JOIN LATERAL (SELECT "X" FROM "R" LIMIT 1) r ON true')
            ).toBe('SELECT * FROM "U" u OUTER APPLY (SELECT TOP (1) "X" FROM "R" ) r');
        });

        it('turns JOIN LATERAL into CROSS APPLY', function () {
            expect(sql('SELECT * FROM "U" u JOIN LATERAL (SELECT "X" FROM "R") r ON true')).toBe(
                'SELECT * FROM "U" u CROSS APPLY (SELECT "X" FROM "R") r'
            );
        });

        it('turns DELETE ... USING into DELETE alias FROM ... CROSS JOIN', function () {
            expect(sql('DELETE FROM "A" a USING "B" b WHERE a."BId" = b."Id"')).toBe(
                'DELETE a FROM "A" a CROSS JOIN "B" b WHERE a."BId" = b."Id"'
            );
        });
    });

    describe('Postgres-only SQL', function () {
        for (const text of [
            'INSERT INTO "T" ("A") VALUES ($1) ON CONFLICT ("A") DO NOTHING',
            'SELECT json_agg("A") FROM "T"',
            'SELECT array_agg("A") FROM "T"',
            'SELECT * FROM "T" WHERE "A" ILIKE $1',
            'SELECT DISTINCT ON ("A") * FROM "T"',
            'SELECT * FROM unnest($1)',
            'SELECT "A"::text FROM "T"'
        ]) {
            it(`refuses: ${text}`, function () {
                expect(() => translate(text, [['x']])).toThrow(UnsupportedSqlError);
            });
        }
    });
});
