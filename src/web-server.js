// Server lokal kecil untuk halaman playlist (dipakai sebagai sumber Browser/Link di OBS atau TikTok LIVE Studio).
// Hanya melayani GET dan hanya mendengarkan loopback (127.0.0.1 dan ::1). Tidak ada API yang bisa mengubah apa pun.
//
// Akses lewat tunnel publik (Cloudflare) wajib memakai awalan rahasia: https://xxxx.trycloudflare.com/t/<token>/playlist
// Permintaan dari tunnel dikenali dari header `cf-connecting-ip` / `cf-ray`; permintaan lokal tidak butuh token.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const FILES = {
  '/playlist': ['playlist.html', 'text/html; charset=utf-8'],
  '/playlist.css': ['playlist.css', 'text/css; charset=utf-8'],
  '/playlist.js': ['playlist.js', 'text/javascript; charset=utf-8']
};

export function createWebServer({ getState, port = 3100, host = '127.0.0.1', log = console.log }) {
  const clients = new Set();
  const token = crypto.randomBytes(9).toString('base64url'); // berubah setiap aplikasi dijalankan
  const servers = [];
  let actualPort = 0;

  const isTunnelRequest = req => Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);

  async function handler(req, res) {
    let { pathname } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }

    const prefix = `/t/${token}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length) || '/';
    else if (isTunnelRequest(req)) { res.writeHead(404); return res.end('Tidak ditemukan'); }

    if (pathname === '/') { res.writeHead(302, { Location: 'playlist' }); return res.end(); }
    if (pathname === '/state') {
      // Dipakai halaman playlist bila SSE tidak didukung (mis. lewat Cloudflare Quick Tunnel)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(getState()));
    }
    if (pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write(`event: music:state\ndata: ${JSON.stringify(getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const entry = FILES[pathname];
    if (!entry) { res.writeHead(404); return res.end('Tidak ditemukan'); }
    try {
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      res.end(await readFile(path.join(WEB, entry[0])));
    } catch {
      res.writeHead(500); res.end('Gagal membaca berkas');
    }
  }

  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

  function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(message);
  }

  const tryListen = (server, candidate, address) => new Promise(resolve => {
    const onError = error => { server.off('listening', onListen); resolve(error.code || error.message); };
    const onListen = () => { server.off('error', onError); resolve('ok'); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(candidate, address);
  });

  // Coba port yang diminta; bila terpakai, naik satu per satu (maksimal 10 kali)
  async function start() {
    for (let candidate = port; candidate <= port + 10; candidate++) {
      const primary = http.createServer(handler);
      const result = await tryListen(primary, candidate, host);
      if (result === 'EADDRINUSE') continue;
      if (result !== 'ok') { log(`[playlist] server gagal: ${result}`); return 0; }
      servers.push(primary);
      actualPort = candidate;
      // "localhost" di sebagian aplikasi (Chromium/CEF) diterjemahkan ke ::1 (IPv6): layani juga alamat itu
      const loopback6 = http.createServer(handler);
      if (await tryListen(loopback6, candidate, '::1') === 'ok') servers.push(loopback6);
      log(`[playlist] halaman playlist: http://localhost:${actualPort}/playlist`);
      return actualPort;
    }
    log('[playlist] tidak ada port kosong (3100-3110).');
    return 0;
  }

  const base = name => (actualPort ? `http://${name}:${actualPort}/playlist` : '');
  return {
    start,
    broadcast,
    port: () => actualPort,
    token: () => token,
    url: () => base('localhost'),
    urls: () => ({ localhost: base('localhost'), loopback: base('127.0.0.1') }),
    publicUrl: baseUrl => (baseUrl ? `${baseUrl.replace(/\/$/, '')}/t/${token}/playlist` : ''),
    stop: () => { for (const server of servers) server.close(); }
  };
}
