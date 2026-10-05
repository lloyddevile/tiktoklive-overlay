import { app, BrowserWindow, ipcMain, screen, globalShortcut, session, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { diagnose, makeDohAgent } from './netfix.js';
import { fileURLToPath } from 'node:url';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, WebcastHttpClient } from 'tiktok-live-connector';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { createMusic, isModerator, parseCommand } from './music.js';
import { createWebServer } from './web-server.js';
import { createTunnel } from './tunnel.js';

process.env.TIKTOK_CLIENT_TIMEOUT ??= '30000'; // batas waktu permintaan ke TikTok (bawaan library hanya 10 detik)
dns.setDefaultResultOrder('ipv4first'); // hindari IPv6 yang rusak di sebagian jaringan

// tiktok-live-connector 2.5.0 memakai http:// (port 80) ke tiktok.com. Di sebagian jaringan port itu diputus
// ("Socket closed before the connection was established"). Paksa semua permintaan lewat https://.
WebcastHttpClient.prototype.getBaseUrl = host => `https://${host}`;

const here = path.dirname(fileURLToPath(import.meta.url));
let win;
let live;
let intentionalDisconnect = false;
let clickThrough = false;
let currentUsername = '';
let sessionStart = 0;
let streamEnded = false;
let opening;            // koneksi yang sedang proses connect()
let reconnectTimer;
let reconnectAttempt = 0;
let likeTotal = 0;
let connectSeq = 0;      // naik tiap permintaan connect baru; untuk membatalkan balapan (race)
const MAX_RECONNECT = 8;
const RECONNECT_DELAYS = [2000, 4000, 8000, 15000, 30000];

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// Ambil URL gambar dari berbagai bentuk objek (string, {urls}, {urlList}, {url}, {imageUrl}).
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

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 390, height: Math.min(540, area.height - 70),
    x: area.x + area.width - 425, y: area.y + 35,
    minWidth: 280, minHeight: 220,
    show: false, // ditampilkan tanpa merebut fokus dari game (lihat ready-to-show)
    transparent: true, frame: false, resizable: true,
    alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => win.showInactive());
  win.loadFile(path.join(here, 'index.html'));
  win.once('closed', () => { // tutup jendela playlist & tunnel bersama overlay agar aplikasi benar-benar berhenti
    closePlaylistWindow();
    tunnel.stop(false);
  });
}

function setClickThrough(enabled) {
  clickThrough = Boolean(enabled);
  win?.setIgnoreMouseEvents(clickThrough, { forward: true });
  send('window:click-through-state', clickThrough);
}

function setWindowSize(preset) {
  if (!win) return;
  const sizes = { small: [300, 380], medium: [390, 540], large: [480, 720] };
  const requested = sizes[preset] || sizes.medium;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(requested[0], area.width);
  const height = Math.min(requested[1], area.height);
  win.setSize(width, height, true);
  const bounds = win.getBounds();
  win.setPosition(
    Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    true
  );
}

function clearReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

async function disconnect() {
  intentionalDisconnect = true;
  clearReconnect();
  reconnectAttempt = 0;
  const current = live;
  live = undefined;
  if (current) try { await current.disconnect(); } catch {}
  send('live:status', { state: 'idle', text: 'Terputus' });
}

function bindEvents(connection) {
  connection.on(WebcastEvent.CHAT, data => {
    const user = { ...normalizeUser(data.user), isModerator: isModerator(data.user) };
    const comment = data.comment || data.content || '';
    // `command: true` -> tidak dibacakan TTS dan ditampilkan redup di chat
    send('live:chat', { ...user, comment, command: Boolean(parseCommand(comment)) });
    if (comment) music.handleChat(user, comment);
  });

  connection.on(WebcastEvent.MEMBER, data => {
    send('live:member', normalizeUser(data.user));
  });

  connection.on(WebcastEvent.ROOM_USER, data => {
    // ROOM_USER is TikTok's periodic snapshot. `memberCount` is deliberately
    // not used because it can represent accumulated joins rather than current viewers.
    const currentViewers = Number(data.viewerCount ?? data.total);
    const ranks = data.ranksList ?? data.ranks ?? data.topViewers ?? [];
    send('live:stats', {
      ...(Number.isFinite(currentViewers) ? { viewers: currentViewers } : {}),
      topViewers: ranks.slice(0, 3).map(item => normalizeUser(item.user || item)),
      updatedAt: Date.now()
    });
  });

  connection.on(WebcastEvent.LIKE, data => {
    // Pakai total dari TikTok bila ada; kalau tidak ada, hitung sendiri dari like per event.
    const reported = Number(data.totalLikeCount ?? data.total ?? data.totalLikes);
    const delta = Number(data.likeCount ?? data.count);
    if (Number.isFinite(reported) && reported > 0) likeTotal = Math.max(likeTotal, reported);
    else if (Number.isFinite(delta) && delta > 0) likeTotal += delta;
    send('live:stats', { likes: likeTotal });
  });

  connection.on(WebcastEvent.GIFT, data => {
    const giftType = data.giftDetails?.giftType ?? data.gift?.type;
    if (giftType === 1 && !data.repeatEnd) return;
    // Prioritas antrean lagu: nilai gift = koin per gift x jumlah (gift beruntun dihitung sekali di akhir streak)
    music.gift(normalizeUser(data.user), (Number(data.giftDetails?.diamondCount ?? data.gift?.diamondCount) || 1) * (Number(data.repeatCount || data.comboCount) || 1));
    send('live:activity', {
      type: 'gift', ...normalizeUser(data.user),
      giftName: data.giftDetails?.giftName || data.gift?.name || 'Gift',
      amount: Number(data.repeatCount || data.comboCount || 1),
      image: httpsOnly(data.giftDetails?.giftPictureUrl || firstUrl(data.giftDetails?.giftImage) || firstUrl(data.gift?.image) || firstUrl(data.gift?.icon))
    });
  });

  connection.on(WebcastEvent.SHARE, data => send('live:activity', {
    type: 'share', ...normalizeUser(data.user)
  }));
  connection.on(WebcastEvent.FOLLOW, data => send('live:activity', {
    type: 'follow', ...normalizeUser(data.user)
  }));
  connection.on(WebcastEvent.STREAM_END, () => {
    streamEnded = true;
    clearReconnect();
    send('live:status', { state: 'ended', text: 'LIVE telah selesai' });
  });
  connection.on(ControlEvent.DISCONNECTED, () => {
    // abaikan koneksi lama/yang sedang proses connect (ditangani pemanggilnya)
    if (connection !== live || connection === opening) return;
    scheduleReconnect();
  });
  connection.on('error', error => send('live:debug', String(error?.message || error?.info || JSON.stringify(error))));
}

let signApiKey = process.env.EULER_API_KEY || '';

async function detectProxy() {
  const env = process.env.TIKTOK_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env.includes('://') ? env : `http://${env}`;
  try {
    // pakai proxy sistem Windows (VPN/proxy yang memakai pengaturan sistem), seperti browser
    const first = String(await session.defaultSession.resolveProxy('https://www.tiktok.com/')).split(';')[0].trim();
    const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first);
    if (m) return `${m[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
    if (/^SOCKS/i.test(first)) console.log('[info] proxy sistem bertipe SOCKS belum didukung; gunakan proxy HTTP.');
  } catch {}
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
    + ' ' + (signApiKey ? '' : 'Jika akun benar-benar LIVE, isi API key Euler Stream (kolom kedua). ')
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



const chromiumProbe = async () => {
  try {
    const response = await net.fetch('https://www.tiktok.com/', { method: 'HEAD', signal: AbortSignal.timeout(9000) });
    return `Jalur browser (Chromium): OK HTTP ${response.status}`;
  } catch (error) { return `Jalur browser (Chromium): GAGAL (${error.message})`; }
};

async function openConnection(username, { reconnecting = false, rescued = false } = {}) {
  const proxy = await detectProxy();
  const agent = proxy ? new HttpsProxyAgent(proxy) : dohAgent;
  if (proxy) console.log(`[info] memakai proxy ${proxy.replace(/\/\/[^@/]*@/, '//***@')}`);
  const connection = new TikTokLiveConnection(username, {
    ...(signApiKey ? { signApiKey } : {}),
    // retry dimatikan: di Node 24.20+ retry got menyembunyikan error asli ("Socket closed before ...")
    webClientOptions: { retry: { limit: 0 }, ...(agent ? { agent: { http: agent, https: agent } } : {}) },
    ...(agent ? { wsClientOptions: { agent } } : {}),
    processInitialData: !reconnecting, // saat sambung ulang, jangan putar ulang chat lama
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
      // dibatalkan saat proses connect: tutup koneksi yatim agar tidak bocor
      try { await connection.disconnect(); } catch {}
      return { ok: false, cancelled: true, error: 'Dibatalkan.' };
    }
    reconnectAttempt = 0;
    const info = state?.roomInfo;
    const seed = Number(info?.like_count ?? info?.stats?.like_count ?? info?.data?.like_count ?? info?.likeCount);
    if (Number.isFinite(seed) && seed > likeTotal) { likeTotal = seed; send('live:stats', { likes: likeTotal }); }
    send('live:status', { state: 'connected', text: `LIVE @${username}`, connectedAt: sessionStart });
    return { ok: true, roomId: state.roomId };
  } catch (error) {
    if (live === connection) live = undefined;
    let diag;
    if (!reconnecting && isNetworkError(error)) {
      diag = await diagnose({ extra: chromiumProbe, proxy });
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
  reconnectAttempt += 1;
  if (reconnectAttempt > MAX_RECONNECT) {
    send('live:status', { state: 'error', text: 'Koneksi terputus. Hubungkan ulang secara manual.' });
    return;
  }
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt - 1, RECONNECT_DELAYS.length - 1)];
  send('live:status', {
    state: 'reconnecting',
    text: `Terputus, menyambung ulang (${reconnectAttempt}/${MAX_RECONNECT})…`,
    connectedAt: sessionStart
  });
  const seq = connectSeq;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    if (intentionalDisconnect || streamEnded || seq !== connectSeq) return;
    const old = live;
    live = undefined;
    if (old) try { await old.disconnect(); } catch {}
    const result = await openConnection(currentUsername, { reconnecting: true });
    if (seq !== connectSeq) return; // user sudah menghubungkan akun lain
    if (!result.ok && !intentionalDisconnect && !streamEnded) scheduleReconnect();
  }, delay);
}

function parseUsername(input) {
  return String(input || '').trim()
    .replace(/^https?:\/\/[^/]+\/@/i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

ipcMain.handle('live:connect', async (_event, input, key) => {
  if (typeof key === 'string') signApiKey = key.trim().slice(0, 200) || process.env.EULER_API_KEY || '';
  const username = parseUsername(input);
  if (!username) return { ok: false, error: 'Masukkan username TikTok.' };
  const seq = ++connectSeq;
  await disconnect();
  if (seq !== connectSeq) return { ok: false, cancelled: true, error: 'Dibatalkan.' };
  intentionalDisconnect = false;
  streamEnded = false;
  currentUsername = username;
  sessionStart = Date.now();
  likeTotal = 0;
  music.resetGifts(); // kredit gift sesi LIVE sebelumnya tidak terbawa
  send('live:status', { state: 'connecting', text: `Menghubungkan @${username}…` });
  const result = await openConnection(username);
  if (seq !== connectSeq) return { ok: false, cancelled: true, error: 'Dibatalkan.' };
  if (!result.ok) {
    currentUsername = ''; // gagal di percobaan pertama: jangan sambung ulang otomatis
    send('live:status', { state: 'error', text: 'Gagal terhubung' });
  }
  return result;
});

// ---------- Text-to-speech (Microsoft Edge neural voices, tanpa API key) ----------
const TTS_VOICES = ['id-ID-ArdiNeural', 'id-ID-GadisNeural', 'en-US-AriaNeural', 'ms-MY-YasminNeural'];
let tts;
let ttsVoice;

// Karakter XML dibuang (bukan di-escape) supaya aman baik library meng-escape sendiri maupun tidak
// (kalau di-escape dua kali, TTS akan membaca "amp"/"lt").
const sanitizeForSsml = text => text.replace(/[<>&]/g, ' ').replace(/\s+/g, ' ').trim();

async function synthesize(text, options = {}) {
  const voice = TTS_VOICES.includes(options.voice) ? options.voice : TTS_VOICES[0];
  const rate = Math.min(2, Math.max(0.5, Number(options.rate) || 1));
  if (!tts || ttsVoice !== voice) {
    try { tts?.close(); } catch {}
    tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    ttsVoice = voice;
  }
  const { audioStream } = tts.toStream(sanitizeForSsml(String(text).slice(0, 300)), { rate });
  const chunks = [];
  for await (const chunk of audioStream) chunks.push(chunk);
  if (!chunks.length) throw new Error('Audio kosong dari layanan TTS.');
  return Buffer.concat(chunks).toString('base64');
}

ipcMain.handle('tts:synthesize', async (_event, text, options) => {
  try {
    const audio = await Promise.race([
      synthesize(text, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TTS timeout')), 15000))
    ]);
    return { ok: true, audio };
  } catch (error) {
    try { tts?.close(); } catch {}
    tts = undefined; // paksa koneksi baru di percobaan berikutnya
    return { ok: false, error: error?.message || 'TTS gagal.' };
  }
});

// ---------- Musik (!play, !skip, !pause) ----------
function findYtDlp() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, app.getAppPath(), path.dirname(app.getAppPath()), path.dirname(process.execPath)].filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['yt-dlp.exe', 'yt-dlp']) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return 'yt-dlp'; // cari di PATH
}

// Halaman playlist untuk OBS / TikTok LIVE Studio (sumber Browser/Link): http://localhost:3100/playlist
const web = createWebServer({
  getState: () => music.getState(),
  port: Number(process.env.PLAYLIST_PORT) || 3100,
  log: message => console.log(message)
});

const music = createMusic({
  send: (channel, payload) => {
    send(channel, payload);
    if (channel === 'music:state') web.broadcast(channel, payload);
  },
  getHost: () => currentUsername,
  log: message => console.log(message),
  options: { ytdlp: findYtDlp(), giftConsume: process.env.GIFT_CONSUME !== '0' }
});

ipcMain.handle('music:state', () => music.getState());
ipcMain.handle('music:playlist-url', () => web.url());

// ---------- Link playlist untuk OBS / TikTok LIVE Studio ----------
// 1) localhost / 127.0.0.1 (lokal), 2) link publik https lewat Cloudflare Quick Tunnel,
// 3) jendela playlist sendiri yang bisa ditangkap dengan Window Capture.
const tunnel = createTunnel({
  log: message => console.log(message),
  onChange: info => send('music:tunnel', { ...info, url: web.publicUrl(info.url) })
});
const tunnelInfo = () => { const info = tunnel.getInfo(); return { ...info, url: web.publicUrl(info.url) }; };

ipcMain.handle('music:playlist-urls', () => ({ ...web.urls(), tunnel: tunnelInfo() }));
ipcMain.handle('music:tunnel', async (_e, action) => {
  if (action === 'start') { if (!web.port()) return { status: 'error', url: '', error: 'Server playlist tidak aktif.' }; await tunnel.start(web.port()); }
  else if (action === 'stop') tunnel.stop();
  return tunnelInfo();
});

let playlistWin;
function closePlaylistWindow() {
  if (playlistWin && !playlistWin.isDestroyed()) playlistWin.destroy();
  playlistWin = undefined;
}
function openPlaylistWindow(background) {
  const port = web.port();
  if (!port) return { ok: false, error: 'Server playlist tidak aktif.' };
  const dark = background === 'dark';
  closePlaylistWindow();
  playlistWin = new BrowserWindow({
    width: 440, height: 540, minWidth: 260, minHeight: 200,
    title: 'Playlist TikTok Live Overlay', autoHideMenuBar: true,
    backgroundColor: dark ? '#0b0c10' : '#00ff00',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false }
  });
  playlistWin.setMenu(null);
  playlistWin.loadURL(`http://127.0.0.1:${port}/playlist?bg=${dark ? '0b0c10' : '00ff00'}`);
  playlistWin.on('closed', () => { playlistWin = undefined; send('music:playlist-window', false); });
  send('music:playlist-window', true);
  return { ok: true };
}
ipcMain.handle('music:playlist-window', (_e, action, background) => {
  if (action === 'open') return openPlaylistWindow(background);
  closePlaylistWindow();
  return { ok: true };
});
ipcMain.on('music:started', (_e, id, position) => music.started(id, position));
ipcMain.on('music:set-enabled', (_e, enabled) => music.setEnabled(enabled));
ipcMain.on('music:ended', (_e, id) => music.ended(id));
ipcMain.on('music:error', (_e, id, message) => music.failed(id, String(message || '').slice(0, 120)));
ipcMain.on('music:control', (_e, action) => {
  if (['skip', 'pause', 'resume', 'toggle'].includes(action)) music.control(action, 'Host');
});

ipcMain.handle('live:disconnect', disconnect);
ipcMain.on('window:close', () => win?.close());
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:click-through', (_e, enabled) => setClickThrough(enabled));
ipcMain.on('window:top', (_e, enabled) => win?.setAlwaysOnTop(Boolean(enabled), enabled ? 'screen-saver' : 'normal'));
ipcMain.on('window:size', (_e, preset) => setWindowSize(preset));

if (!app.requestSingleInstanceLock()) app.quit(); // cegah dua overlay jalan bersamaan (shortcut bentrok)
app.on('second-instance', () => { if (win) { win.showInactive(); } });

app.whenReady().then(() => {
  web.start();
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+X', () => setClickThrough(!clickThrough));
  globalShortcut.register('CommandOrControl+Shift+M', () => send('tts:toggle-mute'));
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); tunnel.stop(false); web.stop(); });
app.on('window-all-closed', () => { disconnect(); if (process.platform !== 'darwin') app.quit(); });
