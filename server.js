const express = require('express');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pasta de cache
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Função para gerar chave de sessão (inclui nome da lista)
function getSessionKey(data) {
    console.log('[SESSION DEBUG] Data recebida:', JSON.stringify(data, null, 2));
    if (!data || !data.stalker_portal || !data.stalker_mac) return '_default';
    const o = {
        nome_lista: (data.nome_lista || 'default').trim(),
        stalker_portal: data.stalker_portal.trim(),
        stalker_mac: data.stalker_mac.trim().toUpperCase(),
        stalker_timezone: (data.stalker_timezone || 'Europe/Lisbon').trim()
    };
    const str = JSON.stringify(o, Object.keys(o).sort());
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// Gera/atualiza o M3U via python
function generateStalkerM3U(data, sessionKey) {
    return new Promise((resolve, reject) => {
        const py = spawn('python3', [
            path.join(__dirname, 'python/stalker_engine.py'),
            sessionKey,
            data.stalker_portal,
            data.stalker_mac,
            data.stalker_timezone || 'Europe/Lisbon'
        ]);

        let output = '';
        let error = '';

        py.stdout.on('data', (data) => { output += data.toString(); });
        py.stderr.on('data', (data) => { error += data.toString(); });

        py.on('close', (code) => {
            if (code !== 0) {
                console.error(`Python erro: ${error}`);
                return reject(new Error('Falha ao gerar M3U via Python'));
            }
            console.log(`Python gerou M3U para session ${sessionKey}`);
            resolve();
        });
    });
}

// Lê o M3U gerado e converte para metas Stremio
function getChannelsFromM3U(sessionKey) {
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(m3uPath)) {
        console.log('[DEBUG] M3U não encontrado:', m3uPath);
        return [];
    }

    const content = fs.readFileSync(m3uPath, 'utf8');
    const lines = content.split('\n');
    const metas = [];
    let currentName = '';
    let currentCmd = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF')) {
            const match = trimmed.match(/,(.+)/);
            currentName = match ? match[1].trim() : 'Canal Desconhecido';
        } else if (trimmed && !trimmed.startsWith('#') && currentName) {
            currentCmd = trimmed;
            const id = `channel_${currentName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
            metas.push({
                id,
                type: 'tv',
                name: currentName,
                poster: 'https://via.placeholder.com/300x450/222/fff?text=' + encodeURIComponent(currentName.substring(0, 15)),
                description: 'Canal IPTV via Stalker',
                genres: ['IPTV'],
                runtime: 'N/A'
            });
            console.log('[DEBUG] Canal adicionado:', currentName, 'ID:', id, 'Cmd:', currentCmd);
            currentName = '';
        }
    }

    console.log('[DEBUG] Total canais encontrados:', metas.length);
    return metas;
}

// Manifest com configuração nativa
const manifest = {
    id: "org.xulovski.stalker-iptv",
    version: "1.0.6",  // aumente para forçar recarga do manifest
    name: "Stalker IPTV (MAC)",
    description: "Canais IPTV via portal Stalker/MAG",
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    catalogs: [{
        type: "tv",
        id: "stalker_catalog",
        name: "Canais IPTV",
        extra: [{ name: "genre", isRequired: false, options: ["Todos"] }]
    }],
    behaviorHints: {
        configurable: true,
        reloadRequired: true
        // Sem configurationRequired para evitar abertura externa forçada
    },
    userData: {
        nome_lista: {
            type: "text",
            title: "Nome da Lista",
            description: "Dê um nome para identificar sua lista (ex: Família, Trabalho)",
            required: true,
            default: "Minha Lista IPTV"
        },
        stalker_portal: {
            type: "text",
            title: "URL do Servidor / Portal",
            description: "Ex: http://seu-servidor.com:8080/c/",
            required: true
        },
        stalker_mac: {
            type: "text",
            title: "MAC Address",
            description: "Formato: 00:1A:79:XX:XX:XX",
            required: true
        }
    }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(catalogHandler);
builder.defineStreamHandler(streamHandler);
builder.defineMetaHandler(metaHandler);

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);
app.use(addonRouter);

// Catalog Handler
async function catalogHandler(args) {
    const { type, id, extra = {}, config = {}, userData = {} } = args || {};

    console.log('[CATALOG DEBUG] Args completo:', JSON.stringify(args, null, 2));
    console.log('[CATALOG DEBUG] UserData (config salva):', JSON.stringify(userData, null, 2));

    const effectiveData = Object.keys(userData).length > 0 ? userData : config;

    if (Object.keys(effectiveData).length === 0) {
        console.warn('[CATALOG] Nenhuma configuração encontrada');
        return { metas: [] };
    }

    const sessionKey = getSessionKey(effectiveData);
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);

    if (!fs.existsSync(m3uPath) || fs.statSync(m3uPath).size < 100) {
        try {
            console.log('[CATALOG] M3U não encontrado ou vazio → a gerar via Python...');
            await generateStalkerM3U(effectiveData, sessionKey);
            console.log('[CATALOG] Geração Python concluída');
        } catch (err) {
            console.error('[CATALOG ERROR] Falha ao gerar M3U:', err.message);
            return { metas: [], error: 'Falha ao carregar canais do portal' };
        }
    }

    const metas = getChannelsFromM3U(sessionKey);
    console.log('[CATALOG] Total de canais encontrados:', metas.length);
    return { metas };
}

// Stream Handler
async function streamHandler(args) {
    const { type, id, config = {}, userData = {} } = args || {};

    console.log('[STREAM DEBUG] Args completo:', JSON.stringify(args, null, 2));
    console.log('[STREAM DEBUG] UserData:', JSON.stringify(userData, null, 2));

    const effectiveData = Object.keys(userData).length > 0 ? userData : config;

    if (type !== 'tv') return { streams: [] };

    if (Object.keys(effectiveData).length === 0) {
        console.warn('[STREAM] Nenhuma configuração encontrada');
        return { streams: [] };
    }

    const sessionKey = getSessionKey(effectiveData);
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);

    if (!fs.existsSync(m3uPath)) return { streams: [] };

    const content = fs.readFileSync(m3uPath, 'utf8');
    const lines = content.split('\n');
    let foundUrl = '';
    let currentName = '';

    for (const line of lines) {
        if (line.startsWith('#EXTINF')) {
            const match = line.match(/,(.+)/);
            currentName = match ? match[1].trim() : '';
        } else if (line.trim() && !line.startsWith('#') && currentName) {
            const cleanId = `channel_${currentName.replace(/\s+/g, '_').toLowerCase()}`;
            if (cleanId === id) {
                foundUrl = line.trim();
                break;
            }
            currentName = '';
        }
    }

    if (!foundUrl) return { streams: [] };

    return {
        streams: [{
            url: foundUrl,
            title: 'Stream Direto (Stalker)',
            behaviorHints: { notWebReady: false }
        }]
    };
}

// Meta Handler
async function metaHandler(args) {
    const { type, id, config = {}, userData = {} } = args || {};

    console.log('[META DEBUG] Args completo:', JSON.stringify(args, null, 2));
    console.log('[META DEBUG] UserData:', JSON.stringify(userData, null, 2));

    const effectiveData = Object.keys(userData).length > 0 ? userData : config;

    if (type !== 'tv') return { meta: null };

    if (Object.keys(effectiveData).length === 0) {
        console.warn('[META] Nenhuma configuração encontrada');
        return { meta: null };
    }

    const sessionKey = getSessionKey(effectiveData);
    const metas = getChannelsFromM3U(sessionKey);
    const meta = metas.find(m => m.id === id);

    return { meta: meta || null };
}

// Inicia o servidor
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Addon rodando em http://0.0.0.0:${port}`);
});
