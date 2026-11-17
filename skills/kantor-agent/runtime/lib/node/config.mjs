// Konfigurasi: defaults.json + penimpaan opsional <project>/.claude/kantor-agent.json (nama, judul).
// Port PHP: lib/php/Config.php (harus identik — dicek bin/parity.mjs).
import path from 'node:path';
import { globalConfigFile } from './agents.mjs';
import { orgFile, readOrg } from './org.mjs';
import { isFile, isPlainObj, phpTrim, readText, values } from './util.mjs';

export const CONFIG_REL = '.claude/kantor-agent.json';

// nama tampilan: string, tanpa karakter kontrol, maks 20 titik kode; selain itu null
export function cleanName(v, max = 20) {
  if (typeof v !== 'string') return null;
  const s = phpTrim(v.replace(/[\x00-\x1f\x7f]+/g, ' '));
  if (s === '') return null;
  return Array.from(s).slice(0, max).join('');
}
function parse(file) {
  if (!isFile(file)) return {};
  try {
    const c = JSON.parse(readText(file) ?? '');
    return isPlainObj(c) ? c : {};
  } catch {
    return {};
  }
}
const num = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export function loadDefaults(runtimeDir) {
  const d = JSON.parse(readText(path.join(runtimeDir, 'defaults.json')) ?? 'null');
  if (!isPlainObj(d)) throw new Error('defaults.json tidak valid');
  return d;
}

export function loadConfig(runtimeDir, projectDir) {
  const d = loadDefaults(runtimeDir);
  // global (~/.claude/kantor-agent.json, diatur lewat /kerja/agen) lalu ditimpa project
  const g = parse(globalConfigFile());
  const p = parse(path.join(projectDir, CONFIG_REL));
  const c = { ...g, ...p, names: { ...(isPlainObj(g.names) ? g.names : {}), ...(isPlainObj(p.names) ? p.names : {}) } };
  const n = c.names;
  const ag = values(c.agents);
  const team = values(n.team);
  const fl = [];
  for (const v of values(n.freelancers)) {
    const s = cleanName(v);
    if (s !== null && !fl.includes(s)) fl.push(s);
  }
  return {
    title: cleanName(c.title, 60) ?? (cleanName(path.basename(projectDir), 60) ?? 'Project'),
    // nama Ketua = CEO dari struktur organisasi (bila sudah diatur)
    ketua: (isFile(orgFile()) ? cleanName(readOrg().ceo.name) : null) ?? cleanName(n.ketua) ?? d.ketua,
    team: d.team.map((def, i) => cleanName(team[i]) ?? def),
    // agent khusus per meja tim (nama agent / agentType); null = menerima tugas apa pun
    agents: d.team.map((_, i) => cleanName(ag[i], 100)),
    freelancers: fl.length ? fl : d.freelancers,
    colors: d.colors,
    window_days: num(d.window_days, 7),
    running_window: num(d.running_window, 900),
    main_active: num(d.main_active, 90),
    cooldown: num(d.cooldown, 60),
    spare_desks: num(d.spare_desks, 4),
    mains_max: num(d.mains_max, 40),
  };
}
