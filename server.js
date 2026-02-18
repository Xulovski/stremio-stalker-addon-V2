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

// Função para gerar chave de sessão baseada na configuração
function getSessionKey(data) {
    console.log('[SESSION DEBUG] Data recebida para session key:', JSON.stringify(data, null, 2));
    if (!data || !data.stalker_portal || !data.stalker_mac) return '_default';
}
    const o = {
        stalker_portal: data.stalker_portal.trim(),
        stalker_mac: data.stalker_mac.trim().toUpperCase(),
        stalker_timezone: (data.stalker_timezone || 'Europe/Lisbon').trim()
    };
    const str = JSON.stringify(o, Object.keys(o).sort());
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// Gera/atualiza o arquivo M3U chamando o script Python
function generateStalkerM3U(config, sessionKey) {
    return new Promise((resolve, reject) => {
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
                console.error(`Python erro: ${error}`);
                return reject(new Error('Falha ao gerar M3U via Python'));
            }
            console.log(`Python gerou M3U para session ${sessionKey}`);
            resolve();
        });
    });
}

// Lê o arquivo M3U e converte para formato de metas do Stremio
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

// HANDLERS (devem vir ANTES do builder!)
async function catalogHandler(args) {
    console.log('[CATALOG DEBUG] Tipo de args:', typeof args, 'Chaves de args:', Object.keys(args));

    const { type, id, extra = {}, config = {}, userData = {} } = args || {};

    console.log('[CATALOG DEBUG] Args completo:', JSON.stringify(args, null, 2));
}
    console.log('[CATALOG DEBUG] Args completo recebido:', JSON.stringify(args, null, 2));
    console.log('[CATALOG DEBUG] Config (se vier):', JSON.stringify(config, null, 2));
    console.log('[CATALOG DEBUG] UserData (esperado):', JSON.stringify(userData, null, 2));

    // Usa userData primeiro, fallback para config (compatibilidade)
    const effectiveData = Object.keys(userData).length > 0 ? userData : config;

    if (Object.keys(effectiveData).length === 0) {
        console.warn('[CATALOG] Nenhuma configuração encontrada');
        return { metas: [] };
    }

    const sessionKey = getSessionKey(effectiveData);
    console.log('[CATALOG] Session key gerado:', sessionKey);
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
    if (metas.length === 0) {
        console.warn('[CATALOG] Nenhum canal encontrado no M3U');
    }
    return { metas };
}

async function streamHandler(args) {
    const { type, id, config = {}, userData = {} } = args;

    console.log('[STREAM DEBUG] Args completo recebido:', JSON.stringify(args, null, 2));
    console.log('[STREAM DEBUG] Config (se vier):', JSON.stringify(config, null, 2));
    console.log('[STREAM DEBUG] UserData (esperado):', JSON.stringify(userData, null, 2));

    // Usa userData primeiro, fallback para config
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

async function metaHandler(args) {
    const { type, id, config = {}, userData = {} } = args;

    console.log('[META DEBUG] Args completo recebido:', JSON.stringify(args, null, 2));
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

// Manifest (sem configurationURL fixo – o SDK gerencia dinamicamente se necessário)
const manifest = {
    id: "org.xulovski.stalker-iptv",
    version: "1.0.4", // aumente sempre para forçar o Stremio a recarregar
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
        configurationRequired: true, // ← adiciona isso para forçar tela de config antes de instalar
        reloadRequired: true
    },
    userData: {  // ← formato objeto (chave: config field)
        stalker_portal: {
            type: "text",
            title: "Portal URL",
            description: "Ex: http://seu-portal.com:8080/c/",
            required: true
        },
        stalker_mac: {
            type: "text",
            title: "MAC Address",
            description: "Formato: 00:1A:79:XX:XX:XX",
            required: true
        },
        stalker_timezone: {
            type: "text",
            title: "Timezone",
            description: "Ex: Europe/Lisbon",
            default: "Europe/Lisbon",
            required: false
        }
    }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(catalogHandler);
builder.defineStreamHandler(streamHandler);
builder.defineMetaHandler(metaHandler);

// Integração com Express via router do SDK
const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);
app.use(addonRouter);

// Página de configuração custom
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
    button { margin-top: 2.5rem; width: 100%; padding: 1rem; background: #0066cc; color: white; border: none; border-radius: 8px; font-size: 1.1rem; font-weight: bold; cursor: pointer; }
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
      const mac = document.getElementById('mac').value.trim().toUpperCase();
      const tz = document.getElementById('timezone').value.trim() || 'Europe/Lisbon';

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
          '<a href="https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl) + '" target="_blank">Clique aqui para instalar no browser</a>';
      }, 1800);
    });
  </script>
</body>
</html>
    `);
});

// Inicia o servidor
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Addon rodando em http://0.0.0.0:${port}`);
});
