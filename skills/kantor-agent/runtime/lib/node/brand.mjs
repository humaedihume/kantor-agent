// Brand Kit: pedoman merek (BRAND-KIT.md), aset visual, dan pertanyaan brand kit untuk CEO.
// Semua disimpan di <project>/brand-kit/ supaya setiap agent yang bekerja di folder project bisa membacanya.
import fs from 'node:fs';
import path from 'node:path';

export const brandDir = (project) => path.join(project, 'brand-kit');
const kitFile = (project) => path.join(brandDir(project), 'BRAND-KIT.md');
const assetDir = (project) => path.join(brandDir(project), 'aset');
const qFile = (project) => path.join(brandDir(project), 'pertanyaan.json');

export const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.csv': 'text/csv; charset=utf-8',
  '.ai': 'application/postscript', '.psd': 'image/vnd.adobe.photoshop', '.zip': 'application/zip', '.mp4': 'video/mp4',
};
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}$/;
export function assetPath(project, name) {
  if (typeof name !== 'string' || !ASSET_NAME.test(name) || name.includes('..')) return null;
  if (!ASSET_TYPES[path.extname(name).toLowerCase()]) return null;
  return path.join(assetDir(project), name);
}

export function readKit(project) {
  try {
    return fs.readFileSync(kitFile(project), 'utf8');
  } catch {
    return '';
  }
}
export function writeKit(project, content) {
  if (typeof content !== 'string' || content.length > 500000) throw new Error('Isi brand kit tidak valid');
  fs.mkdirSync(brandDir(project), { recursive: true });
  fs.writeFileSync(kitFile(project), content.replace(/\r\n/g, '\n'), 'utf8');
}
// status tiap bagian "## Judul": diatur atau belum
export function sections(md) {
  const out = [];
  const parts = md.replace(/\r/g, '').split(/^## /m).slice(1);
  for (const p of parts) {
    const [title, ...rest] = p.split('\n');
    const body = rest.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    out.push({ title: title.trim(), set: body !== '' && !/^_\(belum diatur\)_$/.test(body) });
  }
  return out;
}

export function listAssets(project) {
  try {
    return fs.readdirSync(assetDir(project))
      .filter((n) => assetPath(project, n))
      .map((n) => {
        const st = fs.statSync(path.join(assetDir(project), n));
        return { name: n, size: st.size, updated: st.mtime.toISOString(), type: ASSET_TYPES[path.extname(n).toLowerCase()] };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ---- pertanyaan brand kit (dibuat agent/HRD saat aturan belum ada, dijawab CEO)
export function readQuestions(project) {
  try {
    const q = JSON.parse(fs.readFileSync(qFile(project), 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function writeQuestions(project, q) {
  fs.mkdirSync(brandDir(project), { recursive: true });
  fs.writeFileSync(qFile(project), `${JSON.stringify(q, null, 2)}\n`, 'utf8');
}
const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ').trim().slice(0, n) : '');

export function addQuestion(project, { section, question, options, asked_by, task }) {
  const q = readQuestions(project);
  const opts = (Array.isArray(options) ? options : []).map((o) => clip(o, 200)).filter(Boolean).slice(0, 6);
  if (!clip(question, 500) || opts.length < 2) throw new Error('Pertanyaan wajib punya teks dan minimal 2 pilihan');
  const item = {
    id: `q${Date.now().toString(36)}`,
    section: clip(section, 60) || 'Keputusan Tambahan',
    question: clip(question, 500),
    options: opts,
    asked_by: clip(asked_by, 60),
    task: clip(task, 300),
    created: new Date().toISOString(),
    status: 'menunggu',
    answer: null,
    answered: null,
  };
  q.push(item);
  writeQuestions(project, q);
  return item;
}

// jawaban CEO dicatat ke pertanyaan.json dan ditambahkan ke bagian "Keputusan Tambahan" di BRAND-KIT.md
export function answerQuestion(project, id, answer) {
  const q = readQuestions(project);
  const item = q.find((x) => x.id === id);
  if (!item) throw new Error('Pertanyaan tidak ditemukan');
  const a = clip(answer, 1000);
  if (!a) throw new Error('Pilih atau tulis jawaban');
  item.status = 'dijawab';
  item.answer = a;
  item.answered = new Date().toISOString();
  writeQuestions(project, q);
  const day = item.answered.slice(0, 10);
  const line = `- **[${item.section}]** ${item.question} → **${a}** _(diputuskan CEO ${day})_`;
  let md = readKit(project);
  if (!/^## Keputusan Tambahan/m.test(md)) md = `${md.trimEnd()}\n\n## Keputusan Tambahan\n`;
  md = md.replace(/^## Keputusan Tambahan[^\n]*\n(?:<!--[\s\S]*?-->\n)?/m, (m) => `${m}${line}\n`);
  writeKit(project, md);
  return item;
}

// ---- isi per bagian (teks biasa, tanpa perlu format Markdown)
// Mengganti isi bagian "## <title>"; petunjuk <!-- … --> di bagian itu dipertahankan. Teks kosong = "_(belum diatur)_".
export function setSection(project, title, text) {
  const t = String(title || '').trim();
  if (!t || t === 'Keputusan Tambahan') throw new Error('Bagian tidak valid');
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (body.length > 200000) throw new Error('Isi terlalu panjang');
  let md = readKit(project);
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${t}`);
  if (start < 0) {
    // bagian baru: sisipkan sebelum "Keputusan Tambahan"
    const k = lines.findIndex((l) => l.trim() === '## Keputusan Tambahan');
    const block = [`## ${t}`, body || '_(belum diatur)_', ''];
    if (k < 0) lines.push('', ...block); else lines.splice(k, 0, ...block);
    writeKit(project, lines.join('\n'));
    return;
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const hint = lines.slice(start + 1, end).join('\n').match(/<!--[\s\S]*?-->/);
  const out = [lines[start], body || '_(belum diatur)_'];
  if (hint) out.push(hint[0]);
  out.push('');
  lines.splice(start, end - start, ...out);
  writeKit(project, lines.join('\n'));
}

// ---- ambil teks dari file biasa (txt, md, csv, docx) supaya bisa langsung dimasukkan ke bagian brand kit
import zlib from 'node:zlib';
function unzipEntry(buf, wanted) {
  // cari End Of Central Directory, lalu entri bernama `wanted`
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name === wanted) {
      const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(ds, ds + csize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
export function extractText(buf, name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (['.txt', '.md', '.csv'].includes(ext)) return buf.toString('utf8').replace(/^﻿/, '');
  if (ext === '.docx') {
    const xml = unzipEntry(buf, 'word/document.xml');
    if (!xml) throw new Error('File Word tidak bisa dibaca');
    const s = xml.toString('utf8')
      .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:numPr>/g, '• ')
      .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
    return decodeXml(s).replace(/\n{3,}/g, '\n\n').trim();
  }
  return null; // pdf, gambar, dll.: disimpan sebagai lampiran (agent membacanya langsung)
}
