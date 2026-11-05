// Aemberforge: GameCommands#useCard clicks a card and picks the ability in one step (the board's Reap / Fight buttons).
describe('useCard command', function () {
    beforeEach(function () {
        this.setupTest({
            player1: { house: 'brobnar', inPlay: ['troll'] },
            player2: { inPlay: ['bingle-bangbang'] }
        });
        // As the game server does for every command: run it, then let the game continue.
        this.use = (use) => {
            this.game.commands.useCard(this.player1.name, this.troll.uuid, use);
            this.game.continue();
        };
    });

    it('reaps in one step when the creature could fight or reap', function () {
        const amber = this.player1.amber;
        this.use('reap');
        expect(this.player1.amber).toBe(amber + 1);
        expect(this.troll.exhausted).toBe(true);
        expect(this.player1).toHavePrompt('Choose a card to play, discard or use');
    });

    it('goes straight to choosing the fight target', function () {
        this.use('fight');
        expect(this.player1).toHavePrompt('Choose a creature to attack');
        this.player1.clickCard(this.bingleBangbang);
        expect(this.troll.exhausted).toBe(true);
    });

    it('ignores unknown uses', function () {
        this.use('steal');
        expect(this.troll.exhausted).toBe(false);
        expect(this.player1).toHavePrompt('Choose a card to play, discard or use');
    });

    it('tells the client the hub supports it', function () {
        expect(this.game.getState(this.player1.name).features).toContain('useCard');
    });
});
