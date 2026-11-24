import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic value noise in 1D, used for gentle terrain undulation. */
export function valueNoise1D(seed) {
  const rnd = mulberry32(seed);
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = rnd();
  return (x) => {
    const xi = Math.floor(x);
    const xf = x - xi;
    const a = table[((xi % 256) + 256) % 256];
    const b = table[((xi + 1) % 256 + 256) % 256];
    const t = xf * xf * (3 - 2 * xf);
    return a + (b - a) * t;
  };
}

/** 2D value noise */
export function valueNoise2D(seed) {
  const rnd = mulberry32(seed);
  const S = 256;
  const table = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) table[i] = rnd();
  const at = (x, y) => table[((y % S) + S) % S * S + (((x % S) + S) % S)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi);
    const c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
}
export function fbm2D(noise, x, y, oct = 4, lac = 2.03, gain = 0.5) {
  let v = 0, a = 0.5, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    v += a * noise(fx, fy);
    fx *= lac; fy *= lac; a *= gain;
  }
  return v;
}

/** Draw into an offscreen canvas and wrap it as a THREE texture. */
export function canvasTexture(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  t.wrapS = opts.wrapS ?? THREE.RepeatWrapping;
  t.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.anisotropy = opts.anisotropy ?? 4;
  t.needsUpdate = true;
  return t;
}

/** A data-texture from a float heightfield -> normal map. */
export function heightToNormal(heightFn, size = 256, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = heightFn(x / size, y / size);
    }
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * Extrude a closed 2D outline (list of [x,y]) into a prism along Z.
 * Used for the gable walls and the roof profiles.
 */
export function extrudeOutline(points, depth, material, opts = {}) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  if (opts.holes) {
    for (const hole of opts.holes) {
      const p = new THREE.Path();
      hole.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      p.closePath();
      shape.holes.push(p);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 8,
  });
  geo.translate(0, 0, -depth / 2);
  const mesh = new THREE.Mesh(geo, material);
  return mesh;
}

/** Wall with rectangular holes, built from boxes so no CSG is needed. */
export function wallWithHoles(w, h, t, holes, material) {
  // holes: [{x, y, w, h}] in wall-local space, origin bottom-left at (-w/2, 0)
  const group = new THREE.Group();
  const xs = [-w / 2, w / 2];
  for (const s of xs) group.add(box(0.001, h, t, material)); // placeholder to keep API clear
  group.clear();

  // Build a grid of solid rectangles around the holes: horizontal bands first.
  const sorted = [...holes].sort((a, b) => a.y - b.y);
  let cursor = 0;
  const bands = [];
  for (const hole of sorted) {
    if (hole.y > cursor) bands.push({ y: cursor, h: hole.y - cursor, holes: [] });
    bands.push({ y: hole.y, h: hole.h, holes: [hole] });
    cursor = Math.max(cursor, hole.y + hole.h);
  }
  if (cursor < h) bands.push({ y: cursor, h: h - cursor, holes: [] });

  for (const band of bands) {
    const act = band.holes.sort((a, b) => a.x - b.x);
    let x = -w / 2;
    for (const hole of act) {
      const left = hole.x - hole.w / 2;
      if (left > x + 1e-4) group.add(slabb(x, band.y, left, band.y + band.h, t, material));
      x = Math.max(x, hole.x + hole.w / 2);
    }
    if (x < w / 2 - 1e-4) group.add(slabb(x, band.y, w / 2, band.y + band.h, t, material));
  }
  return group;

  function slabb(x0, y0, x1, y1, tt, m) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, tt);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

export function box(w, h, d, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Rounded box via bevelled box geometry substitute (cheap chamfer). */
export function chamferBox(w, h, d, material, r = 0.02) {
  // The corner projection only works while r stays below the smallest half
  // extent. Larger radii collapse the box into a flat sliver, so clamp it.
  r = Math.min(r, Math.min(w, h, d) * 0.34);
  const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const sx = Math.sign(v.x), sy = Math.sign(v.y), sz = Math.sign(v.z);
    v.x -= sx * r; v.y -= sy * r; v.z -= sz * r;
    const l = v.length();
    if (l > 1e-6) v.multiplyScalar((l + r) / l);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
