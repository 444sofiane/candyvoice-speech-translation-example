// Salle de visioconférence simulée : tous les participants sont dans ce même
// onglet (pas de réseau entre eux). Un seul micro physique, attribué au
// participant qui « parle » ; le participant qui « écoute » entend la
// traduction dans sa langue. Comme le recommande le guide d'intégration :
//   - un flux par micro, une session WebSocket par langue cible ;
//   - chaque orateur a un X-Speaker-Id opaque et stable, enrôlé une fois
//     avec son consentement ;
//   - les phrases traduites (live_audio + WAV) sont diffusées dans l'ordre,
//     au fil de l'eau ; les messages "live" servent de sous-titres.
// La clé API reste côté serveur (server.js) : le navigateur parle à /ws/translate
// et /voice/:speakerId, que le serveur relaie vers CandyVoice.

// --- Langues (guide Kizwork, § 2) -------------------------------------------
const SOURCE_LANGUAGES = 'af ar az bg ca cs cy da de en es et eu fi fr gl hi ht hu hy id is it lt lv mk ml mr mt nl pl pt ru sk sq sv tl tr uk ur vi zh'.split(' ');
const TARGET_LANGUAGES = [...SOURCE_LANGUAGES, 'el', 'ga', 'he', 'ro', 'sw'].sort();
const VOICED_TARGETS = new Set('ar bg ca cs cy da de el en es et eu fi fr he hi hu hy id is it lv ml mr nl pl pt ro ru sk sq sv sw tr uk ur vi'.split(' '));
const SPEAKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENROLL_MIN_SECONDS = 30;
const ENROLL_MAX_SECONDS = 600;
const ENROLL_SAMPLE_RATE = 16000;
const STORAGE_KEY = 'cv-integration-room-v1';
const LOG_MAX_LINES = 600;

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'language' });
  } catch {
    return null;
  }
})();
const langName = (code) => {
  const name = displayNames?.of(code);
  return name && name !== code ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : code;
};

// --- Petits utilitaires DOM -------------------------------------------------
const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function tail(text, max = 180) {
  if (!text || text.length <= max) return text || '';
  const cut = text.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 30 ? cut.slice(space + 1) : cut}`;
}

function randomSpeakerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `kz-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 42%)`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

async function errorText(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === 'string') return data.detail;
    if (typeof data.error === 'string') return data.error;
    return JSON.stringify(data);
  } catch {
    return `HTTP ${response.status}`;
  }
}

// --- État de la salle (persistant : les X-Speaker-Id doivent rester stables) --
function defaultRoom() {
  return {
    participants: [
      { id: 'p1', name: 'Moi', speakerId: randomSpeakerId(), spoken: 'fr', listen: 'fr' },
      { id: 'p2', name: 'Alice', speakerId: randomSpeakerId(), spoken: 'en', listen: 'en' },
      { id: 'p3', name: 'Bruno', speakerId: randomSpeakerId(), spoken: 'es', listen: 'es' },
    ],
    speakingAs: 'p1',
    listeningAs: 'p2',
    volume: 1,
  };
}

function loadRoom() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.participants) && saved.participants.length) return { ...defaultRoom(), ...saved };
  } catch {
    // Stockage indisponible ou illisible : salle par défaut.
  }
  return defaultRoom();
}

const room = loadRoom();

function saveRoom() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(room));
  } catch {
    // Navigation privée, stockage bloqué : la salle n'est simplement pas gardée.
  }
}

const participantById = (id) => room.participants.find((p) => p.id === id) || null;
const speaker = () => participantById(room.speakingAs) || room.participants[0];
const listener = () => participantById(room.listeningAs);

let apiConfig = null; // GET /api/speech-translation/config
const enrollment = new Map(); // speakerId -> { status } | { error }

// --- Journal -------------------------------------------------------------------
const logLines = [];

function log(scope, direction, payload) {
  if (direction !== '!' && payload?.type === 'live' && !$('#log-live').checked) return;
  const time = new Date().toISOString().slice(11, 23);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  logLines.push(`${time} [${scope}] ${direction} ${body}`);
  if (logLines.length > LOG_MAX_LINES) logLines.splice(0, logLines.length - LOG_MAX_LINES);
  const pre = $('#log');
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = logLines.join('\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

// --- Micro ---------------------------------------------------------------------
async function openMic(onChunk) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Micro indisponible : ouvrez la page en HTTPS ou via http://localhost (tunnel SSH).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    // L'annulation d'écho évite que le micro retranscrive la traduction diffusée.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
    });
    // Relié à la destination via un gain nul : le graphe est tiré, sans retour du micro.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
    node.port.onmessage = (event) => onChunk(event.data);
    return {
      sampleRate: ctx.sampleRate,
      async close() {
        node.port.onmessage = null;
        stream.getTracks().forEach((track) => track.stop());
        await ctx.close().catch(() => {});
      },
    };
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => {});
    throw err;
  }
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Rééchantillonnage linéaire incrémental (enrôlement : 16 kHz suffit, et
// 10 min restent sous la limite d'upload).
class Downsampler {
  constructor(from, to) {
    this.ratio = from / to;
    this.pos = 0;
    this.last = 0;
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    const out = new Int16Array(Math.ceil((chunk.length + 1) / this.ratio) + 1);
    let n = 0;
    while (this.pos < chunk.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.last : chunk[i];
      const b = chunk[i + 1];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      out[n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.pos += this.ratio;
    }
    this.pos -= chunk.length;
    this.last = chunk[chunk.length - 1];
    this.chunks.push(out.subarray(0, n));
    this.length += n;
  }
}

function encodeWav(chunks, length, sampleRate) {
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    new Int16Array(buffer, offset, chunk.length).set(chunk);
    offset += chunk.length * 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function wavSampleRate(buffer) {
  if (buffer.byteLength < 28) return null;
  const view = new DataView(buffer);
  return view.getUint32(0, false) === 0x52494646 ? view.getUint32(24, true) : null;
}

// --- Lecture des phrases traduites, dans l'ordre, sans trou ----------------------
const playback = {
  ctx: null,
  gain: null,
  playHead: 0,
  chain: Promise.resolve(),
  playing: 0,
  sources: new Set(),
};

function ensurePlayback() {
  // Créé sur un geste utilisateur (clic micro) : sinon le navigateur le bloque.
  if (!playback.ctx) {
    playback.ctx = new AudioContext();
    playback.gain = playback.ctx.createGain();
    playback.gain.gain.value = room.volume;
    playback.gain.connect(playback.ctx.destination);
  }
  if (playback.ctx.state === 'suspended') playback.ctx.resume();
}

function enqueuePlayback(wav, tileId) {
  if (!playback.ctx) return;
  // Le décodage est asynchrone : la chaîne garantit l'ordre d'arrivée.
  playback.chain = playback.chain.then(async () => {
    let audio;
    try {
      audio = await playback.ctx.decodeAudioData(wav);
    } catch (err) {
      log('lecture', '!', `WAV illisible : ${err.message}`);
      return;
    }
    const source = playback.ctx.createBufferSource();
    source.buffer = audio;
    source.connect(playback.gain);
    const startAt = Math.max(playback.ctx.currentTime + 0.02, playback.playHead);
    playback.playHead = startAt + audio.duration;
    const delayMs = (startAt - playback.ctx.currentTime) * 1000;
    setTimeout(() => setPlaying(tileId, +1), delayMs);
    source.onended = () => {
      playback.sources.delete(source);
      setPlaying(tileId, -1);
    };
    playback.sources.add(source);
    source.start(startAt);
  });
}

function stopPlayback() {
  for (const source of playback.sources) {
    try {
      source.stop();
    } catch {
      // Déjà arrêtée.
    }
  }
  playback.sources.clear();
  playback.playHead = 0;
}

const playingTiles = new Map();
function setPlaying(tileId, delta) {
  const count = Math.max(0, (playingTiles.get(tileId) || 0) + delta);
  playingTiles.set(tileId, count);
  document.querySelector(`.tile[data-id="${tileId}"]`)?.classList.toggle('is-playing', count > 0);
}

// --- Sessions en direct : une par langue cible ---------------------------------------
const live = {
  state: 'idle', // idle | starting | live | finishing
  capture: null,
  sessions: [],
  speakerId: null, // participant qui parle pendant cette session
  sampleRate: 48000,
  startedAt: 0,
  tick: null,
  lastTalk: 0,
};
const sentences = [];

function neededTargets(who) {
  const targets = new Set();
  for (const p of room.participants) {
    if (p.id !== who.id && p.listen !== who.spoken) targets.add(p.listen);
  }
  // Personne à traduire : une session de transcription seule pour les sous-titres.
  return targets.size ? [...targets] : [null];
}

function sessionLabel(s) {
  return s.target ? `${s.source}→${s.target}` : `${s.source} (transcription)`;
}

function openSession(who, target, sampleRate) {
  const session = {
    key: `${who.speakerId}:${target || '-'}:${Date.now()}`,
    source: who.spoken,
    target,
    speakerId: who.speakerId,
    speakerName: who.name,
    ws: null,
    state: 'connexion',
    maxSeconds: null,
    sentAudioSeconds: 0,
    text: { transcript: '', transcript_pending: '', translation: '', translation_pending: '' },
    pendingHeader: null,
    sentences: 0,
    imitated: 0,
    delays: [],
    result: null,
    error: null,
    closeCode: null,
    openedAt: performance.now(),
    readyMs: null,
  };
  const url = new URL('ws/translate', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;
  const scope = sessionLabel(session);

  ws.onopen = () => {
    const start = {
      type: 'start',
      sample_rate: sampleRate,
      source_language: who.spoken,
      speaker_id: who.speakerId,
    };
    if (target) start.target_language = target;
    log(scope, '→', start);
    ws.send(JSON.stringify(start));
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      const header = session.pendingHeader;
      session.pendingHeader = null;
      const rate = wavSampleRate(event.data);
      log(scope, '←', `[WAV ${(event.data.byteLength / 1024).toFixed(1)} Ko, ${rate ?? '?'} Hz] phrase ${header?.index ?? '?'}`);
      onSentenceAudio(session, header, event.data, rate);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      log(scope, '←', event.data);
      return;
    }
    log(scope, '←', msg);
    switch (msg.type) {
      case 'auth_ok':
        session.state = 'authentifiée';
        break;
      case 'ready':
        session.state = 'prête';
        session.maxSeconds = msg.max_seconds;
        session.readyMs = Math.round(performance.now() - session.openedAt);
        if (live.state === 'starting') setLiveState('live');
        break;
      case 'live':
        for (const key of Object.keys(session.text)) if (typeof msg[key] === 'string') session.text[key] = msg[key];
        renderCaptions();
        break;
      case 'live_audio':
        session.pendingHeader = msg;
        break;
      case 'stage':
        if (msg.stage === 'finishing') session.state = 'finalisation';
        break;
      case 'limit_reached':
        toast(`${scope} : durée maximale de session atteinte (${msg.max_seconds} s).`);
        session.state = 'finalisation';
        if (live.state === 'live') stopLive();
        break;
      case 'result':
        session.result = msg;
        session.state = 'terminée';
        if (typeof msg.transcript === 'string') session.text.transcript = msg.transcript;
        if (typeof msg.translation === 'string') session.text.translation = msg.translation;
        session.text.transcript_pending = '';
        session.text.translation_pending = '';
        renderCaptions();
        break;
      case 'error':
        session.error = msg.error || JSON.stringify(msg);
        session.state = 'erreur';
        toast(`${scope} : ${session.error}`, 'error');
        break;
      default:
        break;
    }
    renderSessions();
  };

  ws.onclose = (event) => {
    session.closeCode = event.code;
    log(scope, '×', `fermeture ${event.code}${event.reason ? ` (${event.reason})` : ''}`);
    if (!['terminée', 'erreur'].includes(session.state)) {
      session.state = 'fermée';
      if (event.code === 4403) session.error = 'Origine refusée (4403) par l\'API.';
      else if (event.code !== 1000) session.error = session.error || `Connexion fermée (${event.code}).`;
      if (session.error) toast(`${scope} : ${session.error}`, 'error');
    }
    renderSessions();
    if (live.sessions.every((s) => s.ws.readyState === WebSocket.CLOSED)) endLive();
  };

  ws.onerror = () => log(scope, '!', 'erreur WebSocket');
  return session;
}

function onSentenceAudio(session, header, wav, rate) {
  session.sentences += 1;
  if (header?.imitation_applied) session.imitated += 1;
  if (typeof header?.delay_ms === 'number') session.delays.push(header.delay_ms);

  const heard = heardSession();
  const audible = heard === session;
  const entry = {
    session: sessionLabel(session),
    speakerName: session.speakerName,
    index: header?.index,
    text: header?.text || '',
    delayMs: header?.delay_ms,
    imitation: header?.imitation_applied,
    rate,
    url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })),
    heard: audible,
  };
  sentences.push(entry);
  renderSentence(entry);
  if (audible) enqueuePlayback(wav.slice(0), listener().id);
  renderSessions();
}

// Session dont l'auditeur choisi entend la voix : celle de sa langue d'écoute.
// S'il écoute dans la langue parlée, il entendrait l'orateur directement (pas de
// traduction à lire) ; et l'orateur ne s'entend pas lui-même.
function heardSession() {
  const who = listener();
  if (!who || who.id === live.speakerId) return null;
  return live.sessions.find((s) => s.target && s.target === who.listen) || null;
}

function onMicChunk(samples) {
  const pcm = toPcm16(samples).buffer;
  for (const s of live.sessions) {
    if (s.state === 'prête' && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(pcm);
      s.sentAudioSeconds += samples.length / live.sampleRate;
    }
  }
  const talking = rms(samples) > 0.02;
  const now = performance.now();
  if (talking) live.lastTalk = now;
  document.querySelector(`.tile[data-id="${live.speakerId}"]`)
    ?.classList.toggle('is-talking', now - live.lastTalk < 300);
}

async function startLive() {
  const who = speaker();
  ensurePlayback();
  setLiveState('starting');
  live.speakerId = who.id;
  live.sessions = [];
  try {
    live.capture = await openMic(onMicChunk);
  } catch (err) {
    toast(`Micro : ${err.message}`, 'error');
    setLiveState('idle');
    return;
  }
  live.sampleRate = live.capture.sampleRate;
  live.startedAt = performance.now();
  live.sessions = neededTargets(who).map((target) => openSession(who, target, live.sampleRate));
  live.tick = setInterval(updateClock, 250);
  renderAll();
}

async function stopLive() {
  if (live.state !== 'live' && live.state !== 'starting') return;
  setLiveState('finishing');
  const capture = live.capture;
  live.capture = null;
  await capture?.close();
  for (const s of live.sessions) {
    if (s.ws.readyState === WebSocket.CONNECTING) {
      s.ws.close(1000);
      continue;
    }
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    if (s.state === 'prête') {
      log(sessionLabel(s), '→', { type: 'stop' });
      s.ws.send(JSON.stringify({ type: 'stop' }));
      s.state = 'finalisation';
    } else if (!['finalisation', 'terminée', 'erreur'].includes(s.state)) {
      s.ws.close(1000); // pas encore prête : rien à finaliser
    }
  }
  renderSessions();
  if (live.sessions.every((s) => s.ws.readyState === WebSocket.CLOSED)) endLive();
}

function endLive() {
  if (live.state === 'idle') return;
  live.capture?.close();
  live.capture = null;
  clearInterval(live.tick);
  live.tick = null;
  document.querySelectorAll('.tile.is-talking').forEach((t) => t.classList.remove('is-talking'));
  setLiveState('idle');
  updateClock();
  renderAll();
}

function setLiveState(state) {
  live.state = state;
  const mic = $('#mic');
  const label = $('#mic-label');
  mic.setAttribute('aria-pressed', String(state === 'live' || state === 'starting'));
  mic.classList.toggle('is-busy', state === 'finishing' || state === 'starting');
  mic.disabled = state === 'finishing';
  label.textContent = {
    idle: 'Micro coupé',
    starting: 'Ouverture…',
    live: 'En direct',
    finishing: 'Finalisation…',
  }[state];
  $('#speaking-as').disabled = state !== 'idle';
  renderParticipants();
}

function updateClock() {
  const clock = $('#clock');
  if (live.state === 'idle' || !live.startedAt) {
    clock.textContent = '0:00';
    return;
  }
  const elapsed = (performance.now() - live.startedAt) / 1000;
  const max = Math.min(...live.sessions.map((s) => s.maxSeconds || Infinity));
  clock.textContent = Number.isFinite(max) ? `${formatClock(elapsed)} / ${formatClock(max)}` : formatClock(elapsed);
}

// --- Rendu : grille ----------------------------------------------------------------
function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  const who = speaker();
  const heard = listener();
  for (const p of room.participants) {
    const isSpeaker = p.id === who.id;
    const status = enrollment.get(p.speakerId)?.status;
    const tile = el('div', {
      class: `tile${isSpeaker ? ' is-speaker' : ''}${heard?.id === p.id ? ' is-listener' : ''}${playingTiles.get(p.id) ? ' is-playing' : ''}`,
      'data-id': p.id,
    },
    el('div', { class: 'avatar', style: `background:${colorFor(p.speakerId)}`, text: initials(p.name) }),
    el('div', { class: 'tile-name' },
      el('span', { text: p.name }),
      el('span', { class: 'muted', text: `${p.spoken.toUpperCase()} → ${p.listen.toUpperCase()}` })),
    el('div', { class: 'tile-badges' },
      isSpeaker ? el('span', { class: 'badge speak', text: '🎙 parle' }) : null,
      heard?.id === p.id ? el('span', { class: 'badge listen', text: '🎧 écoute' }) : null,
      status ? el('span', { class: `badge ${status.complete ? 'ok' : 'warn'}`, text: status.complete ? 'voix enrôlée' : 'non enrôlé' }) : null),
    el('div', { class: 'caption' }));
    grid.append(tile);
  }
  renderCaptions();
}

// Sous-titres : l'orateur voit sa transcription, chaque auditeur la traduction
// dans sa langue (ou la transcription s'il écoute dans la langue parlée).
function renderCaptions() {
  const sessions = live.sessions;
  const who = participantById(live.speakerId) || speaker();
  const any = sessions[0];
  for (const p of room.participants) {
    const caption = document.querySelector(`.tile[data-id="${p.id}"] .caption`);
    if (!caption) continue;
    caption.replaceChildren();
    if (!any) continue;
    let label;
    let committed;
    let pending;
    if (p.id === who.id || p.listen === any.source) {
      label = p.id === who.id ? `Transcription (${any.source})` : `Original (${any.source})`;
      committed = any.text.transcript;
      pending = any.text.transcript_pending;
    } else {
      const s = sessions.find((x) => x.target === p.listen);
      if (!s) continue;
      label = `Traduction (${s.target})${VOICED_TARGETS.has(s.target) && s.target !== 'zh' ? '' : ' · texte seul'}`;
      committed = s.text.translation;
      pending = s.text.translation_pending;
    }
    if (!committed && !pending) continue;
    caption.append(
      el('span', { class: 'label', text: label }),
      el('span', {}, tail(committed, 160), committed && pending ? ' ' : '', pending ? el('span', { class: 'pending', text: tail(pending, 80) }) : null),
    );
  }
}

// --- Rendu : contrôles ----------------------------------------------------------------
function renderSelects() {
  const fill = (select, value, withNobody) => {
    select.replaceChildren(
      ...(withNobody ? [el('option', { value: '', text: '— personne (muet) —' })] : []),
      ...room.participants.map((p) => el('option', { value: p.id, text: `${p.name} (${p.spoken.toUpperCase()})` })),
    );
    select.value = value || '';
  };
  fill($('#speaking-as'), speaker().id, false);
  const listenSelect = $('#listening-as');
  listenSelect.replaceChildren(
    el('option', { value: '', text: '— personne (muet) —' }),
    ...room.participants.map((p) => el('option', { value: p.id, text: `${p.name} (écoute ${p.listen.toUpperCase()})` })),
  );
  listenSelect.value = listener()?.id || '';
}

// --- Rendu : panneau Participants ---------------------------------------------------------
function enrollmentLabel(p) {
  const entry = enrollment.get(p.speakerId);
  if (!entry) return { text: 'état de la voix…', cls: 'muted' };
  if (entry.error) return { text: `voix : ${entry.error}`, cls: 'warn' };
  const s = entry.status;
  if (s.complete) return { text: `voix enrôlée · ${s.language} · ${Math.round(s.seconds)} s`, cls: 'ok' };
  return { text: 'non enrôlé : voix de synthèse standard', cls: 'warn' };
}

function renderParticipants() {
  const list = $('#participant-list');
  list.replaceChildren();
  const busy = live.state !== 'idle';
  for (const p of room.participants) {
    const label = enrollmentLabel(p);
    const complete = enrollment.get(p.speakerId)?.status?.complete;
    list.append(el('li', { class: 'pitem' },
      el('div', { class: 'pitem-head' },
        el('strong', { text: p.name }),
        el('span', { class: 'muted', text: `parle ${langName(p.spoken)} · écoute ${langName(p.listen)}` })),
      el('div', { class: 'pitem-meta' }, el('code', { text: p.speakerId }), ' · ', el('span', { class: `badge ${label.cls}`, text: label.text })),
      el('div', { class: 'pitem-actions' },
        el('button', { class: 'btn small', disabled: busy, onclick: () => openEnroll(p), text: complete ? 'Ré-enrôler' : 'Enrôler la voix' }),
        el('button', { class: 'btn small danger', disabled: busy, onclick: () => deleteVoice(p), text: 'Supprimer ma voix' }),
        el('button', { class: 'btn small ghost', onclick: () => refreshEnrollment(p), text: '↻' }),
        el('button', { class: 'btn small ghost', disabled: busy, onclick: () => openParticipantDialog(p), text: 'Modifier' }),
        el('button', { class: 'btn small ghost', disabled: busy || room.participants.length <= 1, onclick: () => removeParticipant(p), text: 'Retirer' }))));
  }
  $('#add-participant').disabled = busy;
}

// --- Rendu : panneau Sessions -----------------------------------------------------------
function renderSessions() {
  const box = $('#session-list');
  const sessions = live.sessions;
  if (!sessions.length) {
    box.replaceChildren(el('p', { class: 'hint', text: 'Aucune session. Activez le micro pour en ouvrir.' }));
    return;
  }
  box.replaceChildren(...sessions.map((s) => {
    const avg = s.delays.length ? Math.round(s.delays.reduce((a, b) => a + b, 0) / s.delays.length) : null;
    const r = s.result;
    const stateClass = { prête: 'ready', erreur: 'error', terminée: 'done' }[s.state] || '';
    const rows = [
      ['Orateur', `${s.speakerName} · ${s.speakerId}`],
      ['Prête en', s.readyMs !== null ? `${s.readyMs} ms` : null],
      ['max_seconds', s.maxSeconds],
      ['Audio envoyé', `${s.sentAudioSeconds.toFixed(1)} s`],
      ['Phrases reçues', s.sentences],
      ['Voix de l\'orateur', s.sentences ? `${s.imitated} / ${s.sentences} (imitation_applied)` : null],
      ['delay_ms', avg !== null ? `moy. ${avg} · max ${Math.max(...s.delays)}` : null],
      ['Erreur', s.error],
    ];
    if (r) {
      rows.push(
        ['recording_seconds', r.recording_seconds],
        ['live_sentence_delay_ms', r.live_sentence_delay_ms ? JSON.stringify(r.live_sentence_delay_ms) : null],
        ['voice_model', r.voice_model],
        ['imitation_applied', r.imitation_applied === undefined ? null : String(r.imitation_applied)],
        ['Avertissements', [r.translation_error, r.tts_error, r.imitation_error].filter(Boolean).join(' · ') || null],
        ['Offre', r.plan ? `${r.plan} · ${r.max_session_seconds} s` : null],
      );
    }
    return el('div', { class: 'session' },
      el('h3', {}, el('span', { text: sessionLabel(s) }), el('span', { class: `state ${stateClass}`, text: s.state })),
      el('dl', {}, rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])),
      r?.output_url ? el('p', {},
        el('a', { href: r.output_url, target: '_blank', rel: 'noopener', text: 'Piste traduite entière' }),
        r.tts_output_url && r.tts_output_url !== r.output_url ? [' · ', el('a', { href: r.tts_output_url, target: '_blank', rel: 'noopener', text: 'voix de synthèse seule' })] : null,
        el('span', { class: 'hint', text: ' (lien valable 1 h)' })) : null,
      r ? el('details', {}, el('summary', { class: 'hint', text: 'Résultat brut' }), el('pre', { class: 'log', text: JSON.stringify(r, null, 2) })) : null);
  }));
}

// --- Rendu : panneau Phrases ------------------------------------------------------------
function renderSentence(entry) {
  const list = $('#sentence-list');
  list.append(el('li', {},
    el('div', { class: 'meta' },
      el('strong', { text: `#${entry.index ?? '?'}` }),
      el('span', { text: entry.session }),
      el('span', { text: entry.speakerName }),
      entry.delayMs !== undefined ? el('span', { text: `${entry.delayMs} ms` }) : null,
      el('span', { class: entry.imitation ? 'badge ok' : 'badge warn', text: entry.imitation ? 'voix de l\'orateur' : 'voix standard' }),
      entry.rate ? el('span', { text: `${entry.rate / 1000} kHz` }) : null,
      entry.heard ? el('span', { class: 'badge listen', text: 'diffusée' }) : null),
    el('div', { text: entry.text }),
    el('audio', { controls: true, preload: 'none', src: entry.url, style: 'width:100%;height:30px;margin-top:4px' })));
  list.lastElementChild.scrollIntoView({ block: 'nearest' });
}

// --- Bandeau d'avertissements ------------------------------------------------------------
function renderBanner() {
  const notes = [];
  if (!window.isSecureContext) {
    notes.push('Page non sécurisée : le navigateur refusera le micro. Ouvrez-la via http://localhost (tunnel SSH) ou en HTTPS.');
  }
  if (apiConfig && apiConfig.imitation_mode !== 'knnvc') {
    notes.push(`L'API est en mode « ${apiConfig.imitation_mode} » : la traduction n'est pas lue avec la voix de l'orateur, l'enrôlement est indisponible.`);
  }
  const who = speaker();
  const status = enrollment.get(who.speakerId)?.status;
  if (apiConfig?.imitation_mode === 'knnvc' && status && !status.complete) {
    notes.push(`${who.name} n'est pas enrôlé : ses traductions seront lues avec la voix de synthèse standard.`);
  }
  const targets = neededTargets(who).filter(Boolean);
  const silent = targets.filter((t) => !VOICED_TARGETS.has(t) || t === 'zh');
  if (silent.length) notes.push(`Traduction en texte seul (pas de voix) pour : ${silent.join(', ')}.`);
  if (targets.length > 1) notes.push(`${targets.length} sessions seront ouvertes (${targets.join(', ')}) : chacune occupe un worker de traduction.`);
  const banner = $('#banner');
  banner.hidden = !notes.length;
  banner.replaceChildren(...notes.flatMap((n, i) => (i ? [el('br'), n] : [n])));
}

function renderAll() {
  renderSelects();
  renderGrid();
  renderParticipants();
  renderSessions();
  renderBanner();
}

// --- Voix : état, suppression -------------------------------------------------------------
async function refreshEnrollment(p) {
  try {
    const response = await fetch(`voice/${encodeURIComponent(p.speakerId)}`);
    if (response.ok) enrollment.set(p.speakerId, { status: await response.json() });
    else enrollment.set(p.speakerId, { error: await errorText(response) });
  } catch (err) {
    enrollment.set(p.speakerId, { error: err.message });
  }
  renderParticipants();
  renderGrid();
  renderBanner();
}

async function deleteVoice(p) {
  if (!confirm(`Supprimer toute la voix conservée de ${p.name} (${p.speakerId}) : enrôlement et enregistrements de ses sessions ?`)) return;
  try {
    const response = await fetch(`voice/${encodeURIComponent(p.speakerId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await errorText(response));
    enrollment.set(p.speakerId, { status: await response.json() });
    toast(`Voix de ${p.name} supprimée.`, 'ok');
  } catch (err) {
    toast(`Suppression impossible : ${err.message}`, 'error');
  }
  renderAll();
}

// --- Participants : ajout, modification, retrait ---------------------------------------------
function fillLanguageSelect(select, codes, value) {
  select.replaceChildren(...codes.map((c) => el('option', { value: c, text: `${langName(c)} (${c})` })));
  select.value = value;
}

let editing = null;
function openParticipantDialog(p = null) {
  editing = p;
  const form = $('#participant-form');
  $('#participant-dialog-title').textContent = p ? `Modifier ${p.name}` : 'Nouveau participant';
  form.name.value = p?.name || `Participant ${room.participants.length + 1}`;
  form.speakerId.value = p?.speakerId || randomSpeakerId();
  fillLanguageSelect(form.spoken, SOURCE_LANGUAGES, p?.spoken || 'en');
  fillLanguageSelect(form.listen, TARGET_LANGUAGES, p?.listen || p?.spoken || 'en');
  $('#participant-dialog').showModal();
}

$('#participant-dialog').addEventListener('close', () => {
  if ($('#participant-dialog').returnValue !== 'save') return;
  const form = $('#participant-form');
  const speakerId = form.speakerId.value.trim();
  if (!SPEAKER_ID_PATTERN.test(speakerId)) return toast('Identifiant invalide : 1 à 64 caractères A-Z a-z 0-9 _ -', 'error');
  if (room.participants.some((x) => x !== editing && x.speakerId === speakerId)) return toast('Cet identifiant est déjà utilisé dans la salle.', 'error');
  const values = { name: form.name.value.trim() || 'Sans nom', speakerId, spoken: form.spoken.value, listen: form.listen.value };
  if (editing) Object.assign(editing, values);
  else {
    const p = { id: `p${Date.now().toString(36)}`, ...values };
    room.participants.push(p);
    editing = p;
  }
  saveRoom();
  renderAll();
  refreshEnrollment(editing);
});

function removeParticipant(p) {
  if (!confirm(`Retirer ${p.name} de la salle ? (Sa voix éventuellement enrôlée reste sur le serveur.)`)) return;
  room.participants = room.participants.filter((x) => x !== p);
  if (room.speakingAs === p.id) room.speakingAs = room.participants[0].id;
  if (room.listeningAs === p.id) room.listeningAs = '';
  saveRoom();
  renderAll();
}

// --- Enrôlement ------------------------------------------------------------------------------
const enroll = { participant: null, capture: null, downsampler: null, startedAt: 0, tick: null, blob: null, previewUrl: null, seconds: 0 };

function enrollMessage(text, kind = '') {
  const box = $('#enroll-message');
  box.hidden = !text;
  box.className = `message ${kind}`;
  box.textContent = text || '';
}

async function openEnroll(p) {
  enroll.participant = p;
  enroll.blob = null;
  $('#enroll-name').textContent = p.name;
  $('#enroll-language').textContent = langName(p.spoken);
  $('#enroll-consent').checked = false;
  $('#enroll-record').disabled = true;
  $('#enroll-upload').disabled = true;
  $('#enroll-timer').textContent = '0:00';
  $('#enroll-preview').hidden = true;
  $('#enroll-sentences').replaceChildren(el('li', { class: 'muted', text: 'Chargement des phrases…' }));
  enrollMessage('');
  $('#enroll-dialog').showModal();

  let count = enrollment.get(p.speakerId)?.status?.sentences;
  if (!count) {
    await refreshEnrollment(p);
    count = enrollment.get(p.speakerId)?.status?.sentences || 25;
  }
  $('#enroll-count').textContent = count;
  try {
    const response = await fetch(`corpus/${p.spoken}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const lines = (await response.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, count);
    $('#enroll-sentences').replaceChildren(...lines.map((line) => el('li', { text: line })));
  } catch (err) {
    $('#enroll-sentences').replaceChildren();
    enrollMessage(`Corpus indisponible pour ${p.spoken} : ${err.message}`, 'error');
  }
  const error = enrollment.get(p.speakerId)?.error;
  if (error) enrollMessage(`L'API refuse l'enrôlement pour cette clé : ${error}`, 'error');
}

$('#enroll-consent').addEventListener('change', (e) => {
  $('#enroll-record').disabled = !e.target.checked && !enroll.capture;
  $('#enroll-upload').disabled = !e.target.checked || !enroll.blob;
});

$('#enroll-record').addEventListener('click', async () => {
  if (enroll.capture) return stopEnrollRecording();
  enrollMessage('');
  enroll.blob = null;
  $('#enroll-upload').disabled = true;
  $('#enroll-preview').hidden = true;
  try {
    let downsampler = null;
    enroll.capture = await openMic((samples) => {
      if (!downsampler) return;
      downsampler.push(samples);
      $('#enroll-level').style.width = `${Math.min(100, rms(samples) * 400)}%`;
    });
    downsampler = new Downsampler(enroll.capture.sampleRate, ENROLL_SAMPLE_RATE);
    enroll.downsampler = downsampler;
  } catch (err) {
    enroll.capture = null;
    enrollMessage(`Micro : ${err.message}`, 'error');
    return;
  }
  enroll.startedAt = performance.now();
  $('#enroll-record').textContent = '■ Arrêter';
  enroll.tick = setInterval(() => {
    const seconds = (performance.now() - enroll.startedAt) / 1000;
    $('#enroll-timer').textContent = formatClock(seconds);
    if (seconds >= ENROLL_MAX_SECONDS) stopEnrollRecording();
  }, 250);
});

async function stopEnrollRecording() {
  clearInterval(enroll.tick);
  const capture = enroll.capture;
  enroll.capture = null;
  await capture?.close();
  $('#enroll-level').style.width = '0';
  $('#enroll-record').textContent = '● Recommencer';
  $('#enroll-record').disabled = !$('#enroll-consent').checked;
  const d = enroll.downsampler;
  if (!d || !d.length) return;
  enroll.seconds = d.length / ENROLL_SAMPLE_RATE;
  enroll.blob = encodeWav(d.chunks, d.length, ENROLL_SAMPLE_RATE);
  enroll.downsampler = null;
  if (enroll.previewUrl) URL.revokeObjectURL(enroll.previewUrl);
  enroll.previewUrl = URL.createObjectURL(enroll.blob);
  const preview = $('#enroll-preview');
  preview.src = enroll.previewUrl;
  preview.hidden = false;
  if (enroll.seconds < ENROLL_MIN_SECONDS) {
    enrollMessage(`Enregistrement trop court (${enroll.seconds.toFixed(1)} s) : ${ENROLL_MIN_SECONDS} s minimum. Lisez toutes les phrases.`, 'error');
    enroll.blob = null;
  } else {
    enrollMessage(`${enroll.seconds.toFixed(1)} s enregistrées (${(enroll.blob.size / 1048576).toFixed(1)} Mo). Réécoutez, puis envoyez.`);
  }
  $('#enroll-upload').disabled = !enroll.blob || !$('#enroll-consent').checked;
}

$('#enroll-upload').addEventListener('click', async () => {
  const p = enroll.participant;
  if (!p || !enroll.blob || !$('#enroll-consent').checked) return;
  $('#enroll-upload').disabled = true;
  enrollMessage('Envoi de l\'enrôlement…');
  try {
    const query = new URLSearchParams({ language: p.spoken, consent: 'true' });
    const response = await fetch(`voice/${encodeURIComponent(p.speakerId)}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: enroll.blob,
    });
    if (!response.ok) throw new Error(`${response.status} · ${await errorText(response)}`);
    const status = await response.json();
    enrollment.set(p.speakerId, { status });
    log('voix', '←', status);
    enrollMessage(`Voix enrôlée : ${status.sentences} phrases, ${status.language}, ${Math.round(status.seconds)} s, complete = ${status.complete}.`, 'ok');
    renderAll();
  } catch (err) {
    enrollMessage(`Échec de l'enrôlement : ${err.message}`, 'error');
    $('#enroll-upload').disabled = false;
  }
});

$('#enroll-cancel').addEventListener('click', () => $('#enroll-dialog').close());
$('#enroll-dialog').addEventListener('close', () => {
  if (enroll.capture) {
    clearInterval(enroll.tick);
    enroll.capture.close();
    enroll.capture = null;
  }
  $('#enroll-record').textContent = '● Enregistrer';
  $('#enroll-preview').pause();
});

// --- Câblage -------------------------------------------------------------------------------
$('#mic').addEventListener('click', () => {
  if (live.state === 'idle') startLive();
  else stopLive();
});

$('#speaking-as').addEventListener('change', (e) => {
  room.speakingAs = e.target.value;
  saveRoom();
  renderAll();
});

$('#listening-as').addEventListener('change', (e) => {
  room.listeningAs = e.target.value;
  saveRoom();
  // Les phrases déjà programmées pour l'ancien auditeur sont coupées.
  stopPlayback();
  renderGrid();
});

$('#volume').value = room.volume;
$('#volume').addEventListener('input', (e) => {
  room.volume = Number(e.target.value);
  if (playback.gain) playback.gain.gain.value = room.volume;
  saveRoom();
});

$('#add-participant').addEventListener('click', () => openParticipantDialog());
$('#clear-log').addEventListener('click', () => {
  logLines.length = 0;
  $('#log').textContent = '';
});

document.querySelectorAll('.tabs button').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.tab-body').forEach((body) => { body.hidden = body.dataset.panel !== tab.dataset.tab; });
  });
});

window.addEventListener('beforeunload', () => {
  for (const s of live.sessions) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close(1000);
  }
});

async function init() {
  saveRoom();
  renderAll();
  try {
    const response = await fetch('config');
    const data = await response.json();
    apiConfig = data.api_config;
    const host = new URL(data.api_url).host;
    $('#api-info').textContent = apiConfig ? `${host} · ${apiConfig.imitation_mode}` : `${host} · injoignable`;
  } catch {
    $('#api-info').textContent = 'serveur local injoignable';
  }
  renderBanner();
  await Promise.all(room.participants.map(refreshEnrollment));
}

init();
