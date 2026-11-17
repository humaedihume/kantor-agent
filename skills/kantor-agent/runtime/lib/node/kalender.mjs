// Kalender kerja Kelana: jadwal posting, campaign, acara pelanggan, meeting, kegiatan operasional, ditambah deadline task/subtask
// yang diambil otomatis dari sistem task. Data manual disimpan di <kantor>/kantor/ops/calendar.json (ikut tersinkron GitHub).
// Kalender hanya penjadwalan & status: sistem TIDAK memposting ke media sosial; "Tayang" dicatat orang yang memposting.
import fs from 'node:fs';
import path from 'node:path';
import { opsDir, listTasks } from './ops.mjs';

export const CAL_TYPES = { posting: 'Posting', campaign: 'Campaign', acara: 'Acara pelanggan', meeting: 'Meeting', operasional: 'Operasional', deadline: 'Deadline', tugas: 'Tugas', lainnya: 'Lainnya' };
export const CAL_STATUS = { rencana: 'Rencana', dikerjakan: 'Dikerjakan', 'menunggu izin': 'Menunggu izin CEO', siap: 'Siap', selesai: 'Selesai / tayang', batal: 'Batal' };
export const CAL_PLATFORMS = ['Instagram', 'TikTok', 'Threads', 'WhatsApp Business', 'Website'];
export const CAL_REPEAT = { '': 'Tidak berulang', weekly: 'Tiap minggu', monthly: 'Tiap bulan' };

const file = () => path.join(opsDir(), 'calendar.json');
const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const line = (v, max = 120) => str(v, max).replace(/\s+/g, ' ');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => (DATE.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : '');
const time = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
const nowIso = () => new Date().toISOString();
const url = (v) => (/^https?:\/\/[^\s]{3,500}$/i.test(String(v || '').trim()) ? String(v).trim() : '');

// jadwal tetap yang sudah diputuskan CEO / aturan kantor (diisi sekali saat file belum ada)
const SEED = [
  { title: 'Weekly meeting HRD: laporan mingguan ke CEO', date: '2026-11-21', time: '12:00', type: 'meeting', division: 'Direksi & HRD', owner: 'HRD', repeat: 'weekly', notes: 'Setiap Sabtu 12.00 (jadwal report HRD).' },
  { title: 'Monthly meeting HRD: evaluasi bulanan', date: '2026-12-01', time: '09:00', type: 'meeting', division: 'Direksi & HRD', owner: 'HRD', repeat: 'monthly', notes: 'Setiap tanggal 1 pukul 09.00 (jadwal report HRD).' },
  { title: 'Gajian / honor rutin', date: '2026-12-12', type: 'operasional', division: 'Finance', owner: 'Lestari', repeat: 'monthly', notes: 'Tanggal 12 tiap bulan (keputusan CEO 2026-11-16). Persetujuan pembayaran mengikuti SOP-FIN-02.' },
  { title: 'Rencana campaign bulan berikutnya diajukan ke CEO', date: '2026-11-25', type: 'campaign', division: 'Marketing', owner: 'Bambang', repeat: 'monthly', needs_ceo: true, notes: 'Paling lambat tanggal 25 (aturan campaign bulanan). Konten harga/promo wajib izin CEO.' },
  { title: 'Inventarisasi aset & stock opname pertama selesai', date: '2026-11-30', type: 'operasional', division: 'Finance', owner: 'Fajar', notes: 'Batas: sebelum 30-11-2026 (keputusan CEO). Dasar: SOP-FIN-13 dan SOP-FIN-14.' },
];

function read() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); if (Array.isArray(j.events)) return j; } catch { /* belum ada */ }
  const j = { events: [] };
  SEED.forEach((e, i) => j.events.push(normalize({ ...e, id: `CAL-${String(i + 1).padStart(3, '0')}`, status: 'rencana', source: 'sistem', created: nowIso(), history: [{ at: nowIso(), by: 'Sistem', action: 'Jadwal tetap dibuat', note: '' }] })));
  write(j);
  return j;
}
function write(j) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
  for (let i = 0; i < 8; i += 1) {
    try { fs.renameSync(tmp, file()); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  fs.writeFileSync(file(), fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
}
function normalize(e) {
  return {
    id: e.id, title: line(e.title, 160), date: date(e.date), time: time(e.time), end_time: time(e.end_time), end_date: date(e.end_date),
    type: CAL_TYPES[e.type] ? e.type : 'lainnya', status: CAL_STATUS[e.status] ? e.status : 'rencana',
    division: line(e.division, 60), owner: line(e.owner, 60), platform: CAL_PLATFORMS.includes(e.platform) ? e.platform : line(e.platform, 40),
    notes: str(e.notes, 2000), link: url(e.link), task: /^TASK-\d{3,6}$/.test(String(e.task || '')) ? e.task : '',
    needs_ceo: !!e.needs_ceo, approved_by: line(e.approved_by, 60), repeat: CAL_REPEAT[e.repeat] !== undefined ? e.repeat : '', until: date(e.until),
    source: line(e.source, 40) || 'manual', created: e.created || nowIso(), updated: e.updated || e.created || nowIso(), history: Array.isArray(e.history) ? e.history.slice(-40) : [],
  };
}
const nextId = (j) => `CAL-${String(j.events.reduce((m, e) => Math.max(m, Number(/^CAL-(\d+)$/.exec(e.id)?.[1] || 0)), 0) + 1).padStart(3, '0')}`;

export function addEvent(b, by = 'CEO') {
  const j = read();
  const title = line(b.title, 160);
  if (!title) throw new Error('Judul jadwal wajib diisi');
  if (!date(b.date)) throw new Error('Tanggal wajib diisi (YYYY-MM-DD)');
  if (b.end_date && date(b.end_date) < date(b.date)) throw new Error('Tanggal selesai tidak boleh sebelum tanggal mulai');
  const e = normalize({ ...b, id: nextId(j), status: 'rencana', source: line(by, 40) || 'manual', created: nowIso(), history: [{ at: nowIso(), by: line(by, 60), action: 'Jadwal dibuat', note: '' }] });
  if (e.type === 'posting' && !e.platform) throw new Error('Pilih platform untuk jadwal posting');
  j.events.push(e);
  write(j);
  return e;
}

// status "siap" untuk konten yang wajib izin CEO hanya boleh diberikan CEO (isCeo)
export function updateEvent(id, b, by = 'CEO', isCeo = false) {
  const j = read();
  const e = j.events.find((x) => x.id === id);
  if (!e) throw new Error('Jadwal tidak ditemukan');
  const changes = [];
  for (const k of ['title', 'date', 'time', 'end_time', 'end_date', 'type', 'division', 'owner', 'platform', 'notes', 'link', 'task', 'repeat', 'until']) {
    if (b[k] === undefined) continue;
    const n = normalize({ ...e, [k]: b[k] })[k];
    if (n !== e[k]) { e[k] = n; changes.push(k); }
  }
  if (b.needs_ceo !== undefined && !!b.needs_ceo !== e.needs_ceo) { e.needs_ceo = !!b.needs_ceo; if (!e.needs_ceo) e.approved_by = ''; changes.push('izin CEO'); }
  if (b.status !== undefined && b.status !== e.status) {
    if (!CAL_STATUS[b.status]) throw new Error(`Status: ${Object.keys(CAL_STATUS).join(', ')}`);
    if (e.needs_ceo && !e.approved_by && ['siap', 'selesai'].includes(b.status)) {
      if (!isCeo) throw new Error('Jadwal ini wajib izin CEO: status Siap/Selesai hanya bisa diberikan CEO');
      e.approved_by = line(by, 60);
    }
    changes.push(`status ${e.status}→${b.status}`);
    e.status = b.status;
  }
  if (!changes.length) return e;
  e.updated = nowIso();
  e.history = [...e.history, { at: e.updated, by: line(by, 60), action: `Diubah: ${changes.join(', ')}`, note: str(b.note, 500) }].slice(-40);
  write(j);
  return e;
}

function* occurrences(e, from, to) {
  if (!e.date) return;
  if (!e.repeat) { if (e.date <= to && (e.end_date || e.date) >= from) yield e.date; return; }
  const last = e.until && e.until < to ? e.until : to;
  const start = new Date(`${e.date}T00:00:00Z`);
  if (e.repeat === 'weekly') {
    const t = new Date(start);
    while (t.toISOString().slice(0, 10) < from) t.setUTCDate(t.getUTCDate() + 7);
    for (; t.toISOString().slice(0, 10) <= last; t.setUTCDate(t.getUTCDate() + 7)) yield t.toISOString().slice(0, 10);
  } else if (e.repeat === 'monthly') {
    const dom = Number(e.date.slice(8));
    let y = start.getUTCFullYear(); let m = start.getUTCMonth();
    for (let n = 0; n < 600; n += 1, m += 1) {
      if (m > 11) { m = 0; y += 1; }
      const d = new Date(Date.UTC(y, m, Math.min(dom, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
      if (d > last) break;
      if (d >= from) yield d;
    }
  }
}

export function listRange(from, to) {
  const f = date(from); const t = date(to);
  if (!f || !t) throw new Error('Pakai ?from=YYYY-MM-DD&to=YYYY-MM-DD');
  if (Date.parse(t) - Date.parse(f) > 400 * 86400e3) throw new Error('Rentang maksimal 400 hari');
  const out = [];
  for (const e of read().events) for (const d of occurrences(e, f, t)) out.push({ ...e, history: undefined, date: d, key: e.repeat ? `${e.id}@${d}` : e.id, recurring: !!e.repeat });
  // deadline task & subtask yang masih berjalan, diambil langsung dari sistem task
  for (const k of listTasks()) {
    if (['COMPLETED', 'CANCELLED', 'APPROVED'].includes(k.status)) continue;
    if (k.deadline && k.deadline >= f && k.deadline <= t) out.push({ key: `task:${k.id}`, id: '', auto: true, date: k.deadline, title: `${k.id} ${k.title}`, type: 'deadline', status: k.status, division: k.division, owner: k.pic, task: k.id, platform: '', notes: '', time: '' });
    for (const s of k.subtasks || []) {
      if (s.status === 'DONE' || !s.deadline || s.deadline < f || s.deadline > t || s.deadline === k.deadline) continue;
      out.push({ key: `sub:${k.id}:${s.no}`, id: '', auto: true, date: s.deadline, title: `${k.id} #${s.no} ${s.title}`, type: 'tugas', status: s.status, division: k.division, owner: s.agent, task: k.id, platform: '', notes: '', time: '' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title));
}
