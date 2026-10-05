// Diagnosa koneksi: jalankan dengan  node tes-koneksi.mjs  (atau klik Tes-Koneksi.cmd)
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const HOSTS = ['www.tiktok.com', 'webcast.tiktok.com', 'api.eulerstream.com', 'www.google.com'];
const T = 8000;

const tcp = (ip, family) => new Promise(resolve => {
  const t0 = Date.now();
  const s = net.connect({ host: ip, port: 443, family });
  const done = r => { s.destroy(); resolve(r); };
  s.setTimeout(T, () => done(`timeout ${T}ms`));
  s.on('connect', () => done(`OK (${Date.now() - t0}ms)`));
  s.on('error', e => done(`GAGAL ${e.code || e.message}`));
});

const handshake = host => new Promise(resolve => {
  const t0 = Date.now();
  const s = tls.connect({ host, port: 443, servername: host, timeout: T });
  const done = r => { s.destroy(); resolve(r); };
  s.on('secureConnect', () => done(`OK (${Date.now() - t0}ms)`));
  s.on('timeout', () => done(`timeout ${T}ms`));
  s.on('error', e => done(`GAGAL ${e.code || e.message}`));
});

const https = async host => {
  try {
    const r = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(T) });
    return `HTTP ${r.status}`;
  } catch (e) { return `GAGAL ${e.cause?.code || e.cause?.message || e.message}`; }
};

console.log(`Node ${process.version}`);
console.log('Proxy env:', process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '(tidak ada)', '\n');

for (const host of HOSTS) {
  console.log(`== ${host}`);
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { console.log(`  DNS      : GAGAL ${e.code || e.message}\n`); continue; }
  console.log(`  DNS      : ${addrs.map(a => a.address).join(', ')}`);
  for (const a of addrs.slice(0, 4)) console.log(`  TCP ${a.family === 6 ? 'IPv6' : 'IPv4'} : ${a.address} -> ${await tcp(a.address, a.family)}`);
  console.log(`  TLS      : ${await handshake(host)}`);
  console.log(`  HTTPS    : ${await https(host)}\n`);
}
console.log('Kirim seluruh hasil di atas ke Claude.');
