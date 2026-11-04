// Aemberforge: profile pictures. An upload is decoded, cropped to a centred square and re-encoded as a 256x256 PNG
// (so nothing but pixels is ever stored) in public/img/avatar/<username>-<random>.png, and its name is saved in the
// user's Settings_Avatar. Keyteki's sign-up identicon is named after the username itself, so a different name means a
// picture the player chose.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
/** Uploads bigger than this (decoded) are refused before decoding. */
const MAX_BYTES = 3 * 1024 * 1024;

const isPng = (b) => b.length > 8 && b.toString('hex', 0, 4) === '89504e47';
const isJpeg = (b) => b.length > 3 && b.toString('hex', 0, 3) === 'ffd8ff';
const isWebp = (b) =>
    b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';

/** Only letters, digits, '-' and '_' survive; the name is a file name. */
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');

class AvatarStore {
    /**
     * @param {object} options
     * @param {{ query: Function }} [options.db]
     * @param {string} [options.dir] where pictures are written (public/img/avatar)
     * @param {(buffer: Buffer) => Promise<Buffer>} [options.render] decodes and re-encodes (tests replace it)
     */
    constructor({ db, dir, render } = {}) {
        this.db = db || require('../db');
        this.dir = dir || path.resolve(__dirname, '..', '..', 'public', 'img', 'avatar');
        this.render = render || renderSquare;
    }

    /** True when the stored avatar name is a picture the player uploaded. */
    static isCustom(username, avatar) {
        return !!avatar && avatar !== username;
    }

    /**
     * @param {string} username
     * @param {string} base64 PNG, JPEG or WebP
     * @returns {Promise<string>} the new avatar name
     */
    async set(username, base64) {
        if (typeof base64 !== 'string' || base64.length === 0) {
            throw new AvatarError('No picture was sent.');
        }

        const data = base64.replace(/^data:image\/[a-z]+;base64,/, '');
        if (data.length > (MAX_BYTES * 4) / 3 + 4) {
            throw new AvatarError('That picture is too large (3 MB at most).');
        }

        const buffer = Buffer.from(data, 'base64');
        if (!isPng(buffer) && !isJpeg(buffer) && !isWebp(buffer)) {
            throw new AvatarError('Pictures must be PNG, JPEG or WebP.');
        }

        const user = await this.getUser(username);
        const old = user.Settings_Avatar; // read before saving: the row object may be updated in place
        let png;
        try {
            png = await this.render(buffer);
        } catch {
            throw new AvatarError('That picture could not be read.');
        }

        const name = `${safeName(user.Username)}-${crypto.randomBytes(8).toString('hex')}`;
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(this.file(name), png);
        await this.save(user.Id, name);
        this.remove(user.Username, old);
        return name;
    }

    /** Back to the sign-up identicon. */
    async clear(username) {
        const user = await this.getUser(username);
        const old = user.Settings_Avatar; // read before saving: the row object may be updated in place
        await this.save(user.Id, user.Username);
        this.remove(user.Username, old);
    }

    async getUser(username) {
        const rows = await this.db.query(
            'SELECT "Id", "Username", "Settings_Avatar" FROM "Users" WHERE "Username" = $1',
            [username]
        );
        if (!rows || rows.length === 0) {
            throw new AvatarError('No such player.');
        }

        return rows[0];
    }

    save(id, name) {
        return this.db.query('UPDATE "Users" SET "Settings_Avatar" = $1 WHERE "Id" = $2', [
            name,
            id
        ]);
    }

    file(name) {
        const resolved = path.resolve(this.dir, `${safeName(name)}.png`);
        if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
            throw new Error('Invalid avatar path');
        }

        return resolved;
    }

    /** Deletes an old uploaded picture (never the identicon). */
    remove(username, avatar) {
        if (!AvatarStore.isCustom(username, avatar) || !safeName(avatar)) {
            return;
        }

        fs.promises.unlink(this.file(avatar)).catch(() => {});
    }
}

class AvatarError extends Error {}

/** Decodes an image and draws its centred square, scaled to SIZE x SIZE, as PNG. */
async function renderSquare(buffer) {
    const { createCanvas, loadImage } = require('canvas');
    const img = await loadImage(buffer);
    const side = Math.min(img.width, img.height);
    if (!side) {
        throw new Error('empty image');
    }

    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        SIZE,
        SIZE
    );
    return canvas.toBuffer('image/png');
}

module.exports = { AvatarStore, AvatarError, renderSquare };
