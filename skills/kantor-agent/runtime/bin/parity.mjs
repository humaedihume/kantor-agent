#!/usr/bin/env node
// Uji kesetaraan server PHP (public/index.php via php -S) dan Node (bin/serve-node.mjs) pada project & transkrip yang sama.
//   node bin/parity.mjs [--project=DIR] [--php-port=8791] [--node-port=8792] [--rounds=2] [--forbid=regex …]
// Membandingkan: JSON /kerja/api/state (kecuali "now"), window.KANTOR di /kerja, /kerja/api/ping (kecuali "runtime"),
// aset + ETag, header keamanan, 404 untuk path terlarang, 421 untuk Host asing, dan tidak ada rahasia yang bocor.
// Keluar 0 bila semua sama. Kedua server dimatikan di akhir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const arg = (k, d) => process.argv.slice(2).filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3)).pop() ?? d;
const PROJECT = fs.realpathSync(arg('project', process.cwd()));
const PHP_PORT = Number(arg('php-port', 8791));
const NODE_PORT = Number(arg('node-port', 8792));
const ROUNDS = Number(arg('rounds', 2));
const FORBID = [
  /\bsk-(?!•)[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  ...process.argv.slice(2).filter((a) => a.startsWith('--forbid=')).map((a) => new RegExp(a.slice(9))),
];
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-parity-'));
const procs = [];
const problems = [];
const ok = [];
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* sudah berhenti */
    }
  }
  fs.rmSync(STORE, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: RUNTIME, env: { ...process.env, KANTOR_PROJECT: PROJECT, KANTOR_STORAGE: STORE, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => {
    err += d;
  });
  p.on('error', (e) => problems.push(`${cmd} tidak bisa dijalankan: ${e.message}`));
  procs.push(p);
  return () => err;
}
async function waitUp(base, name, errOf) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/kerja/api/ping`)).ok) return true;
    } catch {
      /* belum siap */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  problems.push(`${name} tidak siap di ${base}: ${errOf().slice(0, 400)}`);
  return false;
}
const get = (base, p, h = {}) => fetch(base + p, { redirect: 'manual', headers: h });
// fetch() tidak bisa mengganti header Host → pakai node:http
const hostGet = (port, p, host) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(0));
  req.end();
});
function diff(a, b, at = '$', ignore = new Set(), out = []) {
  if (out.length > 40) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) {
    out.push(`${at}: tipe ${ta} ≠ ${tb} (${JSON.stringify(a)?.slice(0, 80)} | ${JSON.stringify(b)?.slice(0, 80)})`);
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}: panjang ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, ignore, out);
  } else if (ta === 'object') {
    const ka = Object.keys(a).filter((k) => !(at === '$' && ignore.has(k)));
    const kb = Object.keys(b).filter((k) => !(at === '$' && ignore.has(k)));
    if (ka.join('|') !== kb.join('|')) out.push(`${at}: kunci [${ka}] ≠ [${kb}]`);
    for (const k of ka) if (Object.hasOwn(b, k)) diff(a[k], b[k], `${at}.${k}`, ignore, out);
  } else if (a !== b) out.push(`${at}: ${JSON.stringify(a)?.slice(0, 100)} ≠ ${JSON.stringify(b)?.slice(0, 100)}`);
  return out;
}
function check(name, cond, detail = '') {
  if (cond) ok.push(name);
  else problems.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const phpErr = start('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', 'public', 'public/index.php'], {});
const nodeErr = start(process.execPath, ['bin/serve-node.mjs'], { KANTOR_PORT: String(NODE_PORT), KANTOR_BIND: '127.0.0.1' });
const P = `http://127.0.0.1:${PHP_PORT}`;
const N = `http://127.0.0.1:${NODE_PORT}`;
const up = (await waitUp(P, 'PHP', phpErr)) & (await waitUp(N, 'Node', nodeErr));

if (up) {
  let sp;
  let sn;
  for (let round = 1; round <= ROUNDS; round++) {
    const [rp, rn] = await Promise.all([get(P, '/kerja/api/state'), get(N, '/kerja/api/state')]);
    sp = await rp.json();
    sn = await rn.json();
    const d = diff(sp, sn, '$', new Set(['now']));
    check(`state ronde ${round} identik (${sp.runs?.length ?? 0} run, ${sp.feed?.length ?? 0} event, ${sp.freelancers?.length ?? 0} freelancer)`, d.length === 0, `\n    ${d.slice(0, 25).join('\n    ')}`);
  }
  const raw = JSON.stringify(sp) + JSON.stringify(sn);
  for (const re of FORBID) check(`tidak ada kebocoran ${re}`, !re.test(raw), (raw.match(re) || [''])[0].slice(0, 60));

  const [hp, hn] = await Promise.all([get(P, '/kerja'), get(N, '/kerja')]);
  const [tp, tn] = [await hp.text(), await hn.text()];
  check('/kerja 200 di keduanya', hp.status === 200 && hn.status === 200, `${hp.status}/${hn.status}`);
  const cfgOf = (t) => {
    const m = /window\.KANTOR = (.*?);<\/script>/s.exec(t);
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };
  const cd = diff(cfgOf(tp), cfgOf(tn));
  check('window.KANTOR identik & valid', cfgOf(tp) !== null && cd.length === 0, cd.join('; '));
  check('<title> identik', (/<title>(.*?)<\/title>/.exec(tp) || [])[1] === (/<title>(.*?)<\/title>/.exec(tn) || [])[1]);
  for (const h of ['x-robots-tag', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'content-security-policy']) {
    check(`header ${h}`, !!hp.headers.get(h) && hp.headers.get(h) === hn.headers.get(h), `${hp.headers.get(h)} / ${hn.headers.get(h)}`);
  }
  const [pp, pn] = await Promise.all([get(P, '/kerja/api/ping'), get(N, '/kerja/api/ping')]);
  const [jp, jn] = [await pp.json(), await pn.json()];
  check('/kerja/api/ping identik (kecuali runtime)', jp.app === 'kantor-agent' && jp.project === jn.project && jp.runtime === 'php' && jn.runtime === 'node');
  const [ap, an] = await Promise.all([get(P, '/kerja/assets/kantor.js'), get(N, '/kerja/assets/kantor.js')]);
  check('/kerja/assets/kantor.js identik', ap.status === 200 && an.status === 200 && (await ap.text()) === (await an.text()));
  const etag = an.headers.get('etag');
  check('ETag sama & 304', etag === ap.headers.get('etag') && (await get(N, '/kerja/assets/kantor.js', { 'If-None-Match': etag })).status === 304
    && (await get(P, '/kerja/assets/kantor.js', { 'If-None-Match': etag })).status === 304);
  for (const bad of [
    '/kerja/assets/..%2F..%2Flib%2Fphp%2FConfig.php', '/kerja/assets/..%2Fdefaults.json', '/kerja/assets/%2e%2e/%2e%2e/defaults.json',
    '/kerja/assets/../../bin/kantor.sh', '/kerja/assets/vendor/three/LICENSE', '/kerja/api/doc?path=README.md', '/kerja/evidence/x.png',
    '/kerja/tidak-ada', '/lib/php/Config.php', '/defaults.json', '/views/page.html', '/public/index.php', '/kerja/assets/%00.js',
  ]) {
    const [bp, bn] = await Promise.all([get(P, bad), get(N, bad)]);
    check(`404 ${bad}`, bp.status === 404 && bn.status === 404, `PHP ${bp.status} / Node ${bn.status}`);
  }
  for (const [host, want] of [['jahat.contoh.test', 421], ['jahat.contoh.test:8788', 421], ['abc-def.trycloudflare.com', 200], ['localhost:8788', 200], ['192.168.1.5:8788', 200]]) {
    const [xp, xn] = await Promise.all([hostGet(PHP_PORT, '/kerja/api/ping', host), hostGet(NODE_PORT, '/kerja/api/ping', host)]);
    check(`Host ${host} → ${want}`, xp === want && xn === want, `PHP ${xp} / Node ${xn}`);
  }
  const [mp, mn] = await Promise.all([fetch(`${P}/kerja/api/state`, { method: 'POST' }), fetch(`${N}/kerja/api/state`, { method: 'POST' })]);
  check('POST ditolak (405)', mp.status === 405 && mn.status === 405, `PHP ${mp.status} / Node ${mn.status}`);
  const [rp, rn] = await Promise.all([get(P, '/'), get(N, '/')]);
  check('/ → 302 /kerja', rp.status === 302 && rn.status === 302 && rp.headers.get('location') === '/kerja' && rn.headers.get('location') === '/kerja');
}

cleanup();
for (const o of ok) console.log(`  ok   ${o}`);
for (const p of problems) console.log(`  BEDA ${p}`);
console.log(problems.length ? `PARITY GAGAL (${problems.length} masalah, ${ok.length} ok)` : `PARITY OK (${ok.length} pemeriksaan)`);
process.exit(problems.length ? 1 : 0);
