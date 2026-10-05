const $ = s => document.querySelector(s);
const MAX_ENTRIES = 120;
const UI_KEY = 'ui-settings-v1';

// ---------- Pengaturan tampilan (tersimpan otomatis) ----------
const ui = { font: 15, opacity: 55, fade: 60, topmost: true, showJoin: false, showTop: false };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch {}
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

function applyUi() {
  const root = document.documentElement.style;
  root.setProperty('--size', `${ui.font}px`);
  root.setProperty('--opacity', ui.opacity / 100);
  if (!ui.showTop) $('#top').hidden = true;
  if (!ui.showJoin) $('#join').hidden = true;
}

// ---------- Util ----------
const formatNumber = n => new Intl.NumberFormat('id-ID', {
  notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1
}).format(n || 0);

const initialOf = data => (Array.from(data.nickname || data.username || '?')[0] || '?').toUpperCase();

function nameColor(name) {
  let hue = 0;
  for (const ch of String(name)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 80% 74%)`;
}

function initialAvatar(data) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.textContent = initialOf(data);
  return el;
}

function avatar(data, url = data.avatar) {
  if (!url) return initialAvatar(data);
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.src = url;
  img.onerror = () => img.replaceWith(initialAvatar(data));
  return img;
}

// ---------- Feed ----------
const feed = $('#feed');
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
feed.addEventListener('scroll', () => { $('#jump').hidden = nearBottom(); });
$('#jump').onclick = () => { feed.scrollTop = feed.scrollHeight; $('#jump').hidden = true; };

function pushEntry(item) {
  const stick = nearBottom();
  $('#empty')?.remove();
  feed.append(item);
  while (feed.children.length > MAX_ENTRIES) feed.firstElementChild.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
  else $('#jump').hidden = false;
  if (ui.fade > 0) {
    setTimeout(() => {
      item.classList.add('gone');
      setTimeout(() => item.remove(), 700);
    }, ui.fade * 1000);
  }
}

let total = 0;
function resetCounters() {
  total = 0;
  $('#count').textContent = '0 komentar';
  $('#likes').textContent = '0';
}

// ---------- Status & durasi ----------
let timer;
function setStatus(data) {
  const box = $('#status');
  box.className = `status ${data.state}`;
  box.querySelector('span').textContent = data.text;

  const connected = data.state === 'connected';
  const reconnecting = data.state === 'reconnecting';
  $('#setup').hidden = connected || reconnecting;
  $('#disconnect').hidden = !(connected || reconnecting);
  $('#connect').disabled = data.state === 'connecting';
  $('#connect').textContent = data.state === 'connecting' ? 'Menghubungkan…' : 'Hubungkan';
  if (data.state === 'connecting') resetCounters();
  if (!connected) $('#viewers').textContent = '—';

  clearInterval(timer);
  if (connected) {
    const start = data.connectedAt || Date.now();
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
window.overlay.onStatus(setStatus);

try { if (localStorage.getItem('euler-key')) $('#apikey').placeholder = 'API key tersimpan (ketik untuk mengganti)'; } catch {}
$('#form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#error').textContent = '';
  let savedKey = '';
  try { savedKey = localStorage.getItem('euler-key') || ''; } catch {}
  const typedKey = $('#apikey').value.trim();
  const key = typedKey || savedKey;
  if (typedKey) { try { localStorage.setItem('euler-key', typedKey); } catch {} }
  const result = await window.overlay.connect($('#username').value, key);
  if (result.ok || result.cancelled) return;
  $('#error').textContent = /offline|not live|isn't live/i.test(result.error)
    ? 'Akun ini sedang tidak LIVE atau LIVE tidak publik.'
    : result.error;
});

// ---------- Event dari LIVE ----------
window.overlay.onChat(data => {
  if (!data.comment) return;
  const item = document.createElement('article');
  item.className = data.command ? 'entry command' : 'entry';
  const line = document.createElement('p');
  line.className = 'line';
  const nick = document.createElement('b');
  nick.className = 'nick';
  nick.textContent = data.nickname;
  nick.style.color = nameColor(data.username);
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = data.comment;
  line.append(nick, text);
  item.append(avatar(data), line);
  pushEntry(item);
  total++;
  $('#count').textContent = `${formatNumber(total)} komentar`;
});

let joinTimer;
let lastJoin = 0;
window.overlay.onMember(data => {
  if (!ui.showJoin) return;
  const now = Date.now();
  if (now - lastJoin < 2000) return; // batasi agar tidak berkedip saat live ramai
  lastJoin = now;
  const box = $('#join');
  const holder = $('#join-avatar');
  $('#join-name').textContent = data.nickname || `@${data.username}`;
  holder.replaceChildren();
  if (data.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = data.avatar;
    img.onerror = () => { holder.textContent = initialOf(data); };
    holder.append(img);
  } else {
    holder.textContent = initialOf(data);
  }
  box.hidden = false;
  box.style.animation = 'none';
  requestAnimationFrame(() => { box.style.animation = ''; });
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => { box.hidden = true; }, 4000);
});

window.overlay.onStats(data => {
  if (Number.isFinite(data.viewers)) $('#viewers').textContent = formatNumber(data.viewers);
  if (Number.isFinite(data.likes)) $('#likes').textContent = formatNumber(data.likes);
  if (ui.showTop && data.topViewers?.length) {
    $('#top-list').replaceChildren(...data.topViewers.map(v => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = v.nickname || `@${v.username}`;
      return chip;
    }));
    $('#top').hidden = false;
  }
});

window.overlay.onActivity(data => {
  if (!data.nickname) return;
  const item = document.createElement('article');
  item.className = `entry activity ${data.type}`;
  const line = document.createElement('p');
  line.className = 'line';
  if (data.type === 'gift') line.textContent = `🎁 ${data.nickname} mengirim ${data.giftName} ×${data.amount}`;
  if (data.type === 'share') line.textContent = `↗ ${data.nickname} membagikan LIVE`;
  if (data.type === 'follow') line.textContent = `➕ ${data.nickname} mulai mengikuti`;
  item.append(avatar(data, data.image || data.avatar), line);
  pushEntry(item);
});

// ---------- Pengaturan ----------
$('#gear').onclick = () => { $('#settings').hidden = !$('#settings').hidden; };
$('#settings-close').onclick = () => { $('#settings').hidden = true; };

$('#font').value = ui.font;
$('#opacity').value = ui.opacity;
$('#fade').value = ui.fade;
$('#topmost').checked = ui.topmost;
$('#show-join').checked = ui.showJoin;
$('#show-top').checked = ui.showTop;

$('#font').oninput = e => { ui.font = Number(e.target.value); applyUi(); saveUi(); };
$('#opacity').oninput = e => { ui.opacity = Number(e.target.value); applyUi(); saveUi(); };
$('#fade').oninput = e => { ui.fade = Number(e.target.value); saveUi(); };
$('#topmost').onchange = e => { ui.topmost = e.target.checked; window.overlay.alwaysOnTop(ui.topmost); saveUi(); };
$('#show-join').onchange = e => { ui.showJoin = e.target.checked; applyUi(); saveUi(); };
$('#show-top').onchange = e => { ui.showTop = e.target.checked; applyUi(); saveUi(); };
$('#passthrough').onchange = e => window.overlay.clickThrough(e.target.checked);
document.querySelectorAll('[data-size]').forEach(button => {
  button.onclick = () => window.overlay.setSize(button.dataset.size);
});

window.overlay.onClickThroughState(enabled => {
  $('#passthrough').checked = enabled;
  document.body.classList.toggle('passthrough', enabled);
  if (enabled) $('#settings').hidden = true;
});

$('#disconnect').onclick = () => window.overlay.disconnect();
$('#min').onclick = () => window.overlay.minimize();
$('#close').onclick = () => window.overlay.close();

applyUi();
if (!ui.topmost) window.overlay.alwaysOnTop(false);
