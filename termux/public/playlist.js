// Halaman playlist (hanya tampilan, tanpa suara). Parameter URL:
//   ?max=6      jumlah lagu "Berikutnya" yang ditampilkan (0 = sembunyikan)
//   ?idle=0     sembunyikan kartu petunjuk saat tidak ada lagu (halaman jadi benar-benar kosong)
//   ?hint=0     sembunyikan teks petunjuk "Ketik !play ..." di bawah
//   ?scale=1.2  perbesar/perkecil seluruh tampilan
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const num = (key, fallback, min, max) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
const MAX = Math.round(num('max', 6, 0, 12));
const SHOW_IDLE = params.get('idle') !== '0';
const SHOW_HINT = params.get('hint') !== '0';
document.documentElement.style.setProperty('--scale', String(num('scale', 1, 0.5, 3)));

let state = { enabled: true, paused: false, positionMs: 0, current: null, queue: [] };
let receivedAt = Date.now();
let shownId = null;

const fmt = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const elapsed = () => (state.current ? state.positionMs + (state.paused ? 0 : Date.now() - receivedAt) : 0);

function render() {
  const cur = state.enabled ? state.current : null;
  $('#now').hidden = !cur;
  $('#idle').hidden = Boolean(cur) || !SHOW_IDLE || !state.enabled;
  $('#hint').hidden = !SHOW_HINT || !cur;

  const queue = cur ? state.queue : [];
  $('#next').hidden = !cur || MAX === 0 || queue.length === 0;
  if (!cur) { shownId = null; return; }

  $('#title').textContent = cur.title;
  $('#artist').textContent = cur.artist || 'Artis tidak diketahui';
  const req = $('#req');
  req.textContent = `diminta oleh ${cur.requestedBy?.nickname || 'penonton'}`;
  if (cur.preview) { const badge = document.createElement('b'); badge.textContent = 'PRATINJAU 30 DTK'; req.append(' ', badge); }
  $('#now').classList.toggle('paused', state.paused);

  const cover = $('#cover');
  const bg = $('#bg');
  if (cur.cover) {
    if (cover.dataset.src !== cur.cover) { cover.dataset.src = cur.cover; cover.src = cur.cover; bg.style.backgroundImage = `url("${cur.cover.replace(/"/g, '%22')}")`; }
    cover.hidden = false;
    cover.onerror = () => { cover.hidden = true; };
  } else {
    cover.hidden = true;
    bg.style.backgroundImage = '';
  }
  if (shownId !== cur.id) {
    shownId = cur.id;
    const now = $('#now');
    now.classList.remove('swap'); void now.offsetWidth; now.classList.add('swap');
  }

  const list = $('#list');
  list.replaceChildren();
  queue.slice(0, MAX).forEach((track, index) => {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'num'; n.textContent = String(index + 1);
    const info = document.createElement('div'); info.className = 'info';
    const title = document.createElement('b'); title.textContent = track.title;
    const artist = document.createElement('span'); artist.textContent = track.artist || '';
    info.append(title, artist);
    const who = document.createElement('span'); who.className = 'who'; who.textContent = `${track.gift > 0 ? '🎁 ' : ''}${track.requestedBy?.nickname || ''}`;
    li.append(n, info, who);
    list.append(li);
  });
  if (queue.length > MAX) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `+${queue.length - MAX} lagu lagi`;
    list.append(more);
  }
}

function tick() {
  const cur = state.current;
  if (cur && state.enabled) {
    const total = (cur.duration || 0) * 1000;
    const pos = total ? Math.min(elapsed(), total) : elapsed();
    $('#cur').textContent = fmt(pos);
    $('#dur').textContent = total ? fmt(total) : '--:--';
    $('#bar').style.width = total ? `${Math.min(100, (pos / total) * 100)}%` : '0%';
  }
  requestAnimationFrame(tick);
}

const es = new EventSource('events');
es.addEventListener('music:state', event => {
  try { state = JSON.parse(event.data); receivedAt = Date.now(); render(); } catch {}
});
render();
tick();
