#!/usr/bin/env node
// Server Kantor Agent untuk Node ≥ 18 (tanpa dependensi npm). Setara dengan public/index.php (PHP) — dicek bin/parity.mjs.
//   /kerja  /kerja/api/state  /kerja/api/ping  /kerja/assets/<file.js>
// Read-only: hanya membaca transkrip Claude Code project (ringkasan tool_use; isi tool_result tidak pernah dibaca).
// Biasanya dijalankan lewat bin/kantor.sh start. Variabel lingkungan:
//   KANTOR_PROJECT  folder project (default: folder kerja saat ini)   KANTOR_STORAGE  folder cache/pid (opsional)
//   KANTOR_PORT     port (default 8788)   KANTOR_BIND  alamat (default 127.0.0.1)   KANTOR_ALLOWED_HOSTS  host tambahan
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Butuh Node ≥ 18 (terpasang ${process.versions.node}).`);
  process.exit(1);
}

const RUNTIME = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PUBLIC = path.join(RUNTIME, 'public');
let PROJECT;
try {
  PROJECT = fs.realpathSync(process.env.KANTOR_PROJECT || process.cwd());
} catch {
  console.error(`[kantor] folder project tidak ditemukan: ${process.env.KANTOR_PROJECT}`);
  process.exit(1);
}
const STORAGE = process.env.KANTOR_STORAGE ? path.resolve(process.env.KANTOR_STORAGE) : null;
const { loadConfig } = await import(new URL('../lib/node/config.mjs', import.meta.url));
const { buildState } = await import(new URL('../lib/node/office.mjs', import.meta.url));
const { pageConfig, hostAllowed, SECURITY_HEADERS } = await import(new URL('../lib/node/http.mjs', import.meta.url));

if (STORAGE) {
  try {
    fs.mkdirSync(path.join(STORAGE, 'cache'), { recursive: true });
  } catch {
    /* cache opsional */
  }
}
const PROJECT_ID = crypto.createHash('md5').update(PROJECT).digest('hex').slice(0, 12);
const extraHosts = String(process.env.KANTOR_ALLOWED_HOSTS || '');

const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
// setara JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS (karakter ini hanya muncul di dalam string JSON): aman di <script>
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&'\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const rawurldecode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%2B'));
  } catch {
    return null;
  }
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Metode tidak didukung');
  if (!hostAllowed(req.headers.host, extraHosts)) return send(res, 421, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Host tidak dikenal');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Permintaan tidak valid');
  }
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/index.php') return send(res, 302, { Location: '/kerja' }, '');
  if (p === '/kerja/api/ping') {
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ app: 'kantor-agent', project: PROJECT_ID, runtime: 'node' }));
  }
  // config dibaca per permintaan supaya perubahan .claude/kantor-agent.json langsung terpakai
  const cfg = loadConfig(RUNTIME, PROJECT);
  if (p === '/kerja') {
    const page = fs.readFileSync(path.join(RUNTIME, 'views', 'page.html'), 'utf8');
    const html = page.replace(/\{\{TITLE\}\}|\{\{CONFIG_SCRIPT\}\}/g, (m) => (m === '{{TITLE}}'
      ? htmlEsc(cfg.title)
      : `<script>window.KANTOR = ${scriptJson(pageConfig(cfg))};</script>`));
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html);
  }
  if (p === '/kerja/api/state') {
    const state = buildState({ projectDir: PROJECT, storageDir: STORAGE, cfg, now: Date.now() });
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(state));
  }
  if (p.startsWith('/kerja/assets/')) {
    const rel = rawurldecode(p.slice('/kerja/assets/'.length));
    if (rel === null || rel.includes('\0')) return send(res, 404, {}, '');
    let base;
    let f;
    let st;
    try {
      base = fs.realpathSync(path.join(PUBLIC, 'assets'));
      f = fs.realpathSync(path.join(PUBLIC, 'assets', rel));
      st = fs.statSync(f);
    } catch {
      return send(res, 404, {}, '');
    }
    if (!f.startsWith(base + path.sep) || !st.isFile() || path.extname(f).toLowerCase() !== '.js') return send(res, 404, {}, '');
    const etag = `"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`;
    const h = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ETag: etag };
    if (req.headers['if-none-match'] === etag) return send(res, 304, h, '');
    return send(res, 200, { ...h, 'Content-Length': String(st.size) }, req.method === 'HEAD' ? '' : fs.readFileSync(f));
  }
  return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Tidak ditemukan');
}

const port = Number(process.env.KANTOR_PORT || 8788);
const bind = process.env.KANTOR_BIND || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[kantor] port tidak valid: ${process.env.KANTOR_PORT}`);
  process.exit(1);
}
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`[kantor] ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
    if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Kesalahan server');
    else res.end();
  });
});
server.on('error', (e) => {
  console.error(`[kantor] server gagal: ${e.code === 'EADDRINUSE' ? `port ${port} sudah dipakai` : e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});
server.listen(port, bind, () => console.log(`Kantor Agent: http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/kerja  (Node ${process.versions.node})`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // koneksi keep-alive dari polling browser
    setTimeout(() => process.exit(0), 800).unref();
  });
}
