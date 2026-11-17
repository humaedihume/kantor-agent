// Obrolan ringan otomatis di grup chat kantor (tanpa AI): sapaan, makan siang, ngopi, pulang, dan balasan cepat ke CEO.
// Hanya obrolan sosial — tidak pernah menyebut progres/hasil kerja (itu wajib dari pekerjaan nyata).
// Keramaian "sedang": jam kerja 08.00–18.00, rata-rata ±3 obrolan per jam di semua channel. Pesan diberi auto:'template'.
import fs from 'node:fs';
import path from 'node:path';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (n) => String(n || '').split(/\s+/)[0];

// {a} = orang lain di obrolan; {ceo} = nama CEO
const TOPICS = {
  pagi: { hours: [8, 10], lines: [
    [['Pagi gaes ☀️', 'pagi semuaa', 'Selamat pagi tim!', 'Pagiii, udah pada sarapan?'], ['pagi {a}!', 'Pagi! belum sarapan nih 😅', 'pagi, ngantuk parah wkwk'], ['semangat hari ini ya', 'gas lah', null]],
    [['Ada yang kejebak macet juga ga?', 'Hujan deres di jalan tadi, basah semua 🥲'], ['aku juga {a}, parah banget', 'aman aku, berangkat subuh wkwk', 'sabar ya {a}'], [null, 'hati-hati di jalan semua']],
  ], stickers: ['semangat', 'kopi', 'tidur', 'gas'] },
  siang: { hours: [11, 13], lines: [
    [['Makan siang di mana nih?', 'Laper banget, ada yang mau pesen makan bareng?', 'Lunch break dulu ya gaes 🍜'], ['ikut {a}! padang aja yuk', 'aku bawa bekal hehe', 'mie ayam depan yuk'], ['gas', 'titip satu ya {a} 🙏', null]],
    [['Abis makan ngantuknya nggak ketolong 😴'], ['sama banget {a}', 'kopi solusinya', 'jangan tidur, nanti ketauan bos wkwk'], [null, 'wkwk']],
  ], stickers: ['ngakak', 'tidur', 'kopi', 'cinta'] },
  sore: { hours: [14, 16], lines: [
    [['Ngopi sore dulu ah ☕', 'Ada yang mau es kopi susu? aku mau pesen', 'Jam segini paling enak ngemil'], ['mau {a}! less sugar ya', 'titip satu dong', 'aku teh aja'], [null, 'makasih {a} 🙏']],
    [['Btw kemarin liat booth photobooth orang lain di nikahan, antreannya panjang banget', 'Ada yang udah nonton film baru itu belum?', 'Weekend kemarin pada ke mana?'], ['wah seru tuh, ceritain {a}', 'belum, spoiler dong', 'rebahan doang aku 😂'], [null, 'next time ajak2 ya']],
  ], stickers: ['kopi', 'ngakak', 'mantap', 'hore'] },
  pulang: { hours: [17, 18], lines: [
    [['Udah jam segini aja, cepet banget', 'Siap-siap pulang nih', 'Capek juga hari ini 😮‍💨'], ['iya {a}, hati-hati di jalan', 'aku masih nanggung dikit', 'pulang bareng yuk'], ['sampai besok semua 👋', 'istirahat yang cukup ya', null]],
  ], stickers: ['capek', 'tidur', 'hore', 'makasih'] },
};
const MOOD_OF = { pagi: ['senang', 'biasa', ''], siang: ['senang', 'capek', ''], sore: ['biasa', 'senang', ''], pulang: ['capek', 'senang', ''] };

// balasan cepat ke CEO
const CEO_REPLY = [
  [/(apa kabar|kabarnya|gimana kabar)/i, ['Baik {ceo}, sehat semua 😄', 'alhamdulillah baik {ceo}!', 'aman {ceo}, lagi semangat nih', 'baik, cuma agak ngantuk wkwk']],
  [/\b(halo|hallo|hai|hi|helo|hey)\b/i, ['Halo {ceo} 👋', 'Halo {ceo}! 😄', 'Hai {ceo}, selamat datang di grup', 'halooo']],
  [/\bpagi\b/i, ['Pagi {ceo}! ☀️', 'Selamat pagi {ceo}', 'pagi, semangat {ceo}!']],
  [/\b(siang|sore|malam)\b/i, ['Selamat $1 {ceo} 🙏', '$1 {ceo}!']],
  [/(terima ?kasih|makasih|thanks|thx)/i, ['Sama-sama {ceo} 🙏', 'siap, sama-sama!', 'dengan senang hati {ceo}']],
  [/(semangat|good job|mantap|keren|bagus)/i, ['Siap {ceo}, makasih 🔥', 'Wah makasih {ceo}!', 'semangat juga {ceo} 💪']],
  [/\?\s*$/, ['Siap {ceo}, saya cek dulu ya', 'Baik {ceo}, nanti saya kabari', 'Noted {ceo}, saya cari tahu dulu']],
];
const CEO_DEFAULT = ['Siap {ceo} 🫡', 'Noted {ceo}!', 'Baik {ceo}', 'Siap laksanakan', 'oke {ceo} 👍'];
const CEO_STICKERS = ['siap', 'semangat', 'mantap', 'makasih'];

export function startChatter({ OPS, ORG, opsDir }) {
  const stateFile = path.join(opsDir(), 'chatter.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* baru */ }
  const save = () => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch { /* opsional */ } };
  let busy = false;

  // anggota tiap room dari struktur organisasi (yang aktif)
  function rooms() {
    const org = ORG.readOrg();
    const st = OPS.readAgentStatus();
    const ok = (p) => p && (p.name || p.agent) && st[p.name || p.agent]?.active !== false;
    const P = (p, role) => ({ name: p.name || p.agent, role: p.agent || role });
    const out = [];
    const all = [];
    for (const d of org.divisions) {
      const dm = [d.head, ...d.members].filter(ok).map((p) => P(p, 'Kepala Divisi'));
      const subs = (d.subdivisions || []).map((s) => ({ s, m: [s.head, ...s.members, ...s.freelancers].filter(ok).map((p) => P(p, 'Staff')) }));
      out.push({ id: `div:${d.id}`, members: [...dm, ...subs.map((x) => x.m[0]).filter(Boolean)] });
      for (const { s, m } of subs) out.push({ id: `sub:${d.id}:${OPS.slug(s.name)}`, members: m, head: m[0] });
      all.push(...dm, ...subs.flatMap((x) => x.m));
    }
    out.unshift({ id: 'company', members: all });
    out.push({ id: 'ceo', members: org.divisions.map((d) => d.head).filter(ok).map((p) => P(p, 'Kepala Divisi')) });
    return { org, list: out.filter((r) => r.members.length >= 2 || r.id === 'ceo') };
  }

  async function say(room, p, text, extra = {}) {
    try { return OPS.postMessage({ room, from: p.name, role: p.role, text, kind: 'chat', ...extra, auto: 'template' }); } catch { return null; }
  }

  // satu obrolan: 2–4 orang saling balas, jeda 20–90 detik
  async function burst(r, topicKey) {
    const T = TOPICS[topicKey];
    const thread = pick(T.lines);
    const cast = shuffle(r.members).slice(0, 2 + Math.floor(Math.random() * 2));
    let prev = null;
    for (let i = 0; i < thread.length; i += 1) {
      const line = pick(thread[i]);
      const p = cast[i % cast.length];
      if (!line || !p) continue;
      if (i) await sleep(20000 + Math.random() * 70000);
      const text = line.replace('{a}', prev ? first(prev.from) : first(pick(r.members).name));
      const m = await say(r.id, p, text, { mood: i === 0 ? pick(MOOD_OF[topicKey]) : '', reply_to: i && prev && Math.random() < 0.4 ? prev.id : '' });
      if (m) prev = m;
      if (Math.random() < 0.25) { await sleep(8000 + Math.random() * 20000); await say(r.id, pick(cast), '', { sticker: pick(T.stickers) }); }
    }
  }

  async function tick() {
    if (busy) return;
    const now = new Date();
    const h = now.getHours();
    const day = now.getDay();
    if (h < 8 || h >= 18 || day === 0) return; // Minggu libur
    const topicKey = Object.keys(TOPICS).find((k) => h >= TOPICS[k].hours[0] && h <= TOPICS[k].hours[1]);
    if (!topicKey) return;
    // sedang: peluang 5%/menit ≈ 3 obrolan per jam; jaga jarak minimal 8 menit
    if (Date.now() - (state.last || 0) < 8 * 60e3 || Math.random() > 0.05) return;
    const { list } = rooms();
    const cand = list.filter((r) => r.id !== 'ceo' && r.members.length >= 2);
    if (!cand.length) return;
    // sapaan pagi & pamit pulang sekali sehari di company
    const today = now.toLocaleDateString('sv-SE');
    let r = pick(cand);
    if ((topicKey === 'pagi' || topicKey === 'pulang') && state[`${topicKey}`] !== today) { r = cand.find((x) => x.id === 'company') || r; state[topicKey] = today; }
    state.last = Date.now(); save();
    busy = true;
    try { await burst(r, topicKey); } finally { busy = false; }
  }

  // dipanggil saat CEO mengirim pesan: 1–3 agent di room itu membalas dalam 5–40 detik
  async function onCeoMessage(msg) {
    const { org, list } = rooms();
    const r = list.find((x) => x.id === msg.room) || (msg.room.startsWith('task:') ? null : list[0]);
    if (!r || !r.members.length) return;
    const ceo = org.ceo.name || 'Bos';
    const text = String(msg.text || '');
    const rule = CEO_REPLY.find(([re]) => re.test(text));
    const pool = rule ? rule[1] : CEO_DEFAULT;
    const mentioned = r.members.filter((p) => new RegExp(`@?\\b${first(p.name)}\\b`, 'i').test(text));
    const cast = [...mentioned, ...(r.head ? [r.head] : []), ...shuffle(r.members)].filter((p, i, a) => a.findIndex((x) => x.name === p.name) === i)
      .slice(0, mentioned.length ? Math.max(1, mentioned.length) : 1 + Math.floor(Math.random() * 3));
    const used = new Set();
    for (const [i, p] of cast.entries()) {
      await sleep((i ? 6000 : 4000) + Math.random() * 14000);
      if (i && Math.random() < 0.35) { await say(r.id, p, '', { sticker: pick(CEO_STICKERS) }); continue; }
      let line = pick(pool.filter((x) => !used.has(x))) || pick(CEO_DEFAULT);
      used.add(line);
      const g = /\b(siang|sore|malam)\b/i.exec(text);
      line = line.replace('{ceo}', first(ceo)).replace('$1', g ? g[1].toLowerCase() : '');
      await say(r.id, p, line, { reply_to: i === 0 ? msg.id : '' });
    }
  }

  setInterval(() => { tick().catch(() => {}); }, 60e3).unref();
  return { onCeoMessage, tick, burst: (room, topic) => { const r = rooms().list.find((x) => x.id === room); return r ? burst(r, topic) : null; } };
}
