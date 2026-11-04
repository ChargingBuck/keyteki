const Server = require('./server');
const Lobby = require('./lobby');
const UserService = require('./services/UserService');
const ConfigService = require('./services/ConfigService');
const { checkSecrets } = require('./configCheck');
const configService = new ConfigService();

/**
 * @param {{ webClient?: boolean }} [serverOptions] passed to Server (the Aemberforge hub turns the web client off)
 * @returns {Promise<{ httpServer: import('http').Server, lobby: Lobby }>}
 */
async function runServer(serverOptions = {}) {
    checkSecrets(configService);

    let options = { configService: configService };

    options.userService = new UserService(options.configService);

    let server = new Server(process.env.NODE_ENV !== 'production', serverOptions);
    let httpServer = await server.init(options);
    let lobby = new Lobby(httpServer, options);

    await lobby.init();

    server.run();

    return { httpServer, lobby };
}

module.exports = runServer;
