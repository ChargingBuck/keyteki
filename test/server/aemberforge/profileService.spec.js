const ProfileService = require('../../../server/services/ProfileService');

// Rows as the games query returns them: one per player per finished game, newest first.
const row = (game, username, winner, extra = {}) => ({
    Id: game,
    StartedAt: new Date(`2026-11-0${game}T10:00:00Z`),
    FinishedAt: new Date(`2026-11-0${game}T10:12:00Z`),
    WinReason: 'keys',
    Winner: winner,
    Username: username,
    Keys: username === winner ? 3 : 1,
    Turn: 20,
    Stats: null,
    DeckId: username === 'ash' ? 10 : 20,
    DeckName: username === 'ash' ? 'Ash Deck' : 'Corvid Deck',
    Expansion: 341,
    ...extra
});

function fakeDb({
    user = { Id: 1, Username: 'ash', Registered: new Date('2026-09-01') },
    games = [],
    houses = [],
    avatars = []
}) {
    return {
        query: vi.fn(async (text) => {
            if (text.startsWith('SELECT "Id", "Username", "Registered"')) {
                return user ? [user] : [];
            }

            if (text.includes('"Settings_Avatar"')) {
                return avatars;
            }

            if (text.includes('FROM "DeckHouses"')) {
                return houses;
            }

            return games;
        })
    };
}

describe('ProfileService', function () {
    it('returns undefined for an unknown player', async function () {
        const service = new ProfileService(fakeDb({ user: null }));
        expect(await service.getProfile('nobody')).toBeUndefined();
    });

    it('adds up record, keys, Æmber, decks, rivals and cards from both players’ rows', async function () {
        const games = [
            row(3, 'ash', 'ash', {
                Stats: {
                    amberGained: 12,
                    amberFromReaping: 5,
                    cards: { valdr: { played: 2, reaps: 1, fights: 0 } }
                }
            }),
            row(3, 'corvid', 'ash'),
            // Stats stored as text (older rows) are parsed too.
            row(2, 'ash', 'corvid', {
                Stats: JSON.stringify({
                    amberGained: 8,
                    cards: { valdr: { played: 1, reaps: 2, fights: 1 }, punch: { played: 3 } }
                })
            }),
            row(2, 'corvid', 'corvid'),
            row(1, 'ash', 'ash', { WinReason: 'concede' }),
            row(1, 'corvid', 'ash')
        ];
        const houses = [
            { DeckId: 10, Code: 'brobnar' },
            { DeckId: 10, Code: 'logos' },
            { DeckId: 10, Code: 'untamed' },
            { DeckId: 20, Code: 'dis' }
        ];
        const avatars = [
            { Username: 'ash', Settings_Avatar: 'ash-abc123' },
            { Username: 'corvid', Settings_Avatar: 'corvid' }
        ];
        const p = await new ProfileService(fakeDb({ games, houses, avatars })).getProfile('ash');

        expect(p.username).toBe('ash');
        // Only uploaded pictures are reported; corvid still has the sign-up identicon.
        expect(p.avatar).toBe('ash-abc123');
        expect(p.avatars).toEqual({ ash: 'ash-abc123' });
        expect(p.totals).toEqual(
            expect.objectContaining({
                games: 3,
                wins: 2,
                losses: 1,
                keysForged: 7,
                amberGained: 20,
                amberFromReaping: 5,
                winsByKeys: 1,
                winsByConcede: 1,
                seconds: 3 * 12 * 60
            })
        );
        expect(p.decks).toEqual([
            {
                id: 10,
                name: 'Ash Deck',
                expansion: 341,
                houses: ['brobnar', 'logos', 'untamed'],
                games: 3,
                wins: 2
            }
        ]);
        expect(p.rivals).toEqual([{ name: 'corvid', games: 3, wins: 2 }]);
        expect(p.topCards[0]).toEqual({ id: 'valdr', played: 3, reaps: 3, fights: 1 });
        expect(p.topCards.map((c) => c.id)).toEqual(['valdr', 'punch']);

        expect(p.recent).toHaveLength(3);
        expect(p.recent[0]).toEqual(
            expect.objectContaining({
                id: 3,
                won: true,
                opponent: 'corvid',
                myKeys: 3,
                theirKeys: 1,
                seconds: 720,
                turns: 20
            })
        );
        expect(p.recent[0].theirDeck).toEqual({
            id: 20,
            name: 'Corvid Deck',
            expansion: 341,
            houses: ['dis']
        });
        expect(p.recent[1].won).toBe(false);
    });

    it('skips games missing the opponent’s row', async function () {
        const p = await new ProfileService(fakeDb({ games: [row(1, 'ash', 'ash')] })).getProfile(
            'ash'
        );
        expect(p.totals.games).toBe(0);
        expect(p.recent).toEqual([]);
    });
});
