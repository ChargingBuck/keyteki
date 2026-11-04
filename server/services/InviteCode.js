const crypto = require('crypto');

/**
 * Aemberforge: sign-up is by invite. When `lobby.inviteCode` (INVITE_CODE) is set, /api/account/register needs the
 * same code in `inviteCode`. Unset or empty keeps Keyteki's open registration (the hub refuses to start in production
 * without one, see server/hub.js).
 *
 * Compared case-insensitively, ignoring surrounding spaces (codes are read out or typed by friends), in constant time.
 */
function normalise(code) {
    return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

function inviteCodeRequired(expected) {
    return normalise(expected) !== '';
}

function inviteCodeMatches(expected, given) {
    if (!inviteCodeRequired(expected)) {
        return true;
    }

    // Hash both, so the comparison is constant-time whatever the lengths.
    const a = crypto.createHash('sha256').update(normalise(expected)).digest();
    const b = crypto.createHash('sha256').update(normalise(given)).digest();

    return normalise(given) !== '' && crypto.timingSafeEqual(a, b);
}

module.exports = { inviteCodeMatches, inviteCodeRequired };
