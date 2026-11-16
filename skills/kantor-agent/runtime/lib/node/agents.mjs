// Manajer agent: baca/tulis file agent Claude Code (~/.claude/agents/*.md) dan susunan tim kantor
// (~/.claude/kantor-agent.json, global). Hanya dipakai server Node.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const agentsDir = () => path.join(claudeDir(), 'agents');
export const globalConfigFile = () => path.join(claudeDir(), 'kantor-agent.json');
const trashDir = () => path.join(claudeDir(), 'agents-trash');
import { execFile } from 'node:child_process';

// Agent kantor (buatan sendiri) disimpan di <kantor>/.claude/agents agar ikut repo GitHub & dipakai Claude rekan kerja.
export const projectRoot = () => {
  const p = process.env.KANTOR_PROJECT || process.cwd();
  return fs.existsSync(path.join(p, 'brand-kit')) ? p : null;
};
export const projectAgentsDir = () => (projectRoot() ? path.join(projectRoot(), '.claude', 'agents') : null);
const inProject = (slug) => !!projectAgentsDir() && fs.existsSync(path.join(projectAgentsDir(), `${slug}.md`));

// commit + push otomatis (di latar belakang, berurutan) bila folder kantor adalah repo git
let gitQueue = Promise.resolve();
export function syncGit(msg) {
  const root = projectRoot();
  if (!root || !fs.existsSync(path.join(root, '.git'))) return;
  const run = (args) => new Promise((ok) => execFile('git', args, { cwd: root, windowsHide: true }, (e, out, err) => ok({ e, out, err })));
  gitQueue = gitQueue.then(async () => {
    await run(['add', '-A', '.claude/agents']);
    const c = await run(['commit', '-q', '-m', msg]);
    if (c.e) return;
    let p = await run(['push', '-q']);
    if (p.e) { await run(['pull', '--rebase', '-q']); p = await run(['push', '-q']); }
    if (p.e) console.error('[kantor] push gagal:', p.err);
  }).catch(() => {});
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const validSlug = (s) => typeof s === 'string' && SLUG.test(s) && !s.includes('..');

// frontmatter sederhana: key: value per baris
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const mdFiles = (d) => { try { return d ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort() : []; } catch { return []; } };
const info = (dir, f, kelana) => {
  const slug = f.slice(0, -3);
  let fm = {};
  try { fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000)); } catch { /* lewati */ }
  return { slug, name: fm.name || slug, description: fm.description || '', emoji: fm.emoji || '', color: fm.color || '',
    division: kelana ? 'kelana' : slug.split('-')[0], kelana };
};
export function listAgents() {
  const pd = projectAgentsDir();
  const mine = mdFiles(pd).map((f) => info(pd, f, true));
  const names = new Set(mine.map((a) => a.slug));
  const lib = mdFiles(agentsDir()).filter((f) => !names.has(f.slice(0, -3))).map((f) => info(agentsDir(), f, false));
  return [...mine, ...lib];
}

export function readAgent(slug) {
  if (!validSlug(slug)) return null;
  try {
    return fs.readFileSync(path.join(inProject(slug) ? projectAgentsDir() : agentsDir(), `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
}

export function writeAgent(slug, content, { create }) {
  if (!validSlug(slug)) throw new Error('Nama file tidak valid (huruf kecil, angka, tanda -)');
  if (typeof content !== 'string' || content.length > 200000) throw new Error('Isi tidak valid');
  // Claude Code mewajibkan '---' di baris pertama: buang BOM/baris kosong/spasi di awal (sering ikut saat menempel teks)
  content = content.replace(/^﻿?\s+/, '').replace(/\r\n/g, '\n');
  if (!content.startsWith('---')) throw new Error('Baris pertama harus "---" (awal frontmatter)');
  const fm = frontmatter(content);
  if (!fm.name || !fm.description) throw new Error('Frontmatter wajib berisi name dan description');
  const g = path.join(agentsDir(), `${slug}.md`);
  const pd = projectAgentsDir();
  const exists = inProject(slug) || fs.existsSync(g);
  if (create && exists) throw new Error('Agent dengan nama file itu sudah ada');
  if (!create && !exists) throw new Error('Agent tidak ditemukan');
  // agent baru & agent kantor -> folder kantor (repo); agent perpustakaan bawaan tetap di folder global
  if (pd && (create || inProject(slug))) {
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, `${slug}.md`), content, 'utf8');
    if (fs.existsSync(g)) fs.writeFileSync(g, content, 'utf8'); // salinan lama ikut diperbarui
    syncGit(`${create ? 'tambah' : 'ubah'} agent ${fm.name}`);
    return;
  }
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(g, content, 'utf8');
}

// pindahkan agent perpustakaan ke folder kantor (repo)
export function adoptAgent(slug) {
  if (!validSlug(slug)) throw new Error('Nama file tidak valid');
  const pd = projectAgentsDir();
  if (!pd) throw new Error('Folder kantor tidak ditemukan');
  const g = path.join(agentsDir(), `${slug}.md`);
  if (!fs.existsSync(g)) throw new Error('Agent tidak ditemukan');
  fs.mkdirSync(pd, { recursive: true });
  fs.copyFileSync(g, path.join(pd, `${slug}.md`));
  syncGit(`masukkan agent ${frontmatter(fs.readFileSync(g, 'utf8')).name || slug} ke kantor`);
}

// hapus = pindah ke ~/.claude/agents-trash/ (bisa dipulihkan)
export function deleteAgent(slug) {
  if (!validSlug(slug)) throw new Error('Nama file tidak valid');
  const g = path.join(agentsDir(), `${slug}.md`);
  const proj = inProject(slug);
  if (!proj && !fs.existsSync(g)) throw new Error('Agent tidak ditemukan');
  fs.mkdirSync(trashDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (proj) {
    fs.renameSync(path.join(projectAgentsDir(), `${slug}.md`), path.join(trashDir(), `${slug}.kantor.${stamp}.md`));
    syncGit(`hapus agent ${slug}`);
  }
  if (fs.existsSync(g)) fs.renameSync(g, path.join(trashDir(), `${slug}.${stamp}.md`));
}

export function readGlobalConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(globalConfigFile(), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

export function writeGlobalConfig(c) {
  fs.mkdirSync(claudeDir(), { recursive: true });
  fs.writeFileSync(globalConfigFile(), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
}
