// Aemberforge: Card#getUsability, sent with the active player's creatures and artifacts in play so the client only
// offers Reap / Fight / Remove Stun / Use Ability buttons the game would accept.
describe('Card usability (uses)', function () {
    beforeEach(function () {
        this.setupTest({
            player1: {
                house: 'brobnar',
                inPlay: ['troll']
            },
            player2: {
                inPlay: ['bingle-bangbang']
            }
        });
        this.uses = (card, player = this.player1) => card.getSummary(player.player).uses;
    });

    describe('with an effect that stops reaping', function () {
        beforeEach(function () {
            // Barrister Joya: "Enemy creatures cannot reap."
            this.setupTest({
                player1: { house: 'brobnar', inPlay: ['troll'] },
                player2: { inPlay: ['barrister-joya'] }
            });
        });

        it('leaves Reap out', function () {
            // A second setupTest keeps the first game's card references, so look the card up in this game.
            expect(this.uses(this.player1.findCardByName('troll'))).toEqual(['fight']);
        });
    });

    it('offers fight and reap to an ordinary ready creature', function () {
        expect(this.uses(this.troll).sort()).toEqual(['fight', 'reap']);
    });

    it('offers only Remove Stun to a stunned creature', function () {
        this.troll.stun();
        expect(this.uses(this.troll)).toEqual(['removeStun']);
    });

    it('offers nothing once the creature has been used', function () {
        this.player1.reap(this.troll);
        expect(this.uses(this.troll)).toEqual([]);
    });

    it('offers no fight when there is nothing to fight', function () {
        this.bingleBangbang.moveTo('discard');
        expect(this.uses(this.troll)).toEqual(['reap']);
    });

    it("is only sent for the active player's own cards", function () {
        expect(this.uses(this.bingleBangbang, this.player2)).toBeUndefined();
        expect(this.uses(this.bingleBangbang, this.player1)).toBeUndefined();
    });
});
