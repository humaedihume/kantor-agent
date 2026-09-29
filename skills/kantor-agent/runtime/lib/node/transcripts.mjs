// Ringkasan transkrip Claude Code (JSONL) secara inkremental — hanya metadata tool_use & potongan teks assistant.
// Isi tool_result TIDAK PERNAH dibaca. Port PHP: lib/php/Transcripts.php (harus identik — dicek bin/parity.mjs).
//   <root>/<sesi>.jsonl                                      sesi utama (Ketua)
//   <root>/<sesi>/subagents/agent-<id>.jsonl + .meta.json     subagent (juga subagents/workflows/<wf>/…)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  basename, clip, globDir, isDir, isFile, isObj, isPlainObj, mbLen, mtimeSec, phpLtrim, phpTrim, readText, redact,
  oneLine, safeLine, strcmp, tsMs, values,
} from './util.mjs';

const CACHE_V = 2;
const HEAD_MAX = 1024; // sidik jari awal berkas: berkas diganti (bukan ditambah) → ringkasan dibuat ulang
const EVENTS_KEEP = 40;
const SEGS_KEEP = 20;
const STOPS_KEEP = 80;
const FILES_KEEP = 12;
const TODOS_KEEP = 40;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function transcriptRoot(projectDir) {
  let base = process.env.CLAUDE_CONFIG_DIR || '';
  if (base === '') {
    let home = process.env.HOME || '';
    if (home === '') {
      try {
        home = os.userInfo().homedir || '';
      } catch {
        home = '';
      }
    }
    base = `${home.replace(/\/+$/, '')}/.claude`;
  }
  return `${base.replace(/\/+$/, '')}/projects/${projectDir.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

const memo = new Map(); // file → {size, mtimeMs, s}: menghindari parse ulang cache di proses Node yang sama

export class Transcripts {
  constructor(projectDir, storageDir, cfg) {
    this.projectDir = projectDir;
    this.cacheDir = storageDir ? path.join(storageDir, 'cache') : null;
    this.cfg = cfg;
  }

  scan(nowSec) {
    const root = transcriptRoot(this.projectDir);
    if (!isDir(root)) return { exists: false, runs: [], mains: [] };
    const cutoff = nowSec - this.cfg.window_days * 86400;
    let mainFiles = globDir(root, '.jsonl').map((f) => [f, mtimeSec(f)]).filter(([, mt]) => mt >= cutoff);
    mainFiles.sort((a, b) => b[1] - a[1] || strcmp(a[0], b[0]));
    mainFiles = mainFiles.slice(0, this.cfg.mains_max);
    const mains = mainFiles.map(([f]) => ({ ...this.summarize(f), session: basename(f, '.jsonl') }));

    const metas = [];
    for (const d of globDir(root, '')) {
      if (!isDir(d)) continue;
      for (const m of globDir(path.join(d, 'subagents'), '.meta.json')) metas.push([m, basename(d)]);
      for (const wf of globDir(path.join(d, 'subagents', 'workflows'), '')) {
        for (const m of globDir(wf, '.meta.json')) metas.push([m, basename(d)]);
      }
    }
    metas.sort((a, b) => strcmp(a[0], b[0]));
    const runs = [];
    for (const [metaFile, session] of metas) {
      const jsonl = `${metaFile.slice(0, -'.meta.json'.length)}.jsonl`;
      const name = basename(jsonl, '.jsonl');
      if (!name.startsWith('agent-') || !isFile(jsonl) || mtimeSec(jsonl) < cutoff) continue;
      let meta;
      try {
        meta = JSON.parse(readText(metaFile) ?? '');
      } catch {
        meta = null;
      }
      meta = isPlainObj(meta) ? meta : {};
      const type = typeof meta.agentType === 'string' && phpTrim(meta.agentType) !== '' ? clip(phpTrim(meta.agentType), 40) : 'general-purpose';
      const desc = typeof meta.description === 'string' ? safeLine(meta.description, 140) : '';
      const sum = this.summarize(jsonl);
      if (sum.started === null) continue; // belum ada baris bertanggal
      runs.push({
        ...sum,
        id: name.slice(6),
        session,
        agentType: type,
        description: desc,
        parentAgent: typeof meta.parentAgentId === 'string' ? meta.parentAgentId : null,
      });
    }
    return { exists: true, runs, mains };
  }

  summarize(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      st = { size: 0, mtimeMs: 0 };
    }
    const size = st.size;
    const m = memo.get(file);
    let s = m && m.size === size && m.mtimeMs === st.mtimeMs && m.head === headOf(file, m.s.headLen) ? m.s : null;
    const cacheFile = this.cacheDir ? path.join(this.cacheDir, `n-${crypto.createHash('md5').update(file).digest('hex')}.json`) : null;
    if (s === null && cacheFile && isFile(cacheFile)) {
      try {
        s = JSON.parse(readText(cacheFile) ?? '');
      } catch {
        s = null;
      }
    }
    if (!isPlainObj(s) || s.v !== CACHE_V || !(s.offset >= 0) || s.offset > size || !(s.headLen >= 0) || s.headLen > size
      || headOf(file, s.headLen) !== s.head) s = fresh();
    if (s.offset < size) {
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        let pos = s.offset;
        let carry = Buffer.alloc(0);
        const buf = Buffer.alloc(1 << 20);
        let read;
        let readAt = pos;
        while ((read = fs.readSync(fd, buf, 0, buf.length, readAt)) > 0) {
          readAt += read;
          const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : Buffer.from(buf.subarray(0, read));
          let start = 0;
          let nl;
          while ((nl = chunk.indexOf(10, start)) !== -1) {
            const lineBuf = chunk.subarray(start, nl + 1);
            pos += lineBuf.length;
            start = nl + 1;
            let row = null;
            try {
              row = JSON.parse(utf8.decode(lineBuf));
            } catch {
              row = null;
            }
            if (isPlainObj(row)) this.consume(s, row);
          }
          carry = chunk.subarray(start);
        }
        s.offset = pos; // baris terakhir tanpa \n belum lengkap — dibaca lagi nanti
        s.headLen = Math.min(size, HEAD_MAX);
        s.head = headOf(file, s.headLen);
      } catch {
        /* file hilang/terkunci: pakai ringkasan yang ada */
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      if (cacheFile) {
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(s));
        } catch {
          /* cache opsional */
        }
      }
    }
    memo.set(file, { size, mtimeMs: st.mtimeMs, s, head: s.head });
    return {
      started: s.started, updated: s.updated, tools: s.tools, tokens: s.tokens.in + s.tokens.out + s.tokens.cache,
      events: s.events, lastKind: s.lastKind, limit: s.limit, files: s.files, todos: s.todos, todosAt: s.todosAt,
      todoSource: s.todoSource, segs: s.segs, stops: s.stops,
    };
  }

  consume(s, row) {
    const type = row.type ?? '';
    const t = typeof row.timestamp === 'string' && tsMs(row.timestamp) !== null ? row.timestamp : '';
    const msg = row.message;
    if (type !== 'user' && type !== 'assistant') return;
    if (t !== '') {
      if (s.started === null) s.started = t;
      s.updated = t;
    }
    if (!isObj(msg)) return;
    const content = msg.content ?? '';
    // segmen kerja: dibuka baris pertama, ditutup jawaban akhir (end_turn), dibuka lagi bila ada pesan baru
    if (t !== '') {
      const last = s.segs.length ? s.segs[s.segs.length - 1] : null;
      if (last === null) s.segs.push([t, null]);
      else if (last[1] !== null && (type === 'assistant' || typeof content === 'string')) {
        if (tsMs(t) - tsMs(last[1]) <= this.cfg.cooldown * 1000) last[1] = null;
        else {
          s.segs.push([t, null]);
          if (s.segs.length > SEGS_KEEP) s.segs.shift();
        }
      }
    }
    if (type === 'user') {
      if (typeof content === 'string') {
        if (empty(row.isMeta) && !phpLtrim(content).startsWith('<') && (row.isSidechain ?? false) === false) {
          this.push(s, t, 'user', 'Instruksi dari user', null);
        }
        s.lastKind = 'user';
      } else if (isObj(content) && s.lastKind !== 'handback') {
        s.lastKind = 'result';
      }
      return;
    }
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id !== '' && id !== s.lastMsgId && isObj(msg.usage)) {
      const u = msg.usage;
      s.tokens.in += int(u.input_tokens);
      s.tokens.out += int(u.output_tokens);
      s.tokens.cache += int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens);
      s.lastMsgId = id;
    }
    let hasTool = false;
    let hasText = false;
    let handback = false;
    for (const b of isObj(content) ? values(content) : []) {
      if (!isObj(b)) continue;
      const bt = b.type ?? '';
      if (bt === 'tool_use') {
        hasTool = true;
        const name = typeof b.name === 'string' ? b.name : '?';
        const inp = isPlainObj(b.input) ? b.input : {};
        s.tools++;
        const [text, p] = this.describeTool(name, inp);
        if (p !== null && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
          s.files = s.files.filter((f) => f !== p);
          s.files.push(p);
          if (s.files.length > FILES_KEEP) s.files.shift();
        }
        if (name === 'TaskStop' && t !== '') {
          const tid = typeof inp.task_id === 'string' ? inp.task_id : typeof inp.shell_id === 'string' ? inp.shell_id : '';
          if (/^[A-Za-z0-9_-]{1,64}$/.test(tid)) {
            s.stops.push([tid, t]);
            if (s.stops.length > STOPS_KEEP) s.stops.shift();
          }
        }
        this.todo(s, name, inp, t);
        if (name === 'SubagentHandback') handback = true;
        this.push(s, t, 'tool', text, name);
      } else if (bt === 'text') {
        const txt = typeof b.text === 'string' ? phpTrim(b.text) : '';
        if (txt === '') continue;
        hasText = true;
        if (/(usage limit|rate limit|limit reached|resets? (at|in))/i.test(txt) && mbLen(txt) < 400) s.limit = clip(redact(txt), 200);
        this.push(s, t, 'text', safeLine(txt, 180), null);
      }
    }
    const stop = typeof msg.stop_reason === 'string' ? msg.stop_reason : '';
    if (handback) s.lastKind = 'handback';
    else if (hasTool) s.lastKind = 'tool';
    else if (hasText) s.lastKind = stop === 'end_turn' ? 'final' : 'text';
    else if (s.lastKind === null) s.lastKind = 'thinking';
    if (hasTool) s.limit = null;
    if (stop === 'end_turn' && t !== '' && s.segs.length && s.segs[s.segs.length - 1][1] === null) s.segs[s.segs.length - 1][1] = t;
  }

  todo(s, name, inp, t) {
    if (name === 'TodoWrite' && isObj(inp.todos)) {
      const items = [];
      for (const td of values(inp.todos)) {
        if (!isObj(td)) continue;
        const text = typeof td.content === 'string' ? td.content : typeof td.subject === 'string' ? td.subject : '';
        if (phpTrim(text) === '') continue;
        items.push({ text: safeLine(text, 120), status: todoStatus(td.status) });
        if (items.length >= TODOS_KEEP) break;
      }
      s.todos = items;
      s.todosAt = t;
      s.todoSource = 'TodoWrite';
      return;
    }
    if (name === 'TaskCreate') {
      const subject = typeof inp.subject === 'string' ? inp.subject : typeof inp.description === 'string' ? inp.description : '';
      s.taskSeq++;
      if (phpTrim(subject) === '') return;
      s.tasks[`#${s.taskSeq}`] = { text: safeLine(subject, 120), status: 'pending' };
      const keys = Object.keys(s.tasks);
      if (keys.length > TODOS_KEEP) delete s.tasks[keys[0]];
    } else if (name === 'TaskUpdate') {
      let tid = inp.taskId ?? inp.id ?? null;
      tid = typeof tid === 'string' || Number.isInteger(tid) ? `#${tid}` : '';
      if (!Object.hasOwn(s.tasks, tid)) return;
      if (inp.status === 'deleted') delete s.tasks[tid];
      else {
        if (typeof inp.status === 'string') s.tasks[tid].status = todoStatus(inp.status);
        if (typeof inp.subject === 'string' && phpTrim(inp.subject) !== '') s.tasks[tid].text = safeLine(inp.subject, 120);
      }
    } else return;
    s.todos = Object.values(s.tasks);
    s.todosAt = t;
    s.todoSource = 'Task';
  }

  push(s, t, kind, text, tool) {
    if (t === '') return;
    s.events.push({ t, kind, text, tool });
    if (s.events.length > EVENTS_KEEP) s.events.splice(0, s.events.length - EVENTS_KEEP);
  }

  describeTool(name, inp) {
    const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isInteger(v) ? String(v) : '');
    let p = null;
    for (const k of ['file_path', 'notebook_path']) {
      if (typeof inp[k] === 'string' && inp[k] !== '') {
        const v = inp[k];
        p = v.startsWith(`${this.projectDir}/`) ? v.slice(this.projectDir.length + 1) : basename(v);
        break;
      }
    }
    let text;
    switch (name) {
      case 'Read': text = `Membaca ${p ?? ''}`; break;
      case 'Write': text = `Menulis ${p ?? ''}`; break;
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': text = `Mengubah ${p ?? ''}`; break;
      case 'Bash': text = `Menjalankan: ${str(inp.description) !== '' ? str(inp.description) : `${firstToken(str(inp.command))} …`}`; break;
      case 'Grep': text = `Mencari '${clip(str(inp.pattern), 50)}'`; break;
      case 'Glob': text = `Mencari file ${clip(str(inp.pattern), 60)}`; break;
      case 'Agent': case 'Task': text = `Mendelegasikan: ${str(inp.description) !== '' ? str(inp.description) : 'subagent'}`; break;
      case 'SendMessage': text = 'Mengirim pesan ke agent'; break;
      case 'AskUserQuestion': text = 'Bertanya ke user'; break;
      case 'WebFetch': case 'WebSearch': text = 'Riset web'; break;
      case 'Skill': text = `Memuat skill ${str(inp.skill)}`; break;
      case 'TodoWrite': text = 'Memperbarui daftar tugas'; break;
      case 'TaskCreate': text = `Membuat tugas: ${str(inp.subject)}`; break;
      case 'TaskUpdate': text = `Memperbarui tugas${str(inp.status) !== '' ? ` → ${str(inp.status)}` : ''}`; break;
      case 'TaskStop': text = 'Menghentikan subagent'; break;
      case 'SubagentHandback': text = 'Menyerahkan laporan'; break;
      case 'ToolSearch': text = 'Mencari alat'; break;
      default: text = clip(name, 60);
    }
    return [oneLine(text, 160), p];
  }
}

// md5 dari n byte pertama berkas ('' bila n = 0 atau gagal dibaca)
function headOf(file, n) {
  if (!(n > 0)) return '';
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, 0);
    return got === n ? crypto.createHash('md5').update(b).digest('hex') : '';
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
function fresh() {
  return {
    v: CACHE_V, offset: 0, headLen: 0, head: '', started: null, updated: null, tools: 0, tokens: { in: 0, out: 0, cache: 0 }, lastMsgId: null,
    events: [], lastKind: null, limit: null, files: [], todos: null, todosAt: null, todoSource: null, tasks: {}, taskSeq: 0,
    segs: [], stops: [],
  };
}
function todoStatus(v) {
  return ['pending', 'in_progress', 'completed'].includes(v) ? v : 'pending';
}
function int(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function empty(v) {
  return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && !v.length) || (isPlainObj(v) && !Object.keys(v).length);
}
function firstToken(cmd) {
  for (const tok of cmd.split(/[ \n]+/)) if (tok !== '') return tok;
  return '';
}
