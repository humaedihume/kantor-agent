// Operasional kantor (Agent Operating Rules): task & delegasi, ruang chat internal, quality control berjenjang,
// status agent, dan analitik kinerja. Data disimpan sebagai file di <kantor>/kantor/ops/ (ikut tersinkron GitHub):
//   ops/tasks/TASK-001.json   satu task lengkap (subtask, progres, review, revisi, riwayat)
//   ops/chat/<room>.jsonl     pesan ruang chat (satu JSON per baris, hanya ditambah — tidak pernah dihapus)
//   ops/agents.json           status agent (aktif / nonaktif)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = () => {
  const p = process.env.KANTOR_PROJECT || process.cwd();
  return fs.existsSync(path.join(p, 'brand-kit')) ? p : null;
};
export const opsDir = () => {
  const p = projectDir();
  return p ? path.join(p, 'kantor', 'ops') : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'kantor-agent', 'ops');
};
const tasksDir = () => path.join(opsDir(), 'tasks');
const chatDir = () => path.join(opsDir(), 'chat');

export const STATUSES = {
  INBOX: 'Instruksi baru diterima',
  CLARIFICATION: 'Menunggu klarifikasi',
  'READY TO PLAN': 'Informasi sudah lengkap',
  PLANNING: 'Penyusunan rencana kerja',
  'WAITING APPROVAL': 'Menunggu persetujuan rencana',
  ASSIGNED: 'Tugas sudah didelegasikan',
  'IN PROGRESS': 'Sedang berlangsung',
  BLOCKED: 'Terhambat',
  'INTERNAL REVIEW': 'Diperiksa kepala sub divisi',
  'DIVISION REVIEW': 'Diperiksa kepala divisi',
  REVISION: 'Dalam revisi',
  'CEO REVIEW': 'Menunggu pemeriksaan CEO',
  APPROVED: 'Disetujui CEO',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};
export const PRIORITIES = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };
export const SUB_STATUSES = ['ASSIGNED', 'IN PROGRESS', 'BLOCKED', 'DONE', 'REVISION'];
export const STAGES = { sub: 'Subdivision Review', div: 'Division Review', ceo: 'CEO Review' };
export const CHECKLISTS = {
  self: ['Sesuai instruksi', 'Semua kebutuhan terpenuhi', 'Tidak ada kesalahan data', 'Format benar', 'Output lengkap', 'Hasil dapat digunakan'],
  sub: ['Sesuai tujuan pekerjaan', 'Informasi tepat', 'Output lengkap', 'Hasil konsisten', 'Kualitas analisis baik', 'Sesuai deadline', 'Sesuai standar & Brand Kit'],
  div: ['Kualitas keseluruhan', 'Sesuai strategi divisi', 'Konsisten antar sub divisi', 'Tidak ada kesalahan strategis', 'Tidak ada pekerjaan terlewat'],
  ceo: ['Sesuai arahan CEO', 'Siap dipakai / dipublikasikan'],
};
// tahap review → status saat masuk tahap itu, dan status berikutnya bila lolos
const STAGE_STATUS = { sub: 'INTERNAL REVIEW', div: 'DIVISION REVIEW', ceo: 'CEO REVIEW' };
const NEXT = { sub: 'DIVISION REVIEW', div: 'CEO REVIEW', ceo: 'APPROVED' };
const OPEN = (s) => !['COMPLETED', 'CANCELLED', 'APPROVED'].includes(s);

const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const line = (v, max = 120) => str(v, max).replace(/\s+/g, ' ');
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE');
const TID = /^TASK-\d{3,6}$/;

function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
  // Windows: rename bisa gagal sesaat (EPERM/EBUSY) bila file sedang dibaca server — coba ulang, lalu tulis langsung
  for (let i = 0; i < 8; i += 1) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  fs.writeFileSync(file, fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
}
const readJson = (file, fb) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fb;
  }
};

// ---------------- task
export function listTasks() {
  let files = [];
  try {
    files = fs.readdirSync(tasksDir()).filter((f) => /^TASK-\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => readJson(path.join(tasksDir(), f), null)).filter((t) => t && TID.test(t.id)).map(decorate)
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}
export function getTask(id) {
  if (!TID.test(String(id))) return null;
  const t = readJson(path.join(tasksDir(), `${id}.json`), null);
  return t ? decorate(t) : null;
}
const saveTask = (t) => {
  const { progress, overdue, queue, ...clean } = t;
  writeJson(path.join(tasksDir(), `${t.id}.json`), clean);
  return decorate(clean);
};
// progress = Σ(bobot × progres subtask) / Σ bobot — dihitung dari subtask, bukan perkiraan
function decorate(t) {
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const w = subs.reduce((a, s) => a + (Number(s.weight) || 0), 0);
  let progress = w ? Math.round(subs.reduce((a, s) => a + (Number(s.weight) || 0) * pct(s.progress), 0) / w) : 0;
  if (['APPROVED', 'COMPLETED'].includes(t.status)) progress = 100;
  const overdue = !!(t.deadline && OPEN(t.status) && t.deadline < today());
  return { ...t, progress, overdue, queue: queueOf(t) };
}
// status kerja: menunggu diambil / dikerjakan / macet (tidak ada kabar > 90 menit)
const STALE_MS = 90 * 60e3;
function queueOf(t) {
  const pend = (t.revisions || []).filter((r) => r.status === 'In Progress' && !r.asking);
  let kind = '';
  if (['INBOX', 'READY TO PLAN'].includes(t.status)) kind = 'baru';
  else if (t.status === 'REVISION' && pend.length) kind = 'revisi';
  else if (t.working && ['PLANNING', 'ASSIGNED', 'IN PROGRESS', 'CLARIFICATION', 'BLOCKED'].includes(t.status)) kind = 'kerja';
  if (!kind) return null;
  const unclaimed = kind === 'revisi' ? pend.filter((r) => !r.claimed_by) : (kind === 'baru' ? [1] : []);
  const w = t.working;
  const beat = w ? Date.parse(w.heartbeat || w.since) : 0;
  let state = 'dikerjakan';
  if (unclaimed.length) state = 'menunggu'; else if (!w || Date.now() - beat > STALE_MS) state = 'macet';
  const since = unclaimed.length ? (kind === 'revisi' ? unclaimed.map((r) => r.at).sort()[0] : (t.updated || t.created)) : (w ? w.since : t.updated);
  return { kind, state, since, heartbeat: w ? w.heartbeat : null, by: w ? w.by : [], open: kind === 'revisi' ? pend.length : 1, unclaimed: unclaimed.length };
}
function nextId() {
  let max = 0;
  try {
    for (const f of fs.readdirSync(tasksDir())) {
      const m = /^TASK-(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* belum ada */ }
  return `TASK-${String(max + 1).padStart(3, '0')}`;
}
const log = (t, by, action, note = '') => {
  t.history = [...(t.history || []), { at: nowIso(), by: line(by, 60) || 'Sistem', action: line(action, 120), note: str(note, 2000) }];
  t.updated = nowIso();
  if (t.working && !['CEO', 'Sistem', ''].includes(line(by, 60))) t.working.heartbeat = t.updated;
};

export function createTask(b, by = 'CEO') {
  const title = line(b.title, 140);
  if (!title) throw new Error('Nama pekerjaan wajib diisi');
  const priority = PRIORITIES[b.priority] ? b.priority : 'P2';
  const t = {
    id: nextId(),
    title,
    requester: line(b.requester, 60) || 'CEO',
    division: line(b.division, 60),
    subdivision: line(b.subdivision, 60),
    pic: line(b.pic, 60),
    supporting: Array.isArray(b.supporting) ? b.supporting.map((x) => line(x, 60)).filter(Boolean).slice(0, 30) : [],
    priority,
    created: nowIso(),
    updated: nowIso(),
    deadline: date(b.deadline),
    status: 'INBOX',
    description: str(b.description, 6000),
    objective: str(b.objective, 2000),
    scope: str(b.scope, 3000),
    deliverables: str(b.deliverables, 3000),
    acceptance: str(b.acceptance, 3000),
    clarification: null,
    subtasks: [],
    reviews: [],
    revisions: [],
    blockers: [],
    result: '',
    history: [],
    attachments: imgs(b.attachments),
    source: line(b.source, 20),
  };
  log(t, by, 'Instruksi dibuat', t.description);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: by, text: `Task dibuat: ${t.title}${t.deadline ? ` · deadline ${t.deadline}` : ''} · ${priority}`, task: t.id, kind: 'system' });
  const note = { from: by, text: `Instruksi baru ${t.id}: ${t.title} · PIC ${t.pic || '-'} · ${priority}`, task: t.id, kind: 'system' };
  try {
    if (t.division) postMessage({ ...note, room: `div:${slug(t.division)}` });
    if (t.division && t.subdivision) postMessage({ ...note, room: `sub:${slug(t.division)}:${slug(t.subdivision)}` });
  } catch { /* ruang divisi opsional */ }
  return saved;
}

const EDITABLE = ['title', 'division', 'subdivision', 'pic', 'description', 'objective', 'scope', 'deliverables', 'acceptance', 'result'];
export function updateTask(id, b, by = 'CEO') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const changes = [];
  for (const k of EDITABLE) {
    if (b[k] === undefined) continue;
    const v = ['title', 'division', 'subdivision', 'pic'].includes(k) ? line(b[k], 140) : str(b[k], 6000);
    if (v !== t[k]) { t[k] = v; changes.push(k); }
  }
  if (Array.isArray(b.supporting)) { t.supporting = b.supporting.map((x) => line(x, 60)).filter(Boolean).slice(0, 30); changes.push('supporting'); }
  if (b.priority !== undefined && PRIORITIES[b.priority] && b.priority !== t.priority) {
    if (!str(b.reason)) throw new Error('Perubahan prioritas wajib disertai alasan');
    changes.push(`prioritas ${t.priority}→${b.priority}`); t.priority = b.priority;
  }
  if (b.deadline !== undefined && date(b.deadline) !== t.deadline) {
    if (t.deadline && !str(b.reason)) throw new Error('Perubahan deadline wajib disertai alasan');
    changes.push(`deadline ${t.deadline || '-'}→${date(b.deadline) || '-'}`); t.deadline = date(b.deadline);
  }
  if (b.status !== undefined && b.status !== t.status) {
    if (!STATUSES[b.status]) throw new Error('Status tidak dikenal');
    if (b.status === 'COMPLETED' && t.status !== 'APPROVED') throw new Error('COMPLETED hanya setelah APPROVED oleh CEO');
    if (['APPROVED', 'DIVISION REVIEW', 'CEO REVIEW'].includes(b.status)) throw new Error('Status ini hanya bisa dicapai lewat Quality Control');
    if (b.status === 'BLOCKED' && !str(b.reason)) throw new Error('Tulis kendala saat menandai BLOCKED');
    if (b.status === 'BLOCKED') t.blockers = [...(t.blockers || []), { at: nowIso(), by: line(by, 60), text: str(b.reason, 1000), resolved: false }];
    if (t.status === 'BLOCKED') t.blockers = (t.blockers || []).map((x) => ({ ...x, resolved: true }));
    changes.push(`status ${t.status}→${b.status}`); t.status = b.status;
  }
  if (b.clarification && typeof b.clarification === 'object') {
    const c = b.clarification;
    t.clarification = {
      understood: str(c.understood, 2000), assumptions: str(c.assumptions, 2000), questions: str(c.questions, 3000),
      recommendation: str(c.recommendation, 2000), answer: str(c.answer, 3000) || t.clarification?.answer || '', at: nowIso(),
    };
    changes.push('klarifikasi');
  }
  if (!changes.length) return t;
  log(t, by, `Diubah: ${changes.join(', ')}`, b.reason);
  const saved = saveTask(t);
  if (changes.some((c) => c.startsWith('status') || c.startsWith('deadline') || c.startsWith('prioritas'))) {
    postMessage({ room: `task:${t.id}`, from: by, text: `${changes.join(' · ')}${b.reason ? ` — ${str(b.reason, 300)}` : ''}`, task: t.id, kind: 'system' });
  }
  return saved;
}

// subtask: delegasi ke specialist agent (satu PIC per subtask)
export function upsertSubtask(id, b, by) {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const subs = t.subtasks || [];
  let s = b.no ? subs.find((x) => x.no === Number(b.no)) : null;
  const isNew = !s;
  if (isNew) {
    if (!line(b.title)) throw new Error('Nama subtask wajib diisi');
    if (!line(b.agent)) throw new Error('Setiap subtask wajib punya PIC (agent)');
    s = { no: subs.reduce((m, x) => Math.max(m, x.no), 0) + 1, status: 'ASSIGNED', progress: 0, output: '', created: nowIso(), done_at: null, revisions: 0 };
    subs.push(s);
  }
  const prevStatus = s.status;
  const doneRevs = [];
  if (b.title !== undefined) s.title = line(b.title, 140);
  if (b.agent !== undefined) {
    const a = line(b.agent, 60);
    if (!isNew && a !== s.agent) log(t, by, `PIC subtask ${s.no} dialihkan ${s.agent}→${a}`, b.reason);
    s.agent = a;
  }
  if (b.agent_type !== undefined) s.agent_type = line(b.agent_type, 100);
  if (b.deadline !== undefined) s.deadline = date(b.deadline);
  if (b.weight !== undefined) s.weight = Math.max(0, Math.min(100, Number(b.weight) || 0));
  if (s.weight === undefined) s.weight = 1;
  if (b.instruction !== undefined) s.instruction = str(b.instruction, 4000);
  if (b.output !== undefined) s.output = str(b.output, 4000);
  if (b.progress !== undefined) s.progress = pct(b.progress);
  if (b.status !== undefined) {
    if (!SUB_STATUSES.includes(b.status)) throw new Error(`Status subtask: ${SUB_STATUSES.join(', ')}`);
    if (b.status === 'DONE' && !str(b.output ?? s.output)) throw new Error('Subtask DONE wajib menyertakan output / bukti (path file atau ringkasan hasil)');
    if (b.status === 'REVISION') s.revisions = (s.revisions || 0) + 1;
    s.status = b.status;
  }
  if (s.status === 'DONE') { s.progress = 100; s.done_at = s.done_at || nowIso(); } else s.done_at = null;
  if (!isNew && s.status === 'DONE' && prevStatus === 'REVISION') {
    for (const r of t.revisions || []) {
      if (r.status === 'In Progress' && r.subtask === s.no) { r.status = 'Done'; r.resolved_at = nowIso(); r.resolved_by = line(by, 60); r.result = str(b.note || s.output, 1000); doneRevs.push(r.id); }
    }
  }
  t.subtasks = subs;
  if (isNew && ['INBOX', 'READY TO PLAN', 'PLANNING', 'CLARIFICATION'].includes(t.status)) t.status = 'ASSIGNED';
  if (!isNew && s.status === 'IN PROGRESS' && t.status === 'ASSIGNED') t.status = 'IN PROGRESS';
  log(t, by, isNew ? `Delegasi subtask ${s.no} → ${s.agent}: ${s.title}` : `Subtask ${s.no} (${s.agent}) ${s.status} ${s.progress}%`, b.note || '');
  const saved = saveTask(t);
  const text = isNew
    ? `Delegasi → ${s.agent}: ${s.title}${s.deadline ? ` · deadline ${s.deadline}` : ''}${s.instruction ? `\n${s.instruction}` : ''}`
    : `Subtask ${s.no} · ${s.status} · ${s.progress}%${b.note ? ` — ${str(b.note, 1000)}` : ''}${b.output ? `\nOutput: ${str(b.output, 600)}` : ''}`;
  postMessage({ room: `task:${t.id}`, from: by || s.agent, text, task: t.id, kind: isNew ? 'delegation' : 'progress' });
  if (doneRevs.length) postMessage({ room: `task:${t.id}`, from: by || s.agent, text: `✅ ${doneRevs.join(', ')} selesai direvisi (subtask #${s.no}).`, task: t.id, kind: 'progress' });
  return saved;
}

// quality control berjenjang: sub → div → ceo
export function submitForReview(id, by, note = '') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const open = (t.subtasks || []).filter((s) => s.status !== 'DONE');
  if (!t.subtasks?.length) throw new Error('Belum ada subtask / output untuk diperiksa');
  if (open.length) throw new Error(`Subtask belum selesai: ${open.map((s) => `#${s.no} ${s.agent}`).join(', ')}`);
  t.status = 'INTERNAL REVIEW';
  t.working = null;
  log(t, by, 'Diserahkan untuk Subdivision Review', note);
  postMessage({ room: `task:${t.id}`, from: by, text: `Siap diperiksa kepala sub divisi.${note ? ` ${note}` : ''}`, task: t.id, kind: 'system' });
  return saveTask(t);
}

// poin revisi: tiap poin boleh menunjuk satu subtask (item.subtask = no) → PIC otomatis PIC subtask itu
function parseItems(t, raw) {
  return (Array.isArray(raw) ? raw : []).map((i) => {
    const no = Number(i?.subtask) || null;
    const s = no ? (t.subtasks || []).find((x) => x.no === no) : null;
    if (no && !s) throw new Error(`Subtask #${no} tidak ditemukan`);
    return { problem: str(i?.problem, 3000), cause: str(i?.cause, 1000), pic: line(i?.pic, 60) || (s ? s.agent : ''), correction: str(i?.correction, 3000), subtask: s ? s.no : null };
  }).filter((i) => i.problem);
}
const itemsNote = (items) => items.map((i, n) => `${n + 1}. ${i.subtask ? `[Subtask #${i.subtask}] ` : ''}${i.problem}`).join('\n');
function reopenSubtasks(t, nos) {
  const set = new Set(nos.map(Number));
  for (const s of t.subtasks || []) {
    if (set.has(s.no)) { if (s.status !== 'REVISION') s.revisions = (s.revisions || 0) + 1; s.status = 'REVISION'; s.done_at = null; }
  }
}

export function review(id, b, by) {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const stage = b.stage;
  if (!STAGES[stage]) throw new Error('Tahap review: sub, div, atau ceo');
  if (t.status !== STAGE_STATUS[stage]) throw new Error(`Task berstatus ${t.status}; ${STAGES[stage]} hanya untuk status ${STAGE_STATUS[stage]}`);
  const result = b.result;
  if (!['lolos', 'revisi', 'ditolak'].includes(result)) throw new Error('Hasil review: lolos, revisi, atau ditolak');
  // banyak poin revisi sekaligus: b.items = [{ problem, cause?, pic?, correction? }]
  const items = parseItems(t, b.items);
  const note = str(b.note, 3000) || itemsNote(items);
  if (result !== 'lolos' && !note) throw new Error('Tulis catatan atau poin untuk revisi / penolakan');
  if (result === 'ditolak' && stage !== 'ceo') throw new Error('Hanya CEO yang dapat menolak hasil pekerjaan');
  const checklist = (CHECKLISTS[stage] || []).map((item) => ({ item, ok: Array.isArray(b.checked) ? b.checked.includes(item) : false }));
  if (result === 'lolos' && checklist.some((c) => !c.ok)) throw new Error('Semua checklist harus dicentang agar lolos');
  t.reviews = [...(t.reviews || []), { at: nowIso(), stage, reviewer: line(by, 60), result, note, checklist }];
  t.working = null;
  if (result === 'lolos') {
    t.status = NEXT[stage];
    // persetujuan CEO langsung menyelesaikan task (APPROVED → COMPLETED otomatis)
    if (stage === 'ceo') { log(t, by, 'Disetujui CEO (APPROVED)', b.note); t.status = 'COMPLETED'; }
  } else if (result === 'ditolak') {
    t.status = 'CANCELLED';
  } else {
    const list = items.length ? items : [{ problem: note, cause: str(b.cause, 1000), correction: str(b.correction, 3000) || note, pic: line(b.pic, 60) }];
    for (const it of list) {
      const no = (t.revisions || []).length + 1;
      t.revisions = [...(t.revisions || []), {
        id: `REV-${String(no).padStart(3, '0')}`, at: nowIso(), date: today(), stage, reviewer: line(by, 60),
        problem: it.problem, cause: it.cause || str(b.cause, 1000), correction: it.correction || it.problem,
        pic: it.pic || line(b.pic, 60) || t.pic, subtask: it.subtask || null, deadline: date(b.deadline), status: 'In Progress', resolved_at: null,
      }];
    }
    t.status = 'REVISION';
    // subtask yang ditunjuk (per poin atau daftar b.subtasks) dikembalikan ke REVISION
    reopenSubtasks(t, [...(Array.isArray(b.subtasks) ? b.subtasks : []), ...list.map((x) => x.subtask).filter(Boolean)]);
  }
  log(t, by, `${STAGES[stage]}: ${result}`, note);
  postMessage({ room: `task:${t.id}`, from: by, text: `${STAGES[stage]} → ${result.toUpperCase()}${note ? `\n${str(note, 1500)}` : ''}`, task: t.id, kind: 'review' });
  // revisi selesai & lolos QC sub + divisi → beri tahu CEO agar mengecek ulang
  if (result === 'lolos' && t.status === 'CEO REVIEW' && (t.revisions || []).length) {
    postMessage({ room: 'ceo', from: by, text: `🔔 ${t.id} ${t.title}: revisi selesai dan sudah lolos QC, siap dicek ulang oleh CEO.`, task: t.id, kind: 'system' });
  }
  return saveTask(t);
}

// tambah poin revisi kapan saja selama task berstatus REVISION: b.items = [{ problem, cause?, pic?, correction? }], b.subtasks = [no]
export function addRevisions(id, b, by) {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  if (t.status !== 'REVISION') throw new Error('Poin revisi tambahan hanya untuk task berstatus REVISION');
  const items = parseItems(t, b.items);
  if (!items.length) throw new Error('Tulis minimal satu poin revisi');
  for (const it of items) {
    const no = (t.revisions || []).length + 1;
    t.revisions = [...(t.revisions || []), {
      id: `REV-${String(no).padStart(3, '0')}`, at: nowIso(), date: today(), stage: 'ceo', reviewer: line(by, 60),
      problem: it.problem, cause: it.cause, correction: it.correction || it.problem,
      pic: it.pic || t.pic, subtask: it.subtask || null, deadline: date(b.deadline), status: 'In Progress', resolved_at: null,
    }];
  }
  reopenSubtasks(t, [...(Array.isArray(b.subtasks) ? b.subtasks : []), ...items.map((x) => x.subtask).filter(Boolean)]);
  const note = itemsNote(items);
  log(t, by, `Poin revisi ditambahkan (${items.length})`, note);
  postMessage({ room: `task:${t.id}`, from: by, text: `Poin revisi tambahan:\n${str(note, 1500)}`, task: t.id, kind: 'review' });
  return saveTask(t);
}

// revisi selesai → kembali ke tahap pemeriksaan pertama (kepala sub divisi)
export function resolveRevision(id, by, note = '') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  if (t.status !== 'REVISION') throw new Error('Task tidak sedang direvisi');
  const pending = (t.subtasks || []).filter((s) => s.status === 'REVISION');
  if (pending.length) throw new Error(`Subtask masih revisi: ${pending.map((s) => `#${s.no}`).join(', ')}`);
  const asking = (t.revisions || []).filter((r) => r.asking && r.status === 'In Progress');
  if (asking.length) throw new Error(`Masih menunggu jawaban CEO: ${asking.map((r) => r.id).join(', ')}`);
  t.revisions = (t.revisions || []).map((r) => (r.status === 'In Progress' ? { ...r, status: 'Done', resolved_at: nowIso(), resolved_by: line(by, 60) } : r));
  t.working = null;
  t.status = 'INTERNAL REVIEW';
  log(t, by, 'Revisi selesai, kembali ke Subdivision Review', note);
  postMessage({ room: `task:${t.id}`, from: by, text: `Revisi selesai, diperiksa ulang.${note ? ` ${note}` : ''}`, task: t.id, kind: 'system' });
  return saveTask(t);
}

// ---------------- chat
const ROOM = /^(company|ceo|div:[a-z0-9-]{1,60}|sub:[a-z0-9-]{1,60}:[a-z0-9-]{1,60}|task:TASK-\d{3,6})$/;
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const roomFile = (room) => path.join(chatDir(), `${room.replace(/:/g, '__')}.jsonl`);
// stiker: emoji besar + teks, tanpa file gambar
export const STICKERS = {
  semangat: ['💪', 'Semangat!'], siap: ['🫡', 'Siap laksanakan!'], mantap: ['👍', 'Mantap!'], gas: ['🔥', 'Gaskeun!'],
  selesai: ['✅', 'Beres!'], hore: ['🎉', 'Horeee!'], makasih: ['🙏', 'Makasih ya!'], bingung: ['🤔', 'Hmm… bingung'],
  pusing: ['😵‍💫', 'Pusing pala'], capek: ['😮‍💨', 'Capek bgt'], kesal: ['😤', 'Kesel!'], marah: ['😡', 'Grrr!'],
  sedih: ['😢', 'Sedih…'], ngakak: ['🤣', 'Wkwkwk'], kopi: ['☕', 'Ngopi dulu'], deadline: ['⏰', 'Deadline!!'],
  cinta: ['😍', 'Suka banget'], tolong: ['🆘', 'Tolongin dong'], kamera: ['📸', 'Cekrek!'], tidur: ['😴', 'Ngantuk…'],
};
export const MOODS = { senang: '😄', bahagia: '🥳', biasa: '🙂', fokus: '🧐', bingung: '🤔', capek: '😮‍💨', kesal: '😤', marah: '😡', sedih: '😢', panik: '😱' };
export function postMessage(m) {
  const room = String(m.room || '');
  if (!ROOM.test(room)) throw new Error('Ruang chat tidak dikenal');
  const sticker = STICKERS[m.sticker] ? m.sticker : '';
  const text = str(m.text, 8000);
  const images = imgs(m.images);
  if (!text && !sticker && !images.length) throw new Error('Pesan kosong');
  const reply = /^[a-z0-9-]{6,40}$/.test(String(m.reply_to || '')) ? readRoom(room, 2000).find((x) => x.id === m.reply_to) : null;
  const msg = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: nowIso(), room, from: line(m.from, 60) || 'Anonim', role: line(m.role, 60), text, sticker, images,
    mood: MOODS[m.mood] ? m.mood : '',
    reply_to: reply ? { id: reply.id, from: reply.from, text: (reply.text || (reply.sticker ? STICKERS[reply.sticker]?.join(' ') : (reply.images?.length ? '📷 gambar' : ''))).slice(0, 160) } : null,
    task: TID.test(String(m.task || '')) ? m.task : (/TASK-\d{3,6}/.exec(text)?.[0] || ''),
    kind: line(m.kind, 20) || 'chat',
    ...(m.auto ? { auto: line(m.auto, 20) } : {}),
  };
  fs.mkdirSync(chatDir(), { recursive: true });
  fs.appendFileSync(roomFile(room), `${JSON.stringify(msg)}
`, 'utf8');
  return msg;
}
export function readRoom(room, limit = 300) {
  if (!ROOM.test(String(room))) throw new Error('Ruang chat tidak dikenal');
  let raw = '';
  try { raw = fs.readFileSync(roomFile(room), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function listRooms(org) {
  const rooms = [{ id: 'ceo', name: 'CEO Command Center', type: 'company' }, { id: 'company', name: 'Company Chat', type: 'company' }];
  for (const d of org.divisions) {
    rooms.push({ id: `div:${d.id}`, name: `${d.name} Division Room`, type: 'division', color: d.color });
    for (const s of d.subdivisions || []) rooms.push({ id: `sub:${d.id}:${slug(s.name)}`, name: `${s.name} Room`, type: 'subdivision', color: d.color, parent: d.name });
  }
  for (const t of listTasks()) rooms.push({ id: `task:${t.id}`, name: `${t.id}: ${t.title}`, type: 'task', status: t.status });
  return rooms.map((r) => {
    const msgs = readRoom(r.id, 1);
    return { ...r, last: msgs[0] || null };
  });
}
export function recentActivity(limit = 30) {
  let files = [];
  try { files = fs.readdirSync(chatDir()).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const all = [];
  for (const f of files) {
    const room = f.replace(/\.jsonl$/, '').replace(/__/g, ':');
    if (ROOM.test(room)) all.push(...readRoom(room, limit));
  }
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// ---------------- status agent (aktif / nonaktif)
const agentsFile = () => path.join(opsDir(), 'agents.json');
export const readAgentStatus = () => readJson(agentsFile(), {});
export function setAgentStatus(name, active, by = 'CEO', reason = '') {
  const n = line(name, 60);
  if (!n) throw new Error('Nama agent wajib');
  const all = readAgentStatus();
  all[n] = { active: !!active, at: nowIso(), by: line(by, 60), reason: str(reason, 300) };
  writeJson(agentsFile(), all);
  return all;
}

// ---------------- org chart lengkap (dengan beban kerja)
export function orgChart(org) {
  const st = readAgentStatus();
  const tasks = listTasks();
  const load = {};
  for (const t of tasks) {
    for (const s of t.subtasks || []) {
      if (!load[s.agent]) load[s.agent] = { open: 0, done: 0 };
      if (s.status === 'DONE') load[s.agent].done += 1; else if (OPEN(t.status)) load[s.agent].open += 1;
    }
  }
  const P = (p, role) => p && (p.name || p.agent) ? { name: p.name || p.agent, agent: p.agent, role, active: st[p.name || p.agent]?.active !== false, load: load[p.name || p.agent] || { open: 0, done: 0 } } : null;
  return {
    company: org.company,
    ceo: org.ceo.name,
    hrd: P(org.hrd, 'HRD'),
    divisions: org.divisions.map((d) => ({
      id: d.id, name: d.name, color: d.color, goal: d.goal, head: P(d.head, 'Head of Division'),
      members: d.members.map((m) => P(m, 'Staff')).filter(Boolean),
      subdivisions: (d.subdivisions || []).map((s) => ({
        name: s.name, slug: slug(s.name), goal: s.goal, head: P(s.head, 'Head of Subdivision'),
        members: s.members.map((m) => P(m, 'Specialist Agent')).filter(Boolean),
        freelancers: s.freelancers.map((m) => P(m, 'Freelance')).filter(Boolean),
      })),
    })),
  };
}

// ---------------- dashboard CEO
export function overview(org) {
  const ov = overviewInner(org, listTasks());
  const slow = ov.queue.filter((x) => x.state === 'macet' || (x.state === 'menunggu' && Date.now() - Date.parse(x.since) > 60 * 60e3)).length;
  ov.attention = ov.pending.length + slow + ov.critical.filter((x) => /Menunggu jawaban Anda/.test(x.issue)).length;
  return ov;
}
function overviewInner(org, tasks) {
  const by = (f) => tasks.filter(f).length;
  const agents = new Set();
  let subs = 0;
  for (const d of org.divisions) {
    [d.head, ...d.members].forEach((p) => p && (p.name || p.agent) && agents.add(p.name || p.agent));
    for (const s of d.subdivisions || []) { subs += 1; [s.head, ...s.members, ...s.freelancers].forEach((p) => (p.name || p.agent) && agents.add(p.name || p.agent)); }
  }
  const st = readAgentStatus();
  const active = [...agents].filter((a) => st[a]?.active !== false).length;
  const divisions = org.divisions.map((d) => {
    const ts = tasks.filter((t) => t.division === d.name);
    const done = ts.filter((t) => ['COMPLETED', 'APPROVED'].includes(t.status)).length;
    const live = ts.filter((t) => t.status !== 'CANCELLED');
    return { name: d.name, color: d.color, total: ts.length, completed: done, in_progress: ts.filter((t) => OPEN(t.status) && t.status !== 'BLOCKED').length, blocked: ts.filter((t) => t.status === 'BLOCKED').length, performance: live.length ? Math.round(live.reduce((a, t) => a + t.progress, 0) / live.length) : null };
  });
  const critical = [];
  for (const t of tasks) {
    if (t.status === 'BLOCKED') critical.push({ task: t.id, title: t.title, issue: `Terhambat: ${(t.blockers || []).filter((b) => !b.resolved).map((b) => b.text).join('; ') || '-'}` });
    else if (t.overdue) critical.push({ task: t.id, title: t.title, issue: `Lewat deadline ${t.deadline}` });
    if (t.priority === 'P0' && OPEN(t.status)) critical.push({ task: t.id, title: t.title, issue: 'Prioritas P0 (Critical) masih berjalan' });
    if (t.status === 'CLARIFICATION') critical.push({ task: t.id, title: t.title, issue: 'Menunggu jawaban klarifikasi CEO' });
    for (const r of t.revisions || []) if (r.asking && r.status === 'In Progress') critical.push({ task: t.id, title: t.title, issue: `Menunggu jawaban Anda (${r.id}): ${String(r.asking.q).slice(0, 160)}` });
  }
  return {
    company: { divisions: org.divisions.length, subdivisions: subs, agents: agents.size, active_agents: active, tasks: tasks.length, completed: by((t) => t.status === 'COMPLETED'), in_progress: by((t) => OPEN(t.status) && !['BLOCKED', 'INBOX'].includes(t.status)), blocked: by((t) => t.status === 'BLOCKED'), overdue: by((t) => t.overdue) },
    divisions,
    active: tasks.filter((t) => OPEN(t.status)),
    pending: tasks.filter((t) => ['CEO REVIEW', 'WAITING APPROVAL', 'CLARIFICATION'].includes(t.status) || (t.status === 'APPROVED')),
    critical,
    queue: queueList(),
    attention: 0,
    recent: recentActivity(25),
  };
}

// ---------------- analitik kinerja
export function analytics(org) {
  const tasks = listTasks();
  const live = tasks.filter((t) => t.status !== 'CANCELLED');
  const finished = tasks.filter((t) => ['APPROVED', 'COMPLETED'].includes(t.status));
  const finishedAt = (t) => (t.history || []).find((h) => /CEO Review: lolos/.test(h.action))?.at?.slice(0, 10) || t.updated?.slice(0, 10);
  const onTime = (t) => !t.deadline || finishedAt(t) <= t.deadline;
  const ratio = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const rate = {
    completion: ratio(finished.length, live.length),
    deadline: ratio(finished.filter(onTime).length, finished.length),
    revision: ratio(live.filter((t) => (t.revisions || []).length).length, live.length),
    first_pass: ratio(finished.filter((t) => !(t.revisions || []).length).length, finished.length),
    revisions_total: tasks.reduce((a, t) => a + (t.revisions || []).length, 0),
  };
  // per agent (dari subtask): skor mengikuti bobot Bab 16 (data yang bisa diukur sistem)
  const A = {};
  for (const t of tasks) {
    for (const s of t.subtasks || []) {
      const a = (A[s.agent] ||= { agent: s.agent, assigned: 0, done: 0, on_time: 0, revisions: 0, blocked: 0, tasks: new Set() });
      a.assigned += 1; a.tasks.add(t.id); a.revisions += s.revisions || 0;
      if (s.status === 'DONE') { a.done += 1; if (!s.deadline || String(s.done_at).slice(0, 10) <= s.deadline) a.on_time += 1; }
      if (s.status === 'BLOCKED') a.blocked += 1;
    }
  }
  const agents = Object.values(A).map((a) => {
    const completion = ratio(a.done, a.assigned) ?? 0;
    const timeliness = ratio(a.on_time, a.done) ?? 0;
    const quality = a.done ? Math.max(0, 100 - Math.round((a.revisions / Math.max(a.done, 1)) * 50)) : 0;
    const accuracy = quality;
    const collaboration = Math.min(100, 60 + a.tasks.size * 10);
    const score = Math.round(quality * 0.3 + completion * 0.2 + accuracy * 0.2 + timeliness * 0.15 + collaboration * 0.1 + 100 * 0.05);
    return { agent: a.agent, assigned: a.assigned, done: a.done, completion, timeliness, revisions: a.revisions, tasks: a.tasks.size, score, category: a.done ? category(score) : 'Belum ada data' };
  }).sort((x, y) => y.score - x.score);
  const group = (key, val) => {
    const out = {};
    for (const t of live) {
      const k = val(t);
      if (!k) continue;
      const g = (out[k] ||= { name: k, total: 0, done: 0, on_time: 0, revisions: 0, progress: 0 });
      g.total += 1; g.progress += t.progress; g.revisions += (t.revisions || []).length;
      if (['APPROVED', 'COMPLETED'].includes(t.status)) { g.done += 1; if (onTime(t)) g.on_time += 1; }
    }
    return Object.values(out).map((g) => ({ ...g, completion: ratio(g.done, g.total), deadline: ratio(g.on_time, g.done), avg_progress: Math.round(g.progress / g.total), revision_rate: Math.round((g.revisions / g.total) * 100) / 100 }));
  };
  const subdivisions = group('sub', (t) => t.subdivision && `${t.subdivision}${t.division ? ` · ${t.division}` : ''}`);
  const heads = group('div', (t) => t.division).map((g) => ({ ...g, head: org.divisions.find((d) => d.name === g.name)?.head?.name || '-' }));
  return { rate, agents, subdivisions, heads, weights: { 'Quality of Work': 30, 'Task Completion': 20, Accuracy: 20, Timeliness: 15, Collaboration: 10, Communication: 5 } };
}
const category = (s) => (s >= 90 ? 'Excellent' : s >= 80 ? 'Very Good' : s >= 70 ? 'Good' : s >= 60 ? 'Needs Improvement' : 'Poor');


// ---------------- gambar lampiran chat & perintah
export const uploadsDir = () => path.join(opsDir(), 'uploads');
export const UPLOAD_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const UP_RE = /^[a-z0-9]{6,14}-[a-z0-9]{3,8}\.(png|jpg|webp|gif)$/;
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}
// jenis file ditentukan dari isinya (bukan nama/ekstensi dari pengirim); SVG/HTML ditolak
export function saveUpload(buf) {
  if (!buf || !buf.length) throw new Error('File kosong');
  if (buf.length > 8 * 1024 * 1024) throw new Error('Gambar terlalu besar (maks 8 MB)');
  const ext = sniff(buf);
  if (!ext) throw new Error('Hanya gambar PNG, JPG, WEBP, atau GIF');
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir(), name), buf);
  return { name, size: buf.length };
}
export function uploadFile(name) {
  if (!UP_RE.test(String(name))) return null;
  const f = path.join(uploadsDir(), String(name));
  return fs.existsSync(f) ? f : null;
}
function imgs(a) { return (Array.isArray(a) ? a : []).map(String).filter((n) => uploadFile(n)).slice(0, 10); }

// ---------------- perintah CEO ke divisi: satu task per divisi tujuan, gambar ikut jadi lampiran task
export function createCommand(b, by = 'CEO', org) {
  const text = str(b.text, 6000);
  const images = imgs(b.images);
  if (!text && !images.length) throw new Error('Tulis perintah atau lampirkan gambar');
  const room = String(b.room || '');
  const divOf = (id) => org.divisions.find((d) => d.id === id);
  const targets = [];
  let m;
  if ((m = /^div:(.+)$/.exec(room))) { const d = divOf(m[1]); if (d) targets.push({ d }); }
  else if ((m = /^sub:([^:]+):(.+)$/.exec(room))) { const d = divOf(m[1]); const s = d?.subdivisions.find((x) => slug(x.name) === m[2]); if (d && s) targets.push({ d, s }); }
  else if (room.startsWith('task:')) throw new Error('Perintah tidak dikirim dari thread task; tulis sebagai pesan biasa');
  else for (const id of Array.isArray(b.divisions) ? b.divisions : []) { const d = divOf(String(id)); if (d && !targets.some((x) => x.d.id === d.id)) targets.push({ d }); }
  if (!targets.length) throw new Error('Pilih divisi tujuan perintah');
  const first = text.split('\n').map((x) => x.trim()).find(Boolean) || '';
  const title = line(b.title, 140) || (first.length > 90 ? `${first.slice(0, 87)}...` : first) || 'Perintah dengan gambar';
  const priority = PRIORITIES[b.priority] ? b.priority : 'P2';
  const made = [];
  for (const { d, s } of targets) {
    const head = (s?.head && (s.head.name || s.head.agent)) ? s.head : d.head;
    const pic = head?.name || head?.agent || '';
    const t = createTask({ title, division: d.name, subdivision: s?.name || '', pic, priority, deadline: b.deadline, description: text, attachments: images, requester: by, source: 'perintah' }, by);
    made.push(t);
    postMessage({ room: s ? `sub:${d.id}:${slug(s.name)}` : `div:${d.id}`, from: by, role: 'CEO', text, images, task: t.id, kind: 'command' });
  }
  if (!room.startsWith('div:') && !room.startsWith('sub:')) {
    postMessage({ room, from: by, role: 'CEO', text: `${text}${text ? '\n' : ''}→ ${made.map((t) => `${t.division} (${t.id})`).join(', ')}`, images, task: made[0].id, kind: 'command' });
  }
  return { tasks: made };
}

// ---------------- klaim pekerjaan oleh agent, antrean & inbox
export function claimWork(id, b, by) {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const who = line(by, 60);
  if (!who || who === 'CEO') throw new Error('Klaim pekerjaan hanya oleh agent (--by <nama agent>)');
  const now = nowIso();
  let what = '';
  let kind = 'baru';
  if (t.status === 'REVISION') {
    const want = Array.isArray(b.revs) && b.revs.length ? new Set(b.revs) : null;
    const mine = (t.revisions || []).filter((r) => r.status === 'In Progress' && (b.force || !r.claimed_by) && (!want || want.has(r.id)));
    if (!mine.length) throw new Error('Tidak ada poin revisi yang belum diambil (pakai --force untuk mengambil alih yang macet)');
    for (const r of mine) { r.claimed_by = who; r.claimed_at = now; }
    what = `revisi ${mine.map((r) => r.id).join(', ')}`;
    kind = 'revisi';
  } else if (['INBOX', 'READY TO PLAN'].includes(t.status)) {
    t.status = 'PLANNING';
    what = 'perintah baru';
  } else throw new Error(`Task berstatus ${t.status}; tidak ada yang perlu diambil`);
  const names = new Set([...(t.working?.by || []), who]);
  t.working = { by: [...names], since: t.working?.since || now, heartbeat: now, kind };
  log(t, who, `Mulai mengerjakan ${what}`, b.note);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: who, text: `▶ Mulai mengerjakan ${what}.${b.note ? ` ${str(b.note, 500)}` : ''}`, task: t.id, kind: 'progress' });
  return saved;
}
export function completeRevision(id, revId, by, note = '') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const r = (t.revisions || []).find((x) => x.id === revId);
  if (!r) throw new Error('Poin revisi tidak ditemukan');
  if (r.status === 'Done') throw new Error(`${revId} sudah selesai`);
  if (!str(note)) throw new Error('Tulis ringkasan perbaikan: apa yang diubah dan di mana hasilnya');
  r.status = 'Done'; r.resolved_at = nowIso(); r.resolved_by = line(by, 60); r.result = str(note, 1500);
  log(t, by, `${revId} selesai`, note);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: by, text: `✅ ${revId} selesai: ${str(note, 800)}`, task: t.id, kind: 'progress' });
  return saved;
}
export function releaseWork(id, by, note = '') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  for (const r of t.revisions || []) if (r.status === 'In Progress' && r.claimed_by) { delete r.claimed_by; delete r.claimed_at; }
  t.working = null;
  if (t.status === 'PLANNING') t.status = 'INBOX';
  log(t, by, 'Klaim dilepas', note);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: by, text: `⏸ Klaim dilepas.${note ? ` ${str(note, 400)}` : ''}`, task: t.id, kind: 'progress' });
  return saved;
}
export function queueList() {
  const W = { macet: 0, menunggu: 1, dikerjakan: 2 };
  return listTasks().filter((t) => t.queue).map((t) => ({ task: t.id, title: t.title, pic: t.pic, division: t.division, priority: t.priority, deadline: t.deadline, ...t.queue }))
    .sort((a, b) => W[a.state] - W[b.state] || byDeadline(a, b));
}
// untuk pemroses terjadwal / `hrd.mjs inbox`: pekerjaan yang belum diambil atau macet
export function inbox() {
  return listTasks().filter((t) => t.queue && ['menunggu', 'macet'].includes(t.queue.state)).map((t) => ({
    id: t.id, title: t.title, kind: t.queue.kind, state: t.queue.state, since: t.queue.since, priority: t.priority, deadline: t.deadline,
    division: t.division, subdivision: t.subdivision, pic: t.pic, description: t.description, objective: t.objective, deliverables: t.deliverables,
    attachments: (t.attachments || []).map((n) => uploadFile(n)).filter(Boolean),
    revisions: (t.revisions || []).filter((r) => r.status === 'In Progress' && !r.asking && (t.queue.state === 'macet' || !r.claimed_by)),
    subtasks: (t.subtasks || []).map((s) => ({ no: s.no, title: s.title, agent: s.agent, agent_type: s.agent_type, status: s.status, output: s.output })),
  })).sort(byDeadline);
}
// aturan CEO: pekerjaan dengan deadline terdekat dikerjakan lebih dulu (tanpa deadline paling akhir), lalu prioritas, lalu yang paling lama menunggu
function byDeadline(a, b) {
  const da = a.deadline || '9999-12-31', db = b.deadline || '9999-12-31';
  return da.localeCompare(db) || String(a.priority).localeCompare(String(b.priority)) || String(a.since).localeCompare(String(b.since));
}

// agent bertanya ke CEO per poin revisi; CEO menjawab di dashboard dan poin kembali ke antrean
export function askCeo(id, revId, by, question) {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const r = (t.revisions || []).find((x) => x.id === revId);
  if (!r) throw new Error('Poin revisi tidak ditemukan');
  if (r.status === 'Done') throw new Error(`${revId} sudah selesai`);
  const q = str(question, 1500);
  if (!q) throw new Error('Tulis pertanyaan untuk CEO');
  r.asking = { by: line(by, 60), q, at: nowIso() };
  r.claimed_by = r.claimed_by || line(by, 60);
  log(t, by, `${revId}: menunggu jawaban CEO`, q);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: by, text: `❓ ${revId} butuh jawaban CEO: ${q}`, task: t.id, kind: 'review' });
  postMessage({ room: 'ceo', from: by, text: `🔔 ${t.id} ${revId} menunggu jawaban Anda: ${str(q, 300)}`, task: t.id, kind: 'system' });
  return saved;
}
export function answerRevision(id, revId, answer, by = 'CEO') {
  const t = getTask(id);
  if (!t) throw new Error('Task tidak ditemukan');
  const r = (t.revisions || []).find((x) => x.id === revId);
  if (!r || !r.asking) throw new Error('Poin ini tidak sedang menunggu jawaban');
  const a = str(answer, 3000);
  if (!a) throw new Error('Tulis jawaban');
  r.answer = { q: r.asking.q, a, at: nowIso(), by: line(by, 60) };
  delete r.asking; delete r.claimed_by; delete r.claimed_at;
  log(t, by, `Jawaban untuk ${revId}`, a);
  const saved = saveTask(t);
  postMessage({ room: `task:${t.id}`, from: by, text: `💬 Jawaban CEO untuk ${revId}: ${a}`, task: t.id, kind: 'review' });
  return saved;
}
