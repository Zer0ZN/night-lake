import * as THREE from 'three';
import { TAU, DEG, clamp, lerp, mulberry32, box, chamferBox } from './util.js';

/* -------------------------------------------------------------------------- */
/*  dimensions (house-local metres; +Z = south, -Z = north)                    */
/* -------------------------------------------------------------------------- */

export const H = {
  wallT: 0.17,
  hw: 3.30,          // outer half width  (x)
  hd: 2.95,          // outer half depth  (z)
  eave: 2.62,        // wall head height
  ridge: 3.74,
  innerX: 3.13,
  innerZ: 2.78,
  partitionZ: -0.10,
  partitionT: 0.10,
  doorW: 0.98,
  doorH: 2.08,
  doorX: -1.55,
  southWinX: 1.35,
  southWinW: 1.30,
  southWinSill: 1.02,
  southWinH: 1.18,
  northWinX: 0.85,
  northWinW: 2.15,
  northWinSill: 0.88,
  northWinH: 1.52,
  eastWinZ: 1.55,
  eastWinW: 0.72,
  eastWinSill: 1.30,
  eastWinH: 0.86,
};

// The island pad sits at y=0.44; the house floor rides 0.14 above it so the
// terrain can never z-fight or poke through the floor boards.
export const PAD_Y = 0.58;   // island pad height under the house + clearance
const FLOOR_Y = 0;          // top of interior floor
const PLINTH_H = 0.30;      // stone base above the terrain pad

/* -------------------------------------------------------------------------- */
/*  helpers                                                                    */
/* -------------------------------------------------------------------------- */

function cloneMat(m, repeat) {
  const c = m.clone();
  if (m.map && repeat) {
    c.map = m.map.clone();
    c.map.repeat.set(repeat[0], repeat[1]);
    c.map.needsUpdate = true;
  }
  return c;
}

/**
 * A wall slab built from an extruded outline so window/door holes are real holes.
 * outline: array of [x, y] in wall-local space (x centred on 0, y from 0).
 * holes: array of arrays of [x,y] outlines.
 */
function wallSlab(outline, holes, thickness, material) {
  const shape = new THREE.Shape();
  outline.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  for (const hole of holes) {
    const p = new THREE.Path();
    hole.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
    p.closePath();
    shape.holes.push(p);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: false, curveSegments: 6,
  });
  geo.translate(0, 0, -thickness / 2);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function rect(cx, cy, w, h) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function rectFromBase(cx, y0, w, h) {
  return rect(cx, y0 + h / 2, w, h);
}

/** Gable outline: rectangle to eave height plus the roof triangle. */
function gableOutline(width, eave, ridge) {
  return [
    [-width / 2, 0],
    [width / 2, 0],
    [width / 2, eave],
    [0, ridge],
    [-width / 2, eave],
  ];
}

/* -------------------------------------------------------------------------- */
/*  window / door frames                                                       */
/* -------------------------------------------------------------------------- */

function windowUnit(M, { w, h, sill, depth = H.wallT, mullions = 1, transom = false }) {
  const g = new THREE.Group();
  const frameMat = M.trim;
  const t = 0.055;                     // frame thickness
  const dpt = depth + 0.03;

  // outer frame
  const top = box(w, t, dpt, frameMat); top.position.set(0, h / 2 - t / 2, 0);
  const bot = box(w, t, dpt, frameMat); bot.position.set(0, -h / 2 + t / 2, 0);
  const left = box(t, h, dpt, frameMat); left.position.set(-w / 2 + t / 2, 0, 0);
  const right = box(t, h, dpt, frameMat); right.position.set(w / 2 - t / 2, 0, 0);
  g.add(top, bot, left, right);

  // mullions
  for (let i = 1; i <= mullions; i++) {
    const x = -w / 2 + (w * i) / (mullions + 1);
    const mull = box(t * 0.62, h - t * 2, depth * 0.8, frameMat);
    mull.position.set(x, 0, 0);
    g.add(mull);
  }
  if (transom) {
    const ty = h * 0.16;
    const tr = box(w - t * 2, t * 0.6, depth * 0.8, frameMat);
    tr.position.set(0, ty, 0);
    g.add(tr);
  }

  // sill plate, wider than the wall
  const sillPlate = box(w + 0.14, 0.05, depth + 0.22, M.trim);
  sillPlate.position.set(0, -h / 2 - 0.02, 0.03);
  g.add(sillPlate);

  // glass
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - t * 2, h - t * 2), M.glass);
  glass.position.z = 0.004;
  glass.renderOrder = 4;
  g.add(glass);

  // NOTE: children are built around the pane centre, so lift the group by the
  // sill ONCE here. Callers must set only x/z (a position.set would wipe this).
  const wrap = new THREE.Group();
  g.position.y = sill + h / 2;
  wrap.add(g);
  return { group: wrap, pane: g, glass, w, h, sill };
}

/** Instanced rain beads + sliding trails on a window pane. */
/**
 * Rain beading on a pane. Drawn as texture quads rather than spheres: a water
 * bead on glass reads through its rim (refraction ring) and its highlight, and
 * a tiny sphere gives neither. Also multiplies a condensation film over the
 * whole pane so the glass looks wet rather than clean.
 */
function rainOnGlass(M, w, h, seed = 7) {
  const g = new THREE.Group();
  const rnd = mulberry32(seed);

  const dropTex = makeDropletTexture();
  const dropMat = new THREE.MeshBasicMaterial({
    map: dropTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    opacity: 0.95,
    fog: false,
  });

  // a very faint wet film so the whole pane reads as condensed
  const filmTex = makeFilmTexture();
  const film = new THREE.Mesh(
    new THREE.PlaneGeometry(w - 0.02, h - 0.02),
    new THREE.MeshBasicMaterial({
      map: filmTex, transparent: true, opacity: 0.11,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }),
  );
  film.position.z = 0.002;
  film.renderOrder = 4;
  g.add(film);

  // static beads, weighted towards the top where rain first lands
  const count = 300;
  const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dropMat, count);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const t = Math.pow(rnd(), 0.75);              // 0 = top, 1 = bottom
    const r = 0.0035 + Math.pow(rnd(), 2.3) * 0.0145;
    pos.set((rnd() - 0.5) * (w - 0.06), (h / 2 - 0.03) - t * (h - 0.06), 0.0045);
    scl.set(r * 1.85, r * (1.0 + rnd() * 0.45), 1);
    m4.compose(pos, q, scl);
    inst.setMatrixAt(i, m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.renderOrder = 5;
  g.add(inst);

  // running drops: a head bead with a thin tail behind it
  const runs = [];
  for (let i = 0; i < 9; i++) {
    const rg = new THREE.Group();
    const head = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dropMat);
    const hr = 0.0065 + rnd() * 0.0055;
    head.scale.set(hr * 2.0, hr * 1.35, 1);
    head.position.set(0, 0, 0.0050);
    rg.add(head);
    const tail = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeTrailTexture(), transparent: true, opacity: 0.26,
        depthWrite: false, blending: THREE.NormalBlending, fog: false,
      }),
    );
    const tl = 0.03 + rnd() * 0.16;
    tail.scale.set(hr * 1.1, tl, 1);
    tail.position.set(0, tl / 2 + hr * 0.6, 0.0048);
    rg.add(tail);
    rg.renderOrder = 6;
    rg.position.set(
      (rnd() - 0.5) * (w - 0.10),
      (rnd() - 0.5) * (h - 0.16),
      0,
    );
    rg.userData = {
      speed: 0.014 + rnd() * 0.055,
      top: (h - 0.14) / 2,
      bot: -(h - 0.14) / 2,
      wobble: rnd() * TAU,
    };
    g.add(rg);
    runs.push(rg);
  }

  return {
    group: g,
    update(t, dt) {
      for (const rg of runs) {
        const u = rg.userData;
        rg.position.y -= u.speed * dt;
        rg.position.x += Math.sin(t * 0.9 + u.wobble) * 0.00035;
        // drops stall, then slip again — that is what real beading looks like
        u.speed = 0.006 + Math.abs(Math.sin(t * 0.8 + u.wobble)) * 0.05;
        if (rg.position.y < u.bot) {
          rg.position.y = u.top;
          rg.position.x = (Math.random() - 0.5) * (w - 0.10);
        }
      }
    },
  };
}

/** One water bead: dark refracting rim, bright caustic core, soft specular. */
function makeDropletTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2, r = S / 2 - 1;
  // body of the bead — slightly darker than the sky behind it
  const body = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
  body.addColorStop(0.0, 'rgba(120,150,180,0.30)');
  body.addColorStop(0.55, 'rgba(90,120,155,0.34)');
  body.addColorStop(0.88, 'rgba(45,70,100,0.60)');
  body.addColorStop(1.0, 'rgba(25,40,60,0.0)');
  g.fillStyle = body;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  // rim: an arc of light where the bead refracts the sky
  g.strokeStyle = 'rgba(235,248,255,0.85)';
  g.lineWidth = 2.6;
  g.beginPath(); g.arc(cx, cy, r * 0.84, -2.6, -0.45); g.stroke();
  g.strokeStyle = 'rgba(190,220,245,0.35)';
  g.lineWidth = 1.4;
  g.beginPath(); g.arc(cx, cy, r * 0.80, 0.5, 1.9); g.stroke();
  // specular highlight, up and to the left
  const hx = cx - r * 0.30, hy = cy - r * 0.32;
  const hi = g.createRadialGradient(hx, hy, 0, hx, hy, r * 0.30);
  hi.addColorStop(0, 'rgba(255,255,255,1.0)');
  hi.addColorStop(0.30, 'rgba(240,250,255,0.55)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hi;
  g.beginPath(); g.arc(hx, hy, r * 0.30, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeTrailTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(190,220,245,0.55)');
  grd.addColorStop(0.55, 'rgba(150,185,215,0.22)');
  grd.addColorStop(1, 'rgba(150,185,215,0.0)');
  g.fillStyle = grd;
  g.fillRect(5, 0, 6, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFilmTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(99);
  for (let i = 0; i < 700; i++) {
    const x = rnd() * S, y = rnd() * S;
    const rr = 0.6 + rnd() * 2.2;
    g.fillStyle = `rgba(200,224,245,${0.02 + rnd() * 0.07})`;
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function doorLeaf(M) {
  const g = new THREE.Group();
  const w = H.doorW - 0.03;
  const h = H.doorH - 0.03;
  const t = 0.055;

  // frame of the leaf
  const stile = 0.10;
  const leafMat = cloneMat(M.timberDark, [0.9, 0.9]);

  const boardCount = 4;
  const bw = (w - stile * 2) / boardCount;
  for (let i = 0; i < boardCount; i++) {
    const b = box(bw - 0.006, h - stile * 2, t, leafMat);
    b.position.set(-w / 2 + stile + bw * i + bw / 2, 0, 0);
    g.add(b);
  }
  // vertical stiles
  for (const sx of [-w / 2 + stile / 2, w / 2 - stile / 2]) {
    const s = box(stile, h, t * 1.15, M.oakDark);
    s.position.set(sx, 0, 0);
    g.add(s);
  }
  // top and bottom rails
  for (const sy of [-h / 2 + stile / 2, h / 2 - stile / 2]) {
    const r = box(w, stile, t * 1.15, M.oakDark);
    r.position.set(0, sy, 0);
    g.add(r);
  }
  // diagonal brace on the inside face
  const braceLen = Math.hypot(w * 0.72, h * 0.72);
  const brace = box(braceLen, 0.075, t * 0.55, M.oakDark);
  brace.position.set(0, 0, -t * 0.62);
  brace.rotation.z = Math.atan2(h * 0.72, w * 0.72);
  g.add(brace);

  // handle + latch
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.10, 12), M.brass);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(w / 2 - 0.13, 0, 0.07);
  g.add(handle);
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.014, 14), M.brass);
  rose.rotation.x = Math.PI / 2;
  rose.position.set(w / 2 - 0.13, 0, 0.036);
  g.add(rose);
  const handle2 = handle.clone();
  handle2.position.z = -0.07;
  const rose2 = rose.clone();
  rose2.position.z = -0.036;
  g.add(handle2, rose2);

  // hinges
  for (const hy of [-h * 0.34, h * 0.34]) {
    const hg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.075, 10), M.steelDark);
    hg.position.set(-w / 2 + 0.006, hy, 0);
    g.add(hg);
  }

  return g;
}

/* -------------------------------------------------------------------------- */
/*  furniture                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A draped cloth surface: flat over the middle, falling down both sides, with
 * soft ripples. Built as a grid so normals interpolate smoothly.
 */
function buildDrape(material, { w, len, top, thick, zc, flatW, drop, seed = 1 }) {
  const nx = 30, nz = 26;
  const geo = new THREE.BufferGeometry();
  const pos = [];
  const uv = [];
  const idx = [];
  const rnd = mulberry32(seed);
  const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
  for (let i = 0; i <= nz; i++) {
    const v = i / nz;
    const z = -len / 2 + v * len;
    for (let j = 0; j <= nx; j++) {
      const u = j / nx;
      const x = -w / 2 + u * w;
      const ax = Math.abs(x);
      let y;
      if (ax <= flatW) {
        y = top;
      } else {
        const t = (ax - flatW) / (w / 2 - flatW);
        y = top - Math.pow(t, 1.5) * drop;
      }
      // rumples: strongest at the drape, gentle across the top
      const edge = Math.min(1, Math.max(0, (ax - flatW * 0.55) / (w / 2 - flatW * 0.55)));
      const ripple =
        Math.sin(x * 9.0 + ph[0]) * 0.016 * (0.45 + edge * 1.3) +
        Math.cos(z * 7.0 + ph[1]) * 0.013 * (0.40 + edge * 1.2) +
        Math.sin((x + z) * 14.0 + ph[2]) * 0.005;
      y += ripple;
      pos.push(x, y, z);
      uv.push(u, v);
    }
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j;
      const b = a + nx + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.z = zc;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildBed(M) {
  const g = new THREE.Group();
  const BW = 1.60, BL = 2.00;

  // legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(0.075, 0.24, 0.075, M.oakDark);
      leg.position.set(sx * (BW / 2 - 0.08), 0.12, sz * (BL / 2 - 0.08));
      g.add(leg);
    }
  }
  // frame rails
  const railF = box(BW, 0.11, 0.055, M.oak);
  railF.position.set(0, 0.235, BL / 2 - 0.03);
  const railB = railF.clone(); railB.position.z = -BL / 2 + 0.03;
  const railL = box(0.055, 0.11, BL, M.oak);
  railL.position.set(-BW / 2 + 0.03, 0.235, 0);
  const railR = railL.clone(); railR.position.x = BW / 2 - 0.03;
  g.add(railF, railB, railL, railR);

  // slatted base
  for (let i = 0; i < 12; i++) {
    const z = -BL / 2 + 0.18 + (i * (BL - 0.36)) / 11;
    const s = box(BW - 0.11, 0.02, 0.055, M.oakDark);
    s.position.set(0, 0.305, z);
    g.add(s);
  }

  // mattress (top face at y = 0.52) — this is the white fitted sheet
  const mat = chamferBox(BW - 0.02, 0.20, BL - 0.04, M.linen, 0.05);
  mat.position.set(0, 0.42, 0);
  g.add(mat);

  // duvet: one continuous draped sheet. A grid mesh that lies flat over the
  // mattress and falls down the sides reads as bedding; stacked boxes never do.
  const duvet = buildDrape(M.duvet, {
    w: BW + 0.16, len: BL * 0.74, top: 0.575, thick: 0.16,
    zc: BL * 0.155, flatW: BW * 0.44, drop: 0.33, seed: 5,
  });
  g.add(duvet);
  // the duvet falls over the foot of the bed as well, so its end is not a cut slab
  const footDrop = buildDrape(M.duvet, {
    w: BW + 0.16, len: 0.26, top: 0.545, thick: 0.1,
    zc: BL * 0.155 + BL * 0.74 * 0.5 - 0.02, flatW: BW * 0.44, drop: 0.20, seed: 41,
  });
  footDrop.rotation.x = -Math.PI / 2 + 0.06;
  footDrop.rotation.z = Math.PI / 2;
  g.add(footDrop);

  // turned-down top edge of the duvet, in a warmer linen
  const fold = buildDrape(M.linenWarm, {
    w: BW + 0.06, len: 0.28, top: 0.606, thick: 0.06,
    zc: BL * 0.155 - BL * 0.350, flatW: BW * 0.52, drop: 0.09, seed: 23,
  });
  fold.rotation.x = 0.05;
  g.add(fold);

  // two puffy pillows propped against the headboard — built from squashed
  // spheres so they read as soft fabric rather than leaning planks
  const soft = (w, h, d, m) => {
    const sg = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 12), m);
    sg.scale.set(w, h, d);
    sg.castShadow = true; sg.receiveShadow = true;
    return sg;
  };
  for (const sx of [-0.37, 0.37]) {
    // sit them ON the mattress (top at 0.52) and keep them flatter than tall,
    // otherwise squashed spheres read as eggs hovering over the quilt
    const p = soft(0.72, 0.20, 0.46, M.linenWarm);
    p.position.set(sx, 0.585, -BL * 0.335);
    p.rotation.x = -0.40;
    g.add(p);
    const p2 = soft(0.60, 0.15, 0.36, M.linen);
    p2.position.set(sx + 0.02, 0.548, -BL * 0.212);
    p2.rotation.x = -0.14;
    g.add(p2);
  }
  // folded throw across the foot of the bed
  const throwB = buildDrape(M.wool, {
    w: BW + 0.12, len: 0.40, top: 0.632, thick: 0.09,
    zc: BL * 0.315, flatW: BW * 0.54, drop: 0.13, seed: 17,
  });
  g.add(throwB);

  // headboard
  const hb = chamferBox(BW + 0.10, 0.78, 0.06, M.oak, 0.02);
  hb.position.set(0, 0.66, -BL / 2 - 0.04);
  g.add(hb);
  for (let i = 0; i < 5; i++) {
    const slat = box(0.11, 0.62, 0.012, M.oakDark);
    slat.position.set(-BW / 2 + 0.18 + i * ((BW - 0.36) / 4), 0.68, -BL / 2 - 0.074);
    g.add(slat);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildBedsideTable(M) {
  const g = new THREE.Group();
  const W = 0.46, D = 0.40, Hh = 0.52;
  const top = chamferBox(W, 0.035, D, M.oak, 0.008);
  top.position.y = Hh;
  g.add(top);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(0.038, Hh - 0.02, 0.038, M.oakDark);
      leg.position.set(sx * (W / 2 - 0.05), (Hh - 0.02) / 2, sz * (D / 2 - 0.05));
      g.add(leg);
    }
  }
  const shelf = box(W - 0.08, 0.022, D - 0.08, M.oakDark);
  shelf.position.y = 0.20;
  g.add(shelf);
  // books on the shelf
  const bc = new THREE.Color();
  const rnd = mulberry32(31);
  for (let i = 0; i < 4; i++) {
    const bw = 0.022 + rnd() * 0.02;
    bc.setHSL(0.06 + rnd() * 0.06, 0.25, 0.30 + rnd() * 0.18);
    const bk = box(bw, 0.19 + rnd() * 0.05, 0.15, new THREE.MeshStandardMaterial({
      color: bc.clone(), roughness: 0.85,
    }));
    bk.position.set(-0.13 + i * 0.055, 0.31, 0.02);
    bk.rotation.z = (rnd() - 0.5) * 0.08;
    g.add(bk);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** The one warm light source in the house. */
function buildTableLamp(M) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.088, 0.028, 20), M.ceramic);
  base.position.y = 0.014;
  g.add(base);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.24, 12), M.brass);
  stem.position.y = 0.15;
  g.add(stem);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 12), M.brass);
  neck.position.y = 0.272;
  g.add(neck);

  // shade: open frustum, double sided so it glows from inside too
  const shadeGeo = new THREE.CylinderGeometry(0.095, 0.145, 0.17, 28, 1, true);
  const shadeMat = M.lampShadeWarm.clone();
  const shade = new THREE.Mesh(shadeGeo, shadeMat);
  shade.position.y = 0.365;
  g.add(shade);
  // rim caps for a solid edge
  const rimTop = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.0045, 6, 28), M.brass);
  rimTop.rotation.x = Math.PI / 2;
  rimTop.position.y = 0.45;
  const rimBot = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.0055, 6, 28), M.brass);
  rimBot.rotation.x = Math.PI / 2;
  rimBot.position.y = 0.28;
  g.add(rimTop, rimBot);

  // bulb
  const bulbMat = M.lampBulb.clone();
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.038, 14, 10), bulbMat);
  bulb.position.y = 0.345;
  g.add(bulb);

  // light
  const light = new THREE.PointLight(0xffb168, 0, 6.2, 2.0);
  light.position.y = 0.35;
  const lightOff = new THREE.PointLight(0xffc48a, 0, 5.0, 2.0);
  lightOff.position.y = 0.36;
  g.add(light, lightOff);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });

  let on = false;
  const api = {
    group: g,
    light, lightOff, shadeMat, bulbMat,
    get on() { return on; },
    set(v, instant = false) {
      on = !!v;
      const target = on ? 3.6 : 0;
      const target2 = on ? 4.4 : 0;
      if (instant) {
        light.intensity = target;
        lightOff.intensity = target2;
      }
      shadeMat.emissiveIntensity = on ? 0.42 : 0.0;
      shadeMat.color.set(on ? 0xf7e3c4 : 0xd8d2c6);
      bulbMat.emissiveIntensity = on ? 1.6 : 0.0;
      bulbMat.color.set(on ? 0xfff4e0 : 0xd6d2ca);
      shadeMat.needsUpdate = true;
      bulbMat.needsUpdate = true;
      api._target = { a: target, b: target2 };
    },
    toggle() { api.set(!on); },
    update(dt) {
      const tg = api._target || { a: 0, b: 0 };
      light.intensity += (tg.a - light.intensity) * clamp(dt * 9, 0, 1);
      lightOff.intensity += (tg.b - lightOff.intensity) * clamp(dt * 9, 0, 1);
      // a barely-there flicker keeps it alive
      const f = 1 + Math.sin(performance.now() * 0.0021) * 0.012;
      light.intensity *= f;
    },
  };
  api.set(false, true);
  return api;
}

function buildFridge(M) {
  const g = new THREE.Group();
  const W = 0.66, D = 0.66, Hh = 1.86;
  const body = chamferBox(W, Hh, D, M.fridgeShell || M.steel, 0.02);
  body.position.y = Hh / 2;
  g.add(body);

  // door split: fridge above, freezer drawer below
  const seam = box(W - 0.02, 0.008, 0.004, M.steelDark);
  seam.position.set(0, Hh * 0.32, D / 2 + 0.002);
  g.add(seam);

  // handles
  const h1 = box(0.030, 0.34, 0.035, M.steelDark);
  h1.position.set(W / 2 - 0.09, Hh * 0.66, D / 2 + 0.030);
  const h2 = box(0.030, 0.16, 0.035, M.steelDark);
  h2.position.set(W / 2 - 0.09, Hh * 0.18, D / 2 + 0.030);
  g.add(h1, h2);

  // a small brand plate
  const plate = box(0.10, 0.018, 0.002, M.steelDark);
  plate.position.set(-0.16, Hh * 0.80, D / 2 + 0.0015);
  g.add(plate);

  // feet
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const f = box(0.05, 0.05, 0.05, M.steelDark);
      f.position.set(sx * (W / 2 - 0.07), 0.025, sz * (D / 2 - 0.07));
      g.add(f);
    }
  }
  // magnets / notes to break the steel up
  const rnd = mulberry32(19);
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Color().setHSL(0.55 + rnd() * 0.2, 0.25, 0.62);
    const note = box(0.055 + rnd() * 0.03, 0.07 + rnd() * 0.02, 0.002,
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    note.position.set(-0.18 + rnd() * 0.3, 1.10 + rnd() * 0.25, D / 2 + 0.003);
    note.rotation.z = (rnd() - 0.5) * 0.25;
    g.add(note);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildTable(M) {
  const g = new THREE.Group();
  const W = 1.05, D = 0.70, Hh = 0.74;
  const top = chamferBox(W, 0.042, D, M.oak, 0.01);
  top.position.y = Hh;
  g.add(top);
  // apron
  for (const sz of [-1, 1]) {
    const a = box(W - 0.18, 0.06, 0.028, M.oakDark);
    a.position.set(0, Hh - 0.06, sz * (D / 2 - 0.08));
    g.add(a);
  }
  for (const sx of [-1, 1]) {
    const a = box(0.028, 0.06, D - 0.18, M.oakDark);
    a.position.set(sx * (W / 2 - 0.08), Hh - 0.06, 0);
    g.add(a);
  }
  // tapered legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.019, Hh - 0.04, 10), M.oakDark);
      leg.position.set(sx * (W / 2 - 0.09), (Hh - 0.04) / 2, sz * (D / 2 - 0.09));
      leg.castShadow = true;
      g.add(leg);
    }
  }
  // a mug and a book on the table
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.032, 0.085, 16, 1, true), M.ceramic);
  mug.position.set(-0.22, Hh + 0.065, 0.06);
  mug.material.side = THREE.DoubleSide;
  g.add(mug);
  const mugBase = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.008, 16), M.ceramic);
  mugBase.position.set(-0.22, Hh + 0.025, 0.06);
  g.add(mugBase);
  const book = box(0.18, 0.026, 0.13, new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.85 }));
  book.position.set(0.24, Hh + 0.034, -0.06);
  book.rotation.y = 0.22;
  g.add(book);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildChair(M) {
  const g = new THREE.Group();
  const seatY = 0.45;
  const seat = chamferBox(0.44, 0.038, 0.42, M.oak, 0.008);
  seat.position.y = seatY;
  g.add(seat);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.016, seatY, 10), M.oakDark);
      leg.position.set(sx * 0.175, seatY / 2, sz * 0.165);
      leg.castShadow = true;
      g.add(leg);
    }
  }
  // back posts
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.50, 10), M.oakDark);
    p.position.set(sx * 0.175, seatY + 0.24, -0.185);
    p.rotation.x = -0.10;
    p.castShadow = true;
    g.add(p);
  }
  // back slats
  for (let i = 0; i < 3; i++) {
    const s = box(0.33, 0.062, 0.014, M.oak);
    s.position.set(0, seatY + 0.16 + i * 0.115, -0.190 - i * 0.011);
    s.rotation.x = -0.10;
    g.add(s);
  }
  // stretchers
  for (const sz of [-1, 1]) {
    const st = box(0.33, 0.016, 0.016, M.oakDark);
    st.position.set(0, 0.18, sz * 0.165);
    g.add(st);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildWardrobe(M) {
  const g = new THREE.Group();
  const W = 1.00, D = 0.58, Hh = 1.94;
  const body = chamferBox(W, Hh, D, M.oak, 0.012);
  body.position.y = Hh / 2;
  g.add(body);
  // door split line
  const seam = box(0.006, Hh - 0.06, 0.004, M.oakDark);
  seam.position.set(0, Hh / 2, D / 2 + 0.001);
  g.add(seam);
  // handles
  for (const sx of [-1, 1]) {
    const hd = box(0.014, 0.13, 0.022, M.brass);
    hd.position.set(sx * 0.055, Hh * 0.52, D / 2 + 0.014);
    g.add(hd);
  }
  // feet
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const f = box(0.05, 0.07, 0.05, M.oakDark);
      f.position.set(sx * (W / 2 - 0.07), 0.035, sz * (D / 2 - 0.07));
      g.add(f);
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildRug(M, w, d, color, tex) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    map: tex || null, color: tex ? 0xffffff : color, roughness: 0.97,
  });
  // pile height: a low slab plus a slightly inset darker under-edge
  const base = chamferBox(w, 0.018, d, mat, 0.008);
  base.position.y = 0.010;
  g.add(base);
  const under = box(w - 0.03, 0.006, d - 0.03, new THREE.MeshStandardMaterial({
    color: new THREE.Color(tex ? 0x4a4a4a : color).multiplyScalar(0.55), roughness: 0.98,
  }));
  under.position.y = 0.003;
  g.add(under);
  // fringe at both short ends
  const fringeMat = new THREE.MeshStandardMaterial({
    color: tex ? 0x6b6152 : new THREE.Color(color).multiplyScalar(1.35), roughness: 0.95,
  });
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 16; i++) {
      const t = (i + 0.5) / 16;
      const f = box(0.010, 0.006, 0.032, fringeMat);
      f.position.set(-w / 2 + t * w, 0.005, sz * (d / 2 + 0.014));
      g.add(f);
    }
  }
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  return g;
}



function buildShelf(M) {
  const g = new THREE.Group();
  const W = 1.10;
  const plank = box(W, 0.035, 0.22, M.oak);
  plank.position.y = 0;
  g.add(plank);
  for (const sx of [-1, 1]) {
    // small triangular-ish oak bracket instead of a heavy steel block
    const br = box(0.035, 0.10, 0.16, M.oakDark);
    br.position.set(sx * (W / 2 - 0.10), -0.055, -0.02);
    g.add(br);
    const lip = box(0.035, 0.035, 0.05, M.oakDark);
    lip.position.set(sx * (W / 2 - 0.10), -0.10, -0.08);
    g.add(lip);
  }
  // books
  const rnd = mulberry32(53);
  let x = -W / 2 + 0.06;
  while (x < W / 2 - 0.10) {
    const bw = 0.024 + rnd() * 0.03;
    const bh = 0.16 + rnd() * 0.07;
    const c = new THREE.Color().setHSL(0.04 + rnd() * 0.10, 0.22 + rnd() * 0.2, 0.24 + rnd() * 0.2);
    const bk = box(bw, bh, 0.16, new THREE.MeshStandardMaterial({ color: c, roughness: 0.88 }));
    bk.position.set(x + bw / 2, bh / 2 + 0.018, 0.005);
    g.add(bk);
    x += bw + 0.004;
  }
  // a small jar
  const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.042, 0.10, 14), M.ceramic);
  jar.position.set(W / 2 - 0.12, 0.068, 0.01);
  g.add(jar);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildFirewood(M) {
  const g = new THREE.Group();
  const rnd = mulberry32(404);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2e, roughness: 0.95 });
  const endMat = new THREE.MeshStandardMaterial({ color: 0x8a7051, roughness: 0.9 });
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 5; i++) {
      const r = 0.045 + rnd() * 0.022;
      const len = 0.34 + rnd() * 0.10;
      const log = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 9), logMat);
      log.rotation.z = Math.PI / 2;
      log.position.set(
        (i - 2) * 0.10 + (rnd() - 0.5) * 0.02,
        0.05 + row * 0.085,
        (rnd() - 0.5) * 0.06,
      );
      log.castShadow = true;
      log.receiveShadow = true;
      g.add(log);
      // lighter cut ends
      for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.98, 9), endMat);
        cap.position.set(log.position.x + s * len / 2, log.position.y, log.position.z);
        cap.rotation.y = s * Math.PI / 2;
        g.add(cap);
      }
    }
  }
  return g;
}

/* -------------------------------------------------------------------------- */
/*  main assembly                                                              */
/* -------------------------------------------------------------------------- */

export function buildHouse(M) {
  const root = new THREE.Group();
  root.position.y = PAD_Y;            // sit the floor on the levelled pad
  const body = new THREE.Group();     // everything that is the building
  root.add(body);

  const wallMat = cloneMat(M.timber, [0.62, 0.62]);
  const wallInner = cloneMat(M.plaster, [1, 1]);
  const wallInnerWarm = cloneMat(M.plasterWarm, [1, 1]);

  const colliders = [];
  const addCol = (x0, z0, x1, z1, tag = '') =>
    colliders.push({ x0, z0, x1, z1, tag });

  /* ---------------- plinth + floor --------------------------------------- */
  const plinth = box(H.hw * 2 + 0.22, PLINTH_H, H.hd * 2 + 0.22, M.stone);
  // Keep the plinth top strictly BELOW the floor boards. At an offset of only
  // +0.002 its top face sat 2 mm proud of the floor and the stone poked through
  // the pine boards as pale rectangular patches all over the living room.
  plinth.position.y = -PLINTH_H / 2 - 0.012;
  body.add(plinth);

  const floorMesh = box(H.innerX * 2, 0.04, H.innerZ * 2, M.floor);
  floorMesh.position.y = FLOOR_Y - 0.02;
  body.add(floorMesh);
  // floor texture should run along the boards
  M.floor.map.repeat.set(2.2, 2.2);

  /* ---------------- walls ------------------------------------------------ */
  const gOut = gableOutline(H.hw * 2, H.eave, H.ridge);

  // NORTH wall (bedroom gable) with the Everest window
  const northHole = rectFromBase(H.northWinX, H.northWinSill, H.northWinW, H.northWinH);
  const northWall = wallSlab(gOut, [northHole], H.wallT, wallMat);
  northWall.position.set(0, FLOOR_Y, -H.hd + H.wallT / 2);
  body.add(northWall);
  const northLining = wallSlab(gOut, [northHole], 0.012, wallInner);
  northLining.position.set(0, FLOOR_Y, -H.hd + H.wallT + 0.006);
  body.add(northLining);

  // SOUTH wall (living gable) with door + window
  const doorHole = rectFromBase(H.doorX, 0, H.doorW, H.doorH);
  const southHole = rectFromBase(H.southWinX, H.southWinSill, H.southWinW, H.southWinH);
  const southWall = wallSlab(gOut, [doorHole, southHole], H.wallT, wallMat);
  southWall.position.set(0, FLOOR_Y, H.hd - H.wallT / 2);
  body.add(southWall);
  const southLining = wallSlab(gOut, [doorHole, southHole], 0.012, wallInnerWarm);
  southLining.position.set(0, FLOOR_Y, H.hd - H.wallT - 0.006);
  body.add(southLining);

  // EAST wall (living room) with a small slot window
  const eastOutline = [[-H.innerZ, 0], [H.innerZ, 0], [H.innerZ, H.eave], [-H.innerZ, H.eave]];
  // The slab is rotated +90 deg about Y, which maps local +x to world -z.
  // A hole authored at -eastWinZ therefore appears at +eastWinZ and the frame
  // ends up floating on the wall next to an empty pierced slot.
  const eastHole = rectFromBase(H.eastWinZ, H.eastWinSill, H.eastWinW, H.eastWinH);
  const eastWall = wallSlab(eastOutline, [eastHole], H.wallT, wallMat);
  eastWall.rotation.y = Math.PI / 2;
  eastWall.position.set(H.hw - H.wallT / 2, FLOOR_Y, 0);
  body.add(eastWall);
  const eastLining = wallSlab(eastOutline, [eastHole], 0.012, wallInner);
  eastLining.rotation.y = Math.PI / 2;
  eastLining.position.set(H.hw - H.wallT - 0.006, FLOOR_Y, 0);
  body.add(eastLining);

  // WEST wall (bedroom) — solid, keeps the warmth in
  const westOutline = [[-H.innerZ, 0], [H.innerZ, 0], [H.innerZ, H.eave], [-H.innerZ, H.eave]];
  const westWall = wallSlab(westOutline, [], H.wallT, wallMat);
  westWall.rotation.y = Math.PI / 2;
  westWall.position.set(-H.hw + H.wallT / 2, FLOOR_Y, 0);
  body.add(westWall);
  const westLining = wallSlab(westOutline, [], 0.012, wallInnerWarm);
  westLining.rotation.y = Math.PI / 2;
  westLining.position.set(-H.hw + H.wallT + 0.006, FLOOR_Y, 0);
  body.add(westLining);

  // PARTITION (bedroom | living) with a doorway
  const pH = H.eave;
  const pOutline = [[-H.innerX, 0], [H.innerX, 0], [H.innerX, pH], [-H.innerX, pH]];
  const pDoor = rectFromBase(1.95, 0, 1.02, 2.06);
  const partition = wallSlab(pOutline, [pDoor], H.partitionT, wallInnerWarm);
  partition.position.set(0, FLOOR_Y, H.partitionZ);
  body.add(partition);
  // partition trim
  const pCap = box(H.innerX * 2, 0.035, H.partitionT + 0.05, M.oakDark);
  pCap.position.set(0, FLOOR_Y + pH - 0.02, H.partitionZ);
  body.add(pCap);
  // doorway frame
  for (const sx of [-1, 1]) {
    const j = box(0.06, 2.06, H.partitionT + 0.05, M.oakDark);
    j.position.set(1.95 + sx * 0.54, FLOOR_Y + 1.03, H.partitionZ);
    body.add(j);
  }
  const head = box(1.14, 0.06, H.partitionT + 0.05, M.oakDark);
  head.position.set(1.95, FLOOR_Y + 2.08, H.partitionZ);
  body.add(head);

  /* ---------------- roof ------------------------------------------------- */
  const roofGroup = new THREE.Group();
  const eaveOver = 0.34;     // overhang in x
  const gableOver = 0.30;    // overhang in z
  const slopeLen = Math.hypot(H.hw + eaveOver, H.ridge - H.eave);
  const slopeAng = Math.atan2(H.ridge - H.eave, H.hw + eaveOver);

  const roofMat = cloneMat(M.roofSlate, [4, 2]);
  const snowMat = M.snow;

  const depthZ = (H.hd + gableOver) * 2;

  for (const s of [-1, 1]) {
    const panel = new THREE.Group();

    const slab = box(slopeLen, 0.15, depthZ, roofMat);
    slab.position.set((s * slopeLen) / 2, -0.075, 0);
    panel.add(slab);

    const snowSlab = box(slopeLen * 0.995, 0.06, depthZ - 0.02, snowMat);
    snowSlab.position.set((s * slopeLen) / 2, 0.035, 0);
    panel.add(snowSlab);

    const fascia = box(0.06, 0.17, depthZ, M.oak);
    fascia.position.set(s * (slopeLen - 0.03), -0.055, 0);
    panel.add(fascia);

    panel.position.set(0, FLOOR_Y + H.ridge, 0);
    panel.rotation.z = -s * slopeAng;
    roofGroup.add(panel);
  }

  // ridge cap
  const ridgeCap = box(0.17, 0.09, depthZ + 0.04, M.roofSlate);
  ridgeCap.position.set(0, FLOOR_Y + H.ridge + 0.09, 0);
  roofGroup.add(ridgeCap);
  const ridgeSnow = box(0.20, 0.07, depthZ, snowMat);
  ridgeSnow.position.set(0, FLOOR_Y + H.ridge + 0.145, 0);
  roofGroup.add(ridgeSnow);

  // barge boards along both gable edges
  const soffitMat = new THREE.MeshStandardMaterial({
    color: 0x9c8d7c, roughness: 0.98,
    emissive: 0x3a352c, emissiveIntensity: 0.72,
  });
  for (const sz of [-1, 1]) {
    for (const s of [-1, 1]) {
      const g2 = new THREE.Group();
      const bb = box(slopeLen, 0.15, 0.05, M.oak);
      bb.position.set((s * slopeLen) / 2, -0.01, 0);
      g2.add(bb);
      // Rake soffit: the gable overhang is 0.30 deep, so without a board under
      // it we look straight into the dark recess between the wall face and the
      // barge board and the roof edge reads as a black stripe. It has to sit
      // BELOW the slate (which spans -0.15..0 in this rotated frame) or it ends
      // up buried inside the slab and changes nothing. The material needs its
      // own emissive floor: these faces point straight down, so every light in
      // the scene misses them and they render as a black hole in the roof.
      const soffit = box(slopeLen * 0.99, 0.028, gableOver + 0.06, soffitMat);
      soffit.position.set((s * slopeLen) / 2, -0.164, -sz * (gableOver / 2 - 0.02));
      g2.add(soffit);
      g2.position.set(0, FLOOR_Y + H.ridge, sz * (H.hd + gableOver));
      g2.rotation.z = -s * slopeAng;
      roofGroup.add(g2);
    }
  }
  roofGroup.position.y = FLOOR_Y;
  body.add(roofGroup);

  /* ---------------- ceiling (interior) ----------------------------------- */
  // Without this the underside of the roof slabs is a black void overhead.
  // The boards MUST sit clear below the slate: at the same plane the two
  // surfaces z-fight and the roof wins, so the room appears to have no ceiling.
  const ceilMat = cloneMat(M.ceiling, [3, 3]);
  const ceilDrop = 0.26;                       // clearance under the slate
  const ceilRidge = FLOOR_Y + H.ridge - ceilDrop;
  const ceilEave = FLOOR_Y + H.eave - ceilDrop;
  const ceilAng = Math.atan2(ceilRidge - ceilEave, H.innerX);
  const ceilLen = Math.hypot(H.innerX, ceilRidge - ceilEave);
  for (const s of [-1, 1]) {
    const cp = new THREE.Group();
    const board = box(ceilLen, 0.028, H.innerZ * 2 - 0.02, ceilMat);
    board.position.set((s * ceilLen) / 2, 0, 0);
    cp.add(board);
    // exposed rafters so the ceiling is not a bare plane
    for (let i = -1; i <= 1; i++) {
      const raf = box(ceilLen * 0.99, 0.075, 0.07, M.oakDark);
      raf.position.set((s * ceilLen) / 2, -0.05, i * (H.innerZ * 0.62));
      cp.add(raf);
    }
    cp.position.set(0, ceilRidge, 0);
    cp.rotation.z = -s * ceilAng;
    body.add(cp);
  }
  // collars tying the rafters near the ridge
  for (const cz of [-1.15, 0.55]) {
    const collar = box(1.30, 0.07, 0.075, M.oakDark);
    collar.position.set(0, ceilRidge - 0.10, cz);
    body.add(collar);
  }
  // flat soffit band closing the gap between the wall head and the boarded slope
  for (const s of [-1, 1]) {
    const sof = box(0.62, 0.028, H.innerZ * 2 - 0.02, ceilMat);
    sof.position.set(s * (H.innerX - 0.30), FLOOR_Y + H.eave - 0.02, 0);
    body.add(sof);
  }

  // chimney flue
  const flue = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1.10, 16), M.steelDark);
  flue.position.set(-1.85, FLOOR_Y + 2.95, -1.55);
  body.add(flue);
  const flueCap = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.105, 0.10, 16), M.steelDark);
  flueCap.position.set(-1.85, FLOOR_Y + 3.52, -1.55);
  body.add(flueCap);

  /* ---------------- windows --------------------------------------------- */
  const northWin = windowUnit(M, {
    w: H.northWinW, h: H.northWinH, sill: H.northWinSill, mullions: 2, transom: false,
  });
  northWin.group.position.set(H.northWinX, FLOOR_Y, -H.hd + H.wallT / 2);
  body.add(northWin.group);
  // the north window is the star: heavy rain on it
  const rain = rainOnGlass(M, H.northWinW, H.northWinH, 11);
  rain.group.position.set(H.northWinX, FLOOR_Y + H.northWinSill + H.northWinH / 2, -H.hd + H.wallT / 2 + 0.012);
  body.add(rain.group);

  const southWin = windowUnit(M, {
    w: H.southWinW, h: H.southWinH, sill: H.southWinSill, mullions: 1, transom: true,
  });
  southWin.group.position.set(H.southWinX, FLOOR_Y, H.hd - H.wallT / 2);
  body.add(southWin.group);
  const rainS = rainOnGlass(M, H.southWinW, H.southWinH, 29);
  rainS.group.position.set(H.southWinX, FLOOR_Y + H.southWinSill + H.southWinH / 2, H.hd - H.wallT / 2 - 0.012);
  rainS.group.rotation.y = Math.PI;
  body.add(rainS.group);

  const eastWin = windowUnit(M, {
    w: H.eastWinW, h: H.eastWinH, sill: H.eastWinSill, mullions: 0, transom: false,
  });
  eastWin.group.rotation.y = -Math.PI / 2;
  eastWin.group.position.set(H.hw - H.wallT / 2, FLOOR_Y, -H.eastWinZ);
  body.add(eastWin.group);

  /* ---------------- door ------------------------------------------------- */
  const doorPivot = new THREE.Group();
  doorPivot.position.set(H.doorX - H.doorW / 2 + 0.015, FLOOR_Y + H.doorH / 2, H.hd - H.wallT / 2);
  const leaf = doorLeaf(M);
  leaf.position.x = (H.doorW - 0.03) / 2;
  doorPivot.add(leaf);
  body.add(doorPivot);

  // flush stone landing outside the door
  const landing = box(H.doorW + 0.80, 0.09, 0.62, M.stone);
  landing.position.set(H.doorX, FLOOR_Y - 0.045, H.hd + 0.26);
  body.add(landing);

  /* ---------------- interior: bedroom ----------------------------------- */
  const bed = buildBed(M);
  bed.position.set(-2.05, FLOOR_Y, -1.62);
  body.add(bed);

  const bedside = buildBedsideTable(M);
  bedside.position.set(-1.02, FLOOR_Y, -2.42);
  body.add(bedside);

  const lamp = buildTableLamp(M);
  lamp.group.position.set(-1.02, FLOOR_Y + 0.53, -2.42);
  body.add(lamp.group);

  const wardrobe = buildWardrobe(M);
  wardrobe.position.set(2.55, FLOOR_Y, -1.95);
  wardrobe.rotation.y = -Math.PI / 2;
  body.add(wardrobe);

  const rugBed = buildRug(M, 1.5, 1.1, 0x6d5a4c, M.textures.rugWarm);
  rugBed.position.set(-0.35, FLOOR_Y, -1.35);
  body.add(rugBed);

  /* ---------------- interior: living ------------------------------------ */
  const fridge = buildFridge(M);
  fridge.position.set(-2.78, FLOOR_Y, 1.05);
  fridge.rotation.y = Math.PI / 2;
  body.add(fridge);

  const table = buildTable(M);
  table.position.set(0.55, FLOOR_Y, 1.05);
  body.add(table);

  const chair = buildChair(M);
  chair.position.set(0.55, FLOOR_Y, 2.05);
  chair.rotation.y = Math.PI;
  body.add(chair);

  const rugLiv = buildRug(M, 2.0, 1.5, 0x43505e, M.textures.rugCool);
  rugLiv.position.set(0.45, FLOOR_Y, 1.25);
  body.add(rugLiv);

  const shelf = buildShelf(M);
  shelf.position.set(0.10, FLOOR_Y + 1.44, H.partitionZ + 0.135);
  body.add(shelf);

  // small bench by the door
  const bench = box(0.90, 0.045, 0.30, M.oak);
  bench.position.set(-2.55, FLOOR_Y + 0.42, 2.30);
  body.add(bench);
  for (const sx of [-1, 1]) {
    const bl = box(0.05, 0.42, 0.26, M.oakDark);
    bl.position.set(-2.55 + sx * 0.38, FLOOR_Y + 0.21, 2.30);
    body.add(bl);
  }

  // firewood outside, east wall
  const wood = buildFirewood(M);
  wood.position.set(3.62, 0.30, -1.30);
  root.add(wood);
  const wood2 = buildFirewood(M);
  wood2.position.set(3.62, 0.30, -0.35);
  wood2.rotation.y = 0.06;
  root.add(wood2);

  /* ---------------- interior lighting ------------------------------------ */
  // warm, only in the bedroom — the lamp
  // cold moon spill through the north window
  const northSpill = new THREE.PointLight(0x6f9fd8, 4.2, 9.0, 2.0);
  northSpill.position.set(H.northWinX, FLOOR_Y + 1.55, -H.hd + 0.55);
  body.add(northSpill);

  // cold spill through the south window + faint cold fill (no lamp in here)
  const southSpill = new THREE.PointLight(0x5c7ba8, 3.6, 8.5, 2.0);
  southSpill.position.set(H.southWinX, FLOOR_Y + 1.62, H.hd - 0.55);
  body.add(southSpill);

  const coldFill = new THREE.PointLight(0x2f4767, 3.6, 7.0, 2.0);
  coldFill.position.set(0.9, FLOOR_Y + 2.10, 1.35);
  body.add(coldFill);

  const coldFill2 = new THREE.PointLight(0x364f70, 2.3, 5.5, 2.0);
  coldFill2.position.set(-2.2, FLOOR_Y + 1.8, 0.55);
  body.add(coldFill2);

  /* ---------------- colliders -------------------------------------------- */
  const wallT = H.wallT;
  // outer walls
  addCol(-H.hw, -H.hd, H.hw, -H.hd + wallT, 'wallN');
  // south wall is split around the door opening so the doorway is passable
  addCol(-H.hw, H.hd - wallT, H.doorX - H.doorW / 2, H.hd, 'wallS1');
  addCol(H.doorX + H.doorW / 2, H.hd - wallT, H.hw, H.hd, 'wallS2');
  addCol(-H.hw, -H.hd, -H.hw + wallT, H.hd, 'wallW');
  addCol(H.hw - wallT, -H.hd, H.hw, H.hd, 'wallE');
  // partition, leaving the doorway free
  addCol(-H.innerX, H.partitionZ - H.partitionT / 2, 1.95 - 0.51, H.partitionZ + H.partitionT / 2, 'partA');
  addCol(1.95 + 0.51, H.partitionZ - H.partitionT / 2, H.innerX, H.partitionZ + H.partitionT / 2, 'partB');
  // furniture
  addCol(-2.95, -2.72, -1.15, -0.58, 'bed');
  addCol(-1.30, -2.66, -0.75, -2.16, 'bedside');
  addCol(2.10, -2.50, 2.90, -1.40, 'wardrobe');
  addCol(-3.15, 0.68, -2.40, 1.42, 'fridge');
  addCol(-0.02, 0.66, 1.12, 1.44, 'table');
  addCol(0.28, 1.78, 0.84, 2.32, 'chair');
  addCol(-3.05, 2.12, -2.05, 2.50, 'bench');

  /* ---------------- door / lamp interaction ------------------------------ */
  const state = {
    doorOpen: false,
    doorT: 0,        // 0 closed, 1 open
  };
  const DOOR_SWING = -1.85; // radians, swings outward

  function setDoor(open, instant = false) {
    state.doorOpen = !!open;
    if (instant) {
      state.doorT = open ? 1 : 0;
      doorPivot.rotation.y = DOOR_SWING * state.doorT;
    }
  }

  return {
    root,
    body,
    colliders,
    doorPivot,
    lamp,
    state,
    setDoor,
    getDoorAngle: () => doorPivot.rotation.y,
    doorColliderTag: 'door',
    // world-space AABB used while the door is closed
    doorClosedCol: {
      x0: H.doorX - H.doorW / 2, z0: H.hd - H.wallT,
      x1: H.doorX + H.doorW / 2, z1: H.hd,
      tag: 'door',
    },
    interactables: [],
    update(t, dt) {
      rain.update(t, dt);
      rainS.update(t, dt);
      lamp.update(dt);
      // ease the door
      const target = state.doorOpen ? 1 : 0;
      state.doorT += (target - state.doorT) * clamp(dt * 5.2, 0, 1);
      doorPivot.rotation.y = DOOR_SWING * state.doorT;
      // gentle breathing of the cold spill so the room feels alive
      southSpill.intensity = 1.15 + Math.sin(t * 0.42) * 0.06;
      northSpill.intensity = 1.05 + Math.sin(t * 0.31 + 1.7) * 0.05;
      // warm lamp breathes a little too
      if (lamp.on) {
        lamp.light.intensity *= 1 + Math.sin(t * 1.6) * 0.01;
      }
    },
  };
}

/** Named points the camera director can look at. */
export function houseViewpoints() {
  return {
    exteriorSouth: { pos: [0.2, 1.85, 9.6], target: [0.1, 1.5, 0.4] },
    exteriorSouthEast: { pos: [7.4, 2.1, 7.2], target: [0.4, 1.4, 0.2] },
    exteriorNorthWest: { pos: [-7.6, 2.0, -7.4], target: [0.2, 1.6, -0.6] },
    door: { pos: [H.doorX + 0.1, 1.55, 4.4], target: [H.doorX, 1.35, 2.9] },
    living: { pos: [1.9, 1.62, 2.35], target: [-1.4, 1.15, 0.65] },
    livingDoor: { pos: [2.3, 1.6, 1.05], target: [-2.2, 1.3, 1.9] },
    bedroom: { pos: [1.35, 1.55, -0.55], target: [-0.9, 1.05, -2.35] },
    bed: { pos: [0.95, 1.45, -0.85], target: [-1.6, 0.85, -1.9] },
    windowNorth: { pos: [0.85, 1.50, -0.45], target: [0.85, 1.62, -3.4] },
    windowSouth: { pos: [1.35, 1.62, 1.05], target: [1.35, 1.72, 3.6] },
    lakeView: { pos: [0.0, 1.7, -4.6], target: [-0.6, 2.4, -14.0] },
  };
}
