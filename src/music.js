// Fitur !play: antrean lagu dari permintaan penonton. Murni Node (tanpa Electron) agar dipakai
// bersama oleh versi Windows (src/) dan Termux (termux/src/) — kedua file ini harus identik.
import { spawn } from 'node:child_process';

const DEFAULTS = {
  enabled: true,
  maxQueue: 10,          // total lagu menunggu
  maxPerUser: 2,         // lagu per penonton yang boleh menunggu sekaligus
  cooldownMs: 20000,     // jeda antar !play dari penonton yang sama (host/moderator bebas)
  maxDurationSec: 600,   // lagu lebih panjang dari ini ditolak
  maxQueryLength: 80,
  maxResolving: 2,       // pencarian yang boleh berjalan bersamaan
  searchTimeoutMs: 30000,
  source: 'auto',        // auto = yt-dlp lalu pratinjau; 'preview' = hanya pratinjau iTunes
  ytdlp: 'yt-dlp',       // path yt-dlp; bisa diisi lewat env YTDLP_PATH
  allowPreview: true,    // cadangan: pratinjau 30 detik dari iTunes bila yt-dlp tidak ada/gagal
  admins: [],            // username tambahan yang boleh !skip / !pause
  giftConsume: true      // kredit gift habis saat lagu pemberi gift diputar (false = gift menumpuk selama sesi LIVE)
};

const fail = (code, message) => Object.assign(new Error(message), { code });
const normName = s => String(s || '').trim().replace(/^@/, '').toLowerCase();

// Deteksi moderator dari objek user TikTok (nama field bisa berbeda antar versi library)
export function isModerator(user = {}) {
  if (user.isModerator || user.isMod) return true;
  const badges = user.badges || user.userBadges || user.badgeList;
  return Array.isArray(badges) && badges.some(b => /moderator/i.test(JSON.stringify(b)));
}

export function parseCommand(text) {
  const match = /^\s*!(play|skip|pause|resume)\b\s*(.*)$/is.exec(String(text || ''));
  return match ? { name: match[1].toLowerCase(), arg: match[2].trim() } : null;
}

const cleanArtist = s => String(s || '').replace(/\s*-\s*topic$/i, '').trim();

// ---------- Sumber 1: YouTube lewat yt-dlp (lagu penuh) ----------
function runYtDlp(bin, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    // "ytsearch1:" di depan membuat teks penonton selalu dianggap kata pencarian, bukan opsi/URL.
    const args = ['--no-playlist', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio/best', '-j', `ytsearch1:${query}`];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 5_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? fail('NO_YTDLP', 'yt-dlp tidak ditemukan') : e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const line = out.split('\n').find(l => l.trim().startsWith('{'));
      if (!line) return reject(fail(code === 0 ? 'NOT_FOUND' : 'YTDLP_FAILED', err.trim().split('\n').pop() || 'yt-dlp gagal'));
      try { resolve(JSON.parse(line)); } catch { reject(fail('YTDLP_FAILED', 'Keluaran yt-dlp tidak valid')); }
    });
  });
}

async function resolveYoutube(query, o) {
  const info = await runYtDlp(o.ytdlp, query, o.searchTimeoutMs);
  if (info.is_live) throw fail('LIVE', 'Itu siaran langsung, bukan lagu.');
  const duration = Math.round(Number(info.duration) || 0);
  if (duration > o.maxDurationSec) {
    throw fail('TOO_LONG', `Durasi ${Math.round(duration / 60)} menit melebihi batas ${Math.round(o.maxDurationSec / 60)} menit.`);
  }
  if (!info.url) throw fail('YTDLP_FAILED', 'Tidak ada URL audio.');
  return {
    key: `yt:${info.id || info.webpage_url || info.title}`,
    title: String(info.track || info.title || query).slice(0, 120),
    artist: cleanArtist(info.artist || info.creator || info.uploader || info.channel).slice(0, 80),
    duration,
    cover: String(info.thumbnail || '').replace(/^http:/, 'https:'),
    audioUrl: info.url,
    source: 'youtube',
    preview: false
  };
}

// ---------- Sumber 2: pratinjau 30 detik dari iTunes Search API (tanpa instalasi apa pun) ----------
async function resolveItunes(query, o, fetchImpl) {
  for (const country of ['ID', 'US']) {
    const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: query, media: 'music', entity: 'song', limit: '1', country })}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw fail('SEARCH_FAILED', `Layanan pencarian membalas ${response.status}`);
    const hit = (await response.json())?.results?.[0];
    if (hit?.previewUrl) {
      return {
        key: `it:${hit.trackId}`,
        title: String(hit.trackName || query).slice(0, 120),
        artist: String(hit.artistName || '').slice(0, 80),
        duration: 30,
        cover: String(hit.artworkUrl100 || '').replace('100x100', '300x300').replace(/^http:/, 'https:'),
        audioUrl: hit.previewUrl,
        source: 'preview',
        preview: true
      };
    }
  }
  throw fail('NOT_FOUND', 'Lagu tidak ditemukan.');
}

export function createMusic({ send, getHost = () => '', log = console.log, fetchImpl = fetch, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  o.admins = (o.admins || []).map(normName);

  let seq = 0;
  let current = null;
  let paused = false;
  let enabled = o.enabled;
  let resolving = 0;
  let warnedNoYtDlp = false;
  let safetyTimer;
  let startedAt = 0; // untuk memperkirakan posisi lagu (progress bar di halaman playlist)
  let pausedAt = 0;
  let pausedMs = 0;
  const queue = [];
  const lastRequest = new Map();
  // Kredit gift per penonton: { coins, since, nickname }. `since` = kapan total koin saat ini tercapai
  // (dipakai sebagai pemecah seri: yang lebih dulu mencapai nilai itu tetap di atas).
  const gifts = new Map();
  const giftCoins = t => gifts.get(normName(t.requestedBy?.username))?.coins || 0;

  const strip = t => t && ({
    id: t.id, title: t.title, artist: t.artist, duration: t.duration, cover: t.cover,
    audioUrl: t.audioUrl, source: t.source, preview: t.preview, requestedBy: t.requestedBy, gift: giftCoins(t)
  });
  const position = () => (current ? Math.max(0, (paused ? pausedAt : Date.now()) - startedAt - pausedMs) : 0);
  const getState = () => ({ enabled, paused, positionMs: position(), current: strip(current), queue: queue.map(strip) });
  const emit = () => send('music:state', getState());
  const notice = (kind, text) => send('music:notice', { kind, text });

  // Jaga-jaga bila halaman/pemutar tidak pernah melapor selesai: lanjut sendiri setelah durasi + 30 dtk.
  function armSafety() {
    clearTimeout(safetyTimer);
    if (!current || paused) return;
    const id = current.id;
    safetyTimer = setTimeout(() => ended(id), ((current.duration || 240) + 30) * 1000);
  }

  // Urutan antrean: koin gift terbesar di atas; koin sama -> yang lebih dulu mencapai total itu; tanpa gift -> urutan request.
  // Lagu yang sedang diputar tidak pernah tersentuh.
  function sortQueue() {
    queue.sort((a, b) => {
      const ca = giftCoins(a);
      const cb = giftCoins(b);
      if (ca !== cb) return cb - ca;
      if (ca > 0) {
        const sa = gifts.get(normName(a.requestedBy.username)).since;
        const sb = gifts.get(normName(b.requestedBy.username)).since;
        if (sa !== sb) return sa - sb;
      }
      return a.id - b.id;
    });
  }

  function playNext() {
    current = queue.shift() || null;
    if (current && o.giftConsume) gifts.delete(normName(current.requestedBy?.username)); // kredit dipakai
    paused = false;
    startedAt = Date.now();
    pausedAt = 0;
    pausedMs = 0;
    armSafety();
    emit();
  }

  // Pemutar melapor: audio benar-benar mulai berbunyi pada posisi tertentu (menyelaraskan progress bar)
  function started(id, positionSec) {
    if (!current || current.id !== id || paused) return;
    startedAt = Date.now() - Math.max(0, Number(positionSec) || 0) * 1000;
    pausedMs = 0;
    emit();
  }

  function ended(id) { if (current && current.id === id) playNext(); }

  function failed(id, message) {
    if (!current || current.id !== id) return;
    notice('error', `🎵 Gagal memutar "${current.title}": ${message || 'kesalahan pemutar'}`);
    playNext();
  }

  function isPrivileged(user) {
    const name = normName(user.username);
    const host = normName(getHost());
    return Boolean(user.isHost || user.isModerator || (host && name === host) || o.admins.includes(name));
  }

  async function resolveTrack(query) {
    if (o.source !== 'preview') {
      try { return await resolveYoutube(query, o); }
      catch (error) {
        if (['NOT_FOUND', 'TOO_LONG', 'LIVE'].includes(error.code)) throw error;
        if (error.code === 'NO_YTDLP' && !warnedNoYtDlp) {
          warnedNoYtDlp = true;
          log('[musik] yt-dlp tidak ditemukan: memakai pratinjau 30 detik. Pasang yt-dlp untuk lagu penuh.');
        } else if (error.code !== 'NO_YTDLP') {
          log(`[musik] yt-dlp gagal: ${error.message}`);
        }
        if (!o.allowPreview) throw fail('SEARCH_FAILED', error.code === 'NO_YTDLP' ? 'yt-dlp belum terpasang.' : error.message);
      }
    }
    return resolveItunes(query, o, fetchImpl);
  }

  async function play(user, query) {
    const nick = user.nickname || user.username || 'Penonton';
    if (!query) return notice('info', `🎵 ${nick}, ketik !play judul lagu`);
    if (query.length > o.maxQueryLength) query = query.slice(0, o.maxQueryLength);

    const privileged = isPrivileged(user);
    const key = normName(user.username);
    if (!privileged) {
      const wait = o.cooldownMs - (Date.now() - (lastRequest.get(key) || 0));
      if (wait > 0) return notice('info', `⏳ ${nick}, tunggu ${Math.ceil(wait / 1000)} detik lagi untuk request berikutnya`);
      const mine = queue.filter(t => normName(t.requestedBy.username) === key).length
        + (current && normName(current.requestedBy.username) === key ? 1 : 0);
      if (mine >= o.maxPerUser) return notice('info', `🎵 ${nick}, kamu sudah punya ${mine} lagu di antrean`);
    }
    if (queue.length + resolving >= o.maxQueue) return notice('info', '🎵 Antrean penuh, coba lagi nanti');
    if (resolving >= o.maxResolving) return notice('info', '🎵 Sedang mencari lagu lain, coba lagi sebentar');

    lastRequest.set(key, Date.now());
    if (lastRequest.size > 500) {
      const cutoff = Date.now() - o.cooldownMs;
      for (const [k, t] of lastRequest) if (t < cutoff) lastRequest.delete(k);
    }

    resolving++;
    let track;
    try {
      track = await resolveTrack(query);
    } catch (error) {
      notice('error', `🎵 "${query}": ${error.code === 'NOT_FOUND' ? 'lagu tidak ditemukan' : error.message}`);
      return;
    } finally {
      resolving--;
    }
    if (!enabled) return;
    if ((current && current.key === track.key) || queue.some(t => t.key === track.key)) {
      return notice('info', `🎵 "${track.title}" sudah ada di antrean`);
    }
    track.id = ++seq;
    track.requestedBy = { nickname: nick, username: user.username };
    const boosted = giftCoins(track) > 0;
    if (!current) {
      queue.push(track);
      playNext();
      notice('added', `🎵 ${nick} memutar "${track.title}"${track.artist ? ` — ${track.artist}` : ''}`);
    } else {
      queue.push(track);
      sortQueue();
      emit();
      const position = queue.indexOf(track) + 1;
      notice(boosted ? 'gift' : 'added', `${boosted ? '🎁' : '🎵'} ${nick} menambahkan "${track.title}" (antrean #${position}${boosted ? ', prioritas gift' : ''})`);
    }
  }

  // Dipanggil untuk setiap gift yang selesai (bukan tiap tik streak). `coins` = diamondCount x jumlah.
  // Lagu yang sudah antre dari pemberi gift langsung naik; bila belum ada lagu, kreditnya menunggu request berikutnya.
  function gift(user, coins) {
    if (!enabled) return;
    const key = normName(user?.username);
    if (!key) return;
    const value = Math.max(1, Math.round(Number(coins) || 1));
    const nick = user.nickname || user.username;
    gifts.set(key, { coins: (gifts.get(key)?.coins || 0) + value, since: Date.now(), nickname: nick });
    if (gifts.size > 1000) gifts.delete(gifts.keys().next().value);

    const mine = queue.find(t => normName(t.requestedBy.username) === key);
    if (!mine) { emit(); return; }
    const before = queue.indexOf(mine);
    sortQueue();
    const after = queue.indexOf(mine);
    emit();
    if (after < before) notice('gift', `🎁 ${nick} menaikkan "${mine.title}" ke antrean #${after + 1}`);
  }

  // Dipanggil saat memulai sesi LIVE baru: kredit gift sesi lama tidak terbawa
  function resetGifts() {
    gifts.clear();
    sortQueue();
    emit();
  }

  function control(action, by = 'Host') {
    if (!enabled) return false;
    if (action === 'skip' && current) {
      notice('info', `⏭ ${by} melewati "${current.title}"`);
      playNext();
    } else if (action === 'pause' && current && !paused) {
      paused = true; pausedAt = Date.now(); clearTimeout(safetyTimer); emit();
    } else if (action === 'resume' && current && paused) {
      paused = false; pausedMs += Date.now() - pausedAt; pausedAt = 0; armSafety(); emit();
    } else if (action === 'toggle' && current) {
      return control(paused ? 'resume' : 'pause', by);
    } else {
      return false;
    }
    return true;
  }

  // Dipanggil untuk setiap komentar. Mengembalikan true bila komentar adalah perintah musik
  // (supaya tidak ikut dibacakan TTS).
  function handleChat(user, comment) {
    const command = parseCommand(comment);
    if (!command) return false;
    if (!enabled) return true;
    const by = user.nickname || user.username || 'Moderator';
    if (command.name === 'play') {
      play(user, command.arg).catch(error => log(`[musik] ${error.message}`));
    } else if (isPrivileged(user)) {
      control(command.name === 'pause' ? 'toggle' : command.name, by); // !pause: jeda, ketik lagi untuk lanjut
    }
    return true;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) {
      queue.length = 0;
      current = null;
      paused = false;
      clearTimeout(safetyTimer);
    }
    emit();
  }

  return { handleChat, control, started, ended, failed, getState, setEnabled, isPrivileged, gift, resetGifts };
}
