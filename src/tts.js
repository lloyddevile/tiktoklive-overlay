(() => {
  const $ = s => document.querySelector(s);
  const KEY = 'tts-settings-v1';
  const cfg = {
    on: false,
    voice: 'id-ID-ArdiNeural',
    rate: 1,
    volume: 1,
    readName: true,
    maxLength: 100,
    maxQueue: 6,
    maxAgeMs: 25000, // komentar yang antri lebih lama dari ini dilewati (supaya suara tidak ketinggalan)
    duplicateWindowMs: 30000,
    blockLinks: true,
    blockWords: ['judi', 'slot', 'togel'],
    ignoreUsers: []
  };

  try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        on: cfg.on, voice: cfg.voice, rate: cfg.rate, volume: cfg.volume, readName: cfg.readName
      }));
    } catch {}
  };

  // sinkronkan UI dengan setting tersimpan
  $('#tts-on').checked = cfg.on;
  $('#tts-voice').value = cfg.voice;
  $('#tts-rate').value = Math.round(cfg.rate * 100);
  $('#tts-volume').value = Math.round(cfg.volume * 100);
  $('#tts-name').checked = cfg.readName;

  const queue = [];
  const recent = new Map();
  let speaking = false;
  let ready = false;
  let muted = false;
  let currentAudio = null;
  let generation = 0; // naik setiap kali antrian di-reset

  const showError = msg => { $('#tts-error').textContent = msg || ''; };

  function clean(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/\[[^\]]{1,30}\]/g, ' ') // kode emote TikTok seperti [wow]
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/(.)\1{3,}/g, '$1$1$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function playBase64(b64) {
    return new Promise((resolve, reject) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      currentAudio = audio;
      audio.volume = cfg.volume;
      window.dispatchEvent(new CustomEvent('tts-speaking', { detail: true })); // musik dikecilkan sementara
      const done = fn => value => {
        window.dispatchEvent(new CustomEvent('tts-speaking', { detail: false }));
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        fn(value);
      };
      audio.onended = done(resolve);
      audio.onerror = done(() => reject(new Error('Gagal memutar audio.')));
      audio.play().catch(done(reject));
    });
  }

  async function speak(line, gen = generation) {
    const result = await window.overlay.synthesize(line, { voice: cfg.voice, rate: cfg.rate });
    if (gen !== generation) return; // antrian di-reset/dibisukan saat sintesis berjalan: jangan diputar
    if (!result.ok) throw new Error(result.error);
    await playBase64(result.audio);
  }

  async function next() {
    if (speaking || !cfg.on) return;
    const now = Date.now();
    let item;
    while ((item = queue.shift()) && now - item.at > cfg.maxAgeMs); // buang yang basi
    if (!item) return;
    speaking = true;
    const gen = generation;
    try {
      await speak(item.line, gen);
      if (gen === generation) showError('');
    } catch (err) {
      if (gen === generation) showError(`Suara gagal: ${err.message}`);
    }
    speaking = false;
    next();
  }

  function resetQueue() {
    generation++;
    queue.length = 0;
    if (currentAudio) { currentAudio.pause(); currentAudio.dispatchEvent(new Event('ended')); }
  }

  function isBlocked(raw, text) {
    if (cfg.blockLinks && /https?:\/\/|www\./i.test(raw)) return true;
    const lower = text.toLowerCase();
    return cfg.blockWords.some(w => lower.includes(w.toLowerCase()));
  }

  window.overlay.onChat(data => {
    if (!cfg.on || !ready || muted || data.command) return; // perintah !play dkk tidak dibacakan
    const raw = data.comment || '';
    let text = clean(raw);
    if (!text) return;
    if (cfg.ignoreUsers.includes(data.username)) return;
    if (isBlocked(raw, text)) return;
    if (text.length > cfg.maxLength) text = `${text.slice(0, cfg.maxLength)} dan seterusnya`;

    const key = `${data.username}:${text.toLowerCase()}`;
    const now = Date.now();
    if (recent.has(key) && now - recent.get(key) < cfg.duplicateWindowMs) return;
    recent.set(key, now);
    if (recent.size > 500) {
      for (const [k, t] of recent) if (now - t > cfg.duplicateWindowMs) recent.delete(k);
    }
    if (queue.length >= cfg.maxQueue) queue.shift(); // buang yang terlama, bukan yang terbaru

    const name = clean(data.nickname || data.username) || 'seseorang';
    queue.push({ line: cfg.readName ? `${name} bilang ${text}` : text, at: now });
    next();
  });

  // Abaikan komentar lama yang dikirim TikTok saat baru terhubung
  window.overlay.onStatus(status => {
    ready = false;
    if (status.state === 'connected') setTimeout(() => { ready = true; }, 1500);
    else resetQueue();
  });

  function renderMute() {
    const btn = $('#mute');
    btn.hidden = !cfg.on;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('muted', muted);
  }

  function toggleMute() {
    if (!cfg.on) return;
    muted = !muted;
    if (muted) resetQueue();
    renderMute();
  }

  $('#tts-on').onchange = e => {
    cfg.on = e.target.checked;
    if (!cfg.on) { muted = false; resetQueue(); }
    renderMute();
    save();
  };
  $('#mute').onclick = toggleMute;
  window.overlay.onToggleMute(toggleMute);
  renderMute();
  $('#tts-voice').onchange = e => { cfg.voice = e.target.value; save(); };
  $('#tts-rate').oninput = e => { cfg.rate = e.target.value / 100; save(); };
  $('#tts-volume').oninput = e => {
    cfg.volume = e.target.value / 100;
    if (currentAudio) currentAudio.volume = cfg.volume;
    save();
  };
  $('#tts-name').onchange = e => { cfg.readName = e.target.checked; save(); };
  $('#tts-skip').onclick = resetQueue;
  $('#tts-test').onclick = async () => {
    showError('');
    try { await speak('Halo, tes suara berhasil.'); }
    catch (err) { showError(`Suara gagal: ${err.message}`); }
  };
})();
