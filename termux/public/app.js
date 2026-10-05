const $ = s => document.querySelector(s);
const MAX_ENTRIES = 120;

const post = (url, body = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());

const formatNumber = n => new Intl.NumberFormat('id-ID', {
  notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1
}).format(n || 0);
const initialOf = d => (Array.from(d.nickname || d.username || '?')[0] || '?').toUpperCase();

function nameColor(name) {
  let hue = 0;
  for (const ch of String(name)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 80% 74%)`;
}
function initialAvatar(d) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.textContent = initialOf(d);
  return el;
}
function avatar(d, url = d.avatar) {
  if (!url) return initialAvatar(d);
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.src = url;
  img.onerror = () => img.replaceWith(initialAvatar(d));
  return img;
}

// ---------- Feed ----------
const feed = $('#feed');
let total = 0;
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
feed.addEventListener('scroll', () => { $('#jump').hidden = nearBottom(); });
$('#jump').onclick = () => { feed.scrollTop = feed.scrollHeight; };

function pushEntry(item) {
  const stick = nearBottom();
  $('#empty')?.remove();
  feed.append(item);
  while (feed.children.length > MAX_ENTRIES) feed.firstElementChild.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
  else $('#jump').hidden = false;
}

// ---------- Event dari server ----------
let timer;
function setStatus(d) {
  const box = $('#status');
  box.className = `status ${d.state}`;
  box.querySelector('span').textContent = d.text;
  const connected = d.state === 'connected';
  const reconnecting = d.state === 'reconnecting';
  $('#form').hidden = connected || reconnecting;
  $('#disconnect').hidden = !(connected || reconnecting);
  $('#connect').disabled = d.state === 'connecting';
  $('#connect').textContent = d.state === 'connecting' ? 'Menghubungkan…' : 'Hubungkan';
  if (d.state === 'connecting') { total = 0; $('#count').textContent = '0 komentar'; $('#likes').textContent = '0'; }
  if (!connected) $('#viewers').textContent = '—';
  clearInterval(timer);
  if (connected) {
    const start = d.connectedAt || Date.now();
    const tick = () => {
      const n = Math.max(0, Math.floor((Date.now() - start) / 1000));
      $('#duration').textContent = [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60]
        .map(v => String(v).padStart(2, '0')).join(':');
    };
    tick();
    timer = setInterval(tick, 1000);
  } else if (!reconnecting) {
    $('#duration').textContent = '00:00:00';
  }
}

// ---------- Suara yang diputar di halaman ini (mesin edge / browser) ----------
const VOLUME_KEY = 'termux-tts-volume';
const localVolume = () => Number($('#tts-volume').value) / 100;
try { const v = localStorage.getItem(VOLUME_KEY); if (v !== null) $('#tts-volume').value = v; } catch {}
$('#tts-volume').oninput = () => {
  try { localStorage.setItem(VOLUME_KEY, $('#tts-volume').value); } catch {}
  if (currentAudio) currentAudio.volume = localVolume();
};

let currentAudio = null;
let engine = 'edge';
const reportDone = (id, error) => post('/api/tts-done', { id, ok: !error, error }).catch(() => {});

function stopLocal() {
  setDuck(false);
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function speakWithDeviceVoice(d) {
  setDuck(true);
  if (!('speechSynthesis' in window)) return reportDone(d.id, 'Browser ini tidak mendukung suara bawaan perangkat.');
  const wanted = d.lang === 'en' ? 'en' : 'id';
  const utter = new SpeechSynthesisUtterance(d.text);
  utter.lang = wanted === 'en' ? 'en-US' : 'id-ID';
  utter.rate = d.rate;
  utter.volume = localVolume();
  const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(wanted));
  if (voice) utter.voice = voice;
  utter.onend = () => { setDuck(false); reportDone(d.id); };
  utter.onerror = ev => setDuck(false) || reportDone(d.id, ['canceled', 'interrupted'].includes(ev.error) ? undefined : `Suara perangkat gagal (${ev.error}).`);
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

function playAudio(d) {
  const audio = new Audio(`data:audio/mpeg;base64,${d.audio}`);
  audio.volume = localVolume();
  currentAudio = audio;
  setDuck(true);
  audio.onended = () => { setDuck(false); if (currentAudio === audio) currentAudio = null; reportDone(d.id); };
  audio.onerror = () => { setDuck(false); reportDone(d.id, 'Browser gagal memutar audio.'); };
  audio.play().catch(err => {
    setDuck(false);
    showAudioWarning(true);
    reportDone(d.id, err.name === 'NotAllowedError'
      ? 'Browser memblokir suara. Ketuk layar sekali, lalu tekan Tes suara.'
      : `Gagal memutar: ${err.message}`);
  });
}

// Browser baru mengizinkan suara setelah pengguna menyentuh halaman sekali.
const usesBrowserAudio = () => engine === 'edge' || engine === 'browser';
const activated = () => navigator.userActivation?.hasBeenActive ?? false;
function showAudioWarning(force = false) {
  const needsAudio = $('#music-on').checked || (usesBrowserAudio() && $('#tts-on').checked);
  $('#audio-warning').hidden = !(needsAudio && (force || !activated()));
}
function unlockAudio() {
  const beep = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
  beep.play().catch(() => {});
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  $('#audio-warning').hidden = true;
  musicSync();
}
$('#audio-warning').onclick = unlockAudio;
document.addEventListener('pointerdown', () => { $('#audio-warning').hidden = true; }, { capture: true });
document.addEventListener('pointerup', () => { if (music.blocked) musicSync(); }, { capture: true }); // izin suara baru aktif setelah sentuhan selesai

function syncSettings(s) {
  engine = s.engine;
  $('#tts-engine').value = s.engine;
  $('#tts-voice').value = s.voice;
  document.querySelectorAll('[data-engines]').forEach(el => {
    el.hidden = !el.dataset.engines.split(' ').includes(s.engine);
  });
  [...$('#tts-engine').options].forEach(o => { if (o.value === 'edge' && !s.edgeReady) o.disabled = true; });
  $('#tts-on').checked = s.on;
  $('#tts-name').checked = s.readName;
  $('#tts-rate').value = Math.round(s.rate * 100);
  $('#tts-stream').value = s.stream;
  $('#tts-lang').value = s.lang;
  const mute = $('#mute');
  mute.hidden = !s.on;
  mute.textContent = s.muted ? '🔇 Bunyikan' : '🔊 Bisu';
  mute.classList.toggle('active', s.muted);
  $('#api-key').placeholder = s.hasKey ? 'tersimpan (ketik untuk mengganti)' : 'kosong = tanpa key';
  showAudioWarning();
}

const es = new EventSource('/events');
es.addEventListener('speak', e => {
  const d = JSON.parse(e.data);
  stopLocal();
  if (d.audio) playAudio(d); else speakWithDeviceVoice(d);
});
es.addEventListener('stop', stopLocal);
es.addEventListener('status', e => setStatus(JSON.parse(e.data)));
es.addEventListener('settings', e => syncSettings(JSON.parse(e.data)));
es.addEventListener('tts-error', e => { $('#tts-error').textContent = JSON.parse(e.data).message; });
es.addEventListener('stats', e => {
  const d = JSON.parse(e.data);
  if (Number.isFinite(d.viewers)) $('#viewers').textContent = formatNumber(d.viewers);
  if (Number.isFinite(d.likes)) $('#likes').textContent = formatNumber(d.likes);
});
es.addEventListener('chat', e => {
  const d = JSON.parse(e.data);
  const item = document.createElement('article');
  item.className = d.command ? 'entry command' : 'entry';
  const line = document.createElement('p');
  line.className = 'line';
  const nick = document.createElement('b');
  nick.className = 'nick';
  nick.textContent = d.nickname;
  nick.style.color = nameColor(d.username);
  const text = document.createElement('span');
  text.textContent = d.comment;
  line.append(nick, text);
  item.append(avatar(d), line);
  pushEntry(item);
  total++;
  $('#count').textContent = `${formatNumber(total)} komentar`;
});
es.addEventListener('activity', e => {
  const d = JSON.parse(e.data);
  if (!d.nickname) return;
  const item = document.createElement('article');
  item.className = `entry activity ${d.type}`;
  const line = document.createElement('p');
  line.className = 'line';
  if (d.type === 'gift') line.textContent = `🎁 ${d.nickname} mengirim ${d.giftName} ×${d.amount}`;
  if (d.type === 'share') line.textContent = `↗ ${d.nickname} membagikan LIVE`;
  if (d.type === 'follow') line.textContent = `➕ ${d.nickname} mulai mengikuti`;
  item.append(avatar(d, d.image || d.avatar), line);
  pushEntry(item);
});
// ---------- Musik !play ----------
const music = { state: { enabled: true, paused: false, current: null, queue: [] }, audio: new Audio(), loadedId: null, volume: 0.6, showQueue: true, blocked: false, ducked: false };
try {
  const v = localStorage.getItem('termux-music-volume'); if (v !== null) music.volume = Number(v) / 100;
  music.showQueue = localStorage.getItem('termux-music-queue') !== '0';
} catch {}
$('#music-volume').value = Math.round(music.volume * 100);
$('#music-queue').checked = music.showQueue;
music.audio.preload = 'auto';

const fmtTime = sec => { sec = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
function musicVolume() { music.audio.volume = Math.min(1, Math.max(0, music.volume * (music.ducked ? 0.25 : 1))); }
function setDuck(on) { music.ducked = Boolean(on); musicVolume(); } // musik dikecilkan saat TTS bicara

function musicSync() {
  const cur = music.state.current;
  const audio = music.audio;
  if (!cur) { audio.pause(); audio.removeAttribute('src'); audio.load(); music.loadedId = null; music.blocked = false; return; }
  if (music.loadedId !== cur.id) { music.loadedId = cur.id; audio.src = cur.audioUrl; audio.currentTime = 0; }
  musicVolume();
  if (music.state.paused) { audio.pause(); return; }
  const id = cur.id;
  audio.play().then(() => { music.blocked = false; }).catch(error => {
    if (error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') { music.blocked = true; showAudioWarning(true); return; } // tunggu ketukan pengguna
    if (music.loadedId === id) post('/api/music', { error: id, message: error.message }).catch(() => {});
  });
}
music.audio.onplaying = () => { if (music.loadedId != null) post('/api/music', { started: music.loadedId, position: music.audio.currentTime }).catch(() => {}); };
music.audio.onended = () => { if (music.loadedId != null) post('/api/music', { ended: music.loadedId }).catch(() => {}); };
music.audio.onerror = () => { if (music.loadedId != null) post('/api/music', { error: music.loadedId, message: 'audio tidak bisa dimuat (tautan kedaluwarsa atau diblokir)' }).catch(() => {}); };

function musicProgress() {
  const cur = music.state.current;
  if (!cur) return;
  const a = music.audio;
  const total = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : cur.duration;
  const pos = a.currentTime || 0;
  $('#np-cur').textContent = fmtTime(pos);
  $('#np-dur').textContent = total ? fmtTime(total) : '--:--';
  $('#np-bar').style.width = total ? `${Math.min(100, (pos / total) * 100)}%` : '0%';
}
music.audio.ontimeupdate = musicProgress;

function musicRender() {
  const { current: cur, queue, paused, enabled } = music.state;
  $('#music-on').checked = enabled;
  const box = $('#player');
  box.hidden = !cur;
  if (!cur) return;
  $('#np-title').textContent = cur.title;
  $('#np-artist').textContent = cur.artist || 'Artis tidak diketahui';
  const req = $('#np-req');
  req.textContent = `diminta ${cur.requestedBy?.nickname || 'penonton'}`;
  if (cur.preview) { const badge = document.createElement('b'); badge.textContent = 'PRATINJAU 30 DTK'; req.append(' ', badge); }
  const cover = $('#np-cover');
  if (cur.cover) { if (cover.dataset.src !== cur.cover) { cover.dataset.src = cur.cover; cover.src = cur.cover; } cover.hidden = false; cover.onerror = () => { cover.hidden = true; }; }
  else cover.hidden = true;
  box.classList.toggle('paused', paused);
  $('#np-pause').textContent = paused ? '▶' : '⏸';
  musicProgress();
  const list = $('#np-queue');
  list.replaceChildren();
  const shown = music.showQueue ? queue.slice(0, 3) : [];
  shown.forEach((track, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
    const name = document.createElement('span'); name.className = 'name'; name.textContent = track.artist ? `${track.title} — ${track.artist}` : track.title;
    const who = document.createElement('span'); who.className = 'who'; who.textContent = `${track.gift > 0 ? '🎁 ' : ''}${track.requestedBy?.nickname || ''}`;
    li.append(num, name, who);
    list.append(li);
  });
  if (music.showQueue && queue.length > shown.length) {
    const more = document.createElement('li'); more.className = 'more'; more.textContent = `+${queue.length - shown.length} lagu lagi`; list.append(more);
  }
}

es.addEventListener('music:state', e => { music.state = JSON.parse(e.data); musicSync(); musicRender(); showAudioWarning(); });
es.addEventListener('music:notice', e => {
  const { kind, text } = JSON.parse(e.data);
  const item = document.createElement('article');
  item.className = `entry activity music ${kind === 'error' ? 'music-error' : kind === 'gift' ? 'music-gift' : ''}`;
  const icon = document.createElement('div'); icon.className = 'avatar'; icon.textContent = '♪';
  const line = document.createElement('p'); line.className = 'line'; line.textContent = text;
  item.append(icon, line);
  pushEntry(item);
});
$('#np-pause').onclick = () => post('/api/music', { action: 'toggle' });
$('#np-skip').onclick = () => post('/api/music', { action: 'skip' });
$('#music-on').onchange = e => { post('/api/music', { enabled: e.target.checked }); if (e.target.checked) unlockAudio(); };
$('#music-volume').oninput = e => { music.volume = e.target.value / 100; musicVolume(); try { localStorage.setItem('termux-music-volume', e.target.value); } catch {} };
$('#playlist-url').value = `${location.origin}/playlist`;
$('#playlist-copy').onclick = async () => {
  const field = $('#playlist-url');
  field.select();
  try { await navigator.clipboard.writeText(field.value); } catch { document.execCommand('copy'); }
  $('#playlist-copy').textContent = 'Tersalin ✓';
  setTimeout(() => { $('#playlist-copy').textContent = 'Salin'; }, 1500);
};
$('#music-queue').onchange = e => { music.showQueue = e.target.checked; try { localStorage.setItem('termux-music-queue', e.target.checked ? '1' : '0'); } catch {} musicRender(); };

es.onerror = () => { $('#status span').textContent = 'Menyambung ke server…'; };

// ---------- Kontrol ----------
$('#form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#error').textContent = '';
  try {
    const result = await post('/api/connect', { username: $('#username').value });
    if (result.ok || result.cancelled) return;
    $('#error').textContent = /offline|not live|isn't live/i.test(result.error)
      ? 'Akun ini sedang tidak LIVE atau LIVE tidak publik.'
      : result.error;
  } catch { $('#error').textContent = 'Server tidak merespons.'; }
});
$('#disconnect').onclick = () => post('/api/disconnect');
$('#tts-on').onchange = e => { post('/api/tts', { on: e.target.checked }); if (e.target.checked) unlockAudio(); };
$('#tts-name').onchange = e => post('/api/tts', { readName: e.target.checked });
$('#tts-rate').onchange = e => post('/api/tts', { rate: e.target.value / 100 });
$('#tts-engine').onchange = e => { post('/api/tts', { engine: e.target.value }); unlockAudio(); };
$('#tts-voice').onchange = e => post('/api/tts', { voice: e.target.value });
$('#tts-stream').onchange = e => post('/api/tts', { stream: e.target.value });
$('#tts-lang').onchange = e => post('/api/tts', { lang: e.target.value });
$('#api-key').onchange = e => { post('/api/key', { key: e.target.value }); e.target.value = ''; };
$('#mute').onclick = () => post('/api/tts', { muted: !$('#mute').classList.contains('active') });
$('#tts-skip').onclick = () => post('/api/tts', { skip: true });
$('#tts-test').onclick = () => { unlockAudio(); post('/api/tts', { test: true }); };

const FONT_KEY = 'termux-font';
try { const f = Number(localStorage.getItem(FONT_KEY)); if (f >= 12 && f <= 26) $('#font').value = f; } catch {}
const applyFont = () => document.documentElement.style.setProperty('--size', `${$('#font').value}px`);
$('#font').oninput = () => { applyFont(); try { localStorage.setItem(FONT_KEY, $('#font').value); } catch {} };
applyFont();

// Cegah layar HP mati selama halaman terbuka (layar mati = suara berhenti di browser)
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {}
}
document.addEventListener('pointerdown', keepAwake, { once: true, capture: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
