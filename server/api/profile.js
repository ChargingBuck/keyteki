// Aemberforge: player profiles (totals, decks, rivals, top cards, recent matches) and profile pictures. Any signed-in
// player can view any profile; nothing private (email, settings) is included. Only you can change your own picture.
const passport = require('passport');

const ProfileService = require('../services/ProfileService');
const { AvatarStore, AvatarError } = require('../services/AvatarStore');
const logger = require('../log.js');
const { wrapAsync } = require('../util.js');

const profileService = new ProfileService();
const avatarStore = new AvatarStore();

module.exports.init = function (server) {
    server.get(
        '/api/profile/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const profile = await profileService.getProfile(req.params.username);
            if (!profile) {
                return res.status(404).send({ success: false, message: 'No such player' });
            }

            res.send({ success: true, profile });
        })
    );

    const own = (req, res) => {
        if (req.user.username !== req.params.username) {
            res.status(403).send({
                success: false,
                message: 'You can only change your own picture'
            });
            return false;
        }

        return true;
    };

    const handle = (res, err) => {
        if (err instanceof AvatarError) {
            return res.send({ success: false, message: err.message });
        }

        logger.error('Failed to update avatar', err);
        res.send({ success: false, message: 'The picture could not be saved. Try again later.' });
    };

    // Body: { image: base64 PNG / JPEG / WebP }. Stored as a 256x256 PNG.
    server.put(
        '/api/profile/:username/avatar',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!own(req, res)) {
                return;
            }

            try {
                const avatar = await avatarStore.set(req.user.username, req.body && req.body.image);
                res.send({ success: true, avatar });
            } catch (err) {
                handle(res, err);
            }
        })
    );

    server.delete(
        '/api/profile/:username/avatar',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!own(req, res)) {
                return;
            }

            try {
                await avatarStore.clear(req.user.username);
                res.send({ success: true });
            } catch (err) {
                handle(res, err);
            }
        })
    );
};
