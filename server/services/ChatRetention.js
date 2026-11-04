/**
 * Aemberforge: lobby chat is kept for `lobby.chatRetentionDays` (CHAT_RETENTION_DAYS) days, then deleted. Runs once
 * at start and then every few hours. 0 or unset keeps everything (Keyteki's behaviour). Only the lobby chat table
 * ("Messages") is touched: in-game chat is never stored.
 */
const HOUR = 60 * 60 * 1000;

async function purgeOldMessages(db, days, now = new Date()) {
    const cutoff = new Date(now.getTime() - days * 24 * HOUR);
    const deleted = await db.query(
        'DELETE FROM "Messages" WHERE "PostedTime" < $1 RETURNING "Id"',
        [cutoff]
    );

    return deleted.length;
}

/**
 * @param {{ db: { query: Function }, days: number, logger: { info: Function, error: Function }, intervalMs?: number }} options
 * @returns {{ stop: () => void, purge: () => Promise<number> } | undefined} undefined when retention is off
 */
function startChatRetention({ db, days, logger, intervalMs = 6 * HOUR }) {
    days = Number(days);
    if (!Number.isFinite(days) || days <= 0) {
        return undefined;
    }

    const purge = async () => {
        try {
            const n = await purgeOldMessages(db, days);
            if (n > 0) {
                logger.info(`Chat retention: deleted ${n} lobby messages older than ${days} days`);
            }

            return n;
        } catch (err) {
            logger.error('Chat retention: could not delete old lobby messages', err);
            return 0;
        }
    };

    purge();
    const timer = setInterval(purge, intervalMs);
    // Don't keep the process alive just for this.
    timer.unref();

    return { stop: () => clearInterval(timer), purge };
}

module.exports = { purgeOldMessages, startChatRetention };
