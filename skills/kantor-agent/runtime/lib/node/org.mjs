// Struktur organisasi (CEO, HRD, divisi) dan report meeting HRD.
//   ~/.claude/kantor-agent/org.json            struktur organisasi
//   ~/.claude/kantor-agent/reports/<id>.json   report meeting (dibuat HRD, diputuskan CEO)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bila ada folder kantor (KANTOR_PROJECT atau cwd yang punya brand-kit/), data disimpan di <kantor>/kantor/
// agar ikut tersinkron lewat GitHub. Selain itu pakai lokasi lama ~/.claude/kantor-agent.
const projectDir = () => {
  const p = process.env.KANTOR_PROJECT || process.cwd();
  return fs.existsSync(path.join(p, 'brand-kit')) ? p : null;
};
const base = () => {
  const p = projectDir();
  return p ? path.join(p, 'kantor') : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'kantor-agent');
};
export const orgFile = () => path.join(base(), 'org.json');
export const reportsDir = () => path.join(base(), 'reports');

export const REPORT_TYPES = {
  'harian-pagi': 'Meeting Harian 07.00 — Rencana Kerja',
  'harian-sore': 'Report Harian 18.00 — Hasil Kerja',
  mingguan: 'Weekly Meeting Sabtu 12.00',
  bulanan: 'Monthly Meeting Tanggal 1, 09.00',
  lainnya: 'Report HRD',
};
export const DECISIONS = ['disetujui', 'revisi', 'ditolak'];

const str = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const person = (p) => ({ name: str(p?.name, 40), agent: str(p?.agent, 100) });
const people = (a) => (Array.isArray(a) ? a.map(person).filter((p) => p.name || p.agent).slice(0, 60) : []);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'divisi';

export const DEFAULT_ORG = { ceo: { name: 'CEO' }, hrd: { name: 'HRD', agent: '' }, company: 'Kelana Photobooth', divisions: [] };

export function normalizeOrg(o) {
  const ids = new Set();
  const divisions = (Array.isArray(o?.divisions) ? o.divisions : []).slice(0, 30).map((d) => {
    const name = str(d?.name, 50) || 'Divisi baru';
    let id = slugify(str(d?.id, 40) || name);
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return {
      id,
      name,
      color: /^#[0-9a-f]{6}$/i.test(d?.color) ? d.color : '#3f6fd1',
      goal: str(d?.goal, 300),
      head: person(d?.head),
      members: people(d?.members),
      freelancers: people(d?.freelancers),
      // sub divisi: tim kecil di dalam divisi, masing-masing dengan kepala sub divisi, anggota, dan freelance
      subdivisions: (Array.isArray(d?.subdivisions) ? d.subdivisions : []).slice(0, 20).map((s) => ({
        name: str(s?.name, 50) || 'Sub divisi',
        goal: str(s?.goal, 300),
        head: person(s?.head),
        members: people(s?.members),
        freelancers: people(s?.freelancers),
      })),
    };
  });
  return {
    company: str(o?.company, 60) || DEFAULT_ORG.company,
    ceo: { name: str(o?.ceo?.name, 40) || 'CEO' },
    hrd: { name: str(o?.hrd?.name, 40) || 'HRD', agent: str(o?.hrd?.agent, 100) },
    divisions,
  };
}

export function readOrg() {
  try {
    return normalizeOrg(JSON.parse(fs.readFileSync(orgFile(), 'utf8')));
  } catch {
    return normalizeOrg(DEFAULT_ORG);
  }
}

export function writeOrg(o) {
  const n = normalizeOrg(o);
  fs.mkdirSync(base(), { recursive: true });
  fs.writeFileSync(orgFile(), `${JSON.stringify(n, null, 2)}\n`, 'utf8');
  return n;
}

// ---- report
const RID = /^[a-z0-9][a-z0-9-]{0,80}$/;
function readReport(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

export function listReports() {
  let files = [];
  try {
    files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readReport(path.join(reportsDir(), f)))
    .filter((r) => r && RID.test(String(r.id)))
    .map((r) => ({ ...r, type_label: REPORT_TYPES[r.type] || REPORT_TYPES.lainnya }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export function getReport(id) {
  if (!RID.test(String(id))) return null;
  const r = readReport(path.join(reportsDir(), `${id}.json`));
  return r ? { ...r, type_label: REPORT_TYPES[r.type] || REPORT_TYPES.lainnya } : null;
}

export function decideReport(id, decision, note) {
  if (!DECISIONS.includes(decision)) throw new Error('Keputusan harus disetujui, revisi, atau ditolak');
  const r = getReport(id);
  if (!r) throw new Error('Report tidak ditemukan');
  if ((decision === 'revisi' || decision === 'ditolak') && !str(note, 4000)) throw new Error('Tulis catatan untuk revisi / penolakan');
  delete r.type_label;
  r.status = decision;
  r.ceo_note = str(note, 4000);
  r.decided = new Date().toISOString();
  r.history = [...(Array.isArray(r.history) ? r.history : []), { at: r.decided, status: decision, note: r.ceo_note }];
  fs.writeFileSync(path.join(reportsDir(), `${id}.json`), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  return r;
}

// ---- lantai kantor: lantai 1 = Direksi & HRD (sesi utama Claude + tim umum), lantai 2 dst. = satu divisi per lantai
const low = (s) => String(s || '').trim().toLowerCase();
export function floorList(org) {
  const out = [{ n: 1, title: 'Direksi & HRD', color: '#6a55c9' }];
  org.divisions.forEach((d, i) => out.push({ n: i + 2, title: d.name, color: d.color }));
  return out;
}
// semua orang di sebuah divisi, urut: kepala divisi, anggota divisi, tiap sub divisi (kepala sub, anggota), lalu freelance
function crewOf(d) {
  const ok = (p) => p.name || p.agent;
  const core = [];
  const free = [];
  if (ok(d.head)) core.push({ ...d.head, role: 'Kepala Divisi' });
  for (const m of d.members) core.push({ ...m, role: 'Anggota' });
  for (const s of d.subdivisions || []) {
    if (ok(s.head)) core.push({ ...s.head, role: `Kepala ${s.name}`, sub: s.name });
    for (const m of s.members) core.push({ ...m, role: `Anggota ${s.name}`, sub: s.name });
    for (const m of s.freelancers) free.push({ ...m, role: `Freelance ${s.name}`, sub: s.name });
  }
  for (const m of d.freelancers) free.push({ ...m, role: 'Freelance' });
  return [...core, ...free].map((p) => ({ ...p, name: p.name || p.agent }));
}
// konfigurasi kantor untuk satu lantai (cfg dasar dari loadConfig)
export function floorConfig(cfg, org, n) {
  const floors = floorList(org);
  const f = floors.find((x) => x.n === n) || floors[0];
  const base = { ...cfg, floors, floor: f.n, floor_title: f.title };
  const divAgents = new Set(org.divisions.flatMap((d) => crewOf(d).map((p) => low(p.agent)).filter(Boolean)));
  if (f.n === 1) {
    // Ketua = sesi utama Claude (berperan HRD); subagent yang agent-nya bukan milik divisi mana pun dikerjakan tim umum
    return {
      ...base,
      ketua: org.hrd.name || cfg.ketua,
      ketua_role: 'HRD',
      title: `${cfg.title} · Lantai 1 · Direksi & HRD`,
      ceo: org.ceo.name,
      // hanya orang dari struktur organisasi: tanpa tim bawaan (Budi, Sari, …); subagent lain tampil sebagai
      // pekerja tamu yang dinamai sesuai tipe agent-nya, hanya selama bekerja
      team: [],
      team_roles: [],
      agents: [],
      freelancers: ['Tamu'],
      floorRules: { accept: (t) => !divAgents.has(low(t)), flName: (t) => String(t).slice(0, 20) },
    };
  }
  const d = org.divisions[f.n - 2];
  const crew = crewOf(d);
  const leader = crew[0] || null;
  const rest = crew.slice(1);
  const team = rest.filter((p) => !p.role.startsWith('Freelance')).slice(0, 4);
  const extra = rest.filter((p) => !team.includes(p));
  const agentsHere = new Set(crew.map((p) => low(p.agent)).filter(Boolean));
  const flByAgent = new Map();
  for (const p of extra) if (p.agent && !flByAgent.has(low(p.agent))) flByAgent.set(low(p.agent), p.name);
  return {
    ...base,
    title: `${cfg.title} · Lantai ${f.n} · ${d.name}`,
    ketua: leader ? leader.name : `Kepala ${d.name}`,
    ketua_role: leader ? leader.role : 'Kepala Divisi',
    team: team.map((p) => p.name),
    team_roles: team.map((p) => p.role),
    agents: team.map((p) => p.agent || null),
    freelancers: extra.length ? [...new Set(extra.map((p) => p.name))] : ['Tamu'],
    colors: { ...cfg.colors, ketua: d.color },
    floorRules: {
      accept: (t) => agentsHere.has(low(t)),
      leaderAgent: leader && leader.agent ? low(leader.agent) : null,
      flName: (t) => flByAgent.get(low(t)) ?? null,
    },
  };
}
