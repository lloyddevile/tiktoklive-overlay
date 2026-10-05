// Diagnosa & perbaikan otomatis koneksi ke TikTok (DNS, TCP, HTTPS, DNS-over-HTTPS).
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';

const HOST = 'www.tiktok.com';
const withTimeout = (promise, ms, label = 'timeout') => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(label), { code: 'ETIMEDOUT' })), ms))
]);

export function tcpOk(ip, port = 443, ms = 5000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host: ip, port, family: 4 });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(ms, () => done({ ok: false, why: `timeout ${ms / 1000}s` }));
    socket.on('connect', () => done({ ok: true, ms: Date.now() - started }));
    socket.on('error', error => done({ ok: false, why: error.code || error.message }));
  });
}

// Parser respons Cloudflare DNS-over-HTTPS (format JSON)
export function parseDohAnswer(json) {
  return (json?.Answer || []).filter(a => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)).map(a => a.data);
}

export async function dohResolve(host = HOST, fetchImpl = fetch) {
  const servers = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'];
  for (const server of servers) {
    try {
      const response = await fetchImpl(`${server}?name=${host}&type=A`, {
        headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000)
      });
      const ips = parseDohAnswer(await response.json());
      if (ips.length) return ips;
    } catch {}
  }
  return [];
}

export async function httpsStatus(host = HOST, agent, ms = 9000) {
  return new Promise(resolve => {
    const request = https.request({ host, path: '/', method: 'HEAD', agent, timeout: ms, headers: { 'user-agent': 'Mozilla/5.0' } }, response => {
      response.resume();
      resolve({ ok: true, status: response.statusCode });
    });
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, why: `timeout ${ms / 1000}s` }); });
    request.on('error', error => resolve({ ok: false, why: error.code || error.message }));
    request.end();
  });
}

// Agent HTTPS yang memakai IP hasil DoH (melewati DNS provider yang bermasalah)
export function makeDohAgent(ips) {
  let turn = 0;
  const lookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const ip = ips[turn++ % ips.length];
    if (options?.all) callback(null, [{ address: ip, family: 4 }]);
    else callback(null, ip, 4);
  };
  return new https.Agent({ lookup, keepAlive: true });
}

/**
 * Jalankan semua pengecekan. `extra` (opsional) = fungsi async yang mengembalikan baris tambahan
 * (dipakai Electron untuk membandingkan dengan jalur Chromium).
 * Hasil: { lines: string[], summary: string, dohIps: string[]|null }
 */
export async function diagnose({ extra, proxy } = {}) {
  const lines = [];
  let summary = '';
  let dohIps = null;

  const [sys, doh] = await Promise.all([
    withTimeout(dns.lookup(HOST, { all: true, family: 4 }), 6000, 'dns timeout').then(r => r.map(x => x.address), e => ({ error: e.code || e.message })),
    dohResolve()
  ]);
  const sysIps = Array.isArray(sys) ? sys : [];
  lines.push(`DNS sistem: ${sysIps.length ? sysIps.slice(0, 3).join(', ') : `GAGAL (${sys.error})`}`);
  lines.push(`DNS Cloudflare/Google (DoH): ${doh.length ? doh.slice(0, 3).join(', ') : 'tidak terjangkau'}`);

  const [sysTcp, dohTcp] = await Promise.all([
    sysIps.length ? tcpOk(sysIps[0]) : { ok: false, why: 'tanpa IP' },
    doh.length ? tcpOk(doh[0]) : { ok: false, why: 'tanpa IP' }
  ]);
  lines.push(`TCP:443 ke IP DNS sistem: ${sysTcp.ok ? `OK (${sysTcp.ms}ms)` : `GAGAL (${sysTcp.why})`}`);
  lines.push(`TCP:443 ke IP DoH: ${dohTcp.ok ? `OK (${dohTcp.ms}ms)` : `GAGAL (${dohTcp.why})`}`);

  const web = sysTcp.ok ? await httpsStatus(HOST, undefined, 9000) : { ok: false, why: 'dilewati' };
  lines.push(`HTTPS ke ${HOST} (jalur Node): ${web.ok ? `HTTP ${web.status}` : `GAGAL (${web.why})`}`);

  let chromium;
  if (extra) { try { chromium = await extra(); if (chromium) lines.push(chromium); } catch {} }
  const chromiumOk = typeof chromium === 'string' && /OK/.test(chromium) && !/GAGAL/.test(chromium);

  if (!sysIps.length && doh.length) { summary = 'DNS provider/PC bermasalah, tapi DNS alternatif bekerja.'; dohIps = doh; }
  else if (!sysTcp.ok && dohTcp.ok) { summary = 'IP dari DNS provider tidak bisa dihubungi, tetapi IP dari DNS alternatif bisa.'; dohIps = doh; }
  else if (!sysTcp.ok && !dohTcp.ok && (sysIps.length || doh.length)) summary = 'Provider internet/jaringan kamu memblokir koneksi ke TikTok. Pakai VPN (mode seluruh sistem), tethering HP, atau jaringan lain.';
  else if (sysTcp.ok && !web.ok) summary = 'Koneksi dasar tersambung tetapi HTTPS ke TikTok tertahan: kemungkinan antivirus/firewall (scan HTTPS) atau filter provider. Coba matikan sementara antivirus/firewall.';
  else if (web.ok && web.status === 403) summary = 'TikTok menjawab 403 untuk jalur Node (IP/perangkat dicurigai). Ganti jaringan atau pakai API key Euler Stream.';
  else if (web.ok) summary = 'Jaringan ke TikTok normal. Kemungkinan akun tidak sedang LIVE atau username salah.';
  if (chromiumOk && !web.ok) summary += ' Jalur browser (Chromium) berhasil sedangkan Node tidak: browser kamu kemungkinan memakai VPN/proxy yang tidak dipakai aplikasi.';
  if (proxy) lines.push(`Proxy yang dipakai: ${proxy.replace(/\/\/[^@/]*@/, '//***@')}`);
  return { lines, summary, dohIps };
}
