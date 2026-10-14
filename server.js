// Côté serveur de l'app de visioconférence simulée : c'est lui qui détient la
// clé API, comme le backend d'un intégrateur (voir le guide Kizwork, § 2 :
// connexion « depuis vos serveurs »). Le navigateur ne parle qu'à lui :
//   GET  /config                  -> GET  /api/speech-translation/config
//   GET|POST|DELETE /voice/:id    -> /api/speech-translation/voice (X-Speaker-Id)
//   GET  /outputs/*               -> /outputs/* (piste traduite entière, lien à jeton)
//   GET  /corpus/:lang            -> corpus d'enrôlement de la langue
//   WS   /ws/translate            -> wss /ws/speech-translation, auth injectée
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadEnv(path.join(__dirname, '.env'));

const API_KEY = process.env.CANDYVOICE_API_KEY || '';
const API_URL = (process.env.CANDYVOICE_API_URL || 'https://saas-api.candyvoice.com').replace(/\/$/, '');
const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws/speech-translation`;
// Noms propres à l'app : HOST/PORT, trop génériques, sont souvent déjà
// définis dans le shell (ex. PORT=8001 de l'API).
const HOST = process.env.INTEGRATION_HOST || '127.0.0.1';
const PORT = Number(process.env.INTEGRATION_PORT || 8090);

const PUBLIC_DIR = path.join(__dirname, 'public');
const CORPUS_DIR = path.join(__dirname, 'corpus');
const SPEAKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

if (!API_KEY) {
  console.error('CANDYVOICE_API_KEY manquant (voir .env.example).');
  process.exit(1);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new Error('Upload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Renvoie au navigateur la réponse de l'API telle quelle (statut, corps).
async function relayResponse(res, upstream) {
  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' };
  res.writeHead(upstream.status, headers);
  res.end(body);
}

async function proxyVoice(req, res, speakerId, query) {
  if (!SPEAKER_ID_PATTERN.test(speakerId)) {
    return sendJson(res, 400, { error: 'speaker id must be 1 to 64 letters, digits, "_" or "-"' });
  }
  const headers = { 'X-API-Key': API_KEY, 'X-Speaker-Id': speakerId };
  let body;
  if (req.method === 'POST') {
    // Le consentement vient d'une case cochée par l'orateur dans l'UI : on ne
    // l'atteste auprès de CandyVoice que s'il a été donné.
    if (query.get('consent') === 'true') headers['X-Speaker-Consent'] = 'true';
    if (query.get('language')) headers['X-Source-Language'] = query.get('language');
    headers['Content-Type'] = req.headers['content-type'] || 'audio/wav';
    body = await readBody(req);
  }
  const upstream = await fetch(`${API_URL}/api/speech-translation/voice`, { method: req.method, headers, body });
  await relayResponse(res, upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (req.method === 'GET' && pathname === '/config') {
      const upstream = await fetch(`${API_URL}/api/speech-translation/config`);
      const config = upstream.ok ? await upstream.json() : null;
      return sendJson(res, 200, { api_url: API_URL, api_config: config });
    }

    const voice = pathname.match(/^\/voice\/([^/]+)$/);
    if (voice && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      return await proxyVoice(req, res, decodeURIComponent(voice[1]), url.searchParams);
    }

    if (req.method === 'GET' && pathname.startsWith('/outputs/')) {
      const upstream = await fetch(`${API_URL}${pathname}${url.search}`, { headers: { 'X-API-Key': API_KEY } });
      return await relayResponse(res, upstream);
    }

    const corpus = pathname.match(/^\/corpus\/([a-z]{2})$/);
    if (req.method === 'GET' && corpus) return sendFile(res, path.join(CORPUS_DIR, `${corpus[1]}.txt`));

    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
      return sendFile(res, file);
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(`${req.method} ${pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, 502, { error: `CandyVoice API unreachable: ${err.message}` });
  }
});

// ---------------------------------------------------------------------
// Relais WebSocket. Le navigateur envoie directement le message "start" ;
// le serveur ouvre la session CandyVoice, s'authentifie avec la clé, puis
// relaie tout dans les deux sens (texte et trames binaires, dans l'ordre).
// "auth_ok" est transmis au navigateur, qui sait ainsi que la clé est bonne.
// ---------------------------------------------------------------------

// Codes réservés qu'on ne peut pas renvoyer tels quels avec close().
function relayableCloseCode(code) {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return code === 1008 ? 1008 : 1011;
}

const wss = new WebSocketServer({ server, path: '/ws/translate', maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (client) => {
  const upstream = new WebSocket(WS_URL, { maxPayload: 64 * 1024 * 1024 });
  const pending = [];
  let authenticated = false;

  const flushPending = () => {
    while (pending.length) {
      const [data, isBinary] = pending.shift();
      upstream.send(data, { binary: isBinary });
    }
  };

  client.on('message', (data, isBinary) => {
    if (authenticated && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });

  upstream.on('open', () => upstream.send(JSON.stringify({ type: 'auth', api_key: API_KEY })));

  upstream.on('message', (data, isBinary) => {
    if (!authenticated && !isBinary) {
      try {
        if (JSON.parse(data.toString()).type === 'auth_ok') {
          authenticated = true;
          flushPending();
        }
      } catch {
        // Pas du JSON : relayé tel quel.
      }
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(relayableCloseCode(code), reason);
  });

  upstream.on('error', (err) => {
    console.error('Upstream WebSocket:', err.message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'error', error: `CandyVoice API unreachable: ${err.message}`, relay: true }));
      client.close(1011);
    }
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });
  client.on('error', () => upstream.terminate());
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${HOST}:${PORT} déjà utilisé : changez INTEGRATION_PORT dans .env.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`CandyVoice integration test on http://${HOST}:${PORT}  ->  ${API_URL}`);
});
