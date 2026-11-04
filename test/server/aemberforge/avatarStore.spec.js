const fs = require('fs');
const os = require('os');
const path = require('path');

const { AvatarStore, AvatarError, renderSquare } = require('../../../server/services/AvatarStore');

// A 1x1 PNG and the start of a JPEG; the renderer is faked except in the last test.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function setup(avatar = 'ash') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-avatar-'));
    const db = {
        user: { Id: 7, Username: 'ash', Settings_Avatar: avatar },
        query: vi.fn(async function (text, params) {
            if (text.startsWith('SELECT')) {
                return [db.user];
            }

            db.user.Settings_Avatar = params[0];
            return [];
        })
    };
    const store = new AvatarStore({ db, dir, render: async () => Buffer.from('png-bytes') });
    return { dir, db, store };
}

describe('AvatarStore', function () {
    it('knows the sign-up identicon from an uploaded picture', function () {
        expect(AvatarStore.isCustom('ash', 'ash')).toBe(false);
        expect(AvatarStore.isCustom('ash', undefined)).toBe(false);
        expect(AvatarStore.isCustom('ash', 'ash-0123abcd')).toBe(true);
    });

    it('stores an upload as a new file, saves its name and deletes the old picture', async function () {
        const { dir, db, store } = setup('ash-old');
        fs.writeFileSync(path.join(dir, 'ash-old.png'), 'old');

        const name = await store.set('ash', PNG.toString('base64'));

        expect(name).toMatch(/^ash-[0-9a-f]{16}$/);
        expect(fs.readFileSync(path.join(dir, `${name}.png`), 'utf8')).toBe('png-bytes');
        expect(db.user.Settings_Avatar).toBe(name);
        await new Promise((r) => setTimeout(r, 20));
        expect(fs.existsSync(path.join(dir, 'ash-old.png'))).toBe(false);
    });

    it('accepts a data URL', async function () {
        const { store } = setup();
        await expect(
            store.set('ash', `data:image/png;base64,${PNG.toString('base64')}`)
        ).resolves.toMatch(/^ash-/);
    });

    it('refuses anything that is not a PNG, JPEG or WebP, and empty uploads', async function () {
        const { store, db } = setup();
        await expect(
            store.set('ash', Buffer.from('GIF89a....').toString('base64'))
        ).rejects.toThrow(AvatarError);
        await expect(store.set('ash', '')).rejects.toThrow(AvatarError);
        await expect(store.set('ash', undefined)).rejects.toThrow(AvatarError);
        expect(db.user.Settings_Avatar).toBe('ash');
    });

    it('refuses uploads over 3 MB', async function () {
        const { store } = setup();
        const big = Buffer.concat([PNG, Buffer.alloc(3.2 * 1024 * 1024)]).toString('base64');
        await expect(store.set('ash', big)).rejects.toThrow(/too large/);
    });

    it('reports a picture that cannot be decoded', async function () {
        const { db, dir } = setup();
        const store = new AvatarStore({
            db,
            dir,
            render: async () => {
                throw new Error('bad');
            }
        });
        await expect(store.set('ash', PNG.toString('base64'))).rejects.toThrow(/could not be read/);
    });

    it('goes back to the identicon without touching it', async function () {
        const { dir, db, store } = setup('ash-old');
        fs.writeFileSync(path.join(dir, 'ash.png'), 'identicon');
        fs.writeFileSync(path.join(dir, 'ash-old.png'), 'old');

        await store.clear('ash');
        await new Promise((r) => setTimeout(r, 20));

        expect(db.user.Settings_Avatar).toBe('ash');
        expect(fs.existsSync(path.join(dir, 'ash.png'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'ash-old.png'))).toBe(false);
    });

    it('renders a centred 256x256 square with node-canvas', async function () {
        const { createCanvas, loadImage } = require('canvas');
        const wide = createCanvas(40, 20);
        const ctx = wide.getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 40, 20);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(10, 0, 20, 20); // the centred square

        const out = await loadImage(await renderSquare(wide.toBuffer('image/png')));
        expect([out.width, out.height]).toEqual([256, 256]);
        const check = createCanvas(256, 256).getContext('2d');
        check.drawImage(out, 0, 0);
        expect([...check.getImageData(128, 128, 1, 1).data.slice(0, 3)]).toEqual([0, 255, 0]);
        expect([...check.getImageData(40, 40, 1, 1).data.slice(0, 3)]).toEqual([0, 255, 0]);
    });
});
