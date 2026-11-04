const { inviteCodeMatches, inviteCodeRequired } = require('../../../server/services/InviteCode');
const { purgeOldMessages, startChatRetention } = require('../../../server/services/ChatRetention');
const { MemoryRedisClient, _store } = require('../../../server/services/MemoryRedis');

describe('InviteCode', function () {
    it('is not required when unset or blank', function () {
        expect(inviteCodeRequired(undefined)).toBe(false);
        expect(inviteCodeRequired('  ')).toBe(false);
        expect(inviteCodeMatches('', undefined)).toBe(true);
    });

    it('accepts the right code, ignoring case and surrounding spaces', function () {
        expect(inviteCodeMatches('Aember-Night', 'aember-night')).toBe(true);
        expect(inviteCodeMatches('Aember-Night', '  AEMBER-NIGHT ')).toBe(true);
    });

    it('rejects a wrong or missing code', function () {
        expect(inviteCodeMatches('Aember-Night', 'aember-day')).toBe(false);
        expect(inviteCodeMatches('Aember-Night', '')).toBe(false);
        expect(inviteCodeMatches('Aember-Night', undefined)).toBe(false);
        expect(inviteCodeMatches('Aember-Night', { code: 'Aember-Night' })).toBe(false);
    });
});

describe('ChatRetention', function () {
    const fakeDb = (rows = []) => ({ calls: [], query: vi.fn(async () => rows) });
    const logger = { info: vi.fn(), error: vi.fn() };

    it('deletes lobby messages older than the cutoff', async function () {
        const db = fakeDb([{ Id: 1 }, { Id: 2 }]);
        const now = new Date('2026-11-30T12:00:00Z');

        expect(await purgeOldMessages(db, 30, now)).toBe(2);
        const [text, params] = db.query.mock.calls[0];
        expect(text).toMatch(/^DELETE FROM "Messages" WHERE "PostedTime" < \$1/);
        expect(params[0].toISOString()).toBe('2026-10-31T12:00:00.000Z');
    });

    it('is off for 0, blank or nonsense', function () {
        for (const days of [0, '0', '', undefined, 'forever', -5]) {
            expect(startChatRetention({ db: fakeDb(), days, logger })).toBeUndefined();
        }
    });

    it('purges at start and keeps running when the database fails', async function () {
        const db = { query: vi.fn().mockRejectedValue(new Error('offline')) };
        const retention = startChatRetention({ db, days: '30', logger });
        try {
            expect(db.query).toHaveBeenCalledTimes(1);
            expect(await retention.purge()).toBe(0);
            expect(logger.error).toHaveBeenCalled();
        } finally {
            retention.stop();
        }
    });
});

describe('MemoryRedisClient', function () {
    beforeEach(function () {
        _store.clear();
    });

    it('shares keys between clients and supports glob patterns', async function () {
        const a = await new MemoryRedisClient().connect();
        const b = await new MemoryRedisClient().connect();

        await a.set('cards:en', '[]');
        await a.set('cards:fr', '[]');
        await a.set('other', 1);

        expect(await b.get('other')).toBe('1');
        expect((await b.keys('cards:*')).sort()).toEqual(['cards:en', 'cards:fr']);
        expect(await b.del(['cards:en', 'missing'])).toBe(1);
        expect(await b.get('cards:en')).toBeNull();
    });

    it('delivers published messages asynchronously, and stops after unsubscribe', async function () {
        const pub = await new MemoryRedisClient().connect();
        const sub = await new MemoryRedisClient().connect();
        const got = [];

        await sub.subscribe('nodemessage', (message) => got.push(message));
        expect(await pub.publish('nodemessage', 'hello')).toBe(1);
        expect(got).toEqual([]);

        await new Promise((resolve) => setImmediate(resolve));
        expect(got).toEqual(['hello']);

        await sub.unsubscribe('nodemessage');
        await pub.publish('nodemessage', 'again');
        await new Promise((resolve) => setImmediate(resolve));
        expect(got).toEqual(['hello']);
    });
});
