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

/* =========================
   CACHE
========================= */

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/* =========================
   FUNÇÕES AUXILIARES
========================= */

// ID ÚNICO E CONSISTENTE PARA CANAIS
function makeChannelId(name) {
    return 'channel_' + name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

// SESSION KEY
function getSessionKey(data) {
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

/* =========================
   PYTHON → GERAR M3U
========================= */

function generateStalkerM3U(data, sessionKey) {
    return new Promise((resolve, reject) => {
        const py = spawn('python3', [
            path.join(__dirname, 'python/stalker_engine.py'),
            sessionKey,
            data.stalker_portal,
            data.stalker_mac,
            data.stalker_timezone || 'Europe/Lisbon'
        ]);

        let error = '';

        py.stderr.on('data', d => error += d.toString());

        py.on('close', code => {
            if (code !== 0) {
                console.error('[PYTHON ERROR]', error);
                reject(new Error('Falha ao gerar M3U'));
            } else {
                resolve();
            }
        });
    });
}

/* =========================
   LER M3U → METAS
========================= */

function getChannelsFromM3U(sessionKey) {
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(m3uPath)) return [];

    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n');
    const metas = [];

    let currentName = '';

    for (const line of lines) {
        if (line.startsWith('#EXTINF')) {
            const match = line.match(/,(.+)/);
            currentName = match ? match[1].trim() : '';
        } else if (line.trim() && !line.startsWith('#') && currentName) {
            metas.push({
                id: makeChannelId(currentName),
                type: 'tv',
                name: currentName,
                poster: `https://via.placeholder.com/300x450/222/fff?text=${encodeURIComponent(currentName.slice(0, 15))}`,
                description: 'Canal IPTV via Stalker',
                genres: ['IPTV']
            });
            currentName = '';
        }
    }

    return metas;
}

/* =========================
   MANIFEST
========================= */

const manifest = {
    id: 'org.xulovski.stalker-iptv',
    version: '1.0.11',
    name: 'Stalker IPTV (MAC)',
    description: 'Canais IPTV via portal Stalker/MAG',
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv'],
    catalogs: [{
        type: 'tv',
        id: 'stalker_catalog',
        name: 'Canais IPTV'
    }],
    behaviorHints: {
        configurable: true,
        reloadRequired: true,
        configurationURL: '/configure'
    }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(catalogHandler);
builder.defineStreamHandler(streamHandler);
builder.defineMetaHandler(metaHandler);

app.use(getRouter(builder.getInterface()));

/* =========================
   CONFIGURE PAGE
========================= */

app.get('/configure', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<title>Configurar Stalker IPTV</title>
<style>
body{font-family:Arial;max-width:400px;margin:40px auto;background:#f4f4f4;padding:20px}
input,button{width:100%;padding:10px;margin:10px 0}
button{background:#007bff;color:#fff;border:none}
</style>
</head>
<body>
<h2>Configurar IPTV</h2>
<input id="nome" placeholder="Nome da Lista">
<input id="portal" placeholder="http://servidor/c/">
<input id="mac" placeholder="00:1A:79:XX:XX:XX">
<button onclick="go()">Salvar e abrir Stremio</button>
<script>
function go(){
 const p=new URLSearchParams({
  nome_lista:nome.value,
  stalker_portal:portal.value,
  stalker_mac:mac.value.toUpperCase()
 });
 location.href='stremio://'+encodeURIComponent(location.origin+'/manifest.json?'+p);
}
</script>
</body>
</html>
`);
});

/* =========================
   CATALOG
========================= */

async function catalogHandler(args) {
    const { userData = {}, config = {}, extra = {} } = args || {};

    let data =
        Object.keys(userData).length ? userData :
        Object.keys(config).length ? config :
        Object.keys(extra).length ? extra : {};

    if (!Object.keys(data).length) {
        return { metas: [{
            id: 'config',
            type: 'tv',
            name: 'Configure o addon em /configure',
            poster: 'https://via.placeholder.com/300x450/444/fff?text=Configurar'
        }]};
    }

    const sessionKey = getSessionKey(data);
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);

    if (!fs.existsSync(m3uPath) || fs.statSync(m3uPath).size < 100) {
        await generateStalkerM3U(data, sessionKey);
    }

    return { metas: getChannelsFromM3U(sessionKey) };
}

/* =========================
   STREAM
========================= */

async function streamHandler(args) {
    const { id, userData = {}, config = {} } = args || {};
    const data = Object.keys(userData).length ? userData : config;

    if (!Object.keys(data).length) return { streams: [] };

    const sessionKey = getSessionKey(data);
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(m3uPath)) return { streams: [] };

    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n');

    let name = '';
    for (const line of lines) {
        if (line.startsWith('#EXTINF')) {
            const m = line.match(/,(.+)/);
            name = m ? m[1].trim() : '';
        } else if (line.trim() && !line.startsWith('#') && name) {
            if (makeChannelId(name) === id) {
                return { streams: [{ url: line.trim(), title: name }] };
            }
            name = '';
        }
    }

    return { streams: [] };
}

/* =========================
   META
========================= */

async function metaHandler(args) {
    const { id, userData = {}, config = {} } = args || {};
    const data = Object.keys(userData).length ? userData : config;
    if (!Object.keys(data).length) return { meta: null };

    const sessionKey = getSessionKey(data);
    const meta = getChannelsFromM3U(sessionKey).find(m => m.id === id);
    return { meta: meta || null };
}

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('Addon ativo na porta', PORT);
});
