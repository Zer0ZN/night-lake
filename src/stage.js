import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { TAU, lerp, clamp, smoothstep, mulberry32, fbm2D, valueNoise2D } from './util.js';

/* -------------------------------------------------------------------------- */
/*  Sky: polar night, aurora, stars, moon                                      */
/* -------------------------------------------------------------------------- */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // force to far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uTime;
uniform vec3 uMoonDir;

// hash / noise
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;                     // 1 zenith, 0 horizon, <0 below

  /* --- base polar-night gradient ---------------------------------------- */
  vec3 zenith  = vec3(0.008, 0.014, 0.030);
  vec3 mid     = vec3(0.016, 0.030, 0.056);
  vec3 horizon = vec3(0.040, 0.062, 0.086);
  float t1 = smoothstep(-0.06, 0.34, h);
  float t2 = smoothstep(0.30, 0.92, h);
  vec3 col = mix(horizon, mid, t1);
  col = mix(col, zenith, t2);

  /* --- stars ------------------------------------------------------------- */
  if (h > -0.02) {
    vec2 sp = vec2(atan(d.z, d.x) * 3.0, asin(clamp(h, -1.0, 1.0)) * 6.0);
    vec2 gid = floor(sp * 42.0);
    vec2 gf = fract(sp * 42.0);
    float rnd = hash21(gid);
    if (rnd > 0.968) {
      vec2 c = hash22(gid) * 0.7 + 0.15;
      float dist = length(gf - c);
      float star = smoothstep(0.10, 0.0, dist);
      float twinkle = 0.6 + 0.4 * sin(uTime * (1.2 + rnd * 3.0) + rnd * 30.0);
      float bright = (0.35 + 0.65 * fract(rnd * 91.7)) * twinkle;
      col += vec3(0.82, 0.90, 1.0) * star * bright * smoothstep(-0.01, 0.16, h) * 1.5;
    }
    // faint galactic band
    vec2 cd = normalize(vec2(d.x, d.z) + 1e-5);
    float band = exp(-pow((h - 0.42 + 0.22 * cd.x) * 3.4, 2.0));
    float neb = fbm(cd * 3.2 + vec2(h * 5.0, uTime * 0.004));
    col += vec3(0.10, 0.13, 0.20) * band * neb * 0.42 * smoothstep(0.0, 0.2, h);
  }

  /* --- aurora ------------------------------------------------------------ */
  vec2 circ = normalize(vec2(d.x, d.z) + 1e-5);
  vec3 aur = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // vertical placement of this curtain
    float base = 0.10 + fi * 0.115;
    float t = h - base;

    // horizontal fold: low frequency wobble so the curtain snakes
    float fold = 0.085 + fi * 0.05
               + 0.085 * fbm(circ * (1.6 + fi * 0.7) + vec2(fi * 13.0, uTime * 0.017));

    float sheet = smoothstep(-0.020, 0.045, t) * (1.0 - smoothstep(0.055, 0.30 + fi * 0.07, t));

    // fine vertical rays, sparse
    float rayN = fbm(circ * (16.0 + fi * 7.0) + vec2(fi * 37.0, t * 2.4 - uTime * 0.06));
    float ray = pow(clamp((rayN - 0.40) / 0.60, 0.0, 1.0), 1.6) * 2.2;

    float strength = sheet * (0.06 + ray) * (1.0 - fi * 0.16) * fold;

    // hue: green core -> teal -> violet fringe
    vec3 cGreen = vec3(0.16, 0.86, 0.52);
    vec3 cTeal  = vec3(0.10, 0.66, 0.72);
    vec3 cViolet = vec3(0.42, 0.22, 0.76);
    float hueT = clamp(t * 6.0 + 0.35, 0.0, 1.0);
    vec3 ac = mix(cGreen, cTeal, smoothstep(0.0, 0.45, hueT));
    ac = mix(ac, cViolet, smoothstep(0.55, 1.0, hueT) * 0.7);
    aur += ac * strength;
  }
  // horizon mask: aurora fades out at the waterline
  float hMask = smoothstep(-0.02, 0.16, h) * (1.0 - smoothstep(0.72, 1.0, h) * 0.35);
  col += aur * hMask * 2.05;

  /* --- moon -------------------------------------------------------------- */
  vec3 md = normalize(uMoonDir);
  float mdot = dot(d, md);
  float disc = smoothstep(0.99984, 0.99993, mdot);
  // moon is gibbous: mask out a bite
  vec3 perp = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
  float side = dot(d, perp);
  float lit = smoothstep(-0.010, 0.006, side + 0.004);
  col += vec3(0.92, 0.95, 1.0) * disc * (0.62 + 0.30 * lit) * 1.25;
  // halo
  float halo = pow(clamp((mdot - 0.9975) / 0.0025, 0.0, 1.0), 3.0);
  col += vec3(0.48, 0.62, 0.82) * halo * 0.22;
  float glow = pow(clamp((mdot - 0.965) / 0.035, 0.0, 1.0), 2.2);
  col += vec3(0.14, 0.21, 0.32) * glow * 0.20;

  /* --- horizon haze ------------------------------------------------------ */
  float hz = exp(-abs(h) * 9.0);
  col += vec3(0.055, 0.085, 0.115) * hz * 0.55;

  // below horizon fade to deep water tint
  col = mix(col, vec3(0.012, 0.020, 0.030), smoothstep(0.0, -0.14, h));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/*  Water                                                                      */
/* -------------------------------------------------------------------------- */

const WATER_VERT = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vUv;
varying vec3 vWorld;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = textureMatrix * vec4(position, 1.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uDeep;
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uRipple;
varying vec4 vUv;
varying vec3 vWorld;
#include <logdepthbuf_pars_fragment>

void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = vUv.xy / vUv.w;

  // long, gentle swell + fine chop — the lake is calm, so keep this small
  float a = sin(vWorld.x * 0.115 + uTime * 0.19) * cos(vWorld.z * 0.087 - uTime * 0.13);
  float b = sin(vWorld.x * 0.47 - uTime * 0.41) * cos(vWorld.z * 0.39 + uTime * 0.33);
  float c = sin(vWorld.x * 1.9 + uTime * 0.9) * cos(vWorld.z * 2.3 - uTime * 0.8);
  vec2 dist = vec2(a * 0.55 + b * 0.28 + c * 0.10,
                   a * 0.35 + b * 0.40 + c * 0.13) * uRipple;
  uv += dist;

  // slight vertical smear so the reflection reads as water not glass
  vec3 refl;
  refl.r  = texture2D(tDiffuse, uv + vec2(0.0,  0.0016)).r;
  refl.g  = texture2D(tDiffuse, uv).g;
  refl.b  = texture2D(tDiffuse, uv - vec2(0.0,  0.0016)).b;
  vec3 reflWide = texture2D(tDiffuse, uv + vec2(0.0022, 0.0038)).rgb;
  refl = mix(refl, reflWide, 0.42);

  // fresnel: grazing angles mirror the sky, looking down shows dark water
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 2.6);
  fres = mix(0.16, 1.0, fres);

  vec3 water = mix(uDeep, uColor, 0.35 + 0.25 * a);
  vec3 col = mix(water, refl * 1.02, clamp(fres, 0.0, 0.98));

  // faint specular sheen on the swell
  float glint = pow(max(0.0, b * 0.5 + 0.5), 14.0);
  col += vec3(0.30, 0.42, 0.55) * glint * 0.05;

  // a faint aurora sheen so the calm surface still reads as water
  float sheen = smoothstep(0.55, 1.0, fres);
  col += vec3(0.055, 0.115, 0.135) * sheen * 0.55;

  // distance haze so the far edge melts into the night
  float d = length(cameraPosition - vWorld);
  // Fade to the horizon colour well before the disc's rim, otherwise the
  // texture edge itself becomes a visible line across the lake.
  float haze = smoothstep(120.0, 1500.0, d);
  col = mix(col, vec3(0.052, 0.074, 0.096), haze * 0.85);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/*  Island terrain                                                             */
/* -------------------------------------------------------------------------- */

const HOUSE_PAD = 0.44;   // keep clear of the floor slab top (0.52) to avoid z-fighting
const ISLAND_R = 12.0;

export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  if (r > ISLAND_R) return -0.35;
  const t = r / ISLAND_R;
  // gently domed islet
  let h = 0.80 * Math.pow(1.0 - t * t, 0.55);
  // rocky rim
  h += Math.sin(Math.atan2(z, x) * 3.0) * 0.16 * (1 - t) + Math.sin(Math.atan2(z, x) * 7.0 + 1.7) * 0.07 * (1 - t);
  return h;
}

function buildIsland(mats, noisy) {
  const seg = 168;
  const rings = 46;
  const geo = new THREE.BufferGeometry();
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];

  const cLow = new THREE.Color(0x8e9aa8);
  const cSnow = new THREE.Color(0xf4f7fd);
  const cRock = new THREE.Color(0x3f4753);

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = ISLAND_R * Math.pow(t, 0.92);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let y = terrainHeight(x, z);
      // keep the house pad flat
      const padDist = Math.max(Math.abs(x) / 4.6, Math.abs(z) / 4.2);
      if (padDist < 1.0) y = lerp(HOUSE_PAD, y, smoothstep(0.72, 1.02, padDist));
      // outcrops at the water's edge
      const edge = smoothstep(0.80, 1.0, t);
      y += (noisy(x * 3.1, z * 3.1) - 0.5) * 0.42 * edge;
      y += (noisy(x * 0.6, z * 0.6) - 0.5) * 0.10;
      pos.push(x, y, z);
      uv.push(x * 0.16, z * 0.16);
      // steep faces and the wave-cut rim keep their rock; snow settles on top
      const slope = Math.abs(
        terrainHeight(x + 0.35, z) - y) + Math.abs(terrainHeight(x, z + 0.35) - y);
      const rimRock = smoothstep(0.86, 1.0, t);
      // The noise term must never dip far: at 0.55 it let the dark cLow rock
      // colour bleed through the snow as blue-grey splotches across the island.
      const snowT = smoothstep(0.04, 0.30, y)
        * (0.88 + 0.12 * noisy(x * 2.0 + 9, z * 2.0))
        * (1.0 - 0.55 * smoothstep(0.16, 0.60, slope));
      const c = cLow.clone().lerp(cSnow, clamp(snowT, 0, 1) * 0.96);
      // Rock only shows at the wave-cut rim and on genuinely steep faces.
      // Letting bare noise drive this painted dark patches across the middle of
      // a snowfield, which read as holes in the ground.
      const rockN = noisy(x * 3.6 + 21, z * 3.6 - 7);
      const steep = smoothstep(0.30, 0.72, slope);
      const rockMix = clamp(Math.max(rimRock * 0.8, steep * (0.35 + 0.65 * rockN)), 0, 1);
      c.lerp(cRock, rockMix * 0.85);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0,
    map: mats.textures.snow, bumpMap: mats.textures.snow, bumpScale: 0.06,
  });
  mat.map.repeat.set(6, 6);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/* -------------------------------------------------------------------------- */
/*  Mountains                                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  North massif: a displaced heightfield range with Everest in it             */
/* -------------------------------------------------------------------------- */

/** Smooth peak mask: 1 at the summit, 0 at radius r. */
function peakMask(d, r, p) {
  if (d >= r) return 0;
  const t = 1 - d / r;
  return Math.pow(t, p);
}

/**
 * One continuous mountain range built from a height function so ridges,
 * gullies and cirques come out naturally instead of as a cone of rings.
 */
function buildRange({
  peaks,                       // [{x, z, h, r, sharp}]
  x0, x1, z0, z1,
  nx = 260, nz = 190,
  seed = 7,
  snowLine = 0.26,
  hazeColor = 0x121d29,
}) {
  const noise = valueNoise2D(seed * 661 + 17);
  const noise2 = valueNoise2D(seed * 983 + 41);

  const ridged = (x, z, oct) => {
    let v = 0, amp = 0.5, fx = x, fz = z, norm = 0;
    for (let i = 0; i < oct; i++) {
      const n = noise(fx, fz);
      const r = 1 - Math.abs(n * 2 - 1);
      v += r * r * amp;
      norm += amp;
      fx = fx * 2.07 + 11.3;
      fz = fz * 2.07 - 7.1;
      amp *= 0.5;
    }
    return v / norm;
  };

  const heightAt = (x, z) => {
    // base massifs
    let h = 0;
    let mask = 0;
    for (const p of peaks) {
      const d = Math.hypot(x - p.x, (z - p.z) * 1.15);
      const m = peakMask(d, p.r, p.sharp || 1.7);
      if (m <= 0) continue;
      // ridge structure inside the peak
      const rg = ridged(x * 0.0016 + p.x * 0.001, z * 0.0016, 5);
      h += p.h * m * (0.55 + 0.75 * rg);
      mask = Math.max(mask, m);
    }
    // broad connective ridge noise so the peaks form one range
    const broad = (noise(x * 0.00042, z * 0.00042) - 0.42) * 520;
    h += broad * clamp(mask * 1.7, 0, 1);
    // fine crags
    const crag = (ridged(x * 0.0062, z * 0.0062, 4) - 0.5) * 130;
    h += crag * clamp(mask * 1.3, 0, 1);
    // deep gullies
    const gully = Math.pow(Math.abs(noise2(x * 0.0031, z * 0.0031) * 2 - 1), 5.0);
    h -= gully * 150 * clamp(mask, 0, 1);
    // never below the lake
    return Math.max(h, -40);
  };

  const geo = new THREE.BufferGeometry();
  const cols = nx + 1, rows = nz + 1;
  const pos = new Float32Array(cols * rows * 3);
  const col = new Float32Array(cols * rows * 3);
  const idx = [];

  const cSnow = new THREE.Color(0xf2f8ff);
  const cSnowDeep = new THREE.Color(0xb3c8e0);
  const cRock = new THREE.Color(0x2c3644);
  const cRockDark = new THREE.Color(0x161d27);
  const cHaze = new THREE.Color(hazeColor).lerp(new THREE.Color(0x3d5570), 0.55);

  const hgt = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const z = lerp(z0, z1, j / nz);
    for (let i = 0; i < cols; i++) {
      const x = lerp(x0, x1, i / nx);
      hgt[j * cols + i] = heightAt(x, z);
    }
  }

  for (let j = 0; j < rows; j++) {
    const z = lerp(z0, z1, j / nz);
    for (let i = 0; i < cols; i++) {
      const x = lerp(x0, x1, i / nx);
      const k = j * cols + i;
      const y = hgt[k];
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;

      // slope from neighbours (cell size in world units)
      const dx = 1.6 / nx * (x1 - x0) * 2;
      const dz = 1.2 / nz * (z1 - z0) * 2;
      const hL = hgt[j * cols + Math.max(0, i - 1)];
      const hR = hgt[j * cols + Math.min(cols - 1, i + 1)];
      const hD = hgt[Math.max(0, j - 1) * cols + i];
      const hU = hgt[Math.min(rows - 1, j + 1) * cols + i];
      const gx = (hR - hL) / (dx || 1);
      const gz = (hU - hD) / (dz || 1);
      const slope = Math.min(1.6, Math.hypot(gx, gz));

      // snow: high + shallow. steep faces stay rock.
      const alt = clamp(y / 1150, 0, 1);
      let snowT = smoothstep(snowLine, snowLine + 0.30, alt)
        * (1 - smoothstep(0.42, 1.05, slope));
      snowT *= 0.6 + 0.4 * noise(x * 0.004, z * 0.004);

      let c = cRock.clone().lerp(cRockDark, clamp(slope * 0.9, 0, 1));
      const sc = cSnow.clone().lerp(cSnowDeep, clamp(slope * 0.7, 0, 1));
      c.lerp(sc, clamp(snowT, 0, 1));

      // Fake moonlight from the north-west. The contrast between lit faces and
      // shadowed ones is what makes the massif read as a mountain rather than a
      // flat grey cut-out against a sky of nearly identical brightness.
      const lit = 0.42 + 1.75 * clamp(0.5 - gx * 0.55 - gz * 0.35, 0, 1);
      c.multiplyScalar(lit);
      // Patchy snow on the low ridges. Without this every face under the snow
      // line collapses onto one rock colour and the foothills read as a single
      // flat slab sitting on the water.
      const lowPatch = clamp((0.55 - alt) / 0.55, 0, 1)
        * clamp(1.0 - slope * 0.55, 0, 1)
        * clamp((noise(x * 0.0022, z * 0.0022) - 0.46) * 3.4, 0, 1);
      c.lerp(cSnowDeep, lowPatch * 0.55);
      // Break the remaining flatness with broad tonal drift so the foothills
      // have ridges and hollows instead of one uniform value.
      const drift = 0.80 + 0.42 * noise(x * 0.0011 + 31.0, z * 0.0011);
      c.multiplyScalar(drift);
      // snow catches the moon much harder than rock does
      const dist = Math.hypot(x, z);
      c.lerp(cHaze, clamp((dist - 4200) / 9000, 0, 0.30));
      // The foothills sit exactly on the waterline. Without a strong lift at
      // low altitude their baked shading plunges to near-black and leaves a
      // hard dark band where the massif meets the much brighter lake.
      c.lerp(cHaze, clamp((1.0 - alt) * 0.46, 0, 0.46));

      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c2 = a + cols;
      const d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, fog: true,
  }));
  mesh.frustumCulled = true;
  return mesh;
}

/** Distant ridgeline strip along the horizon. */
function buildRidge({ z = -800, width = 4000, height = 90, seed = 3, color = 0x1b2028 }) {
  const noise = valueNoise2D(seed * 331 + 7);
  const n = 220;
  const geo = new THREE.BufferGeometry();
  const pos = [];
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = (t - 0.5) * width;
    const h = height * (0.25 + 0.75 * fbm2D(noise, t * 6.0, 0.5, 4))
      * (0.5 + 0.5 * Math.sin(t * Math.PI));
    pos.push(x, 0, z);
    pos.push(x, h, z);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, fog: true, side: THREE.DoubleSide,
  }));
  return m;
}

/* -------------------------------------------------------------------------- */
/*  Far shore village (south)                                                  */
/* -------------------------------------------------------------------------- */

function buildVillage(scene, mats, quality) {
  const rnd = mulberry32(4242);
  const group = new THREE.Group();
  const shoreZ = 320;
  const low = quality === 'low';

  const shoreY = (z) => {
    const t = clamp((z - shoreZ) / 260, 0, 1);
    return 6 + t * 54;            // the far bank climbs away from the water
  };

  // low, dark shoreline so the houses read against it instead of hiding behind
  group.add(buildRidge({ z: shoreZ, width: 3200, height: 9, seed: 12, color: 0x0a1017 }));

  // a dark far bank wedge
  const bankGeo = new THREE.BufferGeometry();
  const bv = [];
  for (let i = 0; i <= 60; i++) {
    const x = -1600 + (3200 * i) / 60;
    bv.push(x, 4.5, shoreZ, x, 62, shoreZ + 420);
  }
  const bi = [];
  for (let i = 0; i < 60; i++) {
    const a0 = i * 2;
    bi.push(a0, a0 + 1, a0 + 2, a0 + 2, a0 + 1, a0 + 3);
  }
  bankGeo.setAttribute('position', new THREE.Float32BufferAttribute(bv, 3));
  bankGeo.setIndex(bi);
  bankGeo.computeVertexNormals();
  const bank = new THREE.Mesh(bankGeo, new THREE.MeshBasicMaterial({
    color: 0x070c12, fog: true, side: THREE.DoubleSide,
  }));
  group.add(bank);

  // conifers along the bank
  const treeMat = new THREE.MeshBasicMaterial({ color: 0x070c12, fog: true });
  const treeCount = low ? 160 : 320;
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6), treeMat, treeCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < treeCount; i++) {
    const x = (rnd() - 0.5) * 3000;
    const z = shoreZ + 4 + rnd() * 340;
    const hgt = 9 + rnd() * 18;
    sc.set(hgt * 0.30, hgt, hgt * 0.30);
    p.set(x, shoreY(z) + hgt * 0.5, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * TAU);
    m.compose(p, q, sc);
    trees.setMatrixAt(i, m);
  }
  group.add(trees);

  // ---- houses with warm lit windows -------------------------------------
  const houseCount = low ? 30 : 64;
  const winMat = new THREE.MeshBasicMaterial({
    color: 0xffe3bd, fog: true,
  });
  const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), winMat, houseCount * 3);
  const bodies = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x070b11, fog: true }),
    houseCount,
  );
  const roofGeo = new THREE.ConeGeometry(0.72, 1, 4);
  const roofs = new THREE.InstancedMesh(
    roofGeo,
    new THREE.MeshBasicMaterial({ color: 0x0c1219, fog: true }),
    houseCount,
  );
  let wi = 0;
  const glows = [];
  for (let i = 0; i < houseCount; i++) {
    const x = (rnd() - 0.5) * 2300;
    const z = shoreZ + 12 + rnd() * 200;
    const w = 7 + rnd() * 10;
    const h = 4.5 + rnd() * 5.5;
    const d = 7 + rnd() * 10;
    const base = shoreY(z);
    sc.set(w, h, d);
    p.set(x, base + h * 0.5, z);
    q.identity();
    m.compose(p, q, sc);
    bodies.setMatrixAt(i, m);

    // pyramidal roof
    sc.set(w * 1.5, h * 0.85, d * 1.5);
    p.set(x, base + h + h * 0.42, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    m.compose(p, q, sc);
    roofs.setMatrixAt(i, m);

    for (let k = 0; k < 4; k++) {
      const lit = rnd() > 0.12;
      const ww = 3.0 + rnd() * 3.0;
      const wh = 2.4 + rnd() * 2.2;
      sc.set(ww, wh, 1);
      p.set(
        x + (k - 1.5) * w * 0.26,
        base + h * (0.38 + rnd() * 0.26),
        z - d * 0.5 - 0.15,
      );
      q.identity();
      m.compose(p, q, sc);
      if (lit) {
        windows.setMatrixAt(wi, m);
        glows.push(new THREE.Vector3(p.x, p.y, p.z));
      } else {
        m.makeTranslation(0, -9999, 0);
        windows.setMatrixAt(wi, m);
      }
      wi++;
    }
  }
  windows.instanceMatrix.needsUpdate = true;
  bodies.instanceMatrix.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  windows.count = wi;
  group.add(bodies, roofs, windows);

  // warm glow sprites over the bank, plus a warm haze band
  const glowTex = makeGlowTexture();
  const spriteMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffb268, transparent: true, opacity: 0.17,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  const glowCount = low ? 12 : 26;
  for (let i = 0; i < glowCount; i++) {
    const g = glows[Math.floor(rnd() * glows.length)] || new THREE.Vector3(0, 8, shoreZ);
    const sp = new THREE.Sprite(spriteMat);
    sp.position.set(g.x, g.y, g.z - 2);
    const s2 = 10 + rnd() * 16;
    sp.scale.set(s2, s2, 1);
    group.add(sp);
  }
  // A soft warm haze band used to live here. At only 0.055 opacity it still
  // spanned 420-720 world units, so from the island it stretched into a bright
  // orange rope lying on the water. The per-house glows and the shore pinpoints
  // already carry the "远处灯火" reading, so it is gone.

  // discrete pinpoints of light along the shore — these are what the eye reads
  // through the window as "远处岸上的灯火"
  const ptMat = new THREE.PointsMaterial({
    map: glowTex, color: 0xffd9a8, size: 5.5, sizeAttenuation: true,
    transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: true,
  });
  const ptPos = [];
  const ptCount = low ? 90 : 200;
  for (let i = 0; i < ptCount; i++) {
    const x = (rnd() - 0.5) * 2200;
    const z = shoreZ + 10 + rnd() * 150;
    ptPos.push(x, shoreY(z) + 1.5 + rnd() * 9, z);
  }
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(ptPos, 3));
  group.add(new THREE.Points(ptGeo, ptMat));

  return group;
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,220,170,0.85)');
  grad.addColorStop(0.55, 'rgba(255,170,90,0.22)');
  grad.addColorStop(1, 'rgba(255,140,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* -------------------------------------------------------------------------- */
/*  main build                                                                 */
/* -------------------------------------------------------------------------- */

export function createWorld(scene, renderer, { quality = 'high' } = {}) {
  const noisy = valueNoise2D(1234);
  const rnd = mulberry32(777);

  /* ---------------- moon / lights ---------------------------------------- */
  const moonDir = new THREE.Vector3(0.42, 0.30, -0.86).normalize();
  const moonDist = 3000;
  const moonPos = moonDir.clone().multiplyScalar(moonDist);

  const hemi = new THREE.HemisphereLight(0x6e93b4, 0x121a23, 2.35);
  scene.add(hemi);

  const moonLight = new THREE.DirectionalLight(0xbdd6f0, 2.45);
  moonLight.position.copy(moonDir.clone().multiplyScalar(140));
  moonLight.target.position.set(0, 0, 0);
  moonLight.castShadow = true;
  const sh = quality === 'low' ? 1024 : 2048;
  moonLight.shadow.mapSize.set(sh, sh);
  const d = 16;
  moonLight.shadow.camera.left = -d;
  moonLight.shadow.camera.right = d;
  moonLight.shadow.camera.top = d;
  moonLight.shadow.camera.bottom = -d;
  moonLight.shadow.camera.near = 1;
  moonLight.shadow.camera.far = 320;
  // A low moon rakes the snow at a grazing angle, so a small bias produces
  // stamped-looking acne blobs all over the island. Push the biases up hard.
  moonLight.shadow.bias = -0.0022;
  moonLight.shadow.normalBias = 0.075;
  moonLight.shadow.radius = 3;
  scene.add(moonLight, moonLight.target);

  // Aurora bounce: a wide teal wash from the north sky, no shadows, cheap.
  const auroraFill = new THREE.DirectionalLight(0x5aa8c0, 0.42);
  auroraFill.position.set(-6, 26, -30);
  auroraFill.target.position.set(0, 1.0, 0);
  scene.add(auroraFill, auroraFill.target);



  // South-east ice fill so the facade the visitor arrives at is readable.
  const iceFill = new THREE.DirectionalLight(0xa8c8e2, 0.62);
  iceFill.position.set(16, 9, 18);
  iceFill.target.position.set(0, 1.2, 0);
  scene.add(iceFill, iceFill.target);

  // The moon sits north-east, so the west and south faces fall into a nearly
  // black silhouette. A dim sky-bounce from the opposite side keeps them
  // readable without flattening the moonlight.
  const rimFill = new THREE.DirectionalLight(0x93b8d8, 0.55);
  rimFill.position.set(-20, 7, -6);
  rimFill.target.position.set(0, 1.2, 0);
  scene.add(rimFill, rimFill.target);

  // Faint warm bounce from the village lights across the lake.
  const villageGlow = new THREE.DirectionalLight(0xffb877, 0.30);
  villageGlow.position.set(0, 3, 40);
  villageGlow.target.position.set(0, 1.0, 0);
  scene.add(villageGlow, villageGlow.target);

  /* ---------------- sky --------------------------------------------------- */
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uMoonDir: { value: moonDir.clone() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(14000, 64, 40), skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);

  /* ---------------- env map from the sky --------------------------------- */
  // Render just the sky into a cube and turn it into a PMREM so glass,
  // steel and snow pick up a believable night reflection.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const skyClone = new THREE.Mesh(sky.geometry, skyMat);
  skyClone.frustumCulled = false;
  envScene.add(skyClone);
  const envRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(1, 20000, envRT);
  cubeCam.update(renderer, envScene);
  const envMap = envRT.texture;
  scene.environment = envMap;
  scene.environmentIntensity = 1.15;

  /* ---------------- water ------------------------------------------------- */
  // The mountains start at z = -2100. A 760-radius disc left a hard black
  // gap of open water between the reflection disc and the foothills, which
  // read as a band drawn across the horizon. Reach past the range instead.
  const waterGeo = new THREE.CircleGeometry(9000, 160);
  waterGeo.rotateX(-Math.PI / 2);
  const waterShader = {
    name: 'LakeWater',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTime: { value: 0 },
      uRipple: { value: 0.0022 },
      uDeep: { value: new THREE.Color(0x16283c) },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  };
  const reflSize = quality === 'low' ? 512 : 1024;
  const water = new Reflector(waterGeo, {
    textureWidth: reflSize,
    textureHeight: reflSize,
    clipBias: 0.004,
    color: 0xffffff,
    multisample: quality === 'low' ? 0 : 2,
    shader: waterShader,
  });
  water.material.uniforms.uTime = { value: 0 };
  water.position.y = 0.0;
  water.rotation.x = 0;
  scene.add(water);

  /* ---------------- island ------------------------------------------------ */
  const island = buildIsland({ textures: { snow: matsSnow(renderer) } }, noisy);

  function matsSnow() {
    // simple standalone snow texture for the island material
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#dfe9f5';
    g.fillRect(0, 0, 256, 256);
    const r2 = mulberry32(11);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = r2() > 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(150,170,195,0.14)';
      g.beginPath();
      g.arc(r2() * 256, r2() * 256, 0.5 + r2() * 1.8, 0, TAU);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  scene.add(island);

  /* ---------------- mountains -------------------------------------------- */
  const mountains = new THREE.Group();
  // One continuous range to the north with Everest as the dominant summit.
  const range = buildRange({
    peaks: [
      { x: -300, z: -5200, h: 1580, r: 2600, sharp: 1.85 },   // Everest
      { x: -2600, z: -5600, h: 900, r: 2100, sharp: 1.6 },
      { x: 2100, z: -5500, h: 1080, r: 2200, sharp: 1.65 },
      { x: 4300, z: -6200, h: 720, r: 2000, sharp: 1.5 },
      { x: -5200, z: -6300, h: 640, r: 2000, sharp: 1.5 },
      { x: 900, z: -7400, h: 1150, r: 2600, sharp: 1.7 },
    ],
    x0: -11000, x1: 11000,
    z0: -8200, z1: -2100,
    nx: 320, nz: 200,
    seed: 21,
    snowLine: 0.26,
    hazeColor: 0x131e2b,
  });
  mountains.add(range);

  // layered north ridgelines in front of the range
  // The two flat silhouette ridges that used to stand here drew a hard dark
  // bar straight across the horizon: from eye level at the island they sit
  // exactly on the waterline, so their unlit flat colour read as a black band
  // rather than as distant land. The massif plus the haze now does that job.
  scene.add(mountains);

  /* ---------------- village ---------------------------------------------- */
  const village = buildVillage(scene, {}, quality);
  scene.add(village);

  /* ---------------- fog --------------------------------------------------- */
  scene.fog = new THREE.FogExp2(0x0a1520, 0.000135);

  /* ---------------- stars as points for parallax? (skip: shader sky) ------ */

  /* ---------------- update ------------------------------------------------ */
  const clocked = { t: 0 };
  return {
    sky, skyMat, water, island, mountains, village, moonLight, moonDir, hemi,
    terrainHeight,
    update(t) {
      clocked.t = t;
      skyMat.uniforms.uTime.value = t;
      if (water.material.uniforms.uTime) water.material.uniforms.uTime.value = t;
      water.material.uniforms.uRipple.value = 0.0019 + 0.0004 * Math.sin(t * 0.11);
    },
  };
}
