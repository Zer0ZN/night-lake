import * as THREE from 'three';
import { canvasTexture, mulberry32, TAU } from './util.js';

/* -------------------------------------------------------------------------- */
/*  helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a canvas' luminance as a height field and convert to a tangent normal map. */
function canvasToNormal(canvas, strength = 2.0) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) {
    h[i] = (src[p] * 0.3 + src[p + 1] * 0.59 + src[p + 2] * 0.11) / 255;
  }
  const at = (x, y) =>
    h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

function offscreen(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/* -------------------------------------------------------------------------- */
/*  textures                                                                   */
/* -------------------------------------------------------------------------- */

/** Vertical tarred timber cladding — dark, matt, faint grain. */
function plankTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#9c9083';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(1234);
    const boards = 10;
    const bw = w / boards;
    for (let i = 0; i < boards; i++) {
      const x = i * bw;
      const shade = 0.82 + rnd() * 0.3;
      const r = Math.floor(150 * shade), gg = Math.floor(137 * shade), b = Math.floor(118 * shade);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(x + 1, 0, bw - 2, h);
      // grain
      for (let k = 0; k < 26; k++) {
        const gx = x + 3 + rnd() * (bw - 6);
        g.strokeStyle = `rgba(${100 + rnd() * 34},${90 + rnd() * 28},${76 + rnd() * 22},${0.22 + rnd() * 0.26})`;
        g.lineWidth = 0.6 + rnd() * 1.4;
        g.beginPath();
        g.moveTo(gx, 0);
        for (let y = 0; y <= h; y += 32) {
          g.lineTo(gx + Math.sin(y * 0.02 + k) * 1.6, y);
        }
        g.stroke();
      }
      // knots
      if (rnd() > 0.55) {
        const kx = x + bw * (0.3 + rnd() * 0.4);
        const ky = rnd() * h;
        for (let rr = 7; rr > 1; rr -= 2) {
          g.fillStyle = `rgba(${92 + rnd() * 18},${80 + rnd() * 14},${64 + rnd() * 12},0.45)`;
          g.beginPath();
          g.ellipse(kx, ky, rr * 0.8, rr, 0, 0, TAU);
          g.fill();
        }
      }
      // shadow gap between boards
      g.fillStyle = 'rgba(40,30,20,0.8)';
      g.fillRect(x, 0, 1.5, h);
      g.fillRect(x + bw - 1.5, 0, 1.5, h);
    }
    // weathering streaks
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(214,206,190,${0.03 + rnd() * 0.05})`;
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 20 + rnd() * 180);
    }
  }, { repeat: [1, 1] });
}

/** Interior pine board floor. */
function floorBoardTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.fillStyle = '#6b4a2e';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(77);
    const rows = 14;
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const shade = 0.8 + rnd() * 0.4;
      g.fillStyle = `rgb(${Math.floor(120 * shade)},${Math.floor(84 * shade)},${Math.floor(52 * shade)})`;
      g.fillRect(0, y + 1, w, rh - 2);
      for (let k = 0; k < 40; k++) {
        g.strokeStyle = `rgba(${70 + rnd() * 50},${48 + rnd() * 34},${28 + rnd() * 22},${0.15 + rnd() * 0.3})`;
        g.lineWidth = 0.8 + rnd() * 1.6;
        const gy = y + rnd() * rh;
        g.beginPath();
        g.moveTo(0, gy);
        for (let x = 0; x <= w; x += 64) g.lineTo(x, gy + Math.sin(x * 0.006 + k) * 2.2);
        g.stroke();
      }
      // plank ends
      const seam = rnd() * w;
      g.fillStyle = 'rgba(20,12,6,0.7)';
      g.fillRect(seam, y, 2, rh);
      g.fillStyle = 'rgba(15,9,4,0.85)';
      g.fillRect(0, y, w, 1.5);
    }
  }, { repeat: [2, 2] });
}

/** Snow: bright, faintly blue, granular. */
function snowTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#e9eef6';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(9);
    for (let i = 0; i < 9000; i++) {
      const a = 0.02 + rnd() * 0.09;
      g.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(196,206,220,${a})`;
      const r = 0.6 + rnd() * 2.4;
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, r, 0, TAU);
      g.fill();
    }
    // soft drifts
    for (let i = 0; i < 40; i++) {
      const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.13)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, { repeat: [6, 6] });
}

/** Wet dark rock. */
function rockTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#2b2f35';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(31);
    for (let i = 0; i < 2600; i++) {
      const v = 26 + rnd() * 52;
      g.fillStyle = `rgba(${v},${v + 3},${v + 8},${0.2 + rnd() * 0.5})`;
      const r = 1 + rnd() * 9;
      g.beginPath();
      g.ellipse(rnd() * w, rnd() * h, r, r * (0.4 + rnd() * 0.8), rnd() * 3, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(12,14,18,${0.3 + rnd() * 0.4})`;
      g.lineWidth = 1 + rnd() * 2;
      g.beginPath();
      let x = rnd() * w, y = rnd() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += (rnd() - 0.5) * 70;
        y += (rnd() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }, { repeat: [3, 3] });
}

/** Woven linen for bed sheets / cushions. */
function linenTexture(base = '#c9d3de') {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(5);
    for (let y = 0; y < h; y += 2) {
      g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
      g.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 2) {
      g.fillStyle = `rgba(255,255,255,${0.012 + rnd() * 0.022})`;
      g.fillRect(x, 0, 1, h);
    }
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(90,100,115,${0.02 + rnd() * 0.035})`;
      g.fillRect(rnd() * w, rnd() * h, 1, 1 + rnd() * 2);
    }
  }, { repeat: [3, 3] });
}

/** Quilted duvet: soft cotton with a stitched diamond grid and fibre loft. */
function duvetTexture(base = '#b9c6d4') {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(31);
    // loft: thousands of tiny soft specks so the surface is not flat colour
    for (let i = 0; i < 5200; i++) {
      const a = 0.02 + rnd() * 0.045;
      g.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(96,110,128,${a})`;
      const r = 1 + rnd() * 2.4;
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2);
      g.fill();
    }
    // quilted diamond grid: shallow seams catching a little shadow
    g.lineWidth = 1.8;
    const step = 64;
    for (let i = -h; i < w + h; i += step) {
      g.strokeStyle = 'rgba(70,82,98,0.13)';
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
      g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke();
    }
    g.lineWidth = 1;
    for (let i = -h; i < w + h; i += step) {
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.beginPath(); g.moveTo(i + 2, 0); g.lineTo(i + h + 2, h); g.stroke();
      g.beginPath(); g.moveTo(i + h + 2, 0); g.lineTo(i + 2, h); g.stroke();
    }
  }, { repeat: [4, 4] });
}

/** Woven wool rug: dense pile, subtle banding and a repeating kilim motif. */
function rugTexture(base = '#5b4a3e', accent = '#8d7561') {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(71);
    // dense pile speckle
    for (let i = 0; i < 16000; i++) {
      const a = 0.04 + rnd() * 0.10;
      g.fillStyle = rnd() > 0.48 ? `rgba(255,255,255,${a * 0.6})` : `rgba(0,0,0,${a})`;
      g.fillRect(rnd() * w, rnd() * h, 1, 2 + rnd() * 3);
    }
    // horizontal weft bands
    for (let y = 0; y < h; y += 8) {
      g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.04})`;
      g.fillRect(0, y, w, 3);
    }
    // a repeating diamond motif in the accent tone
    g.strokeStyle = accent;
    g.globalAlpha = 0.22;
    g.lineWidth = 3.5;
    const cell = 86;
    for (let y = cell * 0.5; y < h; y += cell) {
      for (let x = cell * 0.5; x < w; x += cell) {
        g.beginPath();
        g.moveTo(x, y - cell * 0.30);
        g.lineTo(x + cell * 0.26, y);
        g.lineTo(x, y + cell * 0.30);
        g.lineTo(x - cell * 0.26, y);
        g.closePath();
        g.stroke();
      }
    }
    g.globalAlpha = 0.12;
    g.lineWidth = 1.6;
    for (let y = cell * 0.5; y < h; y += cell) {
      for (let x = cell * 0.5; x < w; x += cell) {
        g.beginPath();
        g.moveTo(x, y - cell * 0.16);
        g.lineTo(x + cell * 0.14, y);
        g.lineTo(x, y + cell * 0.16);
        g.lineTo(x - cell * 0.14, y);
        g.closePath();
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }, { repeat: [1, 1] });
}

/** Warm oak for furniture. */
function oakTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#b08556';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(88);
    for (let i = 0; i < 220; i++) {
      g.strokeStyle = `rgba(${96 + rnd() * 60},${68 + rnd() * 44},${38 + rnd() * 28},${0.15 + rnd() * 0.35})`;
      g.lineWidth = 1 + rnd() * 3.5;
      const y = rnd() * h;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= w; x += 48) g.lineTo(x, y + Math.sin(x * 0.01 + i) * 5 + (rnd() - 0.5) * 3);
      g.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const x = rnd() * w, y = rnd() * h;
      g.strokeStyle = 'rgba(80,52,28,0.4)';
      g.lineWidth = 2;
      for (let r = 3; r < 16; r += 3) {
        g.beginPath();
        g.ellipse(x, y, r * 1.6, r, 0, 0, TAU);
        g.stroke();
      }
    }
  }, { repeat: [1, 1] });
}

/** Brushed steel for the fridge. */
function steelTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#9aa2a9';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(14);
    for (let i = 0; i < 1600; i++) {
      const y = rnd() * h;
      g.strokeStyle = `rgba(${40 + rnd() * 120},${45 + rnd() * 120},${50 + rnd() * 120},${0.05 + rnd() * 0.12})`;
      g.lineWidth = 0.5 + rnd();
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y + (rnd() - 0.5) * 2);
      g.stroke();
    }
  }, { repeat: [1, 1] });
}

/** Cracks and moss for the stone plinth. */
function stoneTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#8b8f93';
    g.fillRect(0, 0, w, h);
    const rnd = mulberry32(41);
    const rows = 6;
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 60;
      while (x < w) {
        const bw = 40 + rnd() * 80;
        const v = 104 + rnd() * 54;
        g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
        g.fillRect(x + 2, r * rh + 2, bw - 4, rh - 4);
        g.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`;
        g.fillRect(x + 2, r * rh + rh - 6, bw - 4, 3);
        x += bw;
      }
      g.fillStyle = 'rgba(48,50,54,0.7)';
      g.fillRect(0, r * rh, w, 2);
    }
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(${40 + rnd() * 40},${60 + rnd() * 40},${40 + rnd() * 30},${0.05 + rnd() * 0.12})`;
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, 1 + rnd() * 7, 0, TAU);
      g.fill();
    }
  }, { repeat: [2, 1] });
}

/* -------------------------------------------------------------------------- */
/*  rain droplets                                                              */
/* -------------------------------------------------------------------------- */

/** Height canvas of scattered droplets + a few slide trails. */
function dropletHeightCanvas(size = 512) {
  const c = offscreen(size);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const rnd = mulberry32(2024);

  const drop = (x, y, r) => {
    const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.55, 'rgba(190,190,190,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  };

  // big drops with long tails
  for (let i = 0; i < 46; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 3 + rnd() * 7;
    // tail
    const len = r * (2 + rnd() * 9);
    const grad = g.createLinearGradient(x, y, x, y + len);
    grad.addColorStop(0, 'rgba(180,180,180,0.55)');
    grad.addColorStop(1, 'rgba(180,180,180,0)');
    g.fillStyle = grad;
    g.fillRect(x - r * 0.32, y, r * 0.64, len);
    drop(x, y, r);
  }
  // dense small beads
  for (let i = 0; i < 1500; i++) {
    drop(rnd() * size, rnd() * size, 0.7 + rnd() * 2.4);
  }
  return c;
}

function dropletTextures() {
  const c = dropletHeightCanvas(512);
  const normal = canvasToNormal(c, 3.2);
  const maskTex = new THREE.CanvasTexture(c);
  maskTex.wrapS = maskTex.wrapT = THREE.RepeatWrapping;
  return { normal, mask: maskTex };
}

/* -------------------------------------------------------------------------- */
/*  materials                                                                  */
/* -------------------------------------------------------------------------- */

export function createMaterials() {
  const M = {};

  const plank = plankTexture();
  const floorTex = floorBoardTexture();
  const snow = snowTexture();
  const rock = rockTexture();
  const linen = linenTexture('#cfd8e2');
  const duvetTex = duvetTexture('#b9c6d4');
  const rugWarm = rugTexture('#4f4034', '#9a7f65');
  const rugCool = rugTexture('#333d49', '#4a5766');
  const linenWarm = linenTexture('#d6c3ae');
  const oak = oakTexture();
  const steel = steelTexture();
  const stone = stoneTexture();
  const drops = dropletTextures();

  M.textures = { plank, floorTex, snow, rock, linen, oak, drops, duvetTex, rugWarm, rugCool };

  /* ---- exterior ---------------------------------------------------------- */
  M.timber = new THREE.MeshStandardMaterial({
    map: plank, color: 0xe6e0d6, roughness: 0.9, metalness: 0.0,
  });
  M.timberDark = new THREE.MeshStandardMaterial({
    map: plank, color: 0xbdb2a4, roughness: 0.94, metalness: 0.0,
  });
  M.trim = new THREE.MeshStandardMaterial({
    color: 0xc3cad1, roughness: 0.62, metalness: 0.02,
  });
  M.snow = new THREE.MeshStandardMaterial({
    map: snow, color: 0xdfe9f5, roughness: 0.78, metalness: 0.0,
    emissive: 0x1a2634, emissiveIntensity: 0.16,
  });
  M.stone = new THREE.MeshStandardMaterial({
    map: stone, color: 0xb9bec4, roughness: 0.95,
  });
  M.rock = new THREE.MeshStandardMaterial({
    map: rock, color: 0x6d737a, roughness: 0.9,
  });
  M.roofSlate = new THREE.MeshStandardMaterial({
    color: 0x40464e, roughness: 0.86, metalness: 0.05,
  });

  /* ---- interior ---------------------------------------------------------- */
  M.floor = new THREE.MeshStandardMaterial({
    map: floorTex, color: 0xa8886a, roughness: 0.72, metalness: 0.0,
  });
  M.oak = new THREE.MeshStandardMaterial({ map: oak, color: 0xc0a075, roughness: 0.68 });
  M.oakDark = new THREE.MeshStandardMaterial({ map: oak, color: 0x7d6244, roughness: 0.72 });
  M.plaster = new THREE.MeshStandardMaterial({ map: linen, color: 0x8a9099, roughness: 0.95 });
  M.plasterWarm = new THREE.MeshStandardMaterial({ color: 0x87796c, roughness: 0.96 });
  // Ceiling boards sit above every light in the house, so they render as a black
  // void unless given a floor of their own brightness.
  M.ceiling = new THREE.MeshStandardMaterial({
    map: plank,
    color: 0xb09a80,
    roughness: 0.9,
    emissive: 0x3b4553,
    emissiveIntensity: 1.05,
  });
  // A brushed-steel fridge at metalness .86 mirrors a black night room and reads
  // as a navy slab. Kitchen appliance steel is really a soft grey diffuse.
  // NOT metallic: at any real metalness the appliance mirrors a blue night
  // environment and the whole fridge renders as a saturated cyan slab.
  M.fridgeShell = new THREE.MeshStandardMaterial({
    color: 0xb4b0a6, roughness: 0.52, metalness: 0.0,
    envMapIntensity: 0.22,
  });

  M.linen = new THREE.MeshStandardMaterial({ map: linen, color: 0xb9c0c8, roughness: 0.92 });
  M.linenWarm = new THREE.MeshStandardMaterial({ map: linenWarm, color: 0xb9a68c, roughness: 0.92 });
  M.duvet = new THREE.MeshStandardMaterial({ map: duvetTex, color: 0x94a1b0, roughness: 0.95 });
  M.duvetEdge = new THREE.MeshStandardMaterial({ color: 0x55697e, roughness: 0.92 });
  M.wool = new THREE.MeshStandardMaterial({ color: 0x8a6d58, roughness: 0.97 });

  M.steel = new THREE.MeshStandardMaterial({
    map: steel, color: 0xc8ced4, roughness: 0.34, metalness: 0.86,
  });
  M.steelDark = new THREE.MeshStandardMaterial({
    color: 0x2c3136, roughness: 0.5, metalness: 0.8,
  });
  M.brass = new THREE.MeshStandardMaterial({
    color: 0xb08d4f, roughness: 0.38, metalness: 0.85,
  });
  M.ceramic = new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.35 });

  /* ---- lighting fixtures ------------------------------------------------- */
  M.lampShadeWarm = new THREE.MeshStandardMaterial({
    color: 0xf2e0c4, roughness: 0.75,
    emissive: 0xffb460, emissiveIntensity: 1.0,
    side: THREE.DoubleSide, transparent: true, opacity: 0.96,
  });
  M.lampBulb = new THREE.MeshStandardMaterial({
    color: 0xfff2d8, emissive: 0xffd9a0, emissiveIntensity: 6.0,
  });
  M.lampOff = new THREE.MeshStandardMaterial({
    color: 0xe8e2d6, roughness: 0.7, emissive: 0x000000, emissiveIntensity: 0,
    side: THREE.DoubleSide,
  });
  M.lampOffBulb = new THREE.MeshStandardMaterial({
    color: 0xd8d4cc, roughness: 0.5, emissive: 0x000000, emissiveIntensity: 0,
  });

  /* ---- glass ------------------------------------------------------------- */
  M.glass = new THREE.MeshPhysicalMaterial({
    // roughness 0.06 made the pane a near mirror: looking north it reflected
    // the warm village behind the visitor as a bright orange blob dead centre.
    color: 0xbfd6e8, roughness: 0.34, metalness: 0.0, specularIntensity: 0.22,
    transparent: true, opacity: 0.12, side: THREE.DoubleSide,
    depthWrite: false,
    // A high envMapIntensity on a flat pane condenses the environment's warm
    // pixels (the village sprites reflected in the cube map) into one bright
    // orange blob in the middle of the glass. Keep the reflection weak.
    envMapIntensity: 0.30,
    normalMap: drops.normal, normalScale: new THREE.Vector2(0.10, 0.10),
  });
  M.glass.normalMap.repeat.set(2, 2);

  M.mirror = new THREE.MeshStandardMaterial({
    color: 0x9fb4c6, roughness: 0.08, metalness: 1.0, envMapIntensity: 1.6,
  });

  /* ---- emissive accents -------------------------------------------------- */
  M.windowGlow = new THREE.MeshBasicMaterial({
    color: 0xffc27a, transparent: true, opacity: 0.55,
  });
  M.farLight = new THREE.MeshBasicMaterial({ color: 0xffca7a });

  return M;
}
