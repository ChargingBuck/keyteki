// Aemberforge: a player's profile from the SQL game history (Games / GamePlayers): totals, decks played, rivals,
// most-played cards and recent matches. Only finished games with a winner count.
const { AvatarStore } = require('./AvatarStore');

/** Most recent finished games looked at for the profile; plenty for a small group. */
const MAX_GAMES = 1000;
const RECENT = 25;

const GAMES_QUERY =
    'SELECT g."Id", g."StartedAt", g."FinishedAt", g."WinReason", w."Username" AS "Winner", ' +
    'u."Username", gp."Keys", gp."Turn", gp."Stats", d."Id" AS "DeckId", d."Name" AS "DeckName", e."ExpansionId" AS "Expansion" ' +
    'FROM "Games" g ' +
    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
    'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
    'JOIN "Users" w ON w."Id" = g."WinnerId" ' +
    'LEFT JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
    'LEFT JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
    'WHERE g."FinishedAt" IS NOT NULL AND g."Id" IN (' +
    'SELECT "GameId" FROM "GamePlayers" WHERE "PlayerId" = (SELECT "Id" FROM "Users" WHERE "Username" = $1)' +
    ') ORDER BY g."FinishedAt" DESC, g."Id" DESC';

/** Stats arrive parsed (Postgres jsonb, and the SQL Server layer's JSON columns); a string is parsed here. */
function parseStats(value) {
    if (!value) {
        return undefined;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

class ProfileService {
    /** @param {{ query: Function }} [database] the db module by default; tests pass a fake */
    constructor(database) {
        this.db = database || require('../db');
    }

    /**
     * @param {string} username
     * @returns {Promise<object | undefined>} undefined when there is no such user
     */
    async getProfile(username) {
        const users = await this.db.query(
            'SELECT "Id", "Username", "Registered" FROM "Users" WHERE "Username" = $1 AND "Disabled" = False',
            [username]
        );
        if (!users || users.length === 0) {
            return undefined;
        }

        const user = users[0];
        const rows = (await this.db.query(GAMES_QUERY, [user.Username])) || [];

        // One entry per game: this player's row and the opponent's.
        const games = new Map();
        for (const row of rows) {
            let game = games.get(row.Id);
            if (!game) {
                game = { row, me: undefined, them: undefined };
                games.set(row.Id, game);
            }

            if (row.Username === user.Username) {
                game.me = row;
            } else {
                game.them = row;
            }
        }

        const list = [...games.values()].filter((g) => g.me && g.them).slice(0, MAX_GAMES);
        const deckIds = new Set();
        for (const g of list) {
            for (const r of [g.me, g.them]) {
                if (r.DeckId) {
                    deckIds.add(r.DeckId);
                }
            }
        }

        const houses = await this.housesFor([...deckIds]);
        const deckOf = (r) =>
            r.DeckId
                ? {
                      id: r.DeckId,
                      name: r.DeckName,
                      expansion: r.Expansion,
                      houses: houses.get(r.DeckId) || []
                  }
                : undefined;

        const totals = {
            games: 0,
            wins: 0,
            losses: 0,
            keysForged: 0,
            amberGained: 0,
            amberFromReaping: 0,
            amberStolen: 0,
            amberCaptured: 0,
            turns: 0,
            seconds: 0,
            winsByKeys: 0,
            winsByConcede: 0
        };
        const decks = new Map();
        const rivals = new Map();
        const cards = new Map();

        for (const g of list) {
            const won = g.row.Winner === user.Username;
            const stats = parseStats(g.me.Stats) || {};
            totals.games++;
            totals[won ? 'wins' : 'losses']++;
            totals.keysForged += g.me.Keys || 0;
            totals.amberGained += stats.amberGained || 0;
            totals.amberFromReaping += stats.amberFromReaping || 0;
            totals.amberStolen += stats.amberStolen || 0;
            totals.amberCaptured += stats.amberCaptured || 0;
            totals.turns += g.me.Turn || 0;
            if (g.row.StartedAt && g.row.FinishedAt) {
                totals.seconds += Math.max(
                    0,
                    (new Date(g.row.FinishedAt) - new Date(g.row.StartedAt)) / 1000
                );
            }

            if (won && g.row.WinReason === 'keys') {
                totals.winsByKeys++;
            } else if (won && g.row.WinReason === 'concede') {
                totals.winsByConcede++;
            }

            const deck = deckOf(g.me);
            if (deck) {
                const d = decks.get(deck.id) || { ...deck, games: 0, wins: 0 };
                d.games++;
                d.wins += won ? 1 : 0;
                decks.set(deck.id, d);
            }

            const rival = rivals.get(g.them.Username) || {
                name: g.them.Username,
                games: 0,
                wins: 0
            };
            rival.games++;
            rival.wins += won ? 1 : 0;
            rivals.set(g.them.Username, rival);

            for (const [id, c] of Object.entries(stats.cards || {})) {
                const card = cards.get(id) || { id, played: 0, reaps: 0, fights: 0 };
                card.played += c.played || 0;
                card.reaps += c.reaps || 0;
                card.fights += c.fights || 0;
                cards.set(id, card);
            }
        }

        const recent = list.slice(0, RECENT).map((g) => ({
            id: g.row.Id,
            finishedAt: g.row.FinishedAt,
            seconds:
                g.row.StartedAt && g.row.FinishedAt
                    ? Math.round((new Date(g.row.FinishedAt) - new Date(g.row.StartedAt)) / 1000)
                    : undefined,
            won: g.row.Winner === user.Username,
            winReason: g.row.WinReason,
            turns: Math.max(g.me.Turn || 0, g.them.Turn || 0),
            opponent: g.them.Username,
            myKeys: g.me.Keys || 0,
            theirKeys: g.them.Keys || 0,
            myDeck: deckOf(g.me),
            theirDeck: deckOf(g.them)
        }));

        const names = new Set([user.Username, ...rivals.keys()]);
        const avatars = await this.avatarsFor([...names]);

        return {
            username: user.Username,
            registered: user.Registered,
            avatar: avatars[user.Username],
            avatars,
            totals,
            decks: [...decks.values()].sort((a, b) => b.games - a.games || b.wins - a.wins),
            rivals: [...rivals.values()].sort((a, b) => b.games - a.games),
            topCards: [...cards.values()]
                .sort((a, b) => b.played - a.played || b.reaps + b.fights - (a.reaps + a.fights))
                .slice(0, 8),
            recent
        };
    }

    /** Uploaded profile pictures (avatar names) by username; players without one are left out. */
    async avatarsFor(usernames) {
        const result = {};
        if (usernames.length === 0) {
            return result;
        }

        const params = usernames.map((_, i) => `$${i + 1}`).join(', ');
        const rows =
            (await this.db.query(
                `SELECT "Username", "Settings_Avatar" FROM "Users" WHERE "Username" IN (${params})`,
                usernames
            )) || [];
        for (const row of rows) {
            if (AvatarStore.isCustom(row.Username, row.Settings_Avatar)) {
                result[row.Username] = row.Settings_Avatar;
            }
        }

        return result;
    }

    /** House codes per deck id. */
    async housesFor(deckIds) {
        const map = new Map();
        if (deckIds.length === 0) {
            return map;
        }

        // Ids are integers from our own query, so inlining them is safe.
        const ids = deckIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
        const rows =
            (await this.db.query(
                `SELECT dh."DeckId", h."Code" FROM "DeckHouses" dh JOIN "Houses" h ON h."Id" = dh."HouseId" WHERE dh."DeckId" IN (${ids.join(
                    ','
                )})`,
                []
            )) || [];
        for (const row of rows) {
            const list = map.get(row.DeckId) || [];
            list.push(row.Code);
            map.set(row.DeckId, list);
        }

        return map;
    }
}

module.exports = ProfileService;
