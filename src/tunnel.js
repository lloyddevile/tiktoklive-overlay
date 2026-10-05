// Link publik https:// untuk halaman playlist lewat Cloudflare Quick Tunnel (gratis, tanpa akun).
// Dipakai bila TikTok LIVE Studio / OBS menolak link localhost. Binary `cloudflared` dipasang oleh
// paket npm `cloudflared` (saat npm install) atau diunduh sekali saat pertama dipakai.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 60000;

export function createTunnel({ onChange = () => {}, log = console.log, spawnImpl = spawn, loadBinary } = {}) {
  let child = null;
  let timer = null;
  let stopping = false;
  let info = { status: 'off', url: '', error: '' };

  const set = patch => { info = { ...info, ...patch }; onChange({ ...info }); };

  async function getBinary() {
    if (loadBinary) return loadBinary();
    let mod;
    try { mod = await import('cloudflared'); }
    catch { throw new Error('Modul "cloudflared" belum terpasang. Jalankan npm install di folder aplikasi.'); }
    if (!fs.existsSync(mod.bin)) {
      log('[tunnel] mengunduh cloudflared (sekali saja)…');
      await mod.install(mod.bin);
    }
    return mod.bin;
  }

  async function start(port) {
    if (child) return info;
    stopping = false;
    set({ status: 'starting', url: '', error: '' });
    let bin;
    try { bin = await getBinary(); }
    catch (error) { set({ status: 'error', error: String(error?.message || error).slice(0, 200) }); return info; }

    // http2 (TCP 443) dipilih karena QUIC (UDP 7844) sering diblokir jaringan rumah/kantor
    const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4'];
    let proc;
    try { proc = spawnImpl(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { set({ status: 'error', error: `Gagal menjalankan cloudflared: ${error.message}` }); return info; }
    child = proc;

    let tail = '';
    const onData = chunk => {
      const text = String(chunk);
      tail = (tail + text).slice(-1500);
      const match = text.match(URL_RE);
      if (match && info.status !== 'on') {
        clearTimeout(timer);
        log(`[tunnel] link publik: ${match[0]}`);
        set({ status: 'on', url: match[0], error: '' });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', error => {
      if (child === proc) child = null;
      clearTimeout(timer);
      set({ status: 'error', url: '', error: `cloudflared gagal berjalan: ${error.message}` });
    });
    proc.on('exit', code => {
      if (child === proc) child = null;
      clearTimeout(timer);
      if (stopping || info.status === 'off') return;
      const reason = tail.split('\n').filter(l => /ERR|error|fail/i.test(l)).pop() || `keluar dengan kode ${code}`;
      set({ status: 'error', url: '', error: `Tunnel berhenti: ${reason.replace(/\s+/g, ' ').slice(0, 160)}` });
    });

    clearTimeout(timer);
    timer = setTimeout(() => {
      if (info.status !== 'starting') return;
      stop(false);
      set({ status: 'error', error: 'Tunnel tidak tersambung dalam 60 detik. Jaringan mungkin memblokir Cloudflare; coba jaringan/VPN lain atau pakai Jendela playlist.' });
    }, START_TIMEOUT_MS);
    return info;
  }

  function stop(report = true) {
    stopping = true;
    clearTimeout(timer);
    const proc = child;
    child = null;
    if (proc) { try { proc.kill(); } catch {} }
    if (report) set({ status: 'off', url: '', error: '' });
  }

  return { start, stop, getInfo: () => ({ ...info }) };
}
