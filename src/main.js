import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createMaterials } from './materials.js';
import { createWorld } from './stage.js';
import { buildHouse, H, PAD_Y, houseViewpoints } from './house.js';
import { Player } from './player.js';
import { Ambient } from './audio.js';
import { clamp } from './util.js';

const QUALITY = new URLSearchParams(location.search).get('q') || 'high';
const IS_LOW = QUALITY === 'low';

/* -------------------------------------------------------------------------- */
/*  renderer / scene                                                           */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !IS_LOW,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_LOW ? 1.0 : 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.32;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 12000);
camera.position.set(0.2, 1.9, 9.4);

/* -------------------------------------------------------------------------- */
/*  build                                                                      */
/* -------------------------------------------------------------------------- */

const M = createMaterials();
const world = createWorld(scene, renderer, { quality: QUALITY });
const house = buildHouse(M);
scene.add(house.root);

/* -------------------------------------------------------------------------- */
/*  player                                                                     */
/* -------------------------------------------------------------------------- */

const terrainForPlayer = (x, z) => {
  // inside the house the floor is flat at the pad height
  const inX = Math.abs(x) < H.hw - 0.05;
  const inZ = Math.abs(z) < H.hd - 0.05;
  if (inX && inZ) return PAD_Y;
  // the stone landing outside the door is also flat
  if (Math.abs(x - H.doorX) < 0.78 && z > H.hd && z < H.hd + 0.62) return PAD_Y;
  return world.terrainHeight(x, z);
};

const colliders = [...house.colliders];
const doorCol = house.doorClosedCol;
doorCol.active = true;
colliders.push(doorCol);

const player = new Player(camera, canvas, {
  terrain: terrainForPlayer,
  colliders,
  onInteract: () => tryInteract(),
});
player.setPosition(1.9, 8.6);
// Spawn south of the house looking north at it. Forward is -Z rotated by yaw,
// so a yaw of PI would face straight OUT over the lake with the cabin behind the
// player — which is exactly what the first public build did.
player.yaw = 0.22;
player.pitch = -0.03;

/* -------------------------------------------------------------------------- */
/*  interaction                                                                */
/* -------------------------------------------------------------------------- */

const raycaster = new THREE.Raycaster();
raycaster.far = 3.4;
const center = new THREE.Vector2(0, 0);

const interactTargets = [];
// door leaf
house.doorPivot.traverse((o) => {
  if (o.isMesh) { o.userData.kind = 'door'; interactTargets.push(o); }
});
// lamp
house.lamp.group.traverse((o) => {
  if (o.isMesh) { o.userData.kind = 'lamp'; interactTargets.push(o); }
});

let hovered = null;
let toastTimer = 0;

function updateHover() {
  raycaster.setFromCamera(center, camera);
  const hits = raycaster.intersectObjects(interactTargets, false);
  const next = hits.length ? hits[0].object.userData.kind : null;
  if (next !== hovered) {
    hovered = next;
    const hint = document.getElementById('hoverHint');
    if (hovered === 'door') hint.textContent = house.state.doorOpen ? '关门' : '开门';
    else if (hovered === 'lamp') hint.textContent = house.lamp.on ? '关台灯' : '开台灯';
    else hint.textContent = '';
    document.getElementById('crosshair').classList.toggle('active', !!hovered);
  }
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  toastTimer = 1.7;
}

function tryInteract() {
  if (hovered === 'door') {
    house.setDoor(!house.state.doorOpen);
    doorCol.active = !house.state.doorOpen;
    toast(house.state.doorOpen ? '门已打开' : '门已关闭');
    updateHover();
    syncUI();
  } else if (hovered === 'lamp') {
    toggleLamp();
  }
}

function toggleLamp() {
  house.lamp.toggle();
  syncUI();
  toast(house.lamp.on ? '卧室台灯：开' : '卧室台灯：关');
}

/* -------------------------------------------------------------------------- */
/*  audio                                                                      */
/* -------------------------------------------------------------------------- */

const ambient = new Ambient();
let audioOn = false;

async function toggleAudio() {
  audioOn = await ambient.toggle();
  syncUI();
  const b = document.getElementById('btnSound');
  b.textContent = audioOn ? '♪ 音乐 开' : '♪ 音乐 关';
  b.classList.toggle('on', audioOn);
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                         */
/* -------------------------------------------------------------------------- */

const ui = {
  btnSound: document.getElementById('btnSound'),
  btnLamp: document.getElementById('btnLamp'),
  btnDoor: document.getElementById('btnDoor'),
  btnHelp: document.getElementById('btnHelp'),
  btnHide: document.getElementById('btnHide'),
  btnFly: document.getElementById('btnFly'),
};

function syncUI() {
  ui.btnLamp.classList.toggle('on', house.lamp.on);
  ui.btnLamp.textContent = house.lamp.on ? '台灯 开' : '台灯 关';
  ui.btnDoor.classList.toggle('on', house.state.doorOpen);
  ui.btnDoor.textContent = house.state.doorOpen ? '门 开' : '门 关';
  // The 现场记录 panel is a live readout, not decoration — without this the
  // 卧室 / 大门 rows stayed frozen on their initial text forever.
  const specLamp = document.getElementById('specLamp');
  const specDoor = document.getElementById('specDoor');
  if (specLamp) {
    specLamp.textContent = house.lamp.on ? '台灯 开' : '台灯 关';
    specLamp.classList.toggle('warm', house.lamp.on);
  }
  if (specDoor) {
    specDoor.textContent = house.state.doorOpen ? '开启' : '关闭';
    specDoor.classList.toggle('warm', house.state.doorOpen);
  }
}

ui.btnSound.addEventListener('click', toggleAudio);
ui.btnLamp.addEventListener('click', toggleLamp);
ui.btnDoor.addEventListener('click', () => {
  house.setDoor(!house.state.doorOpen);
  doorCol.active = !house.state.doorOpen;
  syncUI();
  updateHover();
});
ui.btnHelp.addEventListener('click', () => {
  document.getElementById('helpPanel').classList.toggle('show');
});
ui.btnHide.addEventListener('click', () => {
  document.body.classList.toggle('hide-ui');
});
ui.btnFly.addEventListener('click', () => {
  player.allowFly = !player.allowFly;
  ui.btnFly.classList.toggle('on', player.allowFly);
  toast(player.allowFly ? '自由飞行：开（Q/E 升降）' : '自由飞行：关');
});

// viewpoint chips
const views = houseViewpoints();
const viewList = [
  ['屋外 · 正面', 'exteriorSouth'],
  ['屋外 · 东北', 'exteriorNorthWest'],
  ['客厅', 'living'],
  ['卧室', 'bedroom'],
  ['北窗 · 珠峰', 'windowNorth'],
  ['南窗 · 灯火', 'windowSouth'],
];
const chipWrap = document.getElementById('chips');
for (const [label, key] of viewList) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = label;
  b.addEventListener('click', () => {
    const v = views[key];
    player.setPosition(v.pos[0], v.pos[2]);
    player.pos.y = terrainForPlayer(v.pos[0], v.pos[2]);
    player.eye = v.pos[1] - player.pos.y;
    const dx = v.target[0] - v.pos[0];
    const dy = v.target[1] - v.pos[1];
    const dz = v.target[2] - v.pos[2];
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  });
  chipWrap.appendChild(b);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' && !player.allowFly) { /* fallthrough */ }
  if (e.code === 'KeyM') toggleAudio();
  if (e.code === 'KeyL') toggleLamp();
  if (e.code === 'KeyF') {
    house.setDoor(!house.state.doorOpen);
    doorCol.active = !house.state.doorOpen;
    syncUI();
    updateHover();
  }
  if (e.code === 'KeyH') document.body.classList.toggle('hide-ui');
  if (e.code === 'KeyQ' && player.allowFly) player.eye = Math.max(0.4, player.eye - 0.5);
  if (e.code === 'KeyE' && player.allowFly) player.eye = Math.min(9, player.eye + 0.5);
});

/* -------------------------------------------------------------------------- */
/*  post                                                                       */
/* -------------------------------------------------------------------------- */

const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  IS_LOW ? 0.20 : 0.28,
  0.74,
  0.90,
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* -------------------------------------------------------------------------- */
/*  resize                                                                     */
/* -------------------------------------------------------------------------- */

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
}
window.addEventListener('resize', onResize);

/* -------------------------------------------------------------------------- */
/*  loop                                                                       */
/* -------------------------------------------------------------------------- */

const clock = new THREE.Clock();
let t = 0;
let readyFrames = 0;
let fpsAcc = 0, fpsN = 0, fps = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;

  player.update(dt, t);
  house.update(t, dt);
  world.update(t);
  updateHover();

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) document.getElementById('toast').classList.remove('show');
  }

  composer.render();

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    fpsAcc = 0; fpsN = 0;
    const st = document.getElementById('stat');
    if (st) st.textContent = `${fps} FPS`;
  }

  readyFrames++;
  if (readyFrames === 4) {
    document.getElementById('loader').classList.add('done');
    document.body.classList.add('ready');
  }

  requestAnimationFrame(tick);
}

/* -------------------------------------------------------------------------- */
/*  test hooks                                                                 */
/* -------------------------------------------------------------------------- */

window.__THREE = THREE;
let __bloomRef = bloom;

window.__NL = {
  scene, camera, renderer, player, house, world, ambient,
  setDoor: (v) => {
    house.setDoor(v);
    doorCol.active = !v;
    syncUI();
  },
  setLamp: (v) => { house.lamp.set(v); syncUI(); },
  toggleAudio,
  teleport(x, z, yaw = 0, pitch = 0) {
    player.setPosition(x, z);
    player.pos.y = terrainForPlayer(x, z);
    player.eye = 1.62;
    player.yaw = yaw;
    player.pitch = pitch;
  },
  getBloom(){ return __bloomRef; },
  viewV,
  stats() {
    let meshes = 0, verts = 0, tris = 0;
    scene.traverse((o) => {
      if (o.isMesh && o.geometry) {
        meshes++;
        const p = o.geometry.attributes.position;
        if (p) verts += p.count;
        if (o.geometry.index) tris += o.geometry.index.count / 3;
        else if (p) tris += p.count / 3;
      }
    });
    return { meshes, verts, triangles: Math.round(tris), fps };
  },
};

function viewV(key) {
  const v = houseViewpoints()[key];
  if (!v) return false;
  player.setPosition(v.pos[0], v.pos[2]);
  player.pos.y = terrainForPlayer(v.pos[0], v.pos[2]);
  player.eye = v.pos[1] - player.pos.y;
  const dx = v.target[0] - v.pos[0];
  const dy = v.target[1] - v.pos[1];
  const dz = v.target[2] - v.pos[2];
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return true;
}

window.__NL_READY = false;
syncUI();
tick();
requestAnimationFrame(() => { window.__NL_READY = true; });
