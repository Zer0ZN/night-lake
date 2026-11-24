import * as THREE from 'three';
import { clamp, lerp } from './util.js';

/**
 * First-person walker with a simple AABB collider list, terrain following,
 * a soft step bob and mouse-look. Click-and-drag look also works so the
 * scene is explorable without pointer lock.
 */
export class Player {
  constructor(camera, dom, opts = {}) {
    this.camera = camera;
    this.dom = dom;
    this.terrain = opts.terrain || (() => 0);
    this.colliders = opts.colliders || [];
    this.onInteract = opts.onInteract || (() => {});

    this.pos = new THREE.Vector3(0, 0, 7.5);
    this.vel = new THREE.Vector3();
    this.yaw = Math.PI;          // looking toward -Z at start
    this.pitch = -0.02;
    this.eye = 1.62;
    this.radius = 0.30;
    this.speed = 2.55;
    this.runSpeed = 4.6;
    this.bob = 0;
    this.keys = new Set();
    this.locked = false;
    this.enabled = true;
    this.allowFly = false;
    this.flyY = 0;

    this._bind();
  }

  _bind() {
    const dom = this.dom;

    this._onKeyDown = (e) => {
      if (e.code === 'Space') {
        // interact with whatever is in front
        if (this.enabled) {
          e.preventDefault();
          this.onInteract();
        }
        return;
      }
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);

    this._onMouseMove = (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch -= e.movementY * 0.0022;
        this.pitch = clamp(this.pitch, -1.35, 1.35);
      } else if (this.dragging) {
        this.yaw -= e.movementX * 0.0032;
        this.pitch -= e.movementY * 0.0032;
        this.pitch = clamp(this.pitch, -1.35, 1.35);
      }
    };

    this._onMouseDown = (e) => {
      if (e.button === 0) this.dragging = true;
    };
    this._onMouseUp = () => { this.dragging = false; };

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === dom;
    };

    this._onClick = () => {
      if (!this.enabled) return;
      if (!this.locked) {
        const p = dom.requestPointerLock?.();
        if (p && p.catch) p.catch(() => {});
      }
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    dom.addEventListener('click', this._onClick);

    // touch: one finger look, no move — the UI pad handles walking
    this._touchState = null;
    dom.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this._touchState = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });
    dom.addEventListener('touchmove', (e) => {
      if (!this._touchState || e.touches.length !== 1) return;
      const t = e.touches[0];
      this.yaw -= (t.clientX - this._touchState.x) * 0.006;
      this.pitch -= (t.clientY - this._touchState.y) * 0.006;
      this.pitch = clamp(this.pitch, -1.35, 1.35);
      this._touchState = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    dom.addEventListener('touchend', () => { this._touchState = null; }, { passive: true });
  }

  setPosition(x, z) {
    this.pos.set(x, this.terrain(x, z), z);
    this.vel.set(0, 0, 0);
  }

  /** Is the circle (x,z,r) clear of all colliders? */
  _blocked(x, z) {
    const r = this.radius;
    for (const c of this.colliders) {
      if (!c.active && c.active !== undefined) continue;
      const cx = clamp(x, c.x0, c.x1);
      const cz = clamp(z, c.z0, c.z1);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  update(dt, t) {
    if (!this.enabled) return;
    const k = this.keys;
    let fwd = 0, strafe = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) strafe -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) strafe += 1;

    // touch / on-screen pad
    if (this.padForward) fwd += this.padForward;
    if (this.padStrafe) strafe += this.padStrafe;

    const running = k.has('ShiftLeft') || k.has('ShiftRight');
    const spd = running ? this.runSpeed : this.speed;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward is -Z rotated by yaw
    let dx = (-sin * fwd + cos * strafe);
    let dz = (-cos * fwd - sin * strafe);
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) { dx /= len; dz /= len; }

    const targetVX = dx * spd * (len > 1e-4 ? 1 : 0);
    const targetVZ = dz * spd * (len > 1e-4 ? 1 : 0);
    const accel = clamp(dt * 12, 0, 1);
    this.vel.x += (targetVX - this.vel.x) * accel;
    this.vel.z += (targetVZ - this.vel.z) * accel;

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;

    // axis-separated so sliding along walls works
    if (!this._blocked(nx, this.pos.z)) this.pos.x = nx;
    else this.vel.x *= 0.2;
    if (!this._blocked(this.pos.x, nz)) this.pos.z = nz;
    else this.vel.z *= 0.2;

    // keep on the island
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > 11.2) {
      this.pos.x *= 11.2 / r;
      this.pos.z *= 11.2 / r;
    }

    // ground follow
    const groundY = this.terrain(this.pos.x, this.pos.z);
    this.pos.y += (groundY - this.pos.y) * clamp(dt * 12, 0, 1);

    // step bob
    const moving = len > 1e-4 && (Math.abs(this.vel.x) + Math.abs(this.vel.z)) > 0.6;
    this.bob += dt * (running ? 11.5 : 7.6) * (moving ? 1 : 0);
    const bobY = moving ? Math.sin(this.bob) * 0.026 : 0;
    const bobX = moving ? Math.cos(this.bob * 0.5) * 0.012 : 0;

    // camera
    const cam = this.camera;
    cam.position.set(
      this.pos.x + Math.cos(this.yaw) * bobX,
      this.pos.y + this.eye + bobY,
      this.pos.z - Math.sin(this.yaw) * bobX,
    );
    const cp = Math.cos(this.pitch);
    cam.lookAt(
      cam.position.x - Math.sin(this.yaw) * cp,
      cam.position.y + Math.sin(this.pitch),
      cam.position.z - Math.cos(this.yaw) * cp,
    );
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
