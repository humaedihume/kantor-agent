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
const AG = await import(new URL('../lib/node/agents.mjs', import.meta.url));
const ORG = await import(new URL('../lib/node/org.mjs', import.meta.url));
const BRAND = await import(new URL('../lib/node/brand.mjs', import.meta.url));
const OPS = await import(new URL('../lib/node/ops.mjs', import.meta.url));
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

const json = (res, status, v) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(v));
const readBody = (req) => new Promise((ok, bad) => {
  let n = 0; const parts = [];
  req.on('data', (c) => { n += c.length; if (n > 1000000) { bad(new Error('Terlalu besar')); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { bad(new Error('JSON tidak valid')); } });
  req.on('error', bad);
});
// perubahan hanya dari komputer ini (bukan lewat tunnel publik) + header khusus (cegah CSRF)
const localHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ''));

async function agentApi(req, res, p) {
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (write && (!localHost(req.headers.host) || req.headers['x-kantor'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return json(res, 403, { error: 'Perubahan hanya boleh dari http://127.0.0.1 di komputer ini' });
  }
  try {
    if (p === '/kerja/api/agents' && req.method === 'GET') return json(res, 200, { dir: AG.agentsDir(), projectDir: AG.projectAgentsDir(), agents: AG.listAgents() });
    if (p === '/kerja/api/agents' && req.method === 'POST') {
      const b = await readBody(req);
      AG.writeAgent(b.slug, b.content, { create: true });
      return json(res, 201, { ok: true });
    }
    const m = /^\/kerja\/api\/agents\/([^/]+)$/.exec(p);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        const c = AG.readAgent(slug);
        return c === null ? json(res, 404, { error: 'Tidak ditemukan' }) : json(res, 200, { slug, content: c });
      }
      if (req.method === 'PUT') { const b = await readBody(req); AG.writeAgent(slug, b.content, { create: false }); return json(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { AG.deleteAgent(slug); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && req.url.includes('kantor=1')) { AG.adoptAgent(slug); return json(res, 200, { ok: true }); }
    }
    if (p === '/kerja/api/roster') {
      if (req.method === 'GET') {
        const cfg = loadConfig(RUNTIME, PROJECT);
        return json(res, 200, { ketua: cfg.ketua, team: cfg.team, agents: cfg.agents, freelancers: cfg.freelancers, file: AG.globalConfigFile() });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const g = AG.readGlobalConfig();
        g.names = { ...(g.names || {}), ketua: b.ketua, team: b.team, freelancers: b.freelancers };
        g.agents = b.agents;
        AG.writeGlobalConfig(g);
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/kerja/api/org') {
      if (req.method === 'GET') return json(res, 200, { ...ORG.readOrg(), file: ORG.orgFile() });
      if (req.method === 'PUT') return json(res, 200, ORG.writeOrg(await readBody(req)));
    }
    // report berisi info internal perusahaan: hanya bisa dibaca dari komputer ini
    if (p.startsWith('/kerja/api/reports')) {
      if (!localHost(req.headers.host)) return json(res, 403, { error: 'Report hanya bisa dibuka dari komputer ini' });
      if (p === '/kerja/api/reports' && req.method === 'GET') return json(res, 200, { dir: ORG.reportsDir(), types: ORG.REPORT_TYPES, reports: ORG.listReports() });
      const r = /^\/kerja\/api\/reports\/([a-z0-9-]+)$/.exec(p);
      if (r && req.method === 'GET') {
        const rep = ORG.getReport(r[1]);
        return rep ? json(res, 200, rep) : json(res, 404, { error: 'Tidak ditemukan' });
      }
      if (r && req.method === 'PUT') {
        const b = await readBody(req);
        return json(res, 200, ORG.decideReport(r[1], b.decision, b.note));
      }
    }
    return json(res, 405, { error: 'Metode tidak didukung' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

// ---- Brand Kit (hanya dari komputer ini)
const readRaw = (req, max) => new Promise((ok, bad) => {
  let n = 0; const parts = [];
  req.on('data', (c) => { n += c.length; if (n > max) { bad(new Error('File terlalu besar (maks 25 MB)')); req.destroy(); } else parts.push(c); });
  req.on('end', () => ok(Buffer.concat(parts)));
  req.on('error', bad);
});
async function brandApi(req, res, p) {
  if (!localHost(req.headers.host)) return json(res, 403, { error: 'Brand Kit hanya bisa dibuka dari komputer ini' });
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (write && req.headers['x-kantor'] !== '1') return json(res, 403, { error: 'Permintaan ditolak' });
  try {
    // file aset (gambar, font, pdf…) — SVG/HTML tidak dijalankan sebagai halaman
    const fa = /^\/kerja\/brand\/aset\/(.+)$/.exec(p);
    if (fa && req.method === 'GET') {
      const f = BRAND.assetPath(PROJECT, decodeURIComponent(fa[1]));
      if (!f || !fs.existsSync(f)) return send(res, 404, {}, '');
      const type = BRAND.ASSET_TYPES[path.extname(f).toLowerCase()];
      return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" }, fs.readFileSync(f));
    }
    if (p === '/kerja/api/brand') {
      if (req.method === 'GET') {
        const md = BRAND.readKit(PROJECT);
        return json(res, 200, { dir: BRAND.brandDir(PROJECT), content: md, sections: BRAND.sections(md), assets: BRAND.listAssets(PROJECT), questions: BRAND.readQuestions(PROJECT) });
      }
      if (req.method === 'PUT') { BRAND.writeKit(PROJECT, (await readBody(req)).content); return json(res, 200, { ok: true }); }
    }
    const ua = /^\/kerja\/api\/brand\/aset\/(.+)$/.exec(p);
    if (ua) {
      const f = BRAND.assetPath(PROJECT, decodeURIComponent(ua[1]));
      if (!f) return json(res, 400, { error: 'Nama atau jenis file tidak didukung (pakai huruf, angka, spasi, - _ . dan ekstensi png/jpg/svg/pdf/font/…)' });
      if (req.method === 'PUT') {
        const buf = await readRaw(req, 25 * 1024 * 1024);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, buf);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        // dipindah ke brand-kit/aset-terhapus/ (bisa dipulihkan)
        const trash = path.join(BRAND.brandDir(PROJECT), 'aset-terhapus');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(f, path.join(trash, `${Date.now()}-${path.basename(f)}`));
        return json(res, 200, { ok: true });
      }
    }
    // isi satu bagian dengan teks biasa
    if (p === '/kerja/api/brand/bagian' && req.method === 'PUT') {
      const b = await readBody(req);
      BRAND.setSection(PROJECT, b.title, b.text);
      return json(res, 200, { ok: true });
    }
    // baca teks dari file (txt/md/csv/docx) tanpa menyimpannya — hasilnya dimasukkan ke kotak teks bagian
    if (p === '/kerja/api/brand/baca' && req.method === 'POST') {
      const name = String(req.headers['x-nama-file'] || '');
      const text = BRAND.extractText(await readRaw(req, 25 * 1024 * 1024), decodeURIComponent(name));
      return json(res, 200, { text });
    }
    const qa = /^\/kerja\/api\/brand\/pertanyaan\/([a-z0-9]+)$/.exec(p);
    if (qa && req.method === 'PUT') return json(res, 200, BRAND.answerQuestion(PROJECT, qa[1], (await readBody(req)).answer));
    return json(res, 405, { error: 'Metode tidak didukung' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

// ---- Operasional: task, delegasi, QC, chat internal, analitik (data internal: hanya dari komputer ini)
async function opsApi(req, res, p) {
  if (!localHost(req.headers.host)) return json(res, 403, { error: 'Data operasional hanya bisa dibuka dari komputer ini' });
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (write && (req.headers['x-kantor'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json'))) return json(res, 403, { error: 'Permintaan ditolak' });
  const url = new URL(req.url, 'http://localhost');
  const org = ORG.readOrg();
  try {
    const b = write ? await readBody(req) : {};
    const by = String(b.by || org.ceo.name || 'CEO');
    if (req.method === 'GET') {
      if (p === '/kerja/api/ops/meta') return json(res, 200, { statuses: OPS.STATUSES, priorities: OPS.PRIORITIES, sub_statuses: OPS.SUB_STATUSES, stages: OPS.STAGES, checklists: OPS.CHECKLISTS, stickers: OPS.STICKERS, moods: OPS.MOODS, ceo: org.ceo.name, dir: OPS.opsDir() });
      if (p === '/kerja/api/ops/overview') return json(res, 200, OPS.overview(org));
      if (p === '/kerja/api/ops/org') return json(res, 200, OPS.orgChart(org));
      if (p === '/kerja/api/ops/analytics') return json(res, 200, OPS.analytics(org));
      if (p === '/kerja/api/ops/tasks') return json(res, 200, { tasks: OPS.listTasks() });
      if (p === '/kerja/api/ops/rooms') return json(res, 200, { rooms: OPS.listRooms(org) });
      if (p === '/kerja/api/ops/chat') return json(res, 200, { messages: OPS.readRoom(url.searchParams.get('room') || '') });
      const t = /^\/kerja\/api\/ops\/tasks\/(TASK-\d+)$/.exec(p);
      if (t) { const x = OPS.getTask(t[1]); return x ? json(res, 200, x) : json(res, 404, { error: 'Tidak ditemukan' }); }
    }
    if (p === '/kerja/api/ops/tasks' && req.method === 'POST') return json(res, 201, OPS.createTask(b, by));
    if (p === '/kerja/api/ops/chat' && req.method === 'POST') return json(res, 201, OPS.postMessage({ ...b, from: by, role: b.role || 'CEO' }));
    if (p === '/kerja/api/ops/agents' && req.method === 'PUT') return json(res, 200, OPS.setAgentStatus(b.name, b.active, by, b.reason));
    const m = /^\/kerja\/api\/ops\/tasks\/(TASK-\d+)(?:\/(subtasks|submit|review|resolve))?$/.exec(p);
    if (m && write) {
      if (!m[2] && req.method === 'PUT') return json(res, 200, OPS.updateTask(m[1], b, by));
      if (m[2] === 'subtasks') return json(res, 200, OPS.upsertSubtask(m[1], b, by));
      if (m[2] === 'submit') return json(res, 200, OPS.submitForReview(m[1], by, b.note));
      if (m[2] === 'review') return json(res, 200, OPS.review(m[1], b, by));
      if (m[2] === 'resolve') return json(res, 200, OPS.resolveRevision(m[1], by, b.note));
    }
    return json(res, 405, { error: 'Metode tidak didukung' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

async function handle(req, res) {
  if (!hostAllowed(req.headers.host, extraHosts)) return send(res, 421, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Host tidak dikenal');
  const p0 = (req.url || '').split('?')[0].replace(/\/+$/, '');
  const PAGES = { '/kerja/agen': 'agen.html', '/kerja/report': 'report.html', '/kerja/brand': 'brand.html', '/kerja/ops': 'ops.html' };
  if (p0.startsWith('/kerja/api/ops/')) return opsApi(req, res, p0);
  if (p0.startsWith('/kerja/api/brand') || p0.startsWith('/kerja/brand/aset/')) return brandApi(req, res, p0);
  if (p0 === '/kerja/gedung' || p0 === '/kerja/klasik') return send(res, 301, { Location: '/kerja' }, '');
  if (PAGES[p0]) {
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, fs.readFileSync(path.join(RUNTIME, 'views', PAGES[p0])));
  }
  if (p0.startsWith('/kerja/api/agents') || p0 === '/kerja/api/roster' || p0 === '/kerja/api/org' || p0.startsWith('/kerja/api/reports')) return agentApi(req, res, p0);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Metode tidak didukung');
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
  const lantai = Math.max(1, parseInt(url.searchParams.get('lantai') || '1', 10) || 1);
  const cfg = ORG.floorConfig(loadConfig(RUNTIME, PROJECT), ORG.readOrg(), lantai);
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
