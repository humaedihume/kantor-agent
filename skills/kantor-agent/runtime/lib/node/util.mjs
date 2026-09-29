// Bantuan agar server Node berperilaku sama dengan PHP (trim, strlen multibyte, strcmp, glob, waktu, redaksi).
// Setiap perubahan perilaku di lib/php/*.php harus dicerminkan di sini dan diuji dengan bin/parity.mjs.
import fs from 'node:fs';
import path from 'node:path';

const PHP_TRIM = ' \t\n\r\0\x0B';

export function phpTrim(s, chars = PHP_TRIM) {
  s = String(s);
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function phpLtrim(s, chars = PHP_TRIM) {
  s = String(s);
  let a = 0;
  while (a < s.length && chars.includes(s[a])) a++;
  return s.slice(a);
}
// mb_strlen / mb_substr = titik kode (bukan unit UTF-16)
export function mbLen(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}
export function clip(s, n) {
  s = String(s);
  if (mbLen(s) <= n) return s;
  return `${Array.from(s).slice(0, n - 1).join('')}…`;
}
// strcmp PHP: urutan byte UTF-8
export function strcmp(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) < 0 ? -1 : 1;
}
export const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const isObj = (v) => v !== null && typeof v === 'object';
export const isPlainObj = (v) => isObj(v) && !Array.isArray(v);
// foreach PHP atas array/objek JSON
export const values = (v) => (Array.isArray(v) ? v : isPlainObj(v) ? Object.values(v) : []);
export const nowMs = () => Date.now();

export function mtimeSec(f) {
  try {
    return Math.floor(fs.statSync(f).mtimeMs / 1000);
  } catch {
    return 0;
  }
}
export function isFile(f) {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}
export function isDir(f) {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return false;
  }
}
export function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}
// glob('<dir>/*<suffix>') PHP: tanpa entri tersembunyi, terurut byte
export function globDir(dir, suffix) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith('.') && n.endsWith(suffix) && n.length > suffix.length)
    .sort(strcmp).map((n) => path.join(dir, n));
}
export const splitR = (s) => String(s).split(/\r\n|[\n\x0b\x0c\r\x85\u2028\u2029]/);
export const basename = (p, ext = '') => {
  const b = path.basename(p);
  return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
};

// Waktu transkrip ("2026-09-29T03:04:05.678Z") → milidetik epoch UTC; null bila formatnya tidak dikenal.
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
export function tsMs(s) {
  if (typeof s !== 'string') return null;
  const m = TS.exec(s);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  let off = 0;
  if (m[8] !== 'Z') off = (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6))) * 60000;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) + ms - off;
}
// milidetik epoch → "2026-09-29T03:04:05.678Z"
export function isoMs(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`;
}

export function redact(s) {
  s = String(s);
  s = s.replace(/(pass(word)?|sandi|secret|token|api[_-]?key)(["'\t\n\x0b\f\r ]*[:=][\t\n\x0b\f\r ]*)([^\t\n\x0b\f\r ]+)/gi, '$1$3•••');
  s = s.replace(/--login=['"]?[^'"\t\n\x0b\f\r ]+/g, '--login=•••');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-•••');
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '•••');
  s = s.replace(/\b[a-f0-9]{40,}\b/gi, '•••');
  // alamat email & URL dengan kredensial (user:pass@host)
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '•••@•••');
  return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\/\t\n\x0b\f\r :@]+:[^\/\t\n\x0b\f\r @]+@/gi, '$1•••@');
}

export function firstLine(s) {
  for (let l of splitR(s)) {
    l = phpTrim(l.replace(/[#*`>|_]+/g, ' '));
    if (l !== '') return l.replace(/[ \t\n\x0b\f\r]+/g, ' ');
  }
  return '';
}
// teks satu baris yang aman ditampilkan: baris pertama, diredaksi sebelum & sesudah dipotong
export const safeLine = (s, n) => clip(redact(firstLine(redact(String(s)))), n);
// teks alat (tanpa membuang karakter markdown): satu baris, diredaksi sebelum & sesudah dipotong
export const oneLine = (s, n) => clip(redact(phpTrim(redact(String(s)).replace(/[\t\n\x0b\f\r]+/g, ' '))), n);

// hash deterministik (sama dengan PHP): h = (h*31 + byte) mod 2^32
export function hash(s) {
  let h = 7;
  for (const b of Buffer.from(String(s), 'utf8')) h = (h * 31 + b) % 4294967296;
  return h;
}
