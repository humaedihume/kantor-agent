// Kantor Agent — kantor 3D (three.js r170) yang digerakkan data nyata dari /kerja/api/state.
// Ketua (sesi utama) punya meja sendiri; 4 anggota tim santai di lounge dan duduk bekerja saat mendapat subagent;
// freelancer datang lewat pintu bila tim penuh. Tidak ada aktivitas palsu: tanpa data, semua santai.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const API = '/kerja/api/state';
const POLL_MS = 3000;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CFG = window.KANTOR || {};
const TEAM_NAMES = Array.isArray(CFG.team) && CFG.team.length === 4 ? CFG.team : ['Budi', 'Sari', 'Agus', 'Rina'];
const KETUA_NAME = typeof CFG.ketua === 'string' ? CFG.ketua : 'Joko';
const COLORS = CFG.colors || { ketua: '#6a55c9', team: ['#3f6fd1', '#2f9a6d', '#d9772f', '#c2417a'], freelancers: ['#0f8fa3'] };
const NAMES_SIG = [KETUA_NAME, ...TEAM_NAMES].join('|');
const SPARE = Math.max(0, Math.min(4, Number(CFG.spare_desks) || 4));

// ---------------------------------------------------------------- bantuan umum
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtHm = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNum = new Intl.NumberFormat('id-ID');
const fmtCompact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
const hhmmss = (iso) => (iso ? fmtTime.format(new Date(iso)).replace(/\./g, ':') : '');
const hhmm = (iso) => (iso ? fmtHm.format(new Date(iso)).replace(/\./g, ':') : '');
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return fmtDate.format(new Date(iso));
};
const dur = (a, b) => {
  const s = Math.max(0, ((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  return `${Math.floor(s / 3600)} j ${Math.round((s % 3600) / 60)} m`;
};
const clip = (s, n) => {
  const a = Array.from(String(s ?? ''));
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join('');
};
const initial = (s) => Array.from(String(s || '?'))[0].toUpperCase();
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const STATE_UI = {
  bekerja: { label: 'Bekerja', css: '#1f9d57' },
  selesai: { label: 'Selesai', css: '#0f7f8f' },
  santai: { label: 'Santai', css: '#8a8378' },
};
const RUN_UI = {
  bekerja: { label: 'Bekerja', css: '#1f9d57' },
  selesai: { label: 'Selesai', css: '#0f7f8f' },
  terhenti: { label: 'Terhenti', css: '#c46a1c' },
  limit: { label: 'Limit', css: '#c43d3d' },
};
const TODO_STATUS = {
  pending: { label: 'Rencana', css: '#9a938a', note: '#fff1a8' },
  in_progress: { label: 'Dikerjakan', css: '#2f9a6d', note: '#c9ecd6' },
  completed: { label: 'Selesai', css: '#2f9a6d', note: '#dff1e3' },
};

// ---------------------------------------------------------------- renderer
const host = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch {
  renderer = null;
}
const HAS_GL = !!renderer;
if (!HAS_GL) {
  document.body.classList.add('nogl-on');
  renderer = { domElement: document.createElement('canvas'), setSize() {}, setPixelRatio() {}, render() {}, capabilities: { getMaxAnisotropy: () => 1 }, shadowMap: {} };
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
if (HAS_GL) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
host.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
$('labels').appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e3da');
if (HAS_GL) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
}
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 140);
// sudut kamera awal: layar sempit (ponsel) sedikit lebih jauh & bergeser ke kiri agar meja Ketua terlihat
const HOME = innerWidth < 820
  ? { pos: new THREE.Vector3(-2.2, 14.5, 19.5), target: new THREE.Vector3(-1.9, 0.4, -1.4) }
  : { pos: new THREE.Vector3(-1.2, 12.5, 16.8), target: new THREE.Vector3(-1.0, 0.6, -1.2) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = !REDUCED;
controls.dampingFactor = 0.07;
controls.minDistance = 5;
controls.maxDistance = 34;
controls.minPolarAngle = 0.3;
controls.maxPolarAngle = 1.36;
controls.minAzimuthAngle = -0.8;
controls.maxAzimuthAngle = 1.25;

const hemi = new THREE.HemisphereLight('#fdf7ef', '#c9b9a3', 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1dc', 2.3);
sun.position.set(8, 14, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 13, bottom: -13, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// ---------------------------------------------------------------- material / mesh / tekstur
const matCache = new Map();
function mat(color, rough = 0.8, metal = 0) {
  const k = `${color}|${rough}|${metal}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  return matCache.get(k);
}
function mesh(geo, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const box = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
function canvasTex(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { canvas: c, ctx: c.getContext('2d'), tex: t };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fit(ctx, text, maxW) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
function wrap(ctx, text, x, y, maxW, lh, maxLines) {
  const words = String(text || '').split(/\s+/);
  let line = '';
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) {
        ctx.fillText(fit(ctx, `${line} ${words.slice(i).join(' ')}`, maxW), x, y);
        return y + lh;
      }
      ctx.fillText(line, x, y);
      y += lh;
      line = words[i];
    } else line = test;
  }
  if (line) ctx.fillText(fit(ctx, line, maxW), x, y);
  return y + lh;
}
const HAND = '"Patrick Hand", "Chalkboard SE", "Comic Sans MS", "Segoe Print", cursive';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const V = (x, z) => new THREE.Vector3(x, 0, z);

// ---------------------------------------------------------------- ruangan
const ROOM = { x0: -10, x1: 10, z0: -7, z1: 6, h: 5.2 };
const CORRIDOR_Z = -2.1;
(function buildRoom() {
  const fl = canvasTex(1024, 1024);
  const r = rng(11);
  const plankH = 64;
  for (let y = 0; y < 1024; y += plankH) {
    let x = -Math.floor(r() * 300);
    while (x < 1024) {
      const w = 260 + r() * 260;
      fl.ctx.fillStyle = `hsl(${30 + r() * 6}, ${38 + r() * 8}%, ${62 + r() * 10}%)`;
      fl.ctx.fillRect(x, y, w, plankH);
      fl.ctx.fillStyle = 'rgba(90,60,30,.10)';
      for (let g = 0; g < 5; g++) fl.ctx.fillRect(x, y + 8 + r() * 48, w, 1.5);
      fl.ctx.fillStyle = 'rgba(70,45,20,.35)';
      fl.ctx.fillRect(x, y, 2, plankH);
      x += w;
    }
    fl.ctx.fillStyle = 'rgba(70,45,20,.35)';
    fl.ctx.fillRect(0, y, 1024, 2);
  }
  fl.tex.wrapS = fl.tex.wrapT = THREE.RepeatWrapping;
  fl.tex.repeat.set(4, 3);
  const W = ROOM.x1 - ROOM.x0;
  const D = ROOM.z1 - ROOM.z0;
  const cx = (ROOM.x0 + ROOM.x1) / 2;
  const cz = (ROOM.z0 + ROOM.z1) / 2;
  const floor = mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: fl.tex, roughness: 0.72 }), { cast: false });
  floor.position.set(cx, 0, cz);
  scene.add(floor);
  const slab = mesh(new THREE.BoxGeometry(W + 0.6, 0.35, D + 0.6), mat('#d8cdbf', 0.9), { cast: false });
  slab.position.set(cx, -0.18, cz - 0.15);
  scene.add(slab);
  const wallM = mat('#f1ebe2', 0.95);
  const back = mesh(new THREE.BoxGeometry(W + 0.6, ROOM.h, 0.3), wallM, { cast: false });
  back.position.set(cx, ROOM.h / 2, ROOM.z0 - 0.15);
  scene.add(back);
  // dinding kiri dengan lubang pintu (z −2.65 … −1.55, tinggi 2.3)
  const DZ0 = CORRIDOR_Z - 0.55;
  const DZ1 = CORRIDOR_Z + 0.55;
  const DH = 2.3;
  const segA = mesh(new THREE.BoxGeometry(0.3, ROOM.h, DZ0 - (ROOM.z0 - 0.3)), wallM, { cast: false });
  segA.position.set(ROOM.x0 - 0.15, ROOM.h / 2, (DZ0 + ROOM.z0 - 0.3) / 2);
  const segB = mesh(new THREE.BoxGeometry(0.3, ROOM.h, ROOM.z1 - DZ1), wallM, { cast: false });
  segB.position.set(ROOM.x0 - 0.15, ROOM.h / 2, (ROOM.z1 + DZ1) / 2);
  const lintel = mesh(new THREE.BoxGeometry(0.3, ROOM.h - DH, DZ1 - DZ0), wallM, { cast: false });
  lintel.position.set(ROOM.x0 - 0.15, DH + (ROOM.h - DH) / 2, CORRIDOR_Z);
  scene.add(segA, segB, lintel);
  const baseM = mat('#d6cbbb', 0.8);
  const bb1 = mesh(new THREE.BoxGeometry(W, 0.14, 0.04), baseM);
  bb1.position.set(cx, 0.07, ROOM.z0 + 0.02);
  scene.add(bb1);
  for (const [z0, z1] of [[ROOM.z0, DZ0], [DZ1, ROOM.z1]]) {
    const bb = mesh(new THREE.BoxGeometry(0.04, 0.14, z1 - z0), baseM);
    bb.position.set(ROOM.x0 + 0.02, 0.07, (z0 + z1) / 2);
    const wain = mesh(new THREE.BoxGeometry(0.03, 1.0, z1 - z0), mat('#e4d9c9', 0.9), { cast: false });
    wain.position.set(ROOM.x0 + 0.02, 0.5, (z0 + z1) / 2);
    scene.add(bb, wain);
  }
})();

// pintu kantor (jalur masuk/keluar freelancer) — daun pintu berayun terbuka saat ada yang lewat
const door = (() => {
  const g = new THREE.Group();
  const frameM = mat('#fbfaf7', 0.6);
  const W = 1.1;
  const H = 2.3;
  for (const [w, h, d, x, y, z] of [[0.12, H + 0.1, 0.1, 0, H / 2, -W / 2 - 0.05], [0.12, H + 0.1, 0.1, 0, H / 2, W / 2 + 0.05], [0.12, 0.1, W + 0.2, 0, H + 0.05, 0]]) {
    const f = mesh(new THREE.BoxGeometry(w, h, d), frameM);
    f.position.set(x, y, z);
    g.add(f);
  }
  const hinge = new THREE.Group();
  hinge.position.set(-0.05, 0, -W / 2);
  const leaf = mesh(box(0.05, H - 0.04, W - 0.04, 0.02), mat('#9c7650', 0.55));
  leaf.position.set(0, H / 2, W / 2);
  const knob = mesh(new THREE.SphereGeometry(0.035, 12, 10), mat('#d9c38a', 0.3, 0.8));
  knob.position.set(0.05, 1.05, W - 0.14);
  const pane = mesh(new THREE.PlaneGeometry(0.4, 0.5), new THREE.MeshStandardMaterial({ color: '#cfe3f0', roughness: 0.1 }), { cast: false });
  pane.rotation.y = Math.PI / 2;
  pane.position.set(0.03, 1.65, W / 2);
  hinge.add(leaf, knob, pane);
  g.add(hinge);
  // plakat di atas pintu
  const sign = canvasTex(256, 64);
  sign.ctx.fillStyle = '#2f7d4f';
  sign.ctx.fillRect(0, 0, 256, 64);
  sign.ctx.fillStyle = '#fff';
  sign.ctx.font = `700 34px ${SANS}`;
  sign.ctx.textAlign = 'center';
  sign.ctx.fillText('MASUK', 128, 45);
  sign.tex.needsUpdate = true;
  const plate = mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshBasicMaterial({ map: sign.tex, toneMapped: false }), { cast: false });
  plate.rotation.y = Math.PI / 2;
  plate.position.set(0.07, H + 0.3, 0);
  g.add(plate);
  const mat2 = mesh(new THREE.PlaneGeometry(0.8, 1.1).rotateX(-Math.PI / 2), mat('#7d6a55', 1), { cast: false });
  mat2.position.set(0.55, 0.012, 0);
  g.add(mat2);
  g.position.set(ROOM.x0, 0, CORRIDOR_Z);
  scene.add(g);
  return { hinge, open: 0 };
})();

// jendela dengan langit (siang/malam mengikuti jam penonton)
const windows = [];
function buildWindow(cx, cy, w, h) {
  const sky = canvasTex(256, 256);
  const glass = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: sky.tex, toneMapped: false }), { cast: false });
  glass.position.set(cx, cy, ROOM.z0 + 0.02);
  scene.add(glass);
  const frameM = mat('#fbfaf7', 0.6);
  const t = 0.08;
  for (const [pw, ph, px, py] of [[w + t * 2, t, cx, cy + h / 2], [w + t * 2, t, cx, cy - h / 2], [t, h, cx - w / 2, cy], [t, h, cx + w / 2, cy], [t * 0.6, h, cx, cy], [w, t * 0.6, cx, cy + h * 0.15]]) {
    const f = mesh(new THREE.BoxGeometry(pw, ph, 0.08), frameM);
    f.position.set(px, py, ROOM.z0 + 0.05);
    scene.add(f);
  }
  const sill = mesh(box(w + 0.3, 0.06, 0.26), frameM);
  sill.position.set(cx, cy - h / 2 - 0.05, ROOM.z0 + 0.13);
  scene.add(sill);
  windows.push(sky);
}
buildWindow(3.5, 2.75, 2.0, 2.0);
buildWindow(6.3, 2.75, 2.0, 2.0);
function paintSky(night) {
  for (const s of windows) {
    const g = s.ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, night ? '#1d2745' : '#9fd0f5');
    g.addColorStop(1, night ? '#3a3f63' : '#e7f3fb');
    s.ctx.fillStyle = g;
    s.ctx.fillRect(0, 0, 256, 256);
    const r = rng(5);
    for (let x = 0; x < 256; x += 22 + r() * 18) {
      const bh = 40 + r() * 90;
      s.ctx.fillStyle = night ? '#2b3150' : '#c9d9e6';
      s.ctx.fillRect(x, 256 - bh, 20 + r() * 14, bh);
      if (night) {
        s.ctx.fillStyle = '#ffd98a';
        for (let k = 0; k < 6; k++) if (r() > 0.5) s.ctx.fillRect(x + 4 + r() * 12, 256 - bh + 8 + r() * (bh - 16), 3, 4);
      }
    }
    s.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- perabot
function plant(x, z, s = 1, seed = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  const pot = mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.42, 24), mat('#c8744b', 0.85));
  pot.position.y = 0.21;
  const soil = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 24), mat('#4a3526', 1));
  soil.position.y = 0.41;
  g.add(pot, soil);
  const r = rng(seed);
  const greens = ['#3f8f4f', '#4fa35d', '#367a45', '#5cae66'];
  for (let i = 0; i < 11; i++) {
    const leaf = mesh(new THREE.SphereGeometry(0.1, 12, 8), mat(greens[i % greens.length], 0.7));
    leaf.scale.set(1, 3.4 + r() * 1.6, 0.35);
    const a = (i / 11) * Math.PI * 2 + r() * 0.4;
    const tilt = 0.35 + r() * 0.45;
    leaf.position.set(Math.sin(a) * 0.12, 0.72 + r() * 0.2, Math.cos(a) * 0.12);
    leaf.rotation.set(Math.cos(a) * tilt, 0, -Math.sin(a) * tilt);
    g.add(leaf);
  }
  scene.add(g);
  return g;
}
function bookshelf(x, z, rotY) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  const wood = mat('#b98b5e', 0.7);
  const W = 1.8;
  const H = 2.1;
  const D = 0.38;
  for (const [w, h, d, px, py] of [[W, 0.05, D, 0, H], [W, 0.05, D, 0, 0.03], [0.05, H, D, -W / 2, H / 2], [0.05, H, D, W / 2, H / 2], [W, H, 0.02, 0, H / 2]]) {
    const p = mesh(new THREE.BoxGeometry(w, h, d), wood);
    p.position.set(px, py, d === 0.02 ? -D / 2 : 0);
    g.add(p);
  }
  const r = rng(3);
  const cols = ['#3f6fd1', '#d9772f', '#2f9a6d', '#7a5cc4', '#c94f4f', '#e2c16b', '#5d6b82', '#f0ece4'];
  for (let s = 0; s < 4; s++) {
    const y = 0.08 + s * 0.52;
    if (s > 0) {
      const shelf = mesh(new THREE.BoxGeometry(W - 0.06, 0.03, D - 0.02), wood);
      shelf.position.set(0, y - 0.03, 0);
      g.add(shelf);
    }
    let bx = -W / 2 + 0.08;
    while (bx < W / 2 - 0.2) {
      const bw = 0.05 + r() * 0.07;
      const bh = 0.28 + r() * 0.14;
      if (r() > 0.88) {
        bx += 0.18;
        continue;
      }
      const b = mesh(new THREE.BoxGeometry(bw, bh, 0.24), mat(cols[Math.floor(r() * cols.length)], 0.8));
      b.position.set(bx + bw / 2, y + bh / 2, 0.02);
      b.rotation.z = r() > 0.92 ? 0.2 : 0;
      g.add(b);
      bx += bw + 0.01;
    }
  }
  scene.add(g);
}
function officeChair(color = '#3a3f4a') {
  const g = new THREE.Group();
  const seatM = mat(color, 0.75);
  const dark = mat('#2a2d33', 0.5, 0.3);
  const seat = mesh(box(0.52, 0.09, 0.5, 0.04), seatM);
  seat.position.y = 0.48;
  const backrest = mesh(box(0.48, 0.58, 0.08, 0.04), seatM);
  backrest.position.set(0, 0.86, -0.25);
  backrest.rotation.x = -0.08;
  const post = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 10), dark);
  post.position.y = 0.27;
  g.add(seat, backrest, post);
  for (const s of [-1, 1]) {
    const arm = mesh(box(0.05, 0.05, 0.3, 0.02), dark);
    arm.position.set(s * 0.28, 0.68, -0.02);
    const armPost = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 8), dark);
    armPost.position.set(s * 0.28, 0.58, -0.1);
    g.add(arm, armPost);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.04, 0.03, 0.3), dark);
    leg.position.set(Math.sin(a) * 0.15, 0.08, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    const wheel = mesh(new THREE.SphereGeometry(0.035, 10, 8), dark);
    wheel.position.set(Math.sin(a) * 0.3, 0.035, Math.cos(a) * 0.3);
    g.add(leg, wheel);
  }
  return g;
}
function mugMesh(color) {
  const g = new THREE.Group();
  const cup = mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.11, 18), mat(color, 0.5));
  cup.position.y = 0.055;
  const handle = mesh(new THREE.TorusGeometry(0.03, 0.009, 8, 16), mat(color, 0.5));
  handle.position.set(0.055, 0.06, 0);
  handle.rotation.y = Math.PI / 2;
  const coffee = mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.005, 16), mat('#4b2e1c', 0.4));
  coffee.position.y = 0.105;
  g.add(cup, handle, coffee);
  return g;
}
function espressoMachine(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const steel = mat('#b9bec6', 0.25, 0.85);
  const dark = mat('#26282d', 0.4, 0.3);
  const body = mesh(box(0.62, 0.42, 0.42, 0.04), steel);
  body.position.y = 0.36;
  const top = mesh(box(0.64, 0.05, 0.44, 0.02), dark);
  top.position.y = 0.6;
  const base = mesh(box(0.62, 0.1, 0.46, 0.02), dark);
  base.position.y = 0.05;
  const tray = mesh(box(0.5, 0.02, 0.2, 0.005), mat('#9aa0a8', 0.3, 0.8));
  tray.position.set(0, 0.11, 0.2);
  const grp = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 16), steel);
  grp.position.set(-0.12, 0.22, 0.24);
  const handle = mesh(new THREE.CapsuleGeometry(0.014, 0.16, 4, 8), dark);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(-0.12, 0.2, 0.36);
  const cup = mugMesh('#ffffff');
  cup.scale.setScalar(0.7);
  cup.position.set(-0.12, 0.12, 0.2);
  g.add(body, top, base, tray, grp, handle, cup);
  const grinder = new THREE.Group();
  grinder.position.set(0.5, 0, 0);
  const gb = mesh(box(0.16, 0.3, 0.2, 0.03), dark);
  gb.position.y = 0.15;
  const hopper = mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.18, 18), new THREE.MeshStandardMaterial({ color: '#c8a27a', transparent: true, opacity: 0.55, roughness: 0.1 }));
  hopper.position.y = 0.39;
  const beans = mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.1, 18), mat('#4b2e1c', 0.8));
  beans.position.y = 0.36;
  grinder.add(gb, beans, hopper);
  g.add(grinder);
  return g;
}
function waterDispenser(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const white = mat('#f4f3ef', 0.5);
  const body = mesh(box(0.36, 1.0, 0.36, 0.04), white);
  body.position.y = 0.5;
  const panel = mesh(box(0.26, 0.2, 0.02, 0.01), mat('#d9dde3', 0.4));
  panel.position.set(0, 0.82, 0.18);
  const tapHot = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), mat('#d64545', 0.4));
  tapHot.position.set(-0.06, 0.63, 0.2);
  tapHot.rotation.x = Math.PI / 2;
  const tapCold = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), mat('#3f6fd1', 0.4));
  tapCold.position.set(0.06, 0.63, 0.2);
  tapCold.rotation.x = Math.PI / 2;
  const bottle = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 24), new THREE.MeshStandardMaterial({ color: '#8fc6f0', transparent: true, opacity: 0.55, roughness: 0.05 }));
  bottle.position.y = 1.23;
  const water = mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.3, 24), new THREE.MeshStandardMaterial({ color: '#5aa6e0', transparent: true, opacity: 0.45 }));
  water.position.y = 1.17;
  g.add(body, panel, tapHot, tapCold, water, bottle);
  return g;
}
function gamepad(color) {
  const g = new THREE.Group();
  const shell = mat(color, 0.35);
  const accent = mat(color === '#1d1f24' ? '#3a3d44' : '#1d1f24', 0.4);
  g.add(mesh(box(0.16, 0.035, 0.08, 0.015), shell));
  for (const s of [-1, 1]) {
    const grip = mesh(new THREE.CapsuleGeometry(0.024, 0.05, 4, 10), shell);
    grip.rotation.x = Math.PI / 2 - 0.25;
    grip.rotation.z = s * 0.35;
    grip.position.set(s * 0.065, -0.008, 0.045);
    const stick = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 12), accent);
    stick.position.set(s * 0.03, 0.025, 0.02);
    g.add(grip, stick);
  }
  return g;
}
// TV + konsol generik; layar layanan streaming fiktif "TONTON"
const tvScreen = canvasTex(1280, 720);
function drawTv() {
  const { ctx, tex } = tvScreen;
  const W = 1280;
  const H = 720;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#141414');
  g.addColorStop(1, '#231515');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e50914';
  ctx.font = `800 58px ${SANS}`;
  ctx.fillText('TONTON', 48, 84);
  ctx.fillStyle = '#d0d0d0';
  ctx.font = `500 24px ${SANS}`;
  ['Beranda', 'Serial', 'Film', 'Daftar Saya'].forEach((t, i) => ctx.fillText(t, 330 + i * 150, 76));
  const hero = ctx.createLinearGradient(0, 120, 0, 460);
  hero.addColorStop(0, '#3a1f4f');
  hero.addColorStop(1, '#141414');
  ctx.fillStyle = hero;
  ctx.fillRect(48, 120, W - 96, 320);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 64px ${SANS}`;
  ctx.fillText('Jejak Rempah', 90, 260);
  ctx.font = `500 26px ${SANS}`;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillText('Serial dokumenter · Musim 2 · Episode baru tiap Jumat', 90, 306);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 90, 340, 170, 58, 8);
  ctx.fill();
  ctx.fillStyle = '#141414';
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText('▶  Putar', 118, 378);
  ctx.fillStyle = 'rgba(120,120,120,.7)';
  roundRect(ctx, 280, 340, 220, 58, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText('ⓘ  Info lanjut', 304, 378);
  ctx.fillStyle = '#e6e6e6';
  ctx.fillText('Lanjutkan menonton', 48, 494);
  ['#7a3b2e', '#2e5a7a', '#5a7a2e', '#6f5bbd', '#b8862b', '#2e7a6a'].forEach((c, i) => {
    const tx = 48 + i * 200;
    const tg = ctx.createLinearGradient(tx, 510, tx + 186, 690);
    tg.addColorStop(0, c);
    tg.addColorStop(1, '#141414');
    ctx.fillStyle = tg;
    roundRect(ctx, tx, 512, 186, 150, 8);
    ctx.fill();
    ctx.fillStyle = '#e50914';
    ctx.fillRect(tx, 656, 60 + ((i * 37) % 110), 5);
  });
  tex.needsUpdate = true;
}
function drawGame(t, name) {
  const { ctx, tex } = tvScreen;
  const W = 1280;
  const H = 720;
  const hz = H * 0.42;
  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#2f5fcf');
  sky.addColorStop(1, '#a4cfff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, hz);
  ctx.fillStyle = '#5a7fa8';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 240 - 60, hz);
    ctx.lineTo(i * 240 + 60, hz - 90 - (i % 2) * 40);
    ctx.lineTo(i * 240 + 180, hz);
    ctx.fill();
  }
  ctx.fillStyle = '#3f9b4f';
  ctx.fillRect(0, hz, W, H - hz);
  ctx.fillStyle = '#44474f';
  ctx.beginPath();
  ctx.moveTo(W * 0.47, hz);
  ctx.lineTo(W * 0.53, hz);
  ctx.lineTo(W * 0.98, H);
  ctx.lineTo(W * 0.02, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f4f4f4';
  for (let k = 0; k < 10; k++) {
    const z = (k + ((t * 2.5) % 1)) / 10;
    const y = hz + z * z * (H - hz);
    const w = 3 + z * 26;
    ctx.fillRect(W / 2 - w / 2, y, w, 4 + z * 34);
  }
  const ox = W / 2 + Math.sin(t * 0.7) * 150;
  ctx.fillStyle = '#d64545';
  ctx.fillRect(ox - 40, hz + 110, 80, 44);
  const px = W / 2 + Math.sin(t * 1.3) * 180;
  ctx.fillStyle = '#3f6fd1';
  ctx.fillRect(px - 110, H - 170, 220, 110);
  ctx.fillStyle = '#1d1f24';
  ctx.fillRect(px - 100, H - 70, 50, 20);
  ctx.fillRect(px + 50, H - 70, 50, 20);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(24, 22, 380, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText(fit(ctx, `P1 · ${name}`, 340), 44, 66);
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(`LAP ${1 + (Math.floor(t / 20) % 3)}/3 · POS ${1 + (Math.floor(t / 7) % 4)}`, 44, 102);
  tex.needsUpdate = true;
}
function tvCorner(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const wood = mat('#7a5a40', 0.6);
  const stand = mesh(box(2.2, 0.45, 0.45, 0.03), wood);
  stand.position.y = 0.225;
  const doors = mesh(box(2.1, 0.3, 0.02, 0.01), mat('#8c6a4f', 0.5));
  doors.position.set(0, 0.23, 0.23);
  const tvBody = mesh(box(1.78, 1.02, 0.05, 0.02), mat('#111215', 0.35, 0.2));
  tvBody.position.set(0, 1.12, -0.02);
  const scr = mesh(new THREE.PlaneGeometry(1.72, 0.97), new THREE.MeshBasicMaterial({ map: tvScreen.tex, toneMapped: false }), { cast: false });
  scr.position.set(0, 1.12, 0.006);
  const neck = mesh(box(0.08, 0.16, 0.06, 0.01), mat('#2a2c31', 0.4, 0.4));
  neck.position.set(0, 0.54, -0.02);
  const foot = mesh(box(0.5, 0.02, 0.22, 0.01), mat('#2a2c31', 0.4, 0.4));
  foot.position.set(0, 0.46, 0);
  const glow = new THREE.PointLight('#8f6bd8', 1.2, 3, 2);
  glow.position.set(0, 1.1, 0.6);
  g.add(stand, doors, tvBody, scr, neck, foot, glow);
  const ps = new THREE.Group();
  ps.position.set(0.82, 0.45, 0.02);
  for (const [w, x2, c] of [[0.05, -0.035, '#f4f4f6'], [0.04, 0, '#1d1f24'], [0.05, 0.035, '#f4f4f6']]) {
    const sh = mesh(box(w, 0.4, 0.26, 0.01), mat(c, 0.35));
    sh.position.set(x2, 0.2, 0);
    ps.add(sh);
  }
  const led = mesh(box(0.004, 0.3, 0.004, 0.001), new THREE.MeshBasicMaterial({ color: '#6fb6ff', toneMapped: false }));
  led.position.set(0, 0.22, 0.125);
  ps.add(led);
  g.add(ps);
  const bar = mesh(box(1.0, 0.07, 0.1, 0.03), mat('#1d1f24', 0.5));
  bar.position.set(0, 0.49, 0.12);
  g.add(bar);
  return g;
}
drawTv();

const MEET = { x: -5.2, z: 3.7 };
const LOUNGE_PADS = [];
(function buildFurniture() {
  bookshelf(ROOM.x0 + 0.25, 3.8, Math.PI / 2);
  plant(ROOM.x0 + 0.6, ROOM.z0 + 0.6, 1.25, 2);
  plant(6.6, ROOM.z0 + 0.6, 1.0, 4);
  plant(ROOM.x0 + 0.6, 1.2, 1.0, 6);
  plant(ROOM.x1 - 0.7, 5.2, 1.3, 8);
  plant(7.4, 2.3, 0.9, 14);
  // pojok kopi (dinding belakang kanan)
  const counter = mesh(box(2.4, 0.95, 0.9, 0.03), mat('#ece5da', 0.7));
  counter.position.set(8.2, 0.475, ROOM.z0 + 0.55);
  const top = mesh(box(2.5, 0.05, 0.98, 0.02), mat('#8c6a4f', 0.5));
  top.position.set(8.2, 0.97, ROOM.z0 + 0.55);
  const shelf = mesh(box(1.6, 0.04, 0.3, 0.01), mat('#8c6a4f', 0.5));
  shelf.position.set(8.2, 1.75, ROOM.z0 + 0.18);
  scene.add(counter, top, shelf, espressoMachine(7.7, 0.995, ROOM.z0 + 0.55));
  const disp = waterDispenser(ROOM.x1 - 0.45, 0, ROOM.z0 + 1.55);
  disp.rotation.y = -Math.PI / 2;
  scene.add(disp);
  [['#e8e2d6', 8.85], ['#3f6fd1', 9.1], ['#d9772f', 8.6]].forEach(([c, x]) => {
    const m = mugMesh(c);
    m.position.set(x, 0.995, ROOM.z0 + 0.7);
    const sm = mugMesh(c);
    sm.position.set(x - 0.9, 1.77, ROOM.z0 + 0.18);
    scene.add(m, sm);
  });
  // meja rapat bundar + karpet (depan kiri)
  const rug = mesh(new THREE.CircleGeometry(2.3, 48).rotateX(-Math.PI / 2), mat('#cdbba4', 1), { cast: false });
  rug.position.set(MEET.x, 0.01, MEET.z);
  const tbl = mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.05, 40), mat('#e9e2d6', 0.5));
  tbl.position.set(MEET.x, 0.74, MEET.z);
  const leg = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.72, 12), mat('#8a8f98', 0.4, 0.6));
  leg.position.set(MEET.x, 0.37, MEET.z);
  const foot = mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.04, 24), mat('#8a8f98', 0.4, 0.6));
  foot.position.set(MEET.x, 0.02, MEET.z);
  scene.add(rug, tbl, leg, foot);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    const c = officeChair('#b9a58c');
    c.position.set(MEET.x + Math.sin(a) * 1.35, 0, MEET.z + Math.cos(a) * 1.35);
    c.rotation.y = a + Math.PI;
    scene.add(c);
  }
  const laptop = new THREE.Group();
  const lb = mesh(box(0.42, 0.02, 0.3, 0.01), mat('#c9ccd2', 0.3, 0.7));
  const ls = mesh(box(0.42, 0.28, 0.015, 0.01), mat('#c9ccd2', 0.3, 0.7));
  ls.position.set(0, 0.14, -0.15);
  ls.rotation.x = -0.25;
  laptop.add(lb, ls);
  laptop.position.set(MEET.x + 0.2, 0.78, MEET.z - 0.1);
  laptop.rotation.y = 0.4;
  scene.add(laptop);
  // sudut santai: sofa menghadap TV
  const lounge = new THREE.Group();
  lounge.position.set(4.9, 0, 1.45);
  lounge.rotation.y = Math.PI;
  const fabric = mat('#6f8f86', 0.95);
  const sofaBase = mesh(box(2.6, 0.42, 0.95, 0.12), fabric);
  sofaBase.position.set(0, 0.3, 0);
  const sofaBack = mesh(box(2.6, 0.62, 0.25, 0.1), fabric);
  sofaBack.position.set(0, 0.7, -0.38);
  lounge.add(sofaBase, sofaBack);
  for (const s of [-1, 1]) {
    const armR = mesh(box(0.24, 0.55, 0.95, 0.1), fabric);
    armR.position.set(s * 1.32, 0.45, 0);
    const cushion = mesh(box(1.18, 0.14, 0.72, 0.07), mat('#7fa198', 0.95));
    cushion.position.set(s * 0.6, 0.57, 0.08);
    lounge.add(armR, cushion);
  }
  const pillow = mesh(box(0.42, 0.36, 0.14, 0.07), mat('#e2c16b', 0.9));
  pillow.position.set(-0.85, 0.78, -0.18);
  pillow.rotation.set(-0.2, 0.3, 0.15);
  const low = mesh(box(1.2, 0.06, 0.6, 0.03), mat('#8c6a4f', 0.5));
  low.position.set(0, 0.42, 1.05);
  lounge.add(pillow, low);
  for (const [lx, lz] of [[-0.5, 0.8], [0.5, 0.8], [-0.5, 1.3], [0.5, 1.3]]) {
    const lg = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), mat('#3a3d44', 0.4, 0.5));
    lg.position.set(lx, 0.2, lz);
    lounge.add(lg);
  }
  const magazine = mesh(box(0.32, 0.015, 0.24, 0.005), mat('#d9772f', 0.8));
  magazine.position.set(-0.2, 0.46, 1.0);
  magazine.rotation.y = 0.3;
  const loungeMug = mugMesh('#f0ece4');
  loungeMug.position.set(0.3, 0.45, 1.1);
  const loungeRug = mesh(new THREE.PlaneGeometry(3.4, 2.4).rotateX(-Math.PI / 2), mat('#d9cbb5', 1), { cast: false });
  loungeRug.position.set(0, 0.012, 0.6);
  lounge.add(magazine, loungeMug, loungeRug);
  const pad1 = gamepad('#f4f4f6');
  pad1.position.set(-0.35, 0.47, 1.05);
  pad1.rotation.y = 0.5;
  const pad2 = gamepad('#1d1f24');
  pad2.position.set(0.1, 0.47, 0.95);
  pad2.rotation.y = -0.3;
  lounge.add(pad1, pad2);
  LOUNGE_PADS.push(pad1, pad2);
  scene.add(lounge, tvCorner(4.9, 0, -1.3));
})();

// ---------------------------------------------------------------- papan dinding
function wallBoard({ w, h, cw, ch, pos, rotY }) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.rotation.y = rotY;
  const t = canvasTex(cw, ch);
  const face = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t.tex, roughness: 0.35 }), { cast: false });
  face.position.z = 0.03;
  g.add(face);
  const fm = mat('#b9bec6', 0.4, 0.5);
  for (const [fw, fh, px, py] of [[w + 0.1, 0.06, 0, h / 2], [w + 0.1, 0.06, 0, -h / 2], [0.06, h, -w / 2, 0], [0.06, h, w / 2, 0]]) {
    const f = mesh(new THREE.BoxGeometry(fw, fh, 0.06), fm);
    f.position.set(px, py, 0.03);
    g.add(f);
  }
  const tray = mesh(box(w * 0.5, 0.05, 0.1, 0.02), fm);
  tray.position.set(0, -h / 2 - 0.05, 0.08);
  g.add(tray);
  ['#2f5bd3', '#d64545', '#23a55f'].forEach((c, i) => {
    const mk = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), mat(c, 0.5));
    mk.rotation.z = Math.PI / 2;
    mk.position.set(-0.3 + i * 0.22, -h / 2 - 0.02, 0.1);
    g.add(mk);
  });
  scene.add(g);
  return t;
}
const todoBoard = wallBoard({ w: 6.0, h: 2.5, cw: 2048, ch: 854, pos: new THREE.Vector3(-1.0, 2.8, ROOM.z0 + 0.02), rotY: 0 });
const histBoard = wallBoard({ w: 4.2, h: 2.4, cw: 1792, ch: 1024, pos: new THREE.Vector3(-7.2, 2.8, ROOM.z0 + 0.02), rotY: 0 });

const clockTex = canvasTex(256, 256);
(function buildClock() {
  const face = mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshStandardMaterial({ map: clockTex.tex, roughness: 0.4 }), { cast: false });
  face.position.set(8.6, 3.4, ROOM.z0 + 0.05);
  const rim = mesh(new THREE.TorusGeometry(0.43, 0.035, 10, 48), mat('#3a3d44', 0.4, 0.4));
  rim.position.copy(face.position);
  scene.add(face, rim);
})();
function drawClock() {
  const { ctx, tex } = clockTex;
  const now = new Date();
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#3a3d44';
  for (let i = 0; i < 12; i++) {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate((i / 12) * Math.PI * 2);
    ctx.fillRect(-3, -118, 6, i % 3 ? 14 : 24);
    ctx.restore();
  }
  const hand = (a, len, w, c) => {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate(a);
    ctx.fillStyle = c;
    ctx.fillRect(-w / 2, -len, w, len + 12);
    ctx.restore();
  };
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  hand(((h + m / 60) / 12) * Math.PI * 2, 62, 9, '#2b2a28');
  hand(((m + s / 60) / 60) * Math.PI * 2, 92, 6, '#2b2a28');
  hand((s / 60) * Math.PI * 2, 100, 2, '#d64545');
  ctx.fillStyle = '#d64545';
  ctx.beginPath();
  ctx.arc(128, 128, 7, 0, Math.PI * 2);
  ctx.fill();
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- karakter (dirakit prosedural)
const LOOKS = {
  ketua: { shirt: '#6f5bbd', pants: '#2d3140', skin: '#b97d52', hair: '#221a15', hairStyle: 'side', tie: true },
  team: [
    { shirt: '#4d7fd6', pants: '#3a4150', skin: '#c68a5e', hair: '#2a211c', hairStyle: 'short', glasses: true },
    { shirt: '#3a9b72', pants: '#2e333d', skin: '#d6a07a', hair: '#3b2a1f', hairStyle: 'bun' },
    { shirt: '#e38b4f', pants: '#4a4f5c', skin: '#a86e45', hair: '#191310', hairStyle: 'curly', headphones: true },
    { shirt: '#cf5a90', pants: '#34384a', skin: '#e0b08a', hair: '#5a3a22', hairStyle: 'long' },
  ],
};
function freelancerLook(name, color) {
  const r = rng(hash(name));
  const skins = ['#e0b08a', '#c68a5e', '#a86e45', '#8d5a3b', '#d6a07a', '#b07650'];
  const hairs = ['#140f0c', '#2b2016', '#5a3a22', '#3b2a1f', '#1c1512'];
  const styles = ['short', 'curly', 'bun', 'side', 'long'];
  return {
    shirt: lighten(color, 0.12), pants: ['#303542', '#3a3f4a', '#2f3440', '#4a4f5c'][Math.floor(r() * 4)],
    skin: skins[Math.floor(r() * skins.length)], hair: hairs[Math.floor(r() * hairs.length)], hairStyle: styles[Math.floor(r() * styles.length)],
    glasses: r() > 0.6, backpack: true,
  };
}
function lighten(hex, k = 0.14) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color('#ffffff'), k);
  return `#${c.getHexString()}`;
}
function buildPerson(cfg, key) {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.9;
  root.add(hips);
  const pantsM = mat(cfg.pants, 0.85);
  const shirtM = mat(cfg.shirt, 0.8);
  const skinM = mat(cfg.skin, 0.6);
  const hairM = cfg.hairStyle === 'bun' || cfg.hairStyle === 'long'
    ? new THREE.MeshStandardMaterial({ color: cfg.hair, roughness: 0.75, side: THREE.DoubleSide })
    : mat(cfg.hair, 0.75);
  const shoeM = mat('#2b2622', 0.55);
  const dark = mat('#231c18', 0.4);
  const tag = (m) => {
    m.userData.key = key;
    return m;
  };
  hips.add(tag(mesh(box(0.34, 0.17, 0.22, 0.07), pantsM)));
  const spine = new THREE.Group();
  spine.position.y = 0.06;
  hips.add(spine);
  const torso = tag(mesh(new THREE.CapsuleGeometry(0.16, 0.26, 6, 18), shirtM));
  torso.scale.set(1.14, 1, 0.74);
  torso.position.y = 0.25;
  spine.add(torso);
  if (cfg.headphones) {
    const hood = mesh(new THREE.TorusGeometry(0.1, 0.035, 10, 20), shirtM);
    hood.position.set(0, 0.5, -0.08);
    hood.rotation.x = 1.2;
    spine.add(hood);
  } else {
    const collar = mesh(new THREE.TorusGeometry(0.07, 0.022, 8, 18, Math.PI * 1.3), mat('#ffffff', 0.7));
    collar.position.set(0, 0.5, 0.01);
    collar.rotation.set(Math.PI / 2 - 0.2, 0, Math.PI * 0.85);
    spine.add(collar);
  }
  if (cfg.tie) {
    const tie = mesh(box(0.05, 0.22, 0.02, 0.008), mat('#c9a227', 0.6));
    tie.position.set(0, 0.34, 0.125);
    tie.rotation.x = -0.12;
    spine.add(tie);
  }
  if (cfg.backpack) {
    const bag = mesh(box(0.28, 0.34, 0.14, 0.05), mat('#3d4452', 0.8));
    bag.position.set(0, 0.28, -0.17);
    const flap = mesh(box(0.26, 0.1, 0.02, 0.01), mat('#2f3540', 0.8));
    flap.position.set(0, 0.38, -0.245);
    spine.add(bag, flap);
  }
  const neck = mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.1, 12), skinM);
  neck.position.y = 0.53;
  spine.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.67;
  spine.add(head);
  const R = 0.128;
  const skull = tag(mesh(new THREE.SphereGeometry(R, 32, 24), skinM));
  skull.scale.set(1, 1.1, 1.02);
  head.add(skull);
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.016, 10, 8), dark);
    eye.position.set(s * 0.046, 0.012, R * 0.93);
    const brow = mesh(box(0.04, 0.008, 0.01, 0.003), hairM);
    brow.position.set(s * 0.047, 0.045, R * 0.96);
    const ear = mesh(new THREE.SphereGeometry(0.03, 10, 8), skinM);
    ear.scale.set(0.6, 1, 0.8);
    ear.position.set(s * R * 0.98, 0, 0);
    head.add(eye, brow, ear);
  }
  const nose = mesh(new THREE.SphereGeometry(0.018, 10, 8), skinM);
  nose.position.set(0, -0.012, R * 1.02);
  const mouth = mesh(new THREE.TorusGeometry(0.022, 0.005, 6, 12, Math.PI), mat('#7a3b2e', 0.6));
  mouth.position.set(0, -0.055, R * 0.93);
  mouth.rotation.z = Math.PI;
  head.add(nose, mouth);
  const cap = mesh(new THREE.SphereGeometry(R * 1.07, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.52), hairM);
  cap.position.set(0, 0.012, -0.012);
  cap.scale.set(1, 1.1, 1.04);
  head.add(cap);
  if (cfg.hairStyle === 'short' || cfg.hairStyle === 'side') {
    const backHair = mesh(new THREE.SphereGeometry(R * 1.04, 20, 14, Math.PI * 0.55, Math.PI * 0.9, Math.PI * 0.3, Math.PI * 0.35), hairM);
    backHair.position.y = -0.01;
    head.add(backHair);
    if (cfg.hairStyle === 'side') {
      const part = mesh(box(0.1, 0.03, 0.06, 0.012), hairM);
      part.position.set(0.05, 0.1, 0.08);
      part.rotation.z = -0.25;
      head.add(part);
    }
  } else if (cfg.hairStyle === 'curly') {
    const r = rng(9);
    for (let i = 0; i < 16; i++) {
      const c = mesh(new THREE.SphereGeometry(0.038, 10, 8), hairM);
      const a = r() * Math.PI * 2;
      const up = 0.3 + r() * 0.6;
      c.position.set(Math.sin(a) * R * 0.9 * Math.cos(up), R * 0.55 + Math.sin(up) * 0.06, Math.cos(a) * R * 0.85 * Math.cos(up) - 0.015);
      head.add(c);
    }
  } else if (cfg.hairStyle === 'bun' || cfg.hairStyle === 'long') {
    const longHair = cfg.hairStyle === 'long';
    const hang = mesh(new THREE.CylinderGeometry(R * 1.02, R * (longHair ? 1.18 : 1.1), longHair ? 0.4 : 0.26, 20, 1, true, Math.PI * 0.62, Math.PI * 0.76), hairM);
    hang.position.y = longHair ? -0.14 : -0.08;
    const fringe = mesh(new THREE.SphereGeometry(R * 1.05, 20, 10, Math.PI * 1.7, Math.PI * 0.6, 0.2, 0.55), hairM);
    head.add(hang, fringe);
    if (!longHair) {
      const bun = mesh(new THREE.SphereGeometry(0.058, 14, 10), hairM);
      bun.position.set(0, 0.12, -0.1);
      head.add(bun);
    }
  }
  if (cfg.glasses) {
    const gm = mat('#1f2328', 0.3, 0.4);
    for (const s of [-1, 1]) {
      const ring = mesh(new THREE.TorusGeometry(0.03, 0.005, 8, 20), gm);
      ring.position.set(s * 0.047, 0.012, R * 1.01);
      head.add(ring);
    }
    const bridge = mesh(new THREE.BoxGeometry(0.03, 0.005, 0.005), gm);
    bridge.position.set(0, 0.015, R * 1.03);
    head.add(bridge);
  }
  if (cfg.headphones) {
    const hm = mat('#2b2f36', 0.45, 0.2);
    const band = mesh(new THREE.TorusGeometry(R * 1.12, 0.014, 8, 28, Math.PI), hm);
    band.position.y = 0.01;
    head.add(band);
    for (const s of [-1, 1]) {
      const cup = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 16), mat(cfg.shirt, 0.5));
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * R * 1.05, 0, 0);
      head.add(cup);
    }
  }
  const sh = [];
  const el = [];
  const hand = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.2, 0.44, 0);
    spine.add(shoulder);
    const upper = tag(mesh(new THREE.CapsuleGeometry(0.05, 0.19, 4, 12), shirtM));
    upper.position.y = -0.14;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    const fore = tag(mesh(new THREE.CapsuleGeometry(0.043, 0.17, 4, 12), shirtM));
    fore.position.y = -0.12;
    elbow.add(fore);
    const h = mesh(new THREE.SphereGeometry(0.047, 12, 10), skinM);
    h.position.y = -0.26;
    h.scale.set(0.9, 1.1, 0.7);
    elbow.add(h);
    sh.push(shoulder);
    el.push(elbow);
    hand.push(h);
  }
  const hip = [];
  const knee = [];
  for (const s of [-1, 1]) {
    const hp = new THREE.Group();
    hp.position.set(s * 0.095, -0.03, 0);
    hips.add(hp);
    const thigh = tag(mesh(new THREE.CapsuleGeometry(0.068, 0.26, 4, 12), pantsM));
    thigh.position.y = -0.2;
    hp.add(thigh);
    const kn = new THREE.Group();
    kn.position.y = -0.41;
    hp.add(kn);
    const shin = mesh(new THREE.CapsuleGeometry(0.058, 0.27, 4, 12), pantsM);
    shin.position.y = -0.18;
    kn.add(shin);
    const foot = mesh(box(0.11, 0.07, 0.23, 0.03), shoeM);
    foot.position.set(0, -0.4, 0.05);
    kn.add(foot);
    hip.push(hp);
    knee.push(kn);
  }
  return { root, hips, spine, head, sh, el, hand, hip, knee, nod: 0 };
}
const lerpK = (a, b, k) => a + (b - a) * k;
function applyPose(p, T, dt) {
  const k = REDUCED ? 1 : Math.min(1, dt * 7);
  p.spine.rotation.x = lerpK(p.spine.rotation.x, T.spineX ?? 0, k);
  p.spine.rotation.z = lerpK(p.spine.rotation.z, T.spineZ ?? 0, k);
  p.head.rotation.x = lerpK(p.head.rotation.x, (T.headX ?? 0) + p.nod, Math.min(1, k * 1.4));
  p.head.rotation.y = lerpK(p.head.rotation.y, T.headY ?? 0, k);
  p.head.rotation.z = lerpK(p.head.rotation.z, T.headZ ?? 0, k);
  const side = ['l', 'r'];
  for (let i = 0; i < 2; i++) {
    const s = side[i];
    p.sh[i].rotation.x = lerpK(p.sh[i].rotation.x, T[`${s}ShX`] ?? 0, k);
    p.sh[i].rotation.z = lerpK(p.sh[i].rotation.z, T[`${s}ShZ`] ?? (i ? -0.08 : 0.08), k);
    p.el[i].rotation.x = lerpK(p.el[i].rotation.x, T[`${s}ElX`] ?? 0, k);
    p.el[i].rotation.z = lerpK(p.el[i].rotation.z, T[`${s}ElZ`] ?? 0, k);
    p.hip[i].rotation.x = lerpK(p.hip[i].rotation.x, T[`${s}HipX`] ?? 0, Math.min(1, k * 1.5));
    p.knee[i].rotation.x = lerpK(p.knee[i].rotation.x, T[`${s}KneeX`] ?? 0, Math.min(1, k * 1.5));
  }
  p.hips.position.y = lerpK(p.hips.position.y, T.hipsY ?? p.hips.position.y, k);
}
const SEATED = { hipsY: 0.57, lHipX: -1.5, rHipX: -1.5, lKneeX: 1.45, rKneeX: 1.45 };
function seatedPose(mode, t, seed) {
  const T = { ...SEATED };
  const tw = Math.sin(t * 13 + seed);
  switch (mode) {
    case 'type':
    case 'terminal':
      Object.assign(T, { spineX: 0.12, headX: 0.08 + Math.sin(t * 1.3 + seed) * 0.03, headY: mode === 'terminal' ? -0.35 + Math.sin(t * 0.4) * 0.1 : Math.sin(t * 0.5 + seed) * 0.08,
        lShX: -0.62, lShZ: 0.2, lElX: -0.95 + tw * 0.09, rShX: -0.62, rShZ: -0.2, rElX: -0.95 - tw * 0.09 });
      break;
    case 'read':
      Object.assign(T, { spineX: 0.05, headX: 0.04, headY: Math.sin(t * 0.7 + seed) * 0.16,
        lShX: -0.38, lShZ: 0.32, lElX: -1.2, rShX: -0.5, rShZ: -0.02, rElX: -0.95 + Math.sin(t * 2.2) * 0.04 });
      break;
    case 'think':
      Object.assign(T, { spineX: -0.02, headX: -0.1, headZ: 0.1, headY: 0.15, lShX: -0.4, lShZ: 0.35, lElX: -1.25, rShX: -1.25, rShZ: -0.3, rElX: -2.1 });
      break;
    case 'done':
      Object.assign(T, { spineX: -0.2, headX: -0.15, lShX: -0.3, lShZ: -2.5, lElZ: 2.1, rShX: -0.3, rShZ: 2.5, rElZ: -2.1 });
      break;
    default:
      break;
  }
  return T;
}

// ---------------------------------------------------------------- meja kerja + monitor
function monitor(w, h) {
  const g = new THREE.Group();
  const bezel = mesh(box(w + 0.06, h + 0.06, 0.035, 0.015), mat('#22252b', 0.4, 0.2));
  const scr = canvasTex(1024, Math.round((1024 * h) / w));
  const screen = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }), { cast: false });
  screen.position.z = 0.019;
  const neck = mesh(new THREE.BoxGeometry(0.05, 0.22, 0.04), mat('#3a3d44', 0.4, 0.5));
  neck.position.set(0, -h / 2 - 0.08, -0.03);
  const foot = mesh(box(0.3, 0.02, 0.2, 0.01), mat('#3a3d44', 0.4, 0.5));
  foot.position.set(0, -h / 2 - 0.19, 0);
  g.add(bezel, screen, neck, foot);
  return { g, scr };
}
// meja: A0 = Ketua, A1–A4 = tim, B0–B3 = meja cadangan freelancer
const ROW_A_Z = -4.3;
const ROW_B_Z = -0.7;
const DESK_DEFS = [
  { id: 'A0', x: -7.0, z: ROW_A_Z, kind: 'ketua', color: COLORS.ketua },
  ...TEAM_NAMES.map((n, i) => ({ id: `A${i + 1}`, x: -4.2 + i * 2.8, z: ROW_A_Z, kind: 'tim', idx: i, color: COLORS.team[i % COLORS.team.length] })),
  ...Array.from({ length: SPARE }, (_, j) => ({ id: `B${j}`, x: -7.0 + j * 2.8, z: ROW_B_Z, kind: 'spare', idx: j, color: '#9a938a', gap: [-8.6, -5.6, -2.8, 2.8][j] })),
];
const desks = {};
function drawPlate(d, name, role, css) {
  const np = d.plate;
  np.ctx.fillStyle = '#fbfaf7';
  np.ctx.fillRect(0, 0, 512, 128);
  np.ctx.fillStyle = css;
  np.ctx.fillRect(0, 0, 14, 128);
  np.ctx.fillStyle = '#2b2a28';
  np.ctx.font = `700 50px ${SANS}`;
  np.ctx.fillText(fit(np.ctx, name, 450), 40, 62);
  np.ctx.fillStyle = '#6f6a62';
  np.ctx.font = `500 32px ${SANS}`;
  np.ctx.fillText(fit(np.ctx, role, 450), 40, 106);
  np.tex.needsUpdate = true;
}
function buildDesk(def) {
  const desk = new THREE.Group();
  desk.position.set(def.x, 0, def.z);
  scene.add(desk);
  const boss = def.kind === 'ketua';
  const wood = mat(boss ? '#8f6647' : '#c9a27a', 0.55);
  const top = mesh(box(2.3, 0.05, 1.05, 0.02), wood);
  top.position.y = 0.74;
  desk.add(top);
  const legM = mat(boss ? '#5f4632' : '#e9e4dc', 0.6);
  for (const s of [-1, 1]) {
    const panel = mesh(new THREE.BoxGeometry(0.04, 0.72, 0.95), legM);
    panel.position.set(s * 1.08, 0.36, 0);
    desk.add(panel);
  }
  const modesty = mesh(new THREE.BoxGeometry(2.1, 0.35, 0.03), legM);
  modesty.position.set(0, 0.52, -0.45);
  desk.add(modesty);
  const main = monitor(1.0, 0.58);
  main.g.position.set(-0.3, 1.26, -0.25);
  const side = monitor(0.82, 0.5);
  side.g.position.set(0.68, 1.22, -0.18);
  side.g.rotation.y = -0.35;
  desk.add(main.g, side.g);
  const kb = mesh(box(0.46, 0.022, 0.15, 0.008), mat('#e7e7ea', 0.5));
  kb.position.set(-0.25, 0.775, 0.3);
  const mouse = mesh(new THREE.CapsuleGeometry(0.025, 0.04, 4, 10), mat('#e7e7ea', 0.5));
  mouse.rotation.x = Math.PI / 2;
  mouse.scale.set(1, 1, 0.5);
  mouse.position.set(0.2, 0.78, 0.3);
  const deskMug = mugMesh(def.color);
  deskMug.position.set(0.8, 0.765, 0.3);
  const papers = mesh(box(0.3, 0.02, 0.4, 0.005), mat('#fbfaf6', 0.9));
  papers.position.set(-0.85, 0.775, 0.15);
  papers.rotation.y = 0.2;
  desk.add(kb, mouse, deskMug, papers);
  if (boss) {
    const p = plant(0, 0, 0.35, 12);
    scene.remove(p);
    p.position.set(-0.95, 0.765, -0.3);
    desk.add(p);
    const flagPole = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 6), mat('#b9bec6', 0.3, 0.8));
    flagPole.position.set(-0.6, 0.92, -0.3);
    desk.add(flagPole);
  } else if (def.kind === 'tim') {
    ['#fff1a8', '#ffd8b5', '#cfe0ff'].forEach((c, i) => {
      const n = mesh(new THREE.PlaneGeometry(0.07, 0.07), new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }), { cast: false });
      n.position.set(-0.78 + i * 0.08, 1.5 - (i % 2) * 0.05, -0.23);
      n.rotation.z = (i - 1) * 0.12;
      desk.add(n);
    });
  }
  const np = canvasTex(512, 128);
  const plate = mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshStandardMaterial({ map: np.tex, roughness: 0.5 }), { cast: false });
  plate.position.set(0.55, 0.81, 0.46);
  plate.rotation.x = -0.6;
  desk.add(plate);
  const lamp = new THREE.PointLight('#ffd9a0', 0, 5, 2);
  lamp.position.set(0, 1.9, 0.3);
  desk.add(lamp);
  const seat = new THREE.Group();
  seat.position.set(def.x, 0, def.z + 0.95);
  seat.rotation.y = Math.PI;
  scene.add(seat);
  seat.add(officeChair(boss ? '#5a3f33' : '#3a3f4a'));
  const d = { ...def, group: desk, seat, main, side, deskMug, lamp, plate: np, data: null, who: null, sig: '', drawnAt: 0, plateSig: '' };
  desks[def.id] = d;
  if (def.kind === 'ketua') drawPlate(d, KETUA_NAME, 'Ketua', def.color);
  else if (def.kind === 'tim') drawPlate(d, TEAM_NAMES[def.idx], 'Tim', def.color);
  else drawPlate(d, `Meja cadangan ${def.idx + 1}`, 'Freelancer', def.color);
}
DESK_DEFS.forEach(buildDesk);

// ---------------------------------------------------------------- tempat & jalur (koridor z = −2.1 + "jari" ke tiap tempat)
// Setiap tempat punya spoke: titik pertama di koridor, lalu titik-titik sampai posisi akhir. Rute A→B =
// mundur lewat spoke A ke koridor → sepanjang koridor → maju lewat spoke B. Bebas tabrakan dengan perabot.
const PLACES = {};
for (const d of Object.values(desks)) {
  const seatPos = V(d.x, d.z + 0.95);
  const spoke = d.z === ROW_A_Z ? [V(d.x, CORRIDOR_Z)] : [V(d.gap, CORRIDOR_Z), V(d.gap, 0.95), V(d.x, 0.95)];
  PLACES[`desk:${d.id}`] = { kind: 'desk', desk: d, pos: seatPos, heading: Math.PI, spoke };
}
const SPOTS = {
  tv: { pos: V(4.3, 1.25), heading: Math.PI, spoke: [V(3.2, CORRIDOR_Z), V(3.2, 1.05)], sit: 'sofa' },
  ps: { pos: V(5.5, 1.25), heading: Math.PI, spoke: [V(7.0, CORRIDOR_Z), V(6.9, 1.05)], sit: 'sofa' },
  coffee: { pos: V(7.7, -5.55), heading: Math.PI, spoke: [V(7.2, CORRIDOR_Z), V(7.4, -5.0)] },
  water: { pos: V(8.75, -5.45), heading: Math.PI / 2, spoke: [V(7.2, CORRIDOR_Z), V(7.4, -5.0)] },
  window: { pos: V(3.5, -6.15), heading: Math.PI, spoke: [V(6.3, CORRIDOR_Z), V(6.3, -5.6)] },
  guitar: { pos: V(-1.4, 2.6), heading: 0.35, spoke: [V(2.8, CORRIDOR_Z), V(2.8, 1.7)] },
  meet1: { pos: V(MEET.x + 0.585, MEET.z - 1.217), heading: -0.448, spoke: [V(-2.8, CORRIDOR_Z), V(-2.8, 1.2)], sit: 'chair' },
  meet2: { pos: V(MEET.x - 1.346, MEET.z + 0.103), heading: 1.648, spoke: [V(-8.6, CORRIDOR_Z), V(-8.6, 1.6), V(-7.6, 3.8)], sit: 'chair' },
  meet3: { pos: V(MEET.x + 0.762, MEET.z + 1.114), heading: -2.54, spoke: [V(-2.8, CORRIDOR_Z), V(-2.8, 1.2), V(-3.3, 4.6)], sit: 'chair' },
  bookshelf: { pos: V(-8.9, 3.8), heading: -Math.PI / 2, spoke: [V(-8.6, CORRIDOR_Z), V(-8.6, 2.4)] },
};
for (const [id, s] of Object.entries(SPOTS)) PLACES[`spot:${id}`] = { kind: 'spot', spot: id, ...s };
PLACES.door = { kind: 'door', pos: V(ROOM.x0 - 0.9, CORRIDOR_Z), heading: -Math.PI / 2, spoke: [V(ROOM.x0 + 0.6, CORRIDOR_Z)] };
const SPOT_IDS = Object.keys(SPOTS);

const QUIPS = {
  tv: ['Filmnya lagi seru nih 🍿', 'Eh, aktornya siapa ya?', 'Jangan di-skip dulu!', 'Episode ini bagus banget'],
  ps: ['Gooool! ⚽', 'Satu match lagi ah 🎮', 'Stiknya agak nge-drift nih', 'Tunggu, aku belum siap!'],
  coffee: ['Ngopi dulu biar melek ☕', 'Espresso double, please', 'Wangi banget kopinya', 'Gulanya di mana ya?'],
  water: ['Minum air putih dulu 💧', 'Galonnya tinggal dikit', 'Seger!', 'Airnya dingin, mantap'],
  guitar: ['🎸 jreng… jreng…', 'Request lagu dong', 'Kuncinya G atau C ya?', 'Senarnya perlu diganti'],
  window: ['Langitnya cerah ya ☀️', 'Peregangan dulu, pegal 🙆', 'Macet banget di bawah', 'Ada layangan tuh!'],
  meet1: ['Rapat lima menit, janji!', 'Siapa yang pesan kopi?', 'Kursinya empuk juga'],
  meet2: ['Diskusi ringan dulu ☕', 'Laptopnya siapa ini?', 'Duduk dulu ah'],
  meet3: ['Meja ini paling adem', 'Ngobrol santai dulu', 'Kita bahas nanti aja'],
  bookshelf: ['Buku ini seru juga 📚', 'Wah, ada komik!', 'Bukunya belum dikembalikan nih'],
};
// obrolan receh (sengaja tidak menyebut data nyata apa pun)
const CHAT = [
  ['{to}, main bola di PS yuk! Yang kalah traktir bakso', 'Ogah, kemarin aku kalah 3–0 😅'],
  ['Filmnya jangan di-spoiler ya, {to}!', 'Siap, mulutku terkunci 🤐'],
  ['Kopinya kok pahit banget?', 'Itu espresso, bukan kopi sachet 😂'],
  ['Galon siapa yang ngabisin?', 'Bukan aku, sumpah!'],
  ['Gitarnya fals dikit tuh, {to}', 'Namanya juga gitar kantor'],
  ['Besok hujan nggak ya?', 'Bawa payung aja biar aman ☔'],
  ['Ada gorengan nggak di pantry?', 'Tadi ada, udah habis 🙃'],
  ['Ngantuk banget habis makan siang', 'Sama, butuh kopi kedua'],
  ['Kucingku tadi pagi nyolong ikan', 'Wkwk pasti kucing oranye'],
  ['{to}, weekend mau ke mana?', 'Rebahan aja, paling mewah 😴'],
  ['Lagu apa ini? Enak juga', 'Lagu lama, tapi masih enak'],
  ['{to}, itu gelas kopi ketiga ya?', 'Biar fokus nanti 😆'],
  ['Kemarin nemu warung mi ayam enak', 'Wah, bagi lokasinya dong!'],
  ['{to}, kamu tim bubur diaduk?', 'Nggak diaduk dong, garis keras'],
  ['AC-nya dingin banget ya', 'Pakai jaket, jangan kalah sama AC'],
  ['{to}, headset-mu mana?', 'Lagi di-charge 🔋'],
  ['Martabak manis atau telur?', 'Dua-duanya, biar adil'],
  ['{to}, tanamannya udah disiram?', 'Udah, tadi pagi 🌱'],
  ['Kok tiba-tiba pengin nasi padang', 'Rendangnya jangan lupa!'],
  ['Siapa yang naruh kaus kaki di sofa?', 'Bukan punyaku… kayaknya 😬'],
  ['{to}, tadi berangkat naik apa?', 'Ojek, lancar jaya'],
  ['Hari ini kok cepat banget ya', 'Iya, tahu-tahu sore'],
  ['Pengin liburan ke pantai', 'Ajak-ajak dong!'],
  ['{to}, suka pedas nggak?', 'Level lima pun aman 🌶️'],
  ['Kursi ini bunyi kalau diduduki', 'Sudah dari dulu, jadi ciri khas'],
  ['Siapa yang pinjam spidol biru?', 'Ada di papan, tuh'],
  ['{to}, sudah sarapan?', 'Sudah, roti bakar 🍞'],
  ['Es teh atau es jeruk?', 'Es teh manis, selalu'],
  ['Jam dinding itu telat nggak sih?', 'Tepat kok, kitanya yang telat'],
  ['{to}, tim kucing atau tim anjing?', 'Tim kucing, jelas 🐈'],
  ['Kemarin nonton bola?', 'Ketiduran di babak pertama'],
  ['Hujan-hujan enaknya makan bakso', 'Setuju, kuahnya panas'],
  ['{to}, kaosmu baru ya?', 'Iya, diskon kemarin 😄'],
  ['Wah, bukunya ada yang baru', 'Siapa yang beli ya?'],
  ['Mau pesan kopi susu, ada yang nitip?', 'Aku! Gula dikit ya'],
  ['{to}, playlist-mu apa?', 'Campur aduk, dangdut sampai jazz'],
  ['Parkiran tadi penuh banget', 'Aku sampai muter dua kali'],
  ['Kayaknya perlu beli galon lagi', 'Nanti aku telepon depot'],
  ['{to}, jangan lupa minum air', 'Siap, bos air 💧'],
  ['Sore ini cerah ya', 'Enak buat jalan-jalan'],
];

// ---------------------------------------------------------------- aktor (Ketua, tim, freelancer)
const actors = new Map();
const pickables = [];
const tmpV = new THREE.Vector3();
function guitarMesh() {
  const g = new THREE.Group();
  const wood = mat('#b5703a', 0.5);
  const body = mesh(new THREE.SphereGeometry(0.13, 20, 14), wood);
  body.scale.set(1, 1.15, 0.35);
  const upper = mesh(new THREE.SphereGeometry(0.1, 18, 12), wood);
  upper.scale.set(1, 1, 0.35);
  upper.position.set(-0.13, 0.02, 0);
  const neck = mesh(new THREE.BoxGeometry(0.42, 0.04, 0.025), mat('#6b4423', 0.5));
  neck.position.set(-0.42, 0.02, 0.01);
  const head = mesh(box(0.1, 0.06, 0.03, 0.01), mat('#2b2622', 0.5));
  head.position.set(-0.68, 0.02, 0.01);
  g.add(body, upper, neck, head);
  return g;
}
function makeActor(def) {
  const p = buildPerson(def.look, def.key);
  scene.add(p.root);
  const guitar = guitarMesh();
  guitar.scale.x = -1;
  guitar.position.set(0.02, 0.2, 0.2);
  guitar.rotation.z = -0.35;
  guitar.visible = false;
  p.spine.add(guitar);
  const pad = gamepad('#1d1f24');
  pad.position.set(0, 0.1, 0.3);
  pad.rotation.x = -0.6;
  pad.visible = false;
  p.spine.add(pad);
  const book = mesh(box(0.2, 0.26, 0.03, 0.01), mat('#3f6fd1', 0.7));
  book.position.set(0, 0.12, 0.28);
  book.rotation.x = -0.9;
  book.visible = false;
  p.spine.add(book);
  const mug = mugMesh(def.color);
  mug.position.set(0.02, -0.09, 0.05);
  mug.rotation.z = Math.PI;
  mug.scale.setScalar(0.9);
  mug.visible = false;
  p.hand[1].add(mug);
  const el = document.createElement('div');
  el.className = 'person';
  el.style.setProperty('--c', def.color);
  el.innerHTML = def.kind === 'freelancer'
    ? `<div class="bubble hide"></div><div class="tag"><small>Freelancer ·</small> ${esc(def.name)}</div>`
    : `<div class="bubble hide"></div><div class="tag">${esc(def.name)} <small>· ${esc(def.role)}</small></div>`;
  const label = new CSS2DObject(el);
  scene.add(label);
  const a = {
    ...def, p, guitar, pad, book, mug, label, el, bubbleEl: el.querySelector('.bubble'),
    goal: null, walking: false, path: [], i: 0, heading: 0, phase: 0, seated: false, arrivedAt: 0, holding: null,
    spotUntil: 0, bubble: { text: '', until: 0, cls: '' }, data: null, work: false, leaving: false, seed: hash(def.key) % 100,
  };
  p.root.traverse((o) => { if (o.isMesh && o.userData.key) pickables.push(o); });
  actors.set(def.key, a);
  return a;
}
function removeActor(a) {
  scene.remove(a.p.root);
  scene.remove(a.label);
  a.el.remove();
  a.p.root.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      const i = pickables.indexOf(o);
      if (i >= 0) pickables.splice(i, 1);
    }
  });
  actors.delete(a.key);
}
function say(a, text, ms = 4200, cls = '') {
  a.bubble = { text, until: performance.now() + ms, cls };
}
// letakkan langsung (muat pertama / gerak dikurangi)
function placeAt(a, placeId) {
  const pl = PLACES[placeId];
  if (a.seated) {
    scene.attach(a.p.root);
    a.seated = false;
  }
  a.p.root.position.copy(pl.pos);
  a.p.root.rotation.set(0, pl.heading, 0);
  a.heading = pl.heading;
  a.goal = placeId;
  a.path = [];
  a.walking = false;
  arrive(a, true);
}
function goTo(a, placeId) {
  if (a.goal === placeId) return;
  if (REDUCED || a.goal === null) {
    placeAt(a, placeId);
    return;
  }
  const pl = PLACES[placeId];
  let esc0;
  if (a.walking) esc0 = a.path[a.i]?.esc ?? [];
  else {
    const cur = PLACES[a.goal];
    esc0 = [...cur.spoke].reverse();
  }
  if (a.seated) {
    scene.attach(a.p.root);
    a.p.root.rotation.set(0, a.p.root.rotation.y, 0);
    a.heading = a.p.root.rotation.y;
    a.seated = false;
  }
  const path = esc0.map((p, k) => ({ p, esc: esc0.slice(k) }));
  path.push({ p: pl.spoke[0], esc: [] });
  for (let j = 1; j < pl.spoke.length; j++) path.push({ p: pl.spoke[j], esc: pl.spoke.slice(0, j).reverse() });
  path.push({ p: pl.pos, esc: [...pl.spoke].reverse() });
  a.path = path;
  a.i = 0;
  a.goal = placeId;
  a.walking = true;
  a.holding = null;
}
function arrive(a, instant = false) {
  a.walking = false;
  a.arrivedAt = performance.now();
  const pl = PLACES[a.goal];
  if (pl.kind === 'desk') {
    pl.desk.seat.rotation.y = Math.PI;
    pl.desk.seat.attach(a.p.root);
    a.p.root.position.set(0, 0, 0.02);
    a.p.root.rotation.set(0, 0, 0);
    a.seated = true;
  } else if (pl.kind === 'door') {
    a.gone = true;
  } else {
    a.heading = pl.heading;
    if (!instant && Math.random() < 0.55 && performance.now() > a.bubble.until) say(a, pickOne(QUIPS[pl.spot] || ['Santai dulu']));
  }
}
function walkPose(a) {
  const sw = Math.sin(a.phase);
  const mug = a.holding === 'mug';
  return {
    hipsY: 0.9 + Math.abs(Math.cos(a.phase)) * 0.03, spineX: 0.04, headX: 0.05,
    lHipX: sw * 0.5, rHipX: -sw * 0.5, lKneeX: Math.max(0, -sw) * 0.7, rKneeX: Math.max(0, sw) * 0.7,
    lShX: -sw * 0.35, lShZ: 0.1, lElX: -0.25, rShX: mug ? -0.55 : sw * 0.35, rShZ: -0.1, rElX: mug ? -1.35 : -0.25,
  };
}
function spotPose(a, spot, t) {
  const st = (performance.now() - a.arrivedAt) / 1000;
  const stand = { hipsY: 0.9, lHipX: 0, rHipX: 0, lKneeX: 0, rKneeX: 0 };
  const sofa = { ...SEATED, hipsY: 0.64 };
  switch (spot) {
    case 'tv': {
      const laugh = Math.sin(t * 0.7 + a.seed) > 0.93;
      return { ...sofa, spineX: laugh ? -0.25 : -0.12, headX: laugh ? -0.25 : -0.02, lShX: -0.45, lShZ: 0.25, lElX: -0.95, rShX: -0.45, rShZ: -0.25, rElX: -0.95 };
    }
    case 'ps':
      return { ...sofa, spineX: 0.14 + Math.sin(t * 2.3) * 0.03, headX: 0.05, lShX: -0.8, lShZ: 0.3, lElX: -1.25 + Math.sin(t * 9) * 0.05, rShX: -0.8, rShZ: -0.3, rElX: -1.25 - Math.sin(t * 11) * 0.05 };
    case 'coffee':
    case 'water': {
      if (st < 2.5) return { ...stand, spineX: 0.1, headX: 0.25, rShX: -1.1, rShZ: -0.1, rElX: -0.5 };
      a.holding = 'mug';
      const sip = st % 6 < 1.8;
      return { ...stand, spineX: -0.03, headX: sip ? -0.15 : 0.05, headY: sip ? 0 : 0.5, lElX: -0.1, rShX: sip ? -1.05 : -0.55, rShZ: sip ? -0.35 : -0.15, rElX: sip ? -2.05 : -1.35 };
    }
    case 'guitar':
      return { ...stand, spineX: 0.06, headX: 0.25 + Math.sin(t * 4) * 0.05, headZ: Math.sin(t * 2) * 0.08, rShX: -0.9, rShZ: 0.6, rElX: -0.7, lShX: -0.5, lShZ: 0.25, lElX: -1.3 + Math.sin(t * 12) * 0.25 };
    case 'meet1':
    case 'meet2':
    case 'meet3':
      return { ...SEATED, spineX: 0.1, headX: 0.05 + Math.sin(t * 1.7 + a.seed) * 0.06, headY: Math.sin(t * 0.6 + a.seed) * 0.25,
        lShX: -0.85, lShZ: 0.2, lElX: -0.9, rShX: -0.85 + Math.sin(t * 3 + a.seed) * 0.15, rShZ: -0.2, rElX: -0.9 };
    case 'bookshelf':
      return { ...stand, spineX: 0.08, headX: 0.35 + Math.sin(t * 0.8) * 0.04, lShX: -0.7, lShZ: 0.25, lElX: -1.3, rShX: -0.7, rShZ: -0.25, rElX: -1.3 };
    case 'window': {
      const stretch = st % 9 < 2.5;
      return stretch
        ? { ...stand, spineX: -0.12, headX: -0.25, lShZ: -2.8, rShZ: 2.8, lElX: -0.2, rElX: -0.2 }
        : { ...stand, headX: -0.05, headY: Math.sin(t * 0.5) * 0.3, lShX: 0.25, lShZ: 0.15, lElX: -0.4, rShX: 0.25, rShZ: -0.15, rElX: -0.4 };
    }
    default:
      return stand;
  }
}
// pose kerja dari aksi terakhir (data nyata)
function workMode(a) {
  const d = a.data;
  if (!d) return 'type';
  if (a.kind === 'ketua') {
    if (d.state === 'selesai') return 'done';
    if (d.activity === 'menunggu-tim') return 'read';
  }
  const e = (a.kind === 'ketua' ? d.last : d.run?.last)?.[0];
  if (!e) return 'type';
  if (e.kind === 'text') return 'think';
  if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.tool)) return 'read';
  if (e.tool === 'Bash') return 'terminal';
  if (['Agent', 'Task', 'SendMessage', 'AskUserQuestion', 'TodoWrite'].includes(e.tool)) return 'think';
  return 'type';
}

// Ketua + 4 anggota tim selalu ada
const KETUA = makeActor({ key: 'ketua', kind: 'ketua', name: KETUA_NAME, role: 'Ketua', color: COLORS.ketua, look: LOOKS.ketua, desk: 'A0' });
const TEAM = TEAM_NAMES.map((n, i) => makeActor({ key: `tim-${i}`, kind: 'tim', idx: i, name: n, role: 'Tim', color: COLORS.team[i % COLORS.team.length], look: LOOKS.team[i], desk: `A${i + 1}` }));

// ---------------------------------------------------------------- lounge: tempat unik per aktor + obrolan
const LOUNGE = { chatAt: performance.now() + 4000 };
function claimedSpots(except) {
  const s = new Set();
  for (const a of actors.values()) if (a !== except && a.goal?.startsWith('spot:')) s.add(a.goal.slice(5));
  return s;
}
function lounge(a, now, instant) {
  const onSpot = a.goal?.startsWith('spot:');
  if (onSpot && now < a.spotUntil) return;
  const taken = claimedSpots(a);
  let options = SPOT_IDS.filter((id) => !taken.has(id) && `spot:${id}` !== a.goal);
  if (!options.length) options = SPOT_IDS.filter((id) => !taken.has(id));
  if (!options.length) return;
  const id = pickOne(options);
  a.spotUntil = now + (REDUCED ? 90000 : 38000 + Math.random() * 34000);
  if (instant) placeAt(a, `spot:${id}`);
  else goTo(a, `spot:${id}`);
}
function chatter(now) {
  if (now < LOUNGE.chatAt) return;
  LOUNGE.chatAt = now + 7000 + Math.random() * 4500;
  const avail = [...actors.values()].filter((a) => !a.work && !a.walking && a.goal?.startsWith('spot:') && now > a.bubble.until);
  if (avail.length < 2) return;
  const sp = pickOne(avail);
  const near = avail.filter((b) => b !== sp).sort((b1, b2) => b1.p.root.position.distanceTo(sp.p.root.position) - b2.p.root.position.distanceTo(sp.p.root.position));
  const ls = Math.random() < 0.7 ? near[0] : pickOne(near);
  const [q, r] = pickOne(CHAT);
  say(sp, q.replace('{to}', ls.name), 4800);
  setTimeout(() => { if (!ls.work && ls.goal?.startsWith('spot:')) say(ls, r, 4200); }, 2300);
}

// ---------------------------------------------------------------- layar monitor & papan (data nyata)
function drawIdleScreen(scr, title, sub, css, dim) {
  const { ctx, canvas, tex } = scr;
  const W = canvas.width;
  const H = canvas.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, dim ? '#2d3140' : css);
  g.addColorStop(1, dim ? '#1d2029' : '#f3eee6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dim ? 'rgba(255,255,255,.55)' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = `600 110px ${SANS}`;
  ctx.fillText(fmtHm.format(new Date()).replace('.', ':'), W / 2, H / 2 + 10);
  ctx.font = `500 34px ${SANS}`;
  ctx.fillText(fit(ctx, title, W - 80), W / 2, H / 2 + 76);
  if (sub) {
    ctx.font = `500 26px ${SANS}`;
    ctx.fillText(fit(ctx, sub, W - 80), W / 2, H / 2 + 118);
  }
  ctx.textAlign = 'left';
  tex.needsUpdate = true;
}
function screenApp(mode) {
  return { type: 'Editor', read: 'Membaca berkas', terminal: 'Terminal', think: 'Catatan', done: 'Ringkasan' }[mode] || 'Aplikasi kerja';
}
function drawWorkScreen(scr, who, events, title, footer, mode) {
  const { ctx, canvas, tex } = scr;
  const W = canvas.width;
  const H = canvas.height;
  const term = mode === 'terminal';
  ctx.fillStyle = term ? '#1f2330' : '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = term ? '#2a2f3d' : '#f1ede6';
  ctx.fillRect(0, 0, W, 58);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(30 + i * 30, 29, 9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = term ? '#cfd6e6' : '#4a463f';
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(fit(ctx, `${screenApp(mode)} — ${title}`, W - 160), 130, 39);
  const rows = (events || []).slice(0, 8);
  ctx.font = `500 25px ${MONO}`;
  let y = 104;
  if (!rows.length) {
    ctx.fillStyle = term ? '#8b93a7' : '#9a938a';
    ctx.fillText('Belum ada aksi.', 34, y);
  }
  rows.forEach((e, i) => {
    ctx.fillStyle = term ? '#6c7489' : '#b0a89c';
    ctx.fillText(hhmm(e.t), 34, y);
    ctx.fillStyle = term ? (i === 0 ? '#9ef0b9' : '#d7deeb') : i === 0 ? '#1f1d1a' : e.kind === 'text' ? '#8a847b' : '#45413b';
    ctx.fillText(fit(ctx, `${term ? '$ ' : ''}${e.text}`, W - 160), 132, y);
    y += 44;
  });
  ctx.fillStyle = who.color;
  ctx.fillRect(0, H - 50, W, 50);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(fit(ctx, footer, W - 60), 30, H - 17);
  tex.needsUpdate = true;
}
function drawTaskCard(scr, who, run) {
  const { ctx, canvas, tex } = scr;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = who.color;
  ctx.fillRect(0, 0, W, 64);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 30px ${SANS}`;
  ctx.fillText(fit(ctx, `Tugas ${who.name}`, W - 60), 28, 43);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `600 36px ${SANS}`;
  const y = wrap(ctx, run.task, 28, 124, W - 56, 44, 4);
  ctx.fillStyle = '#6f6a62';
  ctx.font = `500 25px ${MONO}`;
  ctx.fillText(fit(ctx, `jenis: ${run.agent_type}`, W - 56), 28, Math.max(y + 6, 300));
  ctx.fillText(fit(ctx, `mulai ${hhmm(run.started)} · ${dur(run.started, run.ended)} · ${fmtNum.format(run.tools)} aksi`, W - 56), 28, Math.max(y + 46, 340));
  tex.needsUpdate = true;
}
function drawTodoScreen(scr, todos) {
  const { ctx, canvas, tex } = scr;
  const W = canvas.width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = '#f1ede6';
  ctx.fillRect(0, 0, W, 60);
  ctx.fillStyle = '#4a463f';
  ctx.font = `600 30px ${SANS}`;
  ctx.fillText('Daftar tugas sesi utama', 28, 41);
  let y = 110;
  ctx.font = `500 26px ${SANS}`;
  const items = todos?.items || [];
  if (!items.length) {
    ctx.fillStyle = '#9a938a';
    ctx.fillText('Belum ada daftar tugas (TodoWrite).', 28, y);
  }
  for (const it of items.slice(0, 8)) {
    const st = TODO_STATUS[it.status] || TODO_STATUS.pending;
    ctx.fillStyle = st.css;
    ctx.fillText(it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▶' : '○', 28, y);
    ctx.fillStyle = it.status === 'completed' ? '#9a938a' : '#2b2a28';
    ctx.fillText(fit(ctx, it.text, W - 90), 66, y);
    y += 46;
  }
  tex.needsUpdate = true;
}
function updateDeskScreens(d, now) {
  const a = d.kind === 'ketua' ? KETUA : d.who;
  let sig;
  if (d.kind === 'ketua') {
    const k = a.data;
    sig = JSON.stringify([k?.state, k?.last?.[0]?.t, k?.tools, k?.todos?.at, a.walking, workMode(a)]);
  } else if (a) {
    sig = JSON.stringify([a.key, a.data?.state, a.data?.run?.id, a.data?.run?.last?.[0]?.t, a.data?.run?.tools, workMode(a)]);
  } else sig = `idle:${d.kind === 'tim' ? JSON.stringify([TEAM[d.idx].data?.state, TEAM[d.idx].data?.run?.id]) : ''}`;
  if (sig === d.sig && now - d.drawnAt < 20000) return;
  d.sig = sig;
  d.drawnAt = now;
  if (d.kind === 'ketua') {
    const k = a.data || {};
    if (k.state === 'bekerja' || k.state === 'selesai') {
      const mode = workMode(a);
      const title = k.activity === 'menunggu-tim' ? `Menunggu ${k.waiting_on} subagent` : 'Sesi utama';
      drawWorkScreen(d.main.scr, a, k.last, title, `${a.name} · ${STATE_UI[k.state]?.label || ''} · ${fmtNum.format(k.tools || 0)} aksi · ${fmtCompact.format(k.tokens || 0)} token`, mode);
    } else drawIdleScreen(d.main.scr, `${a.name} · Santai`, k.updated ? `aktif terakhir ${ago(k.updated)}` : 'belum ada sesi', a.color, false);
    drawTodoScreen(d.side.scr, k.todos);
    return;
  }
  if (a && a.data?.run && a.work) {
    const r = a.data.run;
    const mode = workMode(a);
    drawWorkScreen(d.main.scr, a, r.last, r.task, `${a.name} · ${r.agent_type} · ${fmtNum.format(r.tools)} aksi · ${fmtCompact.format(r.tokens)} token`, mode);
    drawTaskCard(d.side.scr, a, r);
    return;
  }
  if (d.kind === 'tim') {
    const m = TEAM[d.idx];
    drawIdleScreen(d.main.scr, `${m.name} · ${STATE_UI[m.data?.state || 'santai'].label}`, m.data?.run ? `terakhir: ${clip(m.data.run.task, 40)}` : 'menunggu tugas', m.color, false);
    drawIdleScreen(d.side.scr, 'Layar terkunci', '', m.color, true);
  } else {
    drawIdleScreen(d.main.scr, `Meja cadangan ${d.idx + 1}`, 'untuk freelancer', '#9a938a', true);
    drawIdleScreen(d.side.scr, 'Kosong', '', '#9a938a', true);
  }
}
function drawTodoBoard(k) {
  const { ctx, canvas, tex } = todoBoard;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `72px ${HAND}`;
  ctx.fillText(`Tugas ${KETUA_NAME}`, 40, 84);
  const todos = k?.todos;
  const items = todos?.items || [];
  ctx.font = `34px ${HAND}`;
  ctx.fillStyle = '#6f6a62';
  ctx.fillText(fit(ctx, todos ? `sumber: ${todos.source === 'Task' ? 'TaskCreate/TaskUpdate' : 'TodoWrite'} sesi utama · ${items.length} tugas · ${hhmm(todos.at)}` : 'sumber: daftar tugas (TodoWrite) sesi utama', W - 560), 520, 76);
  const cols = ['pending', 'in_progress', 'completed'];
  const colW = (W - 80) / 3;
  cols.forEach((st, i) => {
    const x = 40 + i * colW;
    if (i) {
      ctx.strokeStyle = '#d6cdc0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 6, 110);
      ctx.lineTo(x - 6, H - 30);
      ctx.stroke();
    }
    const mine = items.filter((it) => it.status === st);
    ctx.fillStyle = '#2b2a28';
    ctx.font = `50px ${HAND}`;
    ctx.fillText(`${TODO_STATUS[st].label} (${mine.length})`, x + 10, 158);
    const nw = 280;
    const nh = 160;
    const per = Math.max(1, Math.floor((colW - 20) / (nw + 12)));
    const maxRows = Math.floor((H - 240) / (nh + 14));
    mine.slice(0, per * maxRows).forEach((it, kk) => {
      const r = rng(hash(it.text));
      const nx = x + 10 + (kk % per) * (nw + 12);
      const ny = 188 + Math.floor(kk / per) * (nh + 14);
      ctx.save();
      ctx.translate(nx + nw / 2, ny + nh / 2);
      ctx.rotate((r() - 0.5) * 0.08);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(-nw / 2 + 4, -nh / 2 + 6, nw, nh);
      ctx.fillStyle = TODO_STATUS[st].note;
      ctx.fillRect(-nw / 2, -nh / 2, nw, nh);
      ctx.fillStyle = '#2b2a28';
      ctx.font = `32px ${HAND}`;
      wrap(ctx, it.text, -nw / 2 + 14, -nh / 2 + 44, nw - 26, 32, 4);
      ctx.restore();
    });
    const extra = mine.length - per * maxRows;
    if (extra > 0) {
      ctx.fillStyle = '#6f6a62';
      ctx.font = `34px ${HAND}`;
      ctx.fillText(`+${extra} lagi`, x + 10, H - 36);
    }
  });
  if (!items.length) {
    ctx.fillStyle = '#9a938a';
    ctx.font = `44px ${HAND}`;
    ctx.textAlign = 'center';
    ctx.fillText('Belum ada daftar tugas di sesi utama.', W / 2, H / 2 + 40);
    ctx.font = `34px ${HAND}`;
    ctx.fillText('Muncul otomatis saat Claude memakai TodoWrite.', W / 2, H / 2 + 94);
    ctx.textAlign = 'left';
  }
  tex.needsUpdate = true;
}
function localDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function drawHistBoard(runs) {
  const { ctx, canvas, tex } = histBoard;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fdfdfc';
  ctx.fillRect(0, 0, W, H);
  const today = localDay(new Date().toISOString());
  const list = (runs || []).filter((r) => localDay(r.started) === today);
  ctx.fillStyle = '#2f5bd3';
  ctx.font = `68px ${HAND}`;
  ctx.fillText('Subagent hari ini', 44, 86);
  ctx.fillStyle = '#6f6a62';
  ctx.font = `36px ${HAND}`;
  ctx.fillText(fit(ctx, `sumber: transkrip subagent · ${list.length} tugas`, W - 640), 600, 80);
  if (!list.length) {
    ctx.fillStyle = '#9a938a';
    ctx.font = `44px ${HAND}`;
    ctx.fillText('Belum ada subagent hari ini — tim sedang santai.', 44, 200);
  }
  list.slice(0, 9).forEach((r, i) => {
    const y = 170 + i * 92;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(62, y - 12, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2a28';
    ctx.font = `40px ${HAND}`;
    ctx.fillText(fit(ctx, r.label, 330), 92, y);
    ctx.fillText(fit(ctx, r.task, W - 800), 440, y);
    const ui = RUN_UI[r.status] || RUN_UI.selesai;
    ctx.fillStyle = ui.css;
    ctx.font = `36px ${HAND}`;
    ctx.fillText(fit(ctx, `${ui.label} · ${hhmm(r.started)}`, 300), W - 330, y);
    ctx.strokeStyle = 'rgba(43,42,40,.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(44, y + 30);
    ctx.lineTo(W - 44, y + 30);
    ctx.stroke();
  });
  if (list.length > 9) {
    ctx.fillStyle = '#6f6a62';
    ctx.font = `34px ${HAND}`;
    ctx.fillText(`+${list.length - 9} lagi (lihat tab Riwayat)`, 44, H - 30);
  }
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- data nyata → karakter
let S = null;
let firstLoad = true;
let prevFeedKeys = new Set();
let boardSig = '';
const prev = new Map(); // key → {state, runId}

async function poll() {
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d || d.app !== 'kantor-agent') throw new Error('respons tidak dikenal');
    apply(d);
  } catch {
    $('liveDot').classList.add('off');
    $('liveTxt').textContent = 'Terputus';
  } finally {
    setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
  }
}
let reloading = false;
function maybeReload(d) {
  if (reloading || typeof d.names !== 'string' || (d.names === NAMES_SIG && (typeof CFG.title !== 'string' || d.project === CFG.title))) return false;
  let last = 0;
  try { last = Number(sessionStorage.getItem('kantor.reloadAt') || 0); } catch { /* penyimpanan tidak tersedia */ }
  if (Date.now() - last < 60000) return false;
  try { sessionStorage.setItem('kantor.reloadAt', String(Date.now())); } catch { /* abaikan */ }
  reloading = true;
  location.reload();
  return true;
}
function actionText(a) {
  const d = a.data;
  if (!d) return '';
  const e = a.kind === 'ketua' ? d.last?.[0] : d.run?.last?.[0];
  if (!e || Date.now() - new Date(e.t).getTime() > 25000) return '';
  return clip(e.text, 48);
}
function apply(d) {
  if (maybeReload(d)) return;
  S = d;
  $('liveDot').classList.remove('off');
  $('liveTxt').textContent = innerWidth <= 820 ? `Live · ${hhmm(d.now)}` : `Live · ${hhmmss(d.now)}`;
  const now = performance.now();
  const live = !firstLoad;

  // Ketua
  KETUA.data = d.ketua;
  const kWork = d.ketua.state === 'bekerja' || d.ketua.state === 'selesai';
  const kPrev = prev.get('ketua');
  KETUA.work = kWork;
  if (kWork) {
    if (firstLoad) placeAt(KETUA, 'desk:A0');
    else goTo(KETUA, 'desk:A0');
  } else if (!KETUA.goal?.startsWith('spot:') || firstLoad) lounge(KETUA, now, firstLoad);
  if (live && kPrev && kPrev.state === 'bekerja' && d.ketua.state === 'selesai') say(KETUA, 'Beres, menunggu instruksi berikutnya', 3800, 'hi');
  prev.set('ketua', { state: d.ketua.state });

  // tim
  d.team.forEach((m, i) => {
    const a = TEAM[i];
    if (!a) return;
    a.data = m;
    const working = m.state === 'bekerja';
    const p = prev.get(a.key);
    a.work = working;
    if (working) {
      if (firstLoad) placeAt(a, `desk:${a.desk}`);
      else goTo(a, `desk:${a.desk}`);
      if (live && (!p || p.state !== 'bekerja' || p.runId !== m.run?.id)) {
        say(a, 'Siap, saya kerjakan!', 3600, 'hi');
        if (m.run) say(KETUA, `${a.name}, tolong: ${clip(m.run.task, 40)}`, 4000);
      }
    } else {
      if (live && p && p.state === 'bekerja') say(a, 'Beres!', 3600, 'hi');
      if (!a.goal?.startsWith('spot:') || firstLoad) lounge(a, now, firstLoad);
    }
    prev.set(a.key, { state: m.state, runId: m.run?.id ?? null });
  });

  // freelancer: datang lewat pintu, duduk di meja cadangan, pulang lewat pintu
  const seen = new Set();
  for (const f of d.freelancers) {
    if (f.desk === null || f.desk >= SPARE) continue;
    seen.add(f.key);
    let a = actors.get(f.key);
    if (!a) {
      if (f.state !== 'bekerja') continue;
      a = makeActor({ key: f.key, kind: 'freelancer', name: f.name, role: 'Freelancer', color: f.color, look: freelancerLook(f.name, f.color), desk: `B${f.desk}` });
      if (firstLoad) placeAt(a, `desk:B${f.desk}`);
      else {
        placeAt(a, 'door');
        a.gone = false;
        goTo(a, `desk:B${f.desk}`);
        say(a, 'Permisi, saya bantu ya!', 3000);
      }
    }
    a.data = f;
    a.desk = `B${f.desk}`;
    const p = prev.get(f.key);
    if (f.state === 'bekerja') {
      a.work = true;
      a.leaving = false;
      goTo(a, `desk:${a.desk}`);
      if (live && p && p.runId !== f.run?.id) say(a, 'Siap, saya kerjakan!', 3600, 'hi');
      if (live && !p) setTimeout(() => { if (actors.has(f.key)) say(a, 'Siap, saya kerjakan!', 3600, 'hi'); }, 3200);
    } else if (!a.leaving) {
      a.work = false;
      a.leaving = true;
      if (live) say(a, 'Beres! Pamit dulu ya 👋', 3800, 'hi');
      goTo(a, 'door');
    }
    prev.set(f.key, { state: f.state, runId: f.run?.id ?? null });
  }
  for (const a of [...actors.values()]) {
    if (a.kind !== 'freelancer' || seen.has(a.key) || a.leaving) continue;
    a.work = false;
    a.leaving = true;
    goTo(a, 'door');
  }

  // monitor per meja mengikuti siapa yang ditugaskan
  for (const desk of Object.values(desks)) desk.who = null;
  desks.A0.who = KETUA;
  for (const a of actors.values()) {
    if (a.kind === 'tim') desks[a.desk].who = a.work ? a : null;
    if (a.kind === 'freelancer' && a.work && desks[a.desk]) {
      desks[a.desk].who = a;
      const sig = `${a.name}`;
      if (desks[a.desk].plateSig !== sig) {
        desks[a.desk].plateSig = sig;
        drawPlate(desks[a.desk], a.name, 'Freelancer', a.color);
      }
    }
  }
  for (const desk of Object.values(desks)) {
    if (desk.kind === 'spare' && !desk.who && desk.plateSig !== '') {
      desk.plateSig = '';
      drawPlate(desk, `Meja cadangan ${desk.idx + 1}`, 'Freelancer', desk.color);
    }
  }

  // anggukan saat ada aksi baru
  const keys = new Set(d.feed.map((e) => `${e.t}|${e.who}|${e.text}`));
  if (live) {
    for (const e of d.feed) {
      if (prevFeedKeys.has(`${e.t}|${e.who}|${e.text}`)) continue;
      const a = actors.get(e.who);
      if (a) a.p.nod = 0.16;
    }
  }
  const fresh = live ? new Set([...keys].filter((k) => !prevFeedKeys.has(k))) : new Set();
  prevFeedKeys = keys;

  const sig = JSON.stringify([d.ketua.todos, (d.runs || []).map((r) => [r.id, r.status, r.label]), localDay(new Date().toISOString())]);
  if (sig !== boardSig) {
    boardSig = sig;
    drawTodoBoard(d.ketua);
    drawHistBoard(d.runs);
  }
  renderUi(d, fresh);
  firstLoad = false;
}

// ---------------------------------------------------------------- UI HTML
function stateChip(state, extra = '') {
  const ui = STATE_UI[state] || STATE_UI.santai;
  return `<span class="chip st" style="color:${ui.css}"><i></i>${esc(ui.label)}${extra}</span>`;
}
function renderUi(d, fresh) {
  const today = localDay(new Date().toISOString());
  const nToday = (d.stats.recent_starts || []).filter((s) => localDay(s) === today).length;
  $('sToday').textContent = fmtNum.format(nToday);
  $('sActive').textContent = fmtNum.format(d.stats.active);
  const pub = typeof d.public_url === 'string' && /^https:\/\//.test(d.public_url) ? d.public_url : null;
  $('pubStat').hidden = !pub;
  if (pub) $('pubLink').href = pub;

  const workingTeam = d.team.filter((m) => m.state === 'bekerja').map((m) => m.name);
  const flWork = d.freelancers.filter((f) => f.state === 'bekerja').length;
  let phase;
  if (!d.transcripts) phase = 'Belum ada transkrip Claude Code untuk folder ini — kantor terisi otomatis setelah Claude Code dipakai di sini.';
  else if (workingTeam.length || flWork) phase = `Sedang bekerja: ${[...workingTeam, ...(flWork ? [`${flWork} freelancer`] : [])].join(', ')}${d.ketua.state === 'bekerja' ? ` · ${KETUA_NAME} memantau` : ''}`;
  else if (d.ketua.state === 'bekerja') phase = `${KETUA_NAME} sedang bekerja di sesi utama — tim santai menunggu tugas`;
  else if (d.ketua.state === 'selesai') phase = `${KETUA_NAME} baru selesai — menunggu instruksi berikutnya`;
  else phase = 'Semua santai ☕ — nonton, ngopi & ngobrol. Otomatis kembali kerja saat ada subagent.';
  $('phase').textContent = phase;
  $('phase').title = phase;

  const banner = $('banner');
  if (!d.transcripts) {
    banner.textContent = 'Menunggu aktivitas Claude Code di folder project ini.';
    banner.classList.add('show');
  } else banner.classList.remove('show');

  // feed
  const feedHtml = d.feed.slice(0, 100).map((e) => {
    const k = `${e.t}|${e.who}|${e.text}`;
    return `<li class="k-${esc(e.kind)}${fresh.has(k) ? ' fresh' : ''}"><span class="av" style="background:${esc(e.color)}">${esc(initial(e.name.replace(/^Freelancer · /, '')))}</span><div><div class="meta"><span class="who" style="color:${esc(e.color)}">${esc(e.name)}</span><time>${esc(hhmmss(e.t))}</time></div><div class="txt">${esc(e.text)}</div></div></li>`;
  }).join('') || '<li><div class="empty" style="grid-column:1/-1">Belum ada aktivitas.</div></li>';
  for (const id of ['feed', 'feed2']) if ($(id).innerHTML !== feedHtml) $(id).innerHTML = feedHtml;
  $('feedCount').textContent = fmtNum.format(d.feed.length);

  // riwayat
  const runs = d.runs || [];
  $('nRuns').textContent = fmtNum.format(runs.length);
  $('paneRuns').innerHTML = '<div class="src">Sumber: <b>transkrip subagent</b> 7 hari terakhir (terbaru di atas)</div>'
    + (runs.length ? runs.map((r) => {
      const ui = RUN_UI[r.status] || RUN_UI.selesai;
      return `<div class="run"><span class="c" style="background:${esc(r.color)}"></span><span class="t" title="${esc(r.task)}">${esc(r.task)}</span><span class="chip" style="color:${ui.css}"><i></i>${esc(ui.label)}</span><span class="w">${esc(r.label)} · ${esc(r.agent_type)} · ${esc(hhmm(r.started))} · ${esc(dur(r.started, r.ended))}</span></div>`;
    }).join('') : '<div class="empty">Belum ada subagent. Karakter tetap santai sampai Claude memanggil subagent.</div>');
  // daftar tugas Ketua
  const todos = d.ketua.todos;
  $('tugasWho').textContent = KETUA_NAME;
  $('nTodo').textContent = fmtNum.format(todos ? todos.items.filter((it) => it.status !== 'completed').length : 0);
  $('paneTodo').innerHTML = `<div class="src">Sumber: <b>${todos && todos.source === 'Task' ? 'TaskCreate/TaskUpdate' : 'TodoWrite'}</b> di sesi utama${todos ? ` · diperbarui ${esc(ago(todos.at))}` : ''}</div>`
    + (todos && todos.items.length ? todos.items.map((it) => `<div class="todo s-${esc(it.status)}"><i>${it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▶' : '○'}</i><span>${esc(it.text)}</span></div>`).join('') : '<div class="empty">Belum ada daftar tugas di sesi utama.</div>');

  // kartu
  const k = d.ketua;
  const kLast = k.updated ? `aktif terakhir ${ago(k.updated)}` : 'belum ada sesi utama';
  const kSub = k.other_sessions > 0 ? `+${k.other_sessions} sesi lain aktif`
    : k.activity === 'menunggu-tim' ? `Menunggu ${k.waiting_on} subagent`
      : k.state === 'santai' ? kLast : k.last?.[0]?.text || kLast;
  const cards = [cardHtml({ key: 'ketua', name: KETUA_NAME, role: 'Ketua', color: COLORS.ketua, state: k.state, task: k.state === 'santai' ? 'Santai di lounge' : k.activity === 'alat' ? 'Menjalankan alat' : 'Sesi utama', act: kSub, working: k.state === 'bekerja' })];
  for (const m of d.team) {
    const r = m.run;
    const task = m.state === 'santai' ? (r ? `Terakhir: ${r.task}` : 'Santai di lounge') : r?.task || '';
    const act = m.state === 'bekerja' ? r?.last?.[0]?.text || 'Mulai bekerja…' : m.state === 'selesai' ? `Beres ${ago(r?.ended)}` : r ? `selesai ${ago(r.ended)}` : 'menunggu tugas';
    cards.push(cardHtml({ key: m.key, name: m.name, role: 'Tim', color: m.color, state: m.state, task, act, working: m.state === 'bekerja' }));
  }
  const seated = d.freelancers.filter((f) => f.desk !== null && f.desk < SPARE);
  const extra = d.freelancers.filter((f) => f.desk === null || f.desk >= SPARE);
  for (const f of seated) {
    const act = f.state === 'bekerja' ? f.run?.last?.[0]?.text || 'Mulai bekerja…' : 'Beres, pamit pulang';
    cards.push(cardHtml({ key: f.key, name: f.name, role: 'Freelancer', color: f.color, state: f.state, task: f.run?.task || '', act, working: f.state === 'bekerja' }));
  }
  if (extra.length) {
    const title = extra.map((f) => `Freelancer · ${f.name} — ${STATE_UI[f.state]?.label || f.state}: ${f.run?.task || ''}`).join('\n');
    cards.push(`<div class="card card-ui more" tabindex="0" title="${esc(title)}" aria-label="${esc(`${extra.length} freelancer lain tanpa meja`)}"><span class="ava">+${extra.length}</span><div class="h"><span class="nm">Freelancer lain</span></div><div class="task">${esc(extra.slice(0, 3).map((f) => f.name).join(', '))}${extra.length > 3 ? ' …' : ''}</div><div class="act">meja cadangan penuh — tetap dihitung</div></div>`);
  }
  const el = $('cards');
  const n = cards.length;
  el.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  el.classList.toggle('compact', n > 6);
  const html = cards.join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}
function cardHtml({ key, name, role, color, state, task, act, working }) {
  return `<button type="button" class="card card-ui${working ? ' working' : ''}${role === 'Freelancer' ? ' fl' : ''}" data-focus="${esc(key)}" style="--c:${esc(color)}"><span class="ava">${esc(initial(name))}</span><div class="h"><span class="nm">${esc(name)}</span><span class="role">${esc(role)}</span>${stateChip(state)}</div><div class="task" title="${esc(task)}">${esc(task || '—')}</div><div class="act" title="${esc(act)}">${esc(act || '—')}</div></button>`;
}

// ---------------------------------------------------------------- interaksi
function setMin(side, on) {
  const panel = document.querySelector(`.side.${side}`);
  if (!panel) return;
  panel.classList.toggle('min', on);
  document.body.classList.toggle(`min-${side}`, on);
  const b = panel.querySelector('.minbtn');
  b.setAttribute('aria-expanded', String(!on));
  b.title = on ? 'Buka panel' : 'Perkecil panel';
  try { localStorage.setItem(`kantor.min.${side}`, on ? '1' : '0'); } catch { /* abaikan */ }
}
for (const side of ['left', 'right']) {
  let saved = null;
  try { saved = localStorage.getItem(`kantor.min.${side}`); } catch { /* abaikan */ }
  setMin(side, saved === null ? innerWidth <= 820 : saved === '1');
}
document.addEventListener('click', (e) => {
  const mb = e.target.closest('[data-min]');
  if (mb) {
    const side = mb.dataset.min;
    setMin(side, !document.querySelector(`.side.${side}`).classList.contains('min'));
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    if (document.querySelector('.side.right').classList.contains('min')) setMin('right', false);
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
    document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab.dataset.tab));
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) focusOn(f.dataset.focus);
});
function setLapang(on) {
  document.body.classList.toggle('lapang', on);
  $('togglePanel').textContent = on ? 'Tampilkan panel' : 'Lihat kantor penuh';
  try { localStorage.setItem('kantor.lapang', on ? '1' : '0'); } catch { /* abaikan */ }
  onResize();
}
$('togglePanel').onclick = () => setLapang(!document.body.classList.contains('lapang'));
addEventListener('keydown', (e) => {
  if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input,textarea,[contenteditable]')) setLapang(!document.body.classList.contains('lapang'));
});
let tween = null;
function focusOn(key) {
  const a = actors.get(key);
  if (!a) return;
  a.p.head.getWorldPosition(tmpV);
  const target = tmpV.clone().add(new THREE.Vector3(0, -0.2, 0));
  const pos = target.clone().add(new THREE.Vector3(2.2, 2.6, 4.4));
  if (REDUCED) {
    camera.position.copy(pos);
    controls.target.copy(target);
    return;
  }
  tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target };
}
renderer.domElement.addEventListener('dblclick', () => {
  if (REDUCED) {
    camera.position.copy(HOME.pos);
    controls.target.copy(HOME.target);
    return;
  }
  tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: HOME.pos.clone(), t1: HOME.target.clone() };
});
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; tween = null; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pick(e);
  if (hit?.userData.key) focusOn(hit.userData.key);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  renderer.domElement.style.cursor = pick(e)?.userData.key ? 'pointer' : '';
});
function pick(e) {
  if (!HAS_GL) return null;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  return ray.intersectObjects(pickables, false)[0]?.object || null;
}
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < 820 ? 62 : innerWidth < 1180 ? 44 : document.body.classList.contains('lapang') ? 34 : 38;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  document.querySelector('.mfeed').hidden = innerWidth > 1180;
  if (innerWidth > 1180 && document.querySelector('.mfeed[aria-selected="true"]')) document.querySelector('[data-tab="riwayat"]').click();
}
addEventListener('resize', onResize);
try { if (localStorage.getItem('kantor.lapang') === '1') document.body.classList.add('lapang'); } catch { /* abaikan */ }
onResize();
if (document.body.classList.contains('lapang')) $('togglePanel').textContent = 'Tampilkan panel';

let nightState = null;
function updateDaylight() {
  const h = new Date().getHours();
  const night = h >= 18 || h < 6;
  if (night === nightState) return;
  nightState = night;
  paintSky(night);
  sun.intensity = night ? 0.25 : 2.3;
  hemi.intensity = night ? 0.45 : 1.05;
  scene.background.set(night ? '#d9d3ca' : '#e9e3da');
  for (const d of Object.values(desks)) d.lamp.intensity = night ? 3 : 0;
}

// ---------------------------------------------------------------- loop animasi
const clock = new THREE.Clock();
let lastSec = 0;
let gameAt = 0;
let tvMode = 'tv';
function updateActor(a, dt, t, now) {
  // pilih tempat santai baru bila waktunya
  if (!a.work && !a.leaving && a.kind !== 'freelancer' && !a.walking) lounge(a, now, false);
  const root = a.p.root;
  if (a.walking) {
    const g = a.path[a.i];
    tmpV.subVectors(g.p, root.position).setY(0);
    const dist = tmpV.length();
    if (dist > 0.05) {
      root.position.addScaledVector(tmpV.normalize(), Math.min(dist, 1.6 * dt));
      a.heading = turnTo(a.heading, Math.atan2(tmpV.x, tmpV.z), dt * 7);
      a.phase += dt * 8;
    } else if (a.i < a.path.length - 1) a.i++;
    else arrive(a);
  } else if (!a.seated && PLACES[a.goal]) {
    a.heading = turnTo(a.heading, PLACES[a.goal].heading, dt * 4);
  }
  if (a.gone) return;
  const tt = REDUCED ? 0 : t;
  a.p.nod = Math.max(0, a.p.nod - dt * 0.6);
  if (a.seated) {
    const mode = workMode(a);
    applyPose(a.p, seatedPose(a.work ? mode : 'rest', tt, a.seed), dt);
    a.p.spine.position.y = 0.06 + Math.sin(tt * 1.6 + a.seed) * 0.004;
  } else {
    root.rotation.y = a.heading;
    const pl = PLACES[a.goal];
    applyPose(a.p, a.walking ? walkPose(a) : spotPose(a, pl?.spot, tt), dt);
  }
  const spot = !a.walking && PLACES[a.goal]?.spot;
  a.guitar.visible = spot === 'guitar';
  a.pad.visible = spot === 'ps';
  a.book.visible = spot === 'bookshelf';
  a.mug.visible = a.holding === 'mug';
  // label & gelembung
  a.p.head.getWorldPosition(tmpV);
  a.label.position.set(tmpV.x, tmpV.y + 0.42, tmpV.z);
  const outside = tmpV.x < ROOM.x0 - 0.05;
  a.el.classList.toggle('out', outside);
  let text = '';
  let cls = '';
  if (now < a.bubble.until) {
    text = a.bubble.text;
    cls = a.bubble.cls;
  } else if (a.work && a.seated && innerWidth > 820) text = actionText(a); // ponsel: aksi cukup di kartu
  const b = a.bubbleEl;
  if (!text) {
    if (b.className !== 'bubble hide') b.className = 'bubble hide';
  } else {
    const c = `bubble ${cls}`.trim();
    if (b.className !== c) b.className = c;
    if (b.textContent !== text) b.textContent = text;
  }
}
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(clock.getDelta(), 0.25); // kecepatan jalan tetap wajar di perangkat lambat (fps rendah)
  const t = clock.elapsedTime;
  const now = performance.now();
  if (t - lastSec > 1) {
    lastSec = t;
    drawClock();
    updateDaylight();
  }
  for (const a of [...actors.values()]) {
    updateActor(a, dt, t, now);
    if (a.gone && a.kind === 'freelancer') removeActor(a);
  }
  for (const d of Object.values(desks)) updateDeskScreens(d, now);
  if (!REDUCED) chatter(now);
  // pintu terbuka saat ada yang dekat
  let near = false;
  for (const a of actors.values()) {
    const p = a.p.root.getWorldPosition(tmpV);
    if (Math.abs(p.z - CORRIDOR_Z) < 1 && p.x < ROOM.x0 + 1.4 && p.x > ROOM.x0 - 1.4) near = true;
  }
  door.open = REDUCED ? (near ? 1 : 0) : THREE.MathUtils.lerp(door.open, near ? 1 : 0, Math.min(1, dt * 5));
  door.hinge.rotation.y = door.open * 1.35; // berayun ke dalam ruangan
  // TV jadi game saat ada yang main PS
  const player = [...actors.values()].find((x) => !x.walking && x.goal === 'spot:ps');
  LOUNGE_PADS[1].visible = !player;
  if (player && !REDUCED) {
    if (now - gameAt > 150) {
      drawGame(t, player.name);
      gameAt = now;
      tvMode = 'game';
    }
  } else if (tvMode === 'game') {
    drawTv();
    tvMode = 'tv';
  }
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.2);
    const e = 1 - Math.pow(1 - tween.t, 3);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (tween.t >= 1) tween = null;
  }
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, ROOM.x0 + 1, ROOM.x1 - 1);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, ROOM.z0 + 1, ROOM.z1 - 1);
  controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.3, 3.5);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
function turnTo(cur, target, k) {
  const d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  return cur + d * Math.min(1, k);
}

// diagnostik opsional: buka /kerja#debug untuk memeriksa posisi & tujuan karakter di konsol (window.__kantor)
if (location.hash === '#debug') {
  window.__kantor = {
    actors: () => [...actors.values()].map((a) => ({ key: a.key, goal: a.goal, walking: a.walking, i: a.i, n: a.path.length, work: a.work, leaving: a.leaving,
      pos: a.p.root.getWorldPosition(new THREE.Vector3()).toArray().map((v) => Math.round(v * 100) / 100) })),
  };
}
// awal: semua santai sampai data pertama datang (tanpa data = tanpa aktivitas palsu)
for (const a of [KETUA, ...TEAM]) lounge(a, performance.now(), true);
drawTodoBoard(null);
drawHistBoard([]);
updateDaylight();
drawClock();
document.fonts?.ready.then(() => {
  drawTv();
  drawTodoBoard(S?.ketua ?? null);
  drawHistBoard(S?.runs ?? []);
}).catch(() => {});
frame();
poll();
setTimeout(() => {
  $('loading').classList.add('gone');
  setTimeout(() => $('loading').remove(), 900);
}, 500);
