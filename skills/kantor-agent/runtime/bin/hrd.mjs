#!/usr/bin/env node
// Alat HRD Kantor Agent — dipakai Claude (sebagai HRD) saat meeting terjadwal.
//   node hrd.mjs org                                   struktur organisasi + agent tiap orang
//   node hrd.mjs todo                                  hal yang perlu ditindaklanjuti HRD sekarang
//   node hrd.mjs reports [--type T] [--limit N]        daftar report
//   node hrd.mjs show <id>                             isi report + keputusan CEO
//   node hrd.mjs new --type T --title "…" --file isi.md [--revises <id>]
//                                                      buat report baru (status: menunggu keputusan CEO)
//   node hrd.mjs executed <id>                         tandai rencana harian sudah dibagikan ke karyawan
//   node hrd.mjs brand [--project DIR]                 isi Brand Kit + bagian yang belum diatur + pertanyaan menunggu
//   node hrd.mjs brand-ask --bagian "Warna" --pertanyaan "…" --pilihan "A|B|C" [--oleh Nama] [--tugas "…"] [--project DIR]
//                                                      catat pertanyaan brand kit untuk CEO (dipakai bila tidak bisa bertanya langsung)
// --- Operasional (Agent Operating Rules) — semua tercatat di http://127.0.0.1:8788/kerja/ops
//   node hrd.mjs tasks [--status S] [--pic Nama]       daftar task (status, progres, PIC)
//   node hrd.mjs task <TASK-ID>                        detail task: subtask, review, revisi, riwayat
//   node hrd.mjs task-new --title "…" --division D [--subdivision S] [--pic Nama] [--priority P2] [--deadline YYYY-MM-DD] [--file brief.md] --by Nama
//   node hrd.mjs task-clarify <ID> --by Nama --file klarifikasi.json   (understood, assumptions, questions, recommendation) → status CLARIFICATION
//   node hrd.mjs task-status <ID> --status S --by Nama [--reason "…"]
//   node hrd.mjs task-sub <ID> --title "…" --agent Nama [--type agent-type] [--deadline D] [--weight 20] [--instruction "…"] --by Nama   delegasi
//   node hrd.mjs task-progress <ID> --no N --by Nama [--status IN PROGRESS|BLOCKED|DONE] [--progress 50] [--output "path/ringkasan"] [--note "…"]
//   node hrd.mjs task-submit <ID> --by Nama            serahkan ke Subdivision Review (semua subtask DONE)
//   node hrd.mjs task-review <ID> --stage sub|div|ceo --result lolos|revisi --by Nama [--note "…"] [--cause "…"] [--subtasks 1,2]
//   node hrd.mjs task-resolve <ID> --by Nama           revisi selesai → kembali ke Subdivision Review
//   node hrd.mjs chat --room ROOM --by Nama [--role "Head of …"] --text "…"    room: company|ceo|div:<id>|sub:<div>:<sub>|task:TASK-001
//   node hrd.mjs chat-read --room ROOM [--limit 30]
// Tipe: harian-pagi | harian-sore | mingguan | bulanan | lainnya
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = await import(new URL('../lib/node/org.mjs', import.meta.url));
const BRAND = await import(new URL('../lib/node/brand.mjs', import.meta.url));
const OPS = await import(new URL('../lib/node/ops.mjs', import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD waktu lokal
const save = (r) => {
  fs.mkdirSync(ORG.reportsDir(), { recursive: true });
  const { type_label, ...clean } = r;
  fs.writeFileSync(path.join(ORG.reportsDir(), `${r.id}.json`), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
};
function fail(m) { console.error(m); process.exit(1); }
const by = () => opt('by') || fail('--by <nama Anda> wajib (siapa yang melakukan)');
const done = (m) => console.log(`${m} — pantau di http://127.0.0.1:8788/kerja/ops`);
const who = (p) => `${p.name || '(tanpa nama)'}${p.agent ? ` [agent: ${p.agent}]` : ''}`;

try {
switch (cmd) {
  case 'org': {
    const o = ORG.readOrg();
    console.log(`Perusahaan: ${o.company}\nCEO: ${o.ceo.name}\nHRD: ${who(o.hrd)}\n`);
    if (!o.divisions.length) console.log('(Belum ada divisi. CEO bisa menambahkannya di http://127.0.0.1:8788/kerja/agen)');
    for (const d of o.divisions) {
      console.log(`## Divisi ${d.name}${d.goal ? ` — tujuan: ${d.goal}` : ''}`);
      console.log(`  Kepala   : ${d.head.name || d.head.agent ? who(d.head) : '(kosong)'}`);
      for (const m of d.members) console.log(`  Anggota  : ${who(m)}`);
      for (const f of d.freelancers) console.log(`  Freelance: ${who(f)}`);
      for (const s of d.subdivisions || []) {
        console.log(`  ### Sub divisi ${s.name}${s.goal ? ` — tujuan: ${s.goal}` : ''}`);
        console.log(`    Kepala sub : ${s.head.name || s.head.agent ? who(s.head) : '(kosong)'}`);
        for (const m of s.members) console.log(`    Anggota    : ${who(m)}`);
        for (const f of s.freelancers) console.log(`    Freelance  : ${who(f)}`);
      }
    }
    break;
  }
  case 'reports': {
    const t = opt('type');
    const n = Number(opt('limit') || 15);
    for (const r of ORG.listReports().filter((x) => !t || x.type === t).slice(0, n)) {
      console.log(`${r.id}  ${r.type}  ${r.status}${r.executed ? ' (sudah dibagikan)' : ''}  ${r.title}`);
    }
    break;
  }
  case 'show': {
    const r = ORG.getReport(rest[0]);
    if (!r) { console.error('Report tidak ditemukan'); process.exit(1); }
    console.log(`# ${r.title}\nTipe: ${r.type_label}\nStatus: ${r.status}\nDibuat: ${r.created}`);
    if (r.revises) console.log(`Revisi dari: ${r.revises}`);
    if (r.ceo_note) console.log(`Catatan CEO: ${r.ceo_note}`);
    console.log(`\n${r.content}`);
    break;
  }
  case 'new': {
    const type = opt('type');
    if (!ORG.REPORT_TYPES[type]) { console.error(`--type harus salah satu: ${Object.keys(ORG.REPORT_TYPES).join(', ')}`); process.exit(1); }
    const file = opt('file');
    const content = file ? fs.readFileSync(file, 'utf8') : '';
    if (!content.trim()) { console.error('Isi report kosong (--file isi.md)'); process.exit(1); }
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const r = {
      id: `${today()}-${type}-${stamp.slice(8)}`.toLowerCase(),
      type,
      title: opt('title') || ORG.REPORT_TYPES[type],
      date: today(),
      created: new Date().toISOString(),
      author: ORG.readOrg().hrd.name,
      revises: opt('revises') || null,
      status: 'menunggu',
      content,
      ceo_note: '',
      decided: null,
      executed: false,
    };
    save(r);
    console.log(`Report dibuat: ${r.id} — menunggu keputusan CEO di http://127.0.0.1:8788/kerja/report`);
    break;
  }
  case 'executed': {
    const r = ORG.getReport(rest[0]);
    if (!r) { console.error('Report tidak ditemukan'); process.exit(1); }
    r.executed = new Date().toISOString();
    save(r);
    console.log(`Ditandai sudah dibagikan: ${r.id}`);
    break;
  }
  case 'todo': {
    const all = ORG.listReports();
    const revised = new Set(all.map((r) => r.revises).filter(Boolean));
    const out = [];
    for (const r of all) {
      if (r.type === 'harian-pagi' && r.date === today() && r.status === 'disetujui' && !r.executed) {
        out.push(`KERJAKAN: rencana hari ini ${r.id} sudah disetujui CEO tetapi belum dibagikan ke karyawan.`);
      }
      if (r.status === 'revisi' && !revised.has(r.id)) out.push(`REVISI: ${r.id} diminta direvisi CEO — catatan: ${r.ceo_note}`);
    }
    console.log(out.length ? out.join('\n') : 'Tidak ada yang perlu ditindaklanjuti.');
    break;
  }
  case 'brand': {
    const proj = opt('project') || process.env.KANTOR_PROJECT || process.cwd();
    const md = BRAND.readKit(proj);
    if (!md) { console.log(`Brand Kit belum ada di ${path.join(BRAND.brandDir(proj), 'BRAND-KIT.md')}`); break; }
    const secs = BRAND.sections(md);
    console.log(md);
    console.log('\n=== RINGKASAN ===');
    console.log(`Sudah diatur : ${secs.filter((x) => x.set).map((x) => x.title).join(', ') || '-'}`);
    console.log(`BELUM diatur : ${secs.filter((x) => !x.set && x.title !== 'Keputusan Tambahan').map((x) => x.title).join(', ') || '-'}`);
    console.log(`Aset         : ${BRAND.listAssets(proj).map((a) => a.name).join(', ') || '(belum ada)'} — folder ${path.join(BRAND.brandDir(proj), 'aset')}`);
    const pend = BRAND.readQuestions(proj).filter((q) => q.status === 'menunggu');
    if (pend.length) console.log(`Pertanyaan menunggu jawaban CEO: ${pend.map((q) => `[${q.section}] ${q.question}`).join(' | ')}`);
    break;
  }
  case 'brand-ask': {
    const proj = opt('project') || process.env.KANTOR_PROJECT || process.cwd();
    const item = BRAND.addQuestion(proj, {
      section: opt('bagian'), question: opt('pertanyaan'), options: String(opt('pilihan') || '').split('|'), asked_by: opt('oleh'), task: opt('tugas'),
    });
    console.log(`Pertanyaan dicatat (${item.id}). CEO menjawab di http://127.0.0.1:8788/kerja/brand — jangan kerjakan bagian yang bergantung pada jawaban ini sebelum dijawab.`);
    break;
  }
  case 'tasks': {
    const ts = OPS.listTasks().filter((t) => (!opt('status') || t.status === opt('status')) && (!opt('pic') || t.pic === opt('pic') || t.subtasks.some((s) => s.agent === opt('pic'))));
    for (const t of ts) console.log(`${t.id}  ${t.priority}  ${t.status.padEnd(16)} ${String(t.progress).padStart(3)}%  PIC ${t.pic || '-'}  ${t.deadline || '-'}${t.overdue ? ' TERLAMBAT' : ''}  ${t.title}`);
    if (!ts.length) console.log('Tidak ada task.');
    break;
  }
  case 'task': {
    const t = OPS.getTask(rest[0]);
    if (!t) fail('Task tidak ditemukan');
    console.log(JSON.stringify(t, null, 2));
    break;
  }
  case 'task-new': {
    const t = OPS.createTask({ title: opt('title'), division: opt('division'), subdivision: opt('subdivision'), pic: opt('pic'), priority: opt('priority'), deadline: opt('deadline'), description: opt('file') ? fs.readFileSync(opt('file'), 'utf8') : opt('description'), objective: opt('objective'), deliverables: opt('deliverables'), acceptance: opt('acceptance'), requester: opt('requester') }, by());
    done(`${t.id} dibuat (${t.status})`);
    break;
  }
  case 'task-clarify': {
    const c = JSON.parse(fs.readFileSync(opt('file'), 'utf8'));
    OPS.updateTask(rest[0], { clarification: c, status: c.questions ? 'CLARIFICATION' : 'READY TO PLAN', scope: c.scope, deliverables: c.deliverables, objective: c.objective }, by());
    done(`Klarifikasi ${rest[0]} dicatat${c.questions ? ' — menunggu jawaban CEO' : ''}`);
    break;
  }
  case 'task-status': OPS.updateTask(rest[0], { status: opt('status'), reason: opt('reason') }, by()); done(`${rest[0]} → ${opt('status')}`); break;
  case 'task-sub': {
    const t = OPS.upsertSubtask(rest[0], { title: opt('title'), agent: opt('agent'), agent_type: opt('type'), deadline: opt('deadline'), weight: opt('weight'), instruction: opt('instruction') }, by());
    done(`Subtask #${t.subtasks.at(-1).no} → ${opt('agent')}`);
    break;
  }
  case 'task-progress': {
    const b = { no: opt('no'), note: opt('note') };
    if (opt('status')) b.status = opt('status');
    if (opt('progress')) b.progress = opt('progress');
    if (opt('output')) b.output = opt('output');
    OPS.upsertSubtask(rest[0], b, by());
    done(`Progres ${rest[0]} #${opt('no')} dicatat`);
    break;
  }
  case 'task-submit': OPS.submitForReview(rest[0], by(), opt('note')); done(`${rest[0]} → INTERNAL REVIEW`); break;
  case 'task-review': {
    const list = OPS.CHECKLISTS[opt('stage')] || [];
    const t = OPS.review(rest[0], { stage: opt('stage'), result: opt('result'), note: opt('note'), cause: opt('cause'), correction: opt('correction'), checked: opt('result') === 'lolos' ? list : [], subtasks: String(opt('subtasks') || '').split(',').filter(Boolean) }, by());
    done(`${rest[0]} → ${t.status}`);
    break;
  }
  case 'task-resolve': OPS.resolveRevision(rest[0], by(), opt('note')); done(`${rest[0]} → INTERNAL REVIEW`); break;
  case 'chat': OPS.postMessage({ room: opt('room'), from: by(), role: opt('role'), text: opt('text'), task: opt('task') }); done('Pesan terkirim'); break;
  case 'chat-read': for (const m of OPS.readRoom(opt('room'), Number(opt('limit') || 30))) console.log(`[${m.at.slice(0, 16)}] ${m.from}${m.role ? ` (${m.role})` : ''}: ${m.text}`); break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
} catch (e) { fail(`Gagal: ${e.message}`); }
