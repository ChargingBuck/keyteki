const EventEmitter = require('events');

/**
 * Aemberforge: an in-process stand-in for the Redis client, used when `redisUrl` is `memory` (the hub runs the lobby
 * and the game node in one Node process, e.g. on Winhost, where there is no Redis). Every client created in the process
 * shares one key/value store and one pub/sub bus, which is all Keyteki used Redis for: lobby <-> game node messages,
 * the card-data cache and the "card data updated" signal.
 *
 * Implements the calls Keyteki makes: connect, close/quit/disconnect, on('error'), get, set, keys, del, publish,
 * subscribe, unsubscribe. Values are strings, as with Redis.
 */
const store = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Redis-style glob ('cards:*', 'node?') to a RegExp. */
function globToRegExp(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

class MemoryRedisClient extends EventEmitter {
    constructor() {
        super();
        this.isOpen = false;
        this.isReady = false;
        this.subscriptions = new Map(); // channel -> bus listener
    }

    async connect() {
        this.isOpen = true;
        this.isReady = true;
        // Like node-redis: 'ready' once connected (some callers listen for it).
        setImmediate(() => this.emit('ready'));
        return this;
    }

    async quit() {
        return this.close();
    }

    async disconnect() {
        return this.close();
    }

    async close() {
        for (const [channel, listener] of this.subscriptions) {
            bus.off(channel, listener);
        }
        this.subscriptions.clear();
        this.isOpen = false;
        this.isReady = false;
    }

    async get(key) {
        return store.has(key) ? store.get(key) : null;
    }

    async set(key, value) {
        store.set(key, String(value));
        return 'OK';
    }

    async keys(pattern) {
        const re = globToRegExp(pattern);
        return [...store.keys()].filter((k) => re.test(k));
    }

    async del(keys) {
        let n = 0;
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (store.delete(key)) {
                n++;
            }
        }
        return n;
    }

    /** Delivered asynchronously, as over a real connection (callers must not depend on synchronous delivery). */
    async publish(channel, message) {
        const n = bus.listenerCount(channel);
        setImmediate(() => bus.emit(channel, String(message), channel));
        return n;
    }

    async subscribe(channel, listener) {
        const wrapped = (message, ch) => listener(message, ch);
        this.subscriptions.set(channel, wrapped);
        bus.on(channel, wrapped);
    }

    async unsubscribe(channel) {
        const listener = this.subscriptions.get(channel);
        if (listener) {
            bus.off(channel, listener);
        }
        this.subscriptions.delete(channel);
    }
}

module.exports = { MemoryRedisClient, _store: store };
