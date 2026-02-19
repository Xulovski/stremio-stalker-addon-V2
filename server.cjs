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
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/* =========================
   HELPERS
========================= */

function makeChannelId(name) {
    return 'channel_' + name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
}

function getSessionKey(data) {
    const o = {
        portal: data.stalker_portal,
        mac: data.stalker_mac.toUpperCase(),
        tz: data.stalker_timezone || 'Europe/Lisbon'
    };
    return crypto.createHash('sha256')
        .update(JSON.stringify(o))
        .digest('hex')
        .slice(0, 16);
}

function loadConfigFromArgs(args) {
    const token =
        args?.extra?.token ||
        args?.config?.token ||
        args?.userData?.token;

    if (!token) return null;

    const file = path.join(CACHE_DIR, `config_${token}.json`);
    if (!fs.existsSync(file)) return null;

    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* =========================
   PYTHON → M3U
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

        let err = '';
        py.stderr.on('data', d => err += d.toString());

        py.on('close', code => {
            if (code !== 0) reject(err);
            else resolve();
        });
    });
}

/* =========================
   M3U → METAS
========================= */

function getChannelsFromM3U(sessionKey) {
    const file = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const metas = [];
    let name = '';

    for (const l of lines) {
        if (l.startsWith('#EXTINF')) {
            const m = l.match(/,(.+)/);
            name = m ? m[1].trim() : '';
        } else if (l.trim() && !l.startsWith('#') && name) {
            metas.push({
                id: makeChannelId(name),
                type: 'tv',
                name,
                poster: `https://via.placeholder.com/300x450/222/fff?text=${encodeURIComponent(name.slice(0, 15))}`,
                genres: ['IPTV']
            });
            name = '';
        }
    }
    return metas;
}

/* =========================
   MANIFEST
========================= */

const manifest = {
    id: 'org.xulovski.stalker-iptv',
    version: '1.0.20',
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
   CONFIG WEB
========================= */

app.get('/configure', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt">
<body style="font-family:Arial;max-width:400px;margin:40px auto">
<h2>Configurar Stalker IPTV</h2>
<label>URL do Portal:</label><br>
<input id="portal" placeholder="http://seu-portal.com:8080/c/"><br><br>
<label>MAC Address:</label><br>
<input id="mac" placeholder="00:1A:79:XX:XX:XX"><br><br>
<button onclick="save()">Salvar e abrir Stremio</button>
<script>
async function save(){
 const res = await fetch('/save-config', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    stalker_portal: document.getElementById('portal').value,
    stalker_mac: document.getElementById('mac').value.toUpperCase()
  })
 });
 const j = await res.json();
 location.href = 'stremio://' + encodeURIComponent(location.origin + '/manifest.json?token=' + j.token);
}
</script>
</body>
</html>
`);
});

/* =========================
   SAVE CONFIG (TOKEN)
========================= */

app.post('/save-config', (req, res) => {
    const { stalker_portal, stalker_mac } = req.body;
    if (!stalker_portal || !stalker_mac) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }

    const token = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(
        path.join(CACHE_DIR, `config_${token}.json`),
        JSON.stringify(req.body, null, 2)
    );

    res.json({ token });
});

/* =========================
   CATALOG
========================= */

async function catalogHandler(args) {
    const data = loadConfigFromArgs(args);

    if (!data) {
        return { metas: [{
            id: 'config',
            type: 'tv',
            name: 'Configure o addon',
            poster: 'https://via.placeholder.com/300x450/444/fff?text=Configurar'
        }]};
    }

    const sessionKey = getSessionKey(data);
    const m3u = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);

    if (!fs.existsSync(m3u) || fs.statSync(m3u).size < 100) {
        await generateStalkerM3U(data, sessionKey);
    }

    return { metas: getChannelsFromM3U(sessionKey) };
}

/* =========================
   STREAM
========================= */

async function streamHandler(args) {
    const data = loadConfigFromArgs(args);
    if (!data) return { streams: [] };

    const sessionKey = getSessionKey(data);
    const file = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(file)) return { streams: [] };

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let name = '';

    for (const l of lines) {
        if (l.startsWith('#EXTINF')) {
            const m = l.match(/,(.+)/);
            name = m ? m[1].trim() : '';
        } else if (l.trim() && !l.startsWith('#') && name) {
            if (makeChannelId(name) === args.id) {
                return { streams: [{ url: l.trim(), title: name }] };
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
    const data = loadConfigFromArgs(args);
    if (!data) return { meta: null };

    const sessionKey = getSessionKey(data);
    const meta = getChannelsFromM3U(sessionKey).find(m => m.id === args.id);
    return { meta: meta || null };
}

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
    console.log('Addon ativo na porta', PORT)
);
