import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { diagnose, makeDohAgent } from './netfix.js';
import { createMusic, isModerator, parseCommand } from './music.js';
import { fileURLToPath } from 'node:url';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, WebcastHttpClient } from 'tiktok-live-connector';

// Suara neural Microsoft Edge (sama seperti versi Windows). Dimuat dinamis agar server tetap jalan
// walaupun modulnya belum terpasang.
let edgeLib = null;
try { edgeLib = await import('msedge-tts'); } catch {}

process.env.TIKTOK_CLIENT_TIMEOUT ??= '30000'; // batas waktu permintaan ke TikTok (bawaan library hanya 10 detik)
dns.setDefaultResultOrder('ipv4first'); // hindari IPv6 yang rusak di sebagian jaringan

// tiktok-live-connector 2.5.0 memakai http:// (port 80) ke tiktok.com. Di sebagian jaringan port itu diputus
// ("Socket closed before the connection was established"). Paksa semua permintaan lewat https://.
WebcastHttpClient.prototype.getBaseUrl = host => `https://${host}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PUBLIC = path.join(ROOT, 'public');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // isi HOST=0.0.0.0 jika ingin dibuka dari perangkat lain di WiFi yang sama

// ---------------------------------------------------------------- SSE (kirim event ke halaman web)
const clients = new Set();
let lastStatus = { state: 'idle', text: 'Belum terhubung' };
const stats = { viewers: null, likes: 0 };

function broadcast(event, data) {
  if (event === 'status') lastStatus = data;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(message);
}

// ---------------------------------------------------------------- Pengaturan TTS
const tts = {
  on: false,
  rate: 1,
  readName: true,
  engine: 'edge', // edge = suara Edge diputar di browser | browser = suara bawaan perangkat | player = suara Edge via termux-media-player | termux = termux-tts-speak
  voice: 'id-ID-ArdiNeural',
  lang: 'id',
  stream: 'MUSIC', // default termux-tts-speak adalah NOTIFICATION; volumenya sering 0 sehingga suara tidak terdengar
  maxLength: 100,
  maxQueue: 6,
  maxAgeMs: 25000,
  duplicateWindowMs: 30000,
  blockLinks: true,
  blockWords: ['judi', 'slot', 'togel'],
  ignoreUsers: []
};
let muted = false;
let musicEnabledSaved = true;
let signApiKey = process.env.EULER_API_KEY || '';
const DEBUG = process.env.DEBUG === '1'; // DEBUG=1 npm start -> tampilkan data mentah event like

// Nilai yang diizinkan (dikirim sebagai argumen ke termux-tts-speak, jadi harus di-whitelist)
const ENGINES = ['edge', 'browser', 'player', 'termux'];
const VOICES = ['id-ID-ArdiNeural', 'id-ID-GadisNeural', 'en-US-AriaNeural', 'ms-MY-YasminNeural'];
const STREAMS = ['MUSIC', 'NOTIFICATION', 'ALARM'];
const LANGS = ['id', 'en', '']; // '' = bahasa bawaan mesin TTS

try {
  const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof saved.on === 'boolean') tts.on = saved.on;
  if (STREAMS.includes(saved.stream)) tts.stream = saved.stream;
  if (ENGINES.includes(saved.engine)) tts.engine = saved.engine;
  if (VOICES.includes(saved.voice)) tts.voice = saved.voice;
  if (LANGS.includes(saved.lang)) tts.lang = saved.lang;
  if (typeof saved.rate === 'number') tts.rate = Math.min(2, Math.max(0.5, saved.rate));
  if (typeof saved.readName === 'boolean') tts.readName = saved.readName;
  if (typeof saved.musicEnabled === 'boolean') musicEnabledSaved = saved.musicEnabled;
  if (!signApiKey && typeof saved.signApiKey === 'string') signApiKey = saved.signApiKey.trim();
} catch {}

function saveSettings() {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ on: tts.on, rate: tts.rate, readName: tts.readName, stream: tts.stream, lang: tts.lang, engine: tts.engine, voice: tts.voice, signApiKey, musicEnabled: music.getState().enabled }));
  } catch {}
}
if (!edgeLib && tts.engine === 'edge') {
  tts.engine = 'browser';
  console.log('[info] modul msedge-tts belum terpasang (jalankan npm install); memakai suara bawaan perangkat.');
}
const publicSettings = () => ({
  on: tts.on, rate: tts.rate, readName: tts.readName, muted,
  stream: tts.stream, lang: tts.lang, engine: tts.engine, voice: tts.voice, edgeReady: Boolean(edgeLib), hasKey: Boolean(signApiKey)
});

// ---------------------------------------------------------------- TTS (termux-tts-speak)
const queue = [];
const recent = new Map();
let speaking = false;
let ready = false;
let generation = 0;
let speakProc = null;
let pending = null; // pemutaran di browser yang sedang ditunggu selesai
let speakId = 0;
let playerBusy = false;

function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\[[^\]]{1,30}\]/g, ' ') // kode emote TikTok seperti [wow]
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/(.)\1{3,}/g, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function speakNow(text, gen) {
  return new Promise((resolve, reject) => {
    const args = ['-r', String(tts.rate), '-s', tts.stream];
    if (tts.lang) args.unshift('-l', tts.lang);
    const child = spawn('termux-tts-speak', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    speakProc = child;
    let stderr = '';
    let stdout = '';
    const guard = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('error', err => {
      clearTimeout(guard);
      if (speakProc === child) speakProc = null;
      reject(new Error(err.code === 'ENOENT'
        ? 'termux-tts-speak tidak ditemukan. Jalankan: pkg install termux-api (dan pasang aplikasi Termux:API).'
        : err.message));
    });
    child.on('close', code => {
      clearTimeout(guard);
      if (speakProc === child) speakProc = null;
      const output = `${stderr}${stdout}`.trim();
      if (gen !== generation) resolve();
      else if (code === 0 && !output) resolve();
      else reject(new Error(output || `termux-tts-speak berhenti dengan kode ${code}`)); // pesan dari Termux:API ikut ditampilkan
    });
    child.stdin.end(text); // lewat stdin, bukan argumen, agar teks komentar tidak bisa disisipi opsi
  });
}

// ---- Mesin 1 & 2: diputar di browser (halaman web harus terbuka)
function playInBrowser(payload) {
  return new Promise((resolve, reject) => {
    if (!clients.size) {
      reject(new Error(`Tidak ada halaman web yang terbuka. Buka http://localhost:${PORT} di browser.`));
      return;
    }
    const id = ++speakId;
    const finish = error => {
      clearTimeout(timer);
      if (pending?.id === id) pending = null;
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Browser tidak merespons. Pastikan halaman web terbuka.')), 45000);
    pending = { id, finish };
    broadcast('speak', { id, rate: tts.rate, lang: tts.lang || 'id', ...payload });
  });
}

// ---- Suara neural Edge (menghasilkan MP3)
let edgeTts;
let edgeVoice;
const sanitizeForSsml = text => text.replace(/[<>&]/g, ' ').replace(/\s+/g, ' ').trim();

async function synthesizeEdge(text) {
  if (!edgeLib) throw new Error('Modul msedge-tts belum terpasang. Jalankan: npm install');
  const { MsEdgeTTS, OUTPUT_FORMAT } = edgeLib;
  const work = (async () => {
    if (!edgeTts || edgeVoice !== tts.voice) {
      try { edgeTts?.close(); } catch {}
      edgeTts = new MsEdgeTTS();
      await edgeTts.setMetadata(tts.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      edgeVoice = tts.voice;
    }
    const { audioStream } = edgeTts.toStream(sanitizeForSsml(text).slice(0, 300), { rate: tts.rate });
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    if (!chunks.length) throw new Error('Audio kosong dari layanan TTS.');
    return Buffer.concat(chunks);
  })();
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TTS timeout (cek koneksi internet)')), 15000))
    ]);
  } catch (error) {
    try { edgeTts?.close(); } catch {}
    edgeTts = undefined; // paksa koneksi baru di percobaan berikutnya
    throw error;
  }
}

// ---- Mesin 3: file MP3 diputar lewat termux-media-player (Termux:API)
function runTermux(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', err => reject(new Error(err.code === 'ENOENT'
      ? `${cmd} tidak ditemukan. Jalankan: pkg install termux-api (dan pasang aplikasi Termux:API).`
      : err.message)));
    child.on('close', () => resolve(out.trim()));
  });
}

async function playWithMediaPlayer(buffer, gen) {
  const file = path.join(os.tmpdir(), `tts-${process.pid}-${Date.now()}.mp3`);
  await writeFile(file, buffer);
  try {
    playerBusy = true;
    const out = await runTermux('termux-media-player', ['play', file]);
    if (/error|fail|tidak|cannot|unable/i.test(out)) throw new Error(`termux-media-player: ${out}`);
    // MP3 24kHz/48kbps = 6000 byte/detik; tunggu sampai kira-kira selesai (bisa dibatalkan lewat reset)
    const until = Date.now() + Math.max(800, Math.ceil(buffer.length / 6) + 500);
    while (Date.now() < until && gen === generation) await new Promise(r => setTimeout(r, 150));
  } finally {
    playerBusy = false;
    unlink(file).catch(() => {});
  }
}

// ---- Pemilih mesin
async function speakLine(text, gen) {
  switch (tts.engine) {
    case 'edge': {
      const buffer = await synthesizeEdge(text);
      if (gen !== generation) return;
      return playInBrowser({ audio: buffer.toString('base64') });
    }
    case 'browser':
      return playInBrowser({ text });
    case 'player': {
      const buffer = await synthesizeEdge(text);
      if (gen !== generation) return;
      return playWithMediaPlayer(buffer, gen);
    }
    default:
      return speakNow(text, gen);
  }
}

async function next() {
  if (speaking || !tts.on) return;
  const now = Date.now();
  let item;
  while ((item = queue.shift()) && now - item.at > tts.maxAgeMs); // buang yang basi
  if (!item) return;
  speaking = true;
  const gen = generation;
  try {
    console.log(`${c.dim}[suara]${c.reset} ${item.line}`);
    await speakLine(item.line, gen);
    if (gen === generation) broadcast('tts-error', { message: '' });
  } catch (err) {
    console.log(`${c.dim}[suara gagal] ${err.message}${c.reset}`);
    if (gen === generation) broadcast('tts-error', { message: `Suara gagal: ${err.message}` });
  }
  speaking = false;
  next();
}

function resetQueue() {
  generation++;
  queue.length = 0;
  if (speakProc) speakProc.kill('SIGTERM');
  if (pending) pending.finish();
  if (playerBusy) runTermux('termux-media-player', ['stop']).catch(() => {});
  broadcast('stop', {});
}

function isBlocked(raw, text) {
  if (tts.blockLinks && /https?:\/\/|www\./i.test(raw)) return true;
  const lower = text.toLowerCase();
  return tts.blockWords.some(w => lower.includes(w.toLowerCase()));
}

function handleSpeech(user, raw) {
  if (!tts.on || !ready || muted) return;
  let text = clean(raw);
  if (!text) return;
  if (tts.ignoreUsers.includes(user.username)) return;
  if (isBlocked(raw, text)) return;
  if (text.length > tts.maxLength) text = `${text.slice(0, tts.maxLength)} dan seterusnya`;

  const key = `${user.username}:${text.toLowerCase()}`;
  const now = Date.now();
  if (recent.has(key) && now - recent.get(key) < tts.duplicateWindowMs) return;
  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) if (now - t > tts.duplicateWindowMs) recent.delete(k);
  }
  if (queue.length >= tts.maxQueue) queue.shift(); // buang yang terlama

  const name = clean(user.nickname || user.username) || 'seseorang';
  queue.push({ line: tts.readName ? `${name} bilang ${text}` : text, at: now });
  next();
}

// ---------------------------------------------------------------- Koneksi TikTok LIVE
let live;
let opening;
let intentionalDisconnect = false;
let currentUsername = '';
let sessionStart = 0;
let streamEnded = false;
let reconnectTimer;
let reconnectAttempt = 0;
let connectSeq = 0;
let likeTotal = 0;
let debugLikeLogs = 0;
const MAX_RECONNECT = 8;
const RECONNECT_DELAYS = [2000, 4000, 8000, 15000, 30000];

// Musik !play / !skip / !pause: antrean diputuskan di server, audio diputar di halaman web.
const music = createMusic({
  send: broadcast, // event: music:state, music:notice
  getHost: () => currentUsername,
  log: message => console.log(message),
  options: { enabled: musicEnabledSaved, ytdlp: process.env.YTDLP_PATH || 'yt-dlp', giftConsume: process.env.GIFT_CONSUME !== '0' }
});

function firstUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  for (const key of ['urls', 'urlList', 'url', 'imageUrl']) {
    const found = value[key];
    if (typeof found === 'string' && found) return found;
    if (Array.isArray(found) && found[0]) return String(found[0]);
  }
  return '';
}
const httpsOnly = url => String(url || '').replace(/^http:\/\//i, 'https://');

function normalizeUser(user = {}) {
  const avatar = [user.profilePicture, user.profilePictureUrl, user.avatarThumb, user.avatarMedium, user.avatarLarge]
    .map(firstUrl).find(Boolean) || '';
  return {
    username: user.uniqueId || user.displayId || user.display_id || 'penonton',
    nickname: user.nickname || user.uniqueId || user.displayId || 'Penonton',
    avatar: httpsOnly(avatar)
  };
}

async function detectProxy() {
  const env = process.env.TIKTOK_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env.includes('://') ? env : `http://${env}`;
  return '';
}

function networkHint(subs) {
  const codes = new Set((subs || []).map(e => e?.code).filter(Boolean));
  const text = (subs || []).map(e => String(e?.message || '')).join(' ');
  const has = (...c) => c.some(x => codes.has(x));
  if (has('ENOTFOUND', 'EAI_AGAIN')) return 'DNS gagal menemukan tiktok.com. Ganti DNS Windows ke 1.1.1.1 atau 8.8.8.8, atau coba jaringan lain.';
  if (has('ECONNREFUSED', 'ECONNRESET', 'EPIPE')) return 'Koneksi ke tiktok.com ditolak/diputus. Biasanya diblokir provider internet, antivirus/firewall, atau VPN/proxy bermasalah. Coba VPN, tethering HP, atau jaringan lain.';
  if (has('ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH')) return 'Koneksi ke tiktok.com time-out/tidak terjangkau. Cek internet, matikan IPv6, atau coba jaringan lain.';
  if ([...codes].some(c => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(c))) return 'Sertifikat HTTPS ditolak. Matikan fitur "scan HTTPS" di antivirus dan pastikan jam & tanggal PC benar.';
  if (/status code 403/.test(text)) return 'TikTok menolak IP ini (403). Matikan VPN yang dipakai server datacenter, atau ganti jaringan.';
  return '';
}

function explainError(error, diag) {
  const subs = error?.config?.requestErrs;
  const detail = Array.isArray(subs)
    ? subs.map(e => `${e?.code ? `[${e.code}] ` : ''}${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ')
    : '';
  if (detail) console.log(`[detail error] ${detail}`);
  const base = error?.message || 'Tidak dapat terhubung.';
  const tail = diag ? ` | Diagnosa: ${diag.summary || 'tidak ada kesimpulan'} [${diag.lines.join(' • ')}]` : '';
  if (!/Room ID/i.test(base)) return base + tail;
  const hint = networkHint(subs);
  return (hint || 'Room ID tidak ditemukan. Penyebab umum: akun sedang tidak LIVE, username salah, atau IP diblokir TikTok.')
    + ' ' + (signApiKey ? '' : 'Jika akun benar-benar LIVE, isi API key Euler Stream di Pengaturan. ')
    + (detail ? `Detail: ${detail}` : '')
    + tail;
}

const NET_CODES = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION'];
function isNetworkError(error) {
  const list = error?.config?.requestErrs;
  const items = Array.isArray(list) ? list : [error];
  return items.some(e => NET_CODES.includes(e?.code) || /Timeout awaiting/i.test(String(e?.message)));
}
let dohAgent; // aktif otomatis bila DNS provider bermasalah


const c = { dim: '\x1b[90m', cyan: '\x1b[36m', pink: '\x1b[35m', yellow: '\x1b[33m', reset: '\x1b[0m' };

function setStatus(state, text, extra = {}) {
  broadcast('status', { state, text, ...extra });
  console.log(`${c.dim}[status]${c.reset} ${text}`);
}

function updateStats(patch) {
  Object.assign(stats, patch);
  broadcast('stats', { ...patch });
}

function clearReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

async function disconnect() {
  intentionalDisconnect = true;
  clearReconnect();
  reconnectAttempt = 0;
  ready = false;
  resetQueue();
  const current = live;
  live = undefined;
  if (current) try { await current.disconnect(); } catch {}
  setStatus('idle', 'Terputus');
}

function bindEvents(connection) {
  connection.on(WebcastEvent.CHAT, data => {
    const user = normalizeUser(data.user);
    const comment = data.comment || data.content || '';
    if (!comment) return;
    const command = Boolean(parseCommand(comment));
    broadcast('chat', { ...user, comment, command });
    console.log(`${c.cyan}${user.nickname}${c.reset}${c.dim} @${user.username}${c.reset}: ${comment}`);
    // perintah musik tidak dibacakan TTS
    if (music.handleChat({ ...user, isModerator: isModerator(data.user) }, comment)) return;
    handleSpeech(user, comment);
  });

  connection.on(WebcastEvent.MEMBER, data => broadcast('member', normalizeUser(data.user)));

  connection.on(WebcastEvent.ROOM_USER, data => {
    const viewers = Number(data.viewerCount ?? data.total);
    const ranks = data.ranksList ?? data.ranks ?? data.topViewers ?? [];
    updateStats({
      ...(Number.isFinite(viewers) ? { viewers } : {}),
      topViewers: ranks.slice(0, 3).map(item => normalizeUser(item.user || item))
    });
  });

  connection.on(WebcastEvent.LIKE, data => {
    if (DEBUG && debugLikeLogs++ < 3) {
      console.log('[debug like]', JSON.stringify(data, (k, v) => (k === 'user' ? undefined : v)).slice(0, 500));
    }
    // Pakai total dari TikTok bila ada; kalau tidak ada, hitung sendiri dari jumlah like per event.
    const reported = Number(data.totalLikeCount ?? data.total ?? data.totalLikes);
    const delta = Number(data.likeCount ?? data.count);
    if (Number.isFinite(reported) && reported > 0) likeTotal = Math.max(likeTotal, reported);
    else if (Number.isFinite(delta) && delta > 0) likeTotal += delta;
    updateStats({ likes: likeTotal });
  });

  connection.on(WebcastEvent.GIFT, data => {
    const giftType = data.giftDetails?.giftType ?? data.gift?.type;
    if (giftType === 1 && !data.repeatEnd) return;
    // Prioritas antrean lagu: nilai gift = koin per gift x jumlah (gift beruntun dihitung sekali di akhir streak)
    music.gift(normalizeUser(data.user), (Number(data.giftDetails?.diamondCount ?? data.gift?.diamondCount) || 1) * (Number(data.repeatCount || data.comboCount) || 1));
    const activity = {
      type: 'gift', ...normalizeUser(data.user),
      giftName: data.giftDetails?.giftName || data.gift?.name || 'Gift',
      amount: Number(data.repeatCount || data.comboCount || 1),
      image: httpsOnly(data.giftDetails?.giftPictureUrl || firstUrl(data.giftDetails?.giftImage) || firstUrl(data.gift?.image) || firstUrl(data.gift?.icon))
    };
    broadcast('activity', activity);
    console.log(`${c.yellow}🎁 ${activity.nickname} mengirim ${activity.giftName} ×${activity.amount}${c.reset}`);
  });

  connection.on(WebcastEvent.SHARE, data => broadcast('activity', { type: 'share', ...normalizeUser(data.user) }));
  connection.on(WebcastEvent.FOLLOW, data => broadcast('activity', { type: 'follow', ...normalizeUser(data.user) }));

  connection.on(WebcastEvent.STREAM_END, () => {
    streamEnded = true;
    clearReconnect();
    setStatus('ended', 'LIVE telah selesai');
  });
  connection.on(ControlEvent.DISCONNECTED, () => {
    if (connection !== live || connection === opening) return;
    scheduleReconnect();
  });
  connection.on('error', error => {
    const msg = error?.message || error?.info || error?.exception?.message || (typeof error === 'string' ? error : JSON.stringify(error));
    console.log(`${c.dim}[error] ${msg}${c.reset}`);
  });
}

async function openConnection(username, { reconnecting = false, rescued = false } = {}) {
  const proxy = await detectProxy();
  const agent = proxy ? new HttpsProxyAgent(proxy) : dohAgent;
  if (proxy) console.log(`[info] memakai proxy ${proxy.replace(/\/\/[^@/]*@/, '//***@')}`);
  const connection = new TikTokLiveConnection(username, {
    ...(signApiKey ? { signApiKey } : {}),
    // retry dimatikan: di Node 24.20+ retry got menyembunyikan error asli ("Socket closed before ...")
    webClientOptions: { retry: { limit: 0 }, ...(agent ? { agent: { http: agent, https: agent } } : {}) },
    ...(agent ? { wsClientOptions: { agent } } : {}),
    processInitialData: !reconnecting,
    fetchRoomInfoOnConnect: true
  });
  live = connection;
  opening = connection;
  bindEvents(connection);
  try {
    // got tidak punya batas waktu untuk proxy yang menggantung, jadi pasang batas waktu keras sendiri
    let deadline;
    const state = await Promise.race([
      connection.connect(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Object.assign(new Error('Waktu koneksi habis (35 detik): jaringan/proxy tidak merespons.'), { code: 'ETIMEDOUT' })), 35000); })
    ]).finally(() => clearTimeout(deadline));
    if (live !== connection) {
      try { await connection.disconnect(); } catch {}
      return { ok: false, cancelled: true, error: 'Dibatalkan.' };
    }
    reconnectAttempt = 0;
    // awali jumlah like dari info room (jika tersedia) supaya tidak mulai dari 0 saat masuk di tengah LIVE
    const info = state?.roomInfo;
    const seed = Number(info?.like_count ?? info?.stats?.like_count ?? info?.data?.like_count ?? info?.likeCount);
    if (Number.isFinite(seed) && seed > likeTotal) { likeTotal = seed; updateStats({ likes: likeTotal }); }
    setStatus('connected', `LIVE @${username}`, { connectedAt: sessionStart });
    setTimeout(() => { if (live === connection) ready = true; }, 1500); // abaikan chat lama saat baru tersambung
    return { ok: true, roomId: state.roomId };
  } catch (error) {
    if (live === connection) live = undefined;
    let diag;
    if (!reconnecting && isNetworkError(error)) {
      diag = await diagnose({ proxy });
      console.log(`[diagnosa] ${diag.summary}\n  ${diag.lines.join('\n  ')}`);
      if (diag.dohIps && !rescued && !proxy && live === undefined) {
        dohAgent = makeDohAgent(diag.dohIps); // DNS provider bermasalah: ulangi dengan IP dari DNS alternatif
        console.log('[info] mengulang koneksi lewat DNS alternatif…');
        return await openConnection(username, { reconnecting, rescued: true });
      }
    }
    return { ok: false, error: explainError(error, diag) };
  } finally {
    if (opening === connection) opening = undefined;
  }
}

function scheduleReconnect() {
  if (intentionalDisconnect || streamEnded || !currentUsername) return;
  clearReconnect();
  ready = false;
  reconnectAttempt += 1;
  if (reconnectAttempt > MAX_RECONNECT) {
    setStatus('error', 'Koneksi terputus. Hubungkan ulang secara manual.');
    return;
  }
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt - 1, RECONNECT_DELAYS.length - 1)];
  setStatus('reconnecting', `Terputus, menyambung ulang (${reconnectAttempt}/${MAX_RECONNECT})…`, { connectedAt: sessionStart });
  const seq = connectSeq;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    if (intentionalDisconnect || streamEnded || seq !== connectSeq) return;
    const old = live;
    live = undefined;
    if (old) try { await old.disconnect(); } catch {}
    const result = await openConnection(currentUsername, { reconnecting: true });
    if (seq !== connectSeq) return;
    if (!result.ok && !intentionalDisconnect && !streamEnded) scheduleReconnect();
  }, delay);
}

function parseUsername(input) {
  return String(input || '').trim()
    .replace(/^https?:\/\/[^/]+\/@/i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

async function connect(input) {
  const username = parseUsername(input);
  if (!username) return { ok: false, error: 'Masukkan username TikTok.' };
  const seq = ++connectSeq;
  await disconnect();
  if (seq !== connectSeq) return { ok: false, cancelled: true, error: 'Dibatalkan.' };
  intentionalDisconnect = false;
  streamEnded = false;
  currentUsername = username;
  sessionStart = Date.now();
  stats.viewers = null;
  stats.likes = 0;
  likeTotal = 0;
  debugLikeLogs = 0;
  music.resetGifts(); // kredit gift sesi LIVE sebelumnya tidak terbawa
  setStatus('connecting', `Menghubungkan @${username}…`);
  const result = await openConnection(username);
  if (seq !== connectSeq) return { ok: false, cancelled: true, error: 'Dibatalkan.' };
  if (!result.ok) {
    currentUsername = '';
    setStatus('error', result.error);
  }
  return result;
}

// ---------------------------------------------------------------- Server HTTP
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/playlist': ['playlist.html', 'text/html; charset=utf-8'], // sumber Browser/Link untuk OBS / TikTok LIVE Studio
  '/playlist.css': ['playlist.css', 'text/css; charset=utf-8'],
  '/playlist.js': ['playlist.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10_000) { reject(new Error('Permintaan terlalu besar.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON tidak valid.')); } });
    req.on('error', reject);
  });
}

// Tolak permintaan dari situs lain (mencegah halaman web acak mengontrol server lokal ini)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  res.write(`event: status\ndata: ${JSON.stringify(lastStatus)}\n\n`);
  res.write(`event: settings\ndata: ${JSON.stringify(publicSettings())}\n\n`);
  res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  res.write(`event: music:state\ndata: ${JSON.stringify(music.getState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET') {
      if (pathname === '/events') return openEventStream(req, res);
      const entry = STATIC[pathname];
      if (!entry) { res.writeHead(404); return res.end('Tidak ditemukan'); }
      const body = await readFile(path.join(PUBLIC, entry[0]));
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      return res.end(body);
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'Ditolak.' });
      const body = await readJson(req);

      if (pathname === '/api/connect') return json(res, 200, await connect(body.username));
      if (pathname === '/api/disconnect') { await disconnect(); return json(res, 200, { ok: true }); }

      if (pathname === '/api/key') {
        signApiKey = String(body.key || '').trim().slice(0, 200);
        saveSettings();
        broadcast('settings', publicSettings());
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/music') {
        // halaman web melapor: lagu selesai / gagal; atau tombol kontrol & saklar musik
        if (Number.isInteger(body.started)) music.started(body.started, Number(body.position) || 0);
        if (Number.isInteger(body.ended)) music.ended(body.ended);
        if (Number.isInteger(body.error)) music.failed(body.error, String(body.message || '').slice(0, 120));
        if (['skip', 'pause', 'resume', 'toggle'].includes(body.action)) music.control(body.action, 'Host');
        if (typeof body.enabled === 'boolean') { music.setEnabled(body.enabled); saveSettings(); }
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/tts-done') {
        // browser melapor: audio selesai diputar (atau gagal)
        if (pending && pending.id === body.id) {
          pending.finish(body.ok === false ? new Error(String(body.error || 'Browser gagal memutar suara.').slice(0, 200)) : undefined);
        }
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/tts') {
        if (typeof body.on === 'boolean') {
          tts.on = body.on;
          if (!tts.on) { muted = false; resetQueue(); }
        }
        if (typeof body.muted === 'boolean' && tts.on) {
          muted = body.muted;
          if (muted) resetQueue();
        }
        if (typeof body.rate === 'number' && Number.isFinite(body.rate)) tts.rate = Math.min(2, Math.max(0.5, body.rate));
        if (typeof body.readName === 'boolean') tts.readName = body.readName;
        if (ENGINES.includes(body.engine) && (body.engine !== 'edge' || edgeLib)) tts.engine = body.engine;
        if (VOICES.includes(body.voice)) tts.voice = body.voice;
        if (STREAMS.includes(body.stream)) tts.stream = body.stream;
        if (LANGS.includes(body.lang)) tts.lang = body.lang;
        if (body.skip) resetQueue();
        if (body.test) {
          resetQueue(); // hentikan suara yang sedang berjalan agar tes tidak bentrok dengan pemutaran lain
          const gen = generation;
          speakLine('Halo, tes suara berhasil.', gen)
            .then(() => broadcast('tts-error', { message: '' }))
            .catch(err => broadcast('tts-error', { message: `Suara gagal: ${err.message}` }));
        }
        saveSettings();
        broadcast('settings', publicSettings());
        return json(res, 200, { ok: true });
      }
    }

    res.writeHead(404);
    res.end('Tidak ditemukan');
  } catch (error) {
    json(res, 500, { ok: false, error: error?.message || 'Kesalahan server.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${PORT} sudah dipakai. Jalankan dengan port lain: PORT=3001 npm start`
    : error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\nTikTok Live Overlay (Termux) by Lloyd Von Degurechaff`);
  console.log(`Buka di browser: http://localhost:${PORT}`);
  console.log(`Halaman playlist (OBS/LIVE Studio): http://localhost:${PORT}/playlist\n`);
});

async function shutdown() {
  try { await disconnect(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
