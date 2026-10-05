// Pemutar musik !play: memutar lagu dari antrean (diputuskan main process) dan menampilkan kartu "Now playing".
(() => {
  const $ = s => document.querySelector(s);
  const KEY = 'music-settings-v1';
  const cfg = { enabled: true, volume: 0.6, duck: true, showQueue: true, showCard: true };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };

  const audio = new Audio();
  audio.preload = 'auto';
  let state = { enabled: true, paused: false, current: null, queue: [] };
  let loadedId = null;
  let ducked = false;

  const fmt = sec => {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };

  function applyVolume() {
    audio.volume = Math.min(1, Math.max(0, cfg.volume * (cfg.duck && ducked ? 0.25 : 1)));
  }

  // ---------- Putar sesuai state dari main process ----------
  function syncAudio() {
    const cur = state.current;
    if (!cur) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loadedId = null;
      return;
    }
    if (loadedId !== cur.id) {
      loadedId = cur.id;
      audio.src = cur.audioUrl;
      audio.currentTime = 0;
    }
    applyVolume();
    if (state.paused) {
      audio.pause();
    } else {
      const id = cur.id;
      audio.play().catch(error => {
        if (error.name === 'AbortError') return; // src berganti saat masih memuat: normal
        if (loadedId === id) window.overlay.musicError(id, error.message);
      });
    }
  }

  audio.onplaying = () => { if (loadedId != null) window.overlay.musicStarted(loadedId, audio.currentTime); }; // selaraskan progress di halaman playlist
  audio.onended = () => { if (loadedId != null) window.overlay.musicEnded(loadedId); };
  audio.onerror = () => { if (loadedId != null) window.overlay.musicError(loadedId, 'audio tidak bisa dimuat (tautan kedaluwarsa atau diblokir)'); };

  // ---------- Tampilan ----------
  function renderProgress() {
    const cur = state.current;
    if (!cur) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : cur.duration;
    const pos = audio.currentTime || 0;
    $('#np-cur').textContent = fmt(pos);
    $('#np-dur').textContent = total ? fmt(total) : '--:--';
    $('#np-bar').style.width = total ? `${Math.min(100, (pos / total) * 100)}%` : '0%';
  }
  audio.ontimeupdate = renderProgress;

  function render() {
    const cur = state.current;
    const box = $('#player');
    box.hidden = !cur || !cfg.enabled || !cfg.showCard;
    if (!cur) return;

    $('#np-title').textContent = cur.title;
    $('#np-artist').textContent = cur.artist || 'Artis tidak diketahui';
    const req = $('#np-req');
    req.textContent = `diminta ${cur.requestedBy?.nickname || 'penonton'}`;
    if (cur.preview) {
      const badge = document.createElement('b');
      badge.textContent = 'PRATINJAU 30 DTK';
      req.append(' ', badge);
    }
    const cover = $('#np-cover');
    if (cur.cover) {
      if (cover.dataset.src !== cur.cover) {
        cover.dataset.src = cur.cover;
        cover.src = cur.cover;
      }
      cover.hidden = false;
      cover.onerror = () => { cover.hidden = true; };
    } else {
      cover.hidden = true;
    }
    box.classList.toggle('paused', state.paused);
    $('#np-pause').textContent = state.paused ? '▶' : '⏸';
    renderProgress();

    const list = $('#np-queue');
    list.replaceChildren();
    const shown = cfg.showQueue ? state.queue.slice(0, 3) : [];
    shown.forEach((track, index) => {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.artist ? `${track.title} — ${track.artist}` : track.title;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${track.gift > 0 ? '🎁 ' : ''}${track.requestedBy?.nickname || ''}`;
      li.append(num, name, who);
      list.append(li);
    });
    if (cfg.showQueue && state.queue.length > shown.length) {
      const more = document.createElement('li');
      more.className = 'more';
      more.textContent = `+${state.queue.length - shown.length} lagu lagi`;
      list.append(more);
    }
  }

  window.overlay.onMusicState(next => {
    state = next;
    syncAudio();
    render();
  });

  // Info/error musik tampil sebagai baris di chat (hanya terlihat oleh host)
  window.overlay.onMusicNotice(({ kind, text }) => {
    const item = document.createElement('article');
    item.className = `entry activity music ${kind === 'error' ? 'music-error' : kind === 'gift' ? 'music-gift' : ''}`;
    const icon = document.createElement('div');
    icon.className = 'avatar';
    icon.textContent = '♪';
    const line = document.createElement('p');
    line.className = 'line';
    line.textContent = text;
    item.append(icon, line);
    pushEntry(item); // dari renderer.js
  });

  // Musik dikecilkan saat TTS membacakan komentar
  window.addEventListener('tts-speaking', event => {
    ducked = Boolean(event.detail);
    applyVolume();
  });

  // ---------- Kontrol ----------
  $('#np-pause').onclick = () => window.overlay.musicControl('toggle');
  $('#np-skip').onclick = () => window.overlay.musicControl('skip');

  $('#music-on').checked = cfg.enabled;
  $('#music-volume').value = Math.round(cfg.volume * 100);
  $('#music-duck').checked = cfg.duck;
  $('#music-queue').checked = cfg.showQueue;
  $('#music-card').checked = cfg.showCard;
  $('#music-on').onchange = e => { cfg.enabled = e.target.checked; save(); window.overlay.musicSetEnabled(cfg.enabled); };
  $('#music-volume').oninput = e => { cfg.volume = e.target.value / 100; applyVolume(); save(); };
  $('#music-duck').onchange = e => { cfg.duck = e.target.checked; applyVolume(); save(); };
  $('#music-card').onchange = e => { cfg.showCard = e.target.checked; save(); render(); };
  $('#music-queue').onchange = e => { cfg.showQueue = e.target.checked; save(); render(); };

  // ---------- Link playlist (lokal / publik) & jendela playlist ----------
  const kindEl = $('#playlist-kind');
  const urlEl = $('#playlist-url');
  const statusEl = $('#playlist-status');
  let links = { localhost: '', loopback: '', tunnel: { status: 'off', url: '', error: '' } };
  try { if (localStorage.getItem('playlist-kind')) kindEl.value = localStorage.getItem('playlist-kind'); } catch {}
  try { if (localStorage.getItem('playlist-bg')) $('#playlist-bg').value = localStorage.getItem('playlist-bg'); } catch {}

  function renderLink() {
    const kind = kindEl.value;
    const tunnel = links.tunnel || {};
    statusEl.classList.toggle('error', kind === 'public' && tunnel.status === 'error');
    $('#playlist-stop').hidden = !(kind === 'public' && (tunnel.status === 'on' || tunnel.status === 'starting'));
    if (kind !== 'public') {
      urlEl.value = links[kind] || 'server playlist tidak aktif';
      urlEl.placeholder = '';
      statusEl.textContent = '';
      return;
    }
    urlEl.value = tunnel.status === 'on' ? tunnel.url : '';
    urlEl.placeholder = tunnel.status === 'starting' ? 'menyambung ke Cloudflare…' : tunnel.status === 'error' ? 'gagal membuat link' : 'klik Salin untuk membuat link';
    statusEl.textContent = {
      starting: 'Membuat link publik… bisa sampai 1 menit (pertama kali mengunduh cloudflared).',
      on: 'Link publik aktif selama aplikasi berjalan. Jangan dibagikan: siapa pun yang punya link bisa melihat playlist.',
      error: `Gagal: ${tunnel.error || 'tidak diketahui'}`,
      off: 'Link publik belum dibuat.'
    }[tunnel.status] || '';
  }

  const startTunnelIfNeeded = () => {
    if (kindEl.value === 'public' && (links.tunnel?.status || 'off') === 'off') window.overlay.musicTunnel('start').then(info => { links.tunnel = info; renderLink(); });
  };

  window.overlay.musicPlaylistUrls().then(result => { links = result; renderLink(); }).catch(() => { urlEl.value = 'server playlist tidak aktif'; });
  window.overlay.onMusicTunnel(info => { links.tunnel = info; renderLink(); });
  kindEl.onchange = () => { try { localStorage.setItem('playlist-kind', kindEl.value); } catch {} renderLink(); startTunnelIfNeeded(); };
  $('#playlist-stop').onclick = () => window.overlay.musicTunnel('stop').then(info => { links.tunnel = info; renderLink(); });

  $('#playlist-copy').onclick = async () => {
    if (kindEl.value === 'public' && links.tunnel?.status !== 'on') {
      links.tunnel = await window.overlay.musicTunnel(links.tunnel?.status === 'starting' ? 'status' : 'start');
      renderLink();
      return; // link muncul otomatis setelah tunnel siap; klik Salin lagi
    }
    if (!urlEl.value.startsWith('http')) return;
    urlEl.select();
    try { await navigator.clipboard.writeText(urlEl.value); } catch { document.execCommand('copy'); }
    $('#playlist-copy').textContent = 'Tersalin ✓';
    setTimeout(() => { $('#playlist-copy').textContent = 'Salin'; }, 1500);
  };

  let windowOpen = false;
  const renderWindowButton = () => { $('#playlist-window').textContent = windowOpen ? 'Tutup' : 'Buka'; };
  window.overlay.onMusicPlaylistWindow(open => { windowOpen = open; renderWindowButton(); });
  $('#playlist-bg').onchange = e => { try { localStorage.setItem('playlist-bg', e.target.value); } catch {} if (windowOpen) window.overlay.musicPlaylistWindow('open', e.target.value); };
  $('#playlist-window').onclick = () => window.overlay.musicPlaylistWindow(windowOpen ? 'close' : 'open', $('#playlist-bg').value);

  window.overlay.musicSetEnabled(cfg.enabled);
  window.overlay.musicState().then(initial => { state = initial; syncAudio(); render(); }).catch(() => {});
  applyVolume();
})();
