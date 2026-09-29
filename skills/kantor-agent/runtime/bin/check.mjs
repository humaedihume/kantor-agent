#!/usr/bin/env node
// Pemeriksaan cepat server yang sedang berjalan (Node ≥ 18, tanpa Playwright): halaman, JSON state, header, 404.
//   node bin/check.mjs http://127.0.0.1:8788      → keluar 0 bila semua lolos
const base = (process.argv[2] || `http://127.0.0.1:${process.env.KANTOR_PORT || 8788}`).replace(/\/+$/, '').replace(/\/kerja$/, '');
const bad = [];
const good = [];
const t = (name, cond, extra = '') => (cond ? good : bad).push(extra ? `${name} (${extra})` : name);
const get = (p) => fetch(base + p, { redirect: 'manual' });

try {
  const page = await get('/kerja');
  const html = await page.text();
  t('/kerja → 200', page.status === 200, String(page.status));
  t('header X-Robots-Tag noindex', /noindex/.test(page.headers.get('x-robots-tag') || ''));
  t('header Referrer-Policy no-referrer', page.headers.get('referrer-policy') === 'no-referrer');
  t('header Content-Security-Policy', /default-src 'self'/.test(page.headers.get('content-security-policy') || ''));
  const m = /window\.KANTOR = (.*?);<\/script>/s.exec(html);
  let cfg = null;
  try {
    cfg = m ? JSON.parse(m[1]) : null;
  } catch {
    cfg = null;
  }
  t('window.KANTOR terbaca', cfg !== null && Array.isArray(cfg.team) && cfg.team.length === 4);
  const r = await get('/kerja/api/state');
  const s = await r.json().catch(() => null);
  t('/kerja/api/state → JSON', r.status === 200 && s && s.app === 'kantor-agent', String(r.status));
  if (s) {
    for (const k of ['ketua', 'team', 'freelancers', 'feed', 'runs', 'stats']) t(`state.${k} ada`, k in s);
    const txt = JSON.stringify(s);
    t('tidak ada token sk-… / ghp_… yang lolos redaksi', !/\bsk-(?!•)[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}/.test(txt));
    const busy = s.team.filter((m2) => m2.state === 'bekerja').map((m2) => m2.name);
    console.log(`  ${s.project}: transkrip ${s.transcripts ? 'ada' : 'belum ada'} · ${s.ketua.name} ${s.ketua.state} · tim bekerja: ${busy.join(', ') || '—'} · freelancer: ${s.freelancers.length} · ${s.stats.total} subagent (7 hari)`);
  }
  t('/kerja/assets/kantor.js → 200', (await get('/kerja/assets/kantor.js')).status === 200);
  for (const p of ['/kerja/assets/..%2F..%2Fdefaults.json', '/defaults.json', '/kerja/tidak-ada']) t(`404 ${p}`, (await get(p)).status === 404);
} catch (e) {
  bad.push(`tidak bisa terhubung ke ${base}: ${e.cause?.code || e.message}`);
}
for (const g of good) console.log(`  ok    ${g}`);
for (const b of bad) console.log(`  GAGAL ${b}`);
console.log(bad.length ? `GAGAL (${bad.length})` : `OK (${good.length} pemeriksaan) — buka ${base}/kerja`);
process.exit(bad.length ? 1 : 0);
