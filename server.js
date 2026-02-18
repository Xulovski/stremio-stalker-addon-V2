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

// Manifest com configuração apontando para /configure custom
const manifest = {
    id: "org.xulovski.stalker-iptv",
    version: "1.0.7",  // aumente para forçar recarga
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
        configurationRequired: true,  // força abrir config ao instalar
        reloadRequired: true,
        configurationURL: "/configure"  // aponta para a rota custom
    }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(catalogHandler);
builder.defineStreamHandler(streamHandler);
builder.defineMetaHandler(metaHandler);

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);
app.use(addonRouter);

// Rota custom /configure (form bonito no browser)
app.get('/configure', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <title>Configurar Stalker IPTV</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; background: #f4f4f4; }
    h1 { text-align: center; color: #333; }
    label { display: block; margin: 15px 0 5px; font-weight: bold; }
    input { width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 5px; box-sizing: border-box; }
    button { width: 100%; padding: 12px; background: #007bff; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; margin-top: 10px; }
    button:hover { background: #0056b3; }
    #status { margin-top: 20px; text-align: center; color: #555; }
  </style>
</head>
<body>
  <h1>Configurar Stalker IPTV</h1>
  <form id="form">
    <label>Nome da Lista</label>
    <input type="text" id="nome_lista" placeholder="Ex: Minha Lista Família" required value="Minha Lista IPTV">

    <label>URL do Servidor / Portal</label>
    <input type="text" id="stalker_portal" placeholder="http://seu-servidor.com:8080/c/" required>

    <label>MAC Address</label>
    <input type="text" id="stalker_mac" placeholder="00:1A:79:XX:XX:XX" required pattern="[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}">

    <button type="submit">Salvar Configuração e Abrir Stremio</button>
  </form>

  <div id="status"></div>

  <script>
    document.getElementById('form').addEventListener('submit', function(e) {
      e.preventDefault();
      const nome = document.getElementById('nome_lista').value.trim() || 'Minha Lista';
      const portal = document.getElementById('stalker_portal').value.trim();
      const mac = document.getElementById('stalker_mac').value.trim().toUpperCase();

      if (!portal || !mac) {
        alert('Preencha URL do servidor e MAC!');
        return;
      }

      // Salva a config localmente no browser (para uso futuro se quiser)
      localStorage.setItem('stalker_config', JSON.stringify({ nome_lista: nome, stalker_portal: portal, stalker_mac: mac }));

      // Abre o Stremio com o manifest limpo (instalação ou reload)
      const manifestUrl = window.location.origin + '/manifest.json';
      window.location.href = 'stremio://' + encodeURIComponent(manifestUrl);

      // Mensagem de status
      document.getElementById('status').innerHTML = 'Stremio aberto! <br>Se não instalou ainda, clique em "Instalar".<br>Depois clique na engrenagem para configurar.';
    });
  </script>
</body>
</html>
    `);
});

// Catalog Handler
async function catalogHandler(args) {
    const { type, id, extra = {}, config = {}, userData = {} } = args || {};

    console.log('[CATALOG DEBUG] Args completo:', JSON.stringify(args, null, 2));
    console.log('[CATALOG DEBUG] UserData:', JSON.stringify(userData, null, 2));

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
