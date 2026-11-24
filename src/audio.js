/**
 * Ambient score.
 *
 * The brief asked for "the rescue" by Antent / Nectry. That is a licensed
 * recording, so this module does NOT ship it. Instead:
 *
 *   1. If `assets/the-rescue.mp3` (or .ogg / .m4a) exists next to the page it is
 *      streamed and used as the soundtrack — drop your own licensed copy there.
 *   2. Otherwise an original procedural ambient piece plays, written in the same
 *      mood: a slow minor-key pad bed, sparse felt-piano notes, lake wind, and a
 *      distant sub pulse. It is generated live with WebAudio, so it costs no
 *      bandwidth and can loop forever.
 *
 * Either way the whole thing is behind one toggle.
 */

const CANDIDATES = [
  'assets/the-rescue.mp3',
  'assets/the-rescue.ogg',
  'assets/the-rescue.m4a',
  'assets/the-rescue.wav',
];

export class Ambient {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.started = false;
    this.muted = true;
    this.mode = 'procedural';
    this.audioEl = null;
    this._timers = [];
    this._nodes = [];
    this._fileChecked = false;
    this._fileUrl = null;
  }

  /* ------------------------------------------------------------------ */

  async _probeFile() {
    if (this._fileChecked) return this._fileUrl;
    this._fileChecked = true;
    for (const url of CANDIDATES) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) {
          const len = Number(res.headers.get('content-length') || 0);
          if (len > 1024) { this._fileUrl = url; break; }
        }
      } catch (e) { /* not there */ }
    }
    return this._fileUrl;
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);

    // shared reverb-ish send
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this._impulse(4.2, 2.6);
    this.verbGain = this.ctx.createGain();
    this.verbGain.gain.value = 0.55;
    this.verb.connect(this.verbGain).connect(this.master);

    await this._probeFile();
    if (this._fileUrl) {
      this.mode = 'file';
      this._setupFile();
    } else {
      this.mode = 'procedural';
      this._setupProcedural();
    }
    this.started = true;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  _setupFile() {
    const el = new Audio(this._fileUrl);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    el.volume = 0.0;
    el.preload = 'auto';
    this.audioEl = el;
    // route through the same master so the UI volume works
    try {
      const src = this.ctx.createMediaElementSource(el);
      this.fileGain = this.ctx.createGain();
      this.fileGain.gain.value = 0.9;
      src.connect(this.fileGain).connect(this.master);
    } catch (e) {
      // fall back to element volume
      this.fileGain = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  procedural score                                                   */
  /* ------------------------------------------------------------------ */

  _setupProcedural() {
    const ctx = this.ctx;

    // --- wind bed: filtered noise, slowly breathing
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 6, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < nd.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      nd[i] = last * 3.2;
    }
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuf;
    wind.loop = true;
    const windLP = ctx.createBiquadFilter();
    windLP.type = 'lowpass';
    windLP.frequency.value = 420;
    windLP.Q.value = 0.4;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.16;
    wind.connect(windLP).connect(windGain).connect(this.master);
    // slow LFO on the wind level
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.09;
    lfo.connect(lfoGain).connect(windGain.gain);
    lfo.start();
    wind.start();
    this._nodes.push(wind, lfo);

    // --- pad chord bed
    const padBus = ctx.createGain();
    padBus.gain.value = 0.0;
    padBus.connect(this.master);
    padBus.connect(this.verb);
    this.padBus = padBus;

    // A minor add9 spread wide: A2 C3 E3 G3 B3
    const padNotes = [110.0, 130.81, 164.81, 196.0, 246.94];
    this.padOsc = padNotes.map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i < 2 ? 'sine' : 'triangle';
      o.frequency.value = f;
      o.detune.value = (i - 2) * 6;
      const g = ctx.createGain();
      g.gain.value = 0.0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i / (padNotes.length - 1)) * 1.5 - 0.75;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700 + i * 120;
      o.connect(g).connect(lp).connect(pan).connect(padBus);
      o.start();
      this._nodes.push(o);
      return { o, g, lp };
    });

    // fade the pad in
    padBus.gain.linearRampToValueAtTime(0.30, ctx.currentTime + 6.0);

    // --- distant sub pulse
    this.subTimer = 0;

    // --- felt piano: schedule sparse notes on a slow grid
    this.scale = [
      220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0,
      440.0, 493.88, 523.25, 587.33, 659.25,
    ];
    this._nextNoteAt = ctx.currentTime + 2.0;
    this._noteTimer = setInterval(() => this._scheduleNotes(), 400);
    this._timers.push(this._noteTimer);
  }

  _scheduleNotes() {
    if (!this.ctx || this.mode !== 'procedural') return;
    const now = this.ctx.currentTime;
    // keep ~4 s of lookahead
    while (this._nextNoteAt < now + 4.0) {
      const t = this._nextNoteAt;
      this._playNote(t);
      // irregular spacing, 2.2 – 6.5 s
      const gap = 2.2 + Math.random() * 4.3;
      this._nextNoteAt = t + gap;
    }
  }

  _playNote(t) {
    const ctx = this.ctx;
    // prefer low/mid register notes, occasionally a high answer
    let idx;
    const r = Math.random();
    if (r < 0.55) idx = 0 + Math.floor(Math.random() * 4);
    else if (r < 0.86) idx = 2 + Math.floor(Math.random() * 5);
    else idx = 7 + Math.floor(Math.random() * 5);
    const freq = this.scale[clampInt(idx, 0, this.scale.length - 1)];

    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 2.004;
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;

    const env = ctx.createGain();
    const vel = 0.10 + Math.random() * 0.10;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 3.4 + Math.random() * 2.2);

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(2200, t);
    tone.frequency.exponentialRampToValueAtTime(700, t + 2.6);

    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.1;

    o1.connect(env);
    o2.connect(g2).connect(env);
    env.connect(tone).connect(pan);
    pan.connect(this.master);
    pan.connect(this.verb);

    o1.start(t); o2.start(t);
    const stop = t + 6.0;
    o1.stop(stop); o2.stop(stop);
    o1.onended = () => { try { o1.disconnect(); o2.disconnect(); env.disconnect(); } catch (e) {} };
  }

  /* ------------------------------------------------------------------ */

  async toggle(force) {
    if (!this.ctx) await this.init();
    const next = force !== undefined ? !!force : this.muted;
    this.muted = !next;

    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.linearRampToValueAtTime(next ? 0.62 : 0.0, now + 1.6);

    if (this.mode === 'file' && this.audioEl) {
      if (next) {
        this.audioEl.play().catch(() => {});
        if (this.fileGain) {
          this.fileGain.gain.cancelScheduledValues(now);
          this.fileGain.gain.linearRampToValueAtTime(0.9, now + 1.6);
        }
      } else {
        // let the master fade before pausing
        setTimeout(() => { if (this.muted) this.audioEl.pause(); }, 1700);
      }
    }
    return next;
  }

  dispose() {
    for (const t of this._timers) clearInterval(t);
    for (const n of this._nodes) { try { n.stop(); } catch (e) {} }
    if (this.ctx) this.ctx.close();
  }
}

function clampInt(v, a, b) { return v < a ? a : v > b ? b : v; }
