// src/handlers.js

async function catalogHandler({ type, id, extra, config, cacheManager, epgManager, pythonResolver, pythonRunner }) {
    return {
        metas: [] // vazio por agora
    };
}

async function streamHandler({ type, id, config, cacheManager, epgManager, pythonResolver, pythonRunner }) {
    return {
        streams: [] // vazio por agora
    };
}

module.exports = { catalogHandler, streamHandler };
