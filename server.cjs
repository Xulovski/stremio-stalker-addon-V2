// server.js (versão corrigida - apenas sintaxe do manifest ajustada)
const express = require('express');
const cors = require('cors');
const { addonBuilder } = require('stremio-addon-sdk');
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
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function getSessionKey(config) {
    if (!config || !config.stalker_portal || !config.stalker_mac) return '_default';
    const o = {
        stalker_portal: config.stalker_portal.trim(),
        stalker_mac: config.stalker_mac.trim().toUpperCase(),
        stalker_timezone: (config.stalker_timezone || 'Europe/Lisbon').trim()
    };
    const str = JSON.stringify(o, Object.keys(o).sort());
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function generateStalkerM3U(config, sessionKey) {
    return new Promise((resolve, reject) => {
        console.log(`[PYTHON] Iniciando geração para session ${sessionKey}`);
        const py = spawn('python3', [
            path.join(__dirname, 'python/stalker_engine.py'),
            sessionKey,
            config.stalker_portal,
            config.stalker_mac,
            config.stalker_timezone || 'Europe/Lisbon'
        ]);

        let output = '';
        let error = '';

        py.stdout.on('data', (data) => { output += data.toString(); });
        py.stderr.on('data', (data) => { error += data.toString(); });

        py.on('close', (code) => {
            if (code !== 0) {
                console.error(`[PYTHON ERROR] Código ${code}: ${error}`);
                return reject(new Error('Falha ao gerar M3U via Python'));
            }
            console.log(`[PYTHON] Sucesso para session ${sessionKey}`);
            resolve();
        });
    });
}

function getChannelsFromM3U(sessionKey) {
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    if (!fs.existsSync(m3uPath)) {
        console.log('[M3U] Ficheiro não encontrado:', m3uPath);
        return [];
    }

    const content = fs.readFileSync(m3uPath, 'utf8');
    const lines = content.split('\n');
    const metas = [];
    let currentName = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF')) {
            const match = trimmed.match(/,(.+)/);
            currentName = match ? match[1].trim() : 'Canal Desconhecido';
        } else if (trimmed && !trimmed.startsWith('#') && currentName) {
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
            currentName = '';
        }
    }

    console.log('[M3U] Total canais parseados:', metas.length);
    return metas;
}

async function catalogHandler({ type, id, extra, config }) {
    console.log('[CATALOG] Config recebida:', config);
    const sessionKey = getSessionKey(config);
    console.log('[CATALOG] Session key:', sessionKey);
    const m3uPath = path.join(CACHE_DIR, `${sessionKey}_m3u.m3u`);
    console.log('[CATALOG] Procurando M3U em:', m3uPath);

    if (!fs.existsSync(m3uPath) || fs.statSync(m3uPath).size < 100) {
        try {
            await generateStalkerM3U(config, sessionKey);
        } catch (err) {
            console.error('[CATALOG ERROR]', err.message);
            return { metas: [], error: 'Falha ao gerar canais' };
        }
    }

    const metas = getChannelsFromM3U(sessionKey);
    console.log('[CATALOG] Canais encontrados:', metas.length);
    return { metas };
}

async function streamHandler({ type, id, config }) {
    if (type !== 'tv') return { streams: [] };

    const sessionKey = getSessionKey(config);
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

async function metaHandler({ type, id, config }) {
    if (type !== 'tv') return { meta: null };

    const sessionKey = getSessionKey(config);
    const metas = getChannelsFromM3U(sessionKey);
    const meta = metas.find(m => m.id === id);

    return { meta: meta || null };
}

const manifest = {
    id: "org.xulovski.stalker-iptv",
    version: "1.0.2",
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
        configurationURL: "https://teu-render-url.onrender.com/configure",
        reloadRequired: true
    }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(catalogHandler);
builder.defineStreamHandler(streamHandler);
builder.defineMetaHandler(metaHandler);

// Rotas
app.get('/manifest.json', (req, res) => {
    const fullManifest = {
        ...manifest,
        behaviorHints: {
            ...manifest.behaviorHints,
            configurationURL: `\( {req.protocol}:// \){req.get('host')}/configure`
        }
    };
    res.json(fullManifest);
});

app.get('/configure', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <title>Configurar Stalker IPTV</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 2rem auto; padding: 1rem; background: #f9f9f9; }
    h1 { text-align: center; color: #222; }
    label { display: block; margin: 1.2rem 0 0.4rem; font-weight: 600; }
    input { width: 100%; padding: 0.7rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
    button {
      margin-top: 2.5rem;
      width: 100%;
      padding: 1rem;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1.1rem;
      font-weight: bold;
      cursor: pointer;
    }
    button:hover { background: #0055aa; }
    #status { margin-top: 1.5rem; text-align: center; color: #555; }
    #error { color: #d32f2f; text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Configurar Stalker IPTV</h1>

  <form id="stalkerForm">
    <label>Portal URL</label>
    <input type="url" id="portal" placeholder="http://exemplo.com:8080/c/" required />

    <label>MAC Address</label>
    <input type="text" id="mac" placeholder="00:1A:79:XX:XX:XX" pattern="[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}" required />

    <label>Timezone</label>
    <input type="text" id="timezone" value="Europe/Lisbon" />

    <button type="submit">Instalar no Stremio</button>
  </form>

  <div id="status"></div>
  <div id="error"></div>

  <script>
    document.getElementById('stalkerForm').addEventListener('submit', function(e) {
      e.preventDefault();

      const portal = document.getElementById('portal').value.trim();
      const mac    = document.getElementById('mac').value.trim().toUpperCase();
      const tz     = document.getElementById('timezone').value.trim() || 'Europe/Lisbon';

      if (!portal || !mac) {
        document.getElementById('error').textContent = 'Preencha o Portal e o MAC corretamente.';
        return;
      }

      const params = new URLSearchParams({
        stalker_portal: portal,
        stalker_mac: mac,
        stalker_timezone: tz
      });

      const manifestUrl = window.location.origin + '/manifest.json?' + params.toString();

      window.location.href = 'stremio://' + encodeURIComponent(manifestUrl);

      setTimeout(() => {
        document.getElementById('status').innerHTML =
          'Se o Stremio não abriu:<br>' +
          '<a href="https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl) + '" target="_blank">' +
          'Clique aqui para instalar no browser</a>';
      }, 1800);
    });
  </script>
</body>
</html>
    `);
});

// Rota para o catálogo
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const { type, id, extra } = req.params;
    const config = req.query;

    console.log('[ROTA CATALOG] Chamado com:', { type, id, extra, config });

    let extraObj = {};
    if (extra) {
        const decoded = decodeURIComponent(extra);
        if (decoded.startsWith('{')) {
            try {
                extraObj = JSON.parse(decoded);
            } catch (e) {
                console.warn('[EXTRA] Falha JSON.parse:', e);
            }
        } else {
            const params = new URLSearchParams(decoded);
            extraObj = Object.fromEntries(params);
        }
    }

    try {
        const result = await catalogHandler({ type, id, extra: extraObj, config });
        res.json(result);
    } catch (err) {
        console.error('[ROTA CATALOG ERROR]', err);
        res.status(500).json({ error: 'Erro interno no catálogo' });
    }
});

// Inicia o servidor
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Addon rodando em http://0.0.0.0:${port}`);
});



