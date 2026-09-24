// Air visualisation, driven entirely by the physics fields:
//
//   · WIND TRACERS — particles advected through the 3-D velocity field
//     (along-wind + cross-wind + vertical, in terrain-following coordinates),
//     drawn as fading streak trails. Colour says what a glider would feel there:
//     violet = usable climb, red/orange = rotor (and they get kicked
//     around by a stochastic eddy velocity scaled to the local turbulence).
//   · LIFT BAND — a translucent lens enclosing the usable soarable air (top and
//     bottom surfaces), with altitude contours every 25 ft (major every 100 ft).
//   · ROTOR — soft swirling sprites through the terrain rotor and the tree /
//     building wakes, at random continuous positions (no grid pattern).

import * as THREE from "three";
import { sinkRate, windProfile, USABLE_CLIMB } from "./physics.js";
import { rand } from "./rng.js";

const N_TRACERS = 2600;
const TRAIL = 18;              // points per trail
const TRAIL_DT = 1.1;          // simulated seconds between trail points
const TIME_SCALE = 16;         // simulated seconds per real second
const MAX_ROTOR_SPRITES = 9000;

function gauss() { return Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand()); }

export class AirViz {
  constructor(parent, { phys, worldY, exag, tracers = N_TRACERS }) {
    this.N = tracers;
    this.phys = phys;
    this.worldY = worldY;
    this.exag = exag;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.field = null;
    this.show = { tracers: true, band: true, rotor: true };
    this._initTracers();
    this.band = null;
    this.rotor = null;
    this.stats = { bandCells: 0, rotorSprites: 0, tracers: this.N };
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }

  // ------------------------------------------------------------------ fields
  setFields({ field, net, turb, fine, wing, speed }) {
    this.field = field;
    this.margin = net.margin ?? USABLE_CLIMB;
    this.turb = turb;
    this.fine = fine;
    this.wing = wing;
    this.speed = speed;
    this.speedFac = Math.min(1.4, Math.max(0, (speed - 1.5) / 6));
    // gradient of the effective surface, for terrain-following advection
    const p = this.phys, n = p.n;
    const g = p._gradient(field.base);
    this.bgx = g.gx; this.bgy = g.gy;
    // height-above-surface -> layer index lookup, 1 m resolution
    const agl = field.agl, top = Math.ceil(agl[agl.length - 1]);
    this.lut = new Uint8Array(top + 1);
    for (let d = 0, li = 0; d <= top; d++) {
      while (li < agl.length - 2 && agl[li + 1] <= d) li++;
      this.lut[d] = li;
    }
    this._buildBand(field, net);
    this._buildRotor();
    this._buildRotorShells();
    this.stats.n = n;
  }

  // Sample the flow at (x east, y north, d above the effective surface).
  _sample(x, y, d, out) {
    const p = this.phys, F = this.field, n = p.n, half = p.windowM / 2, cell = p.cell;
    let fi = (x + half) / cell, fj = (y + half) / cell;
    const i0 = Math.max(0, Math.min(n - 2, fi | 0)), j0 = Math.max(0, Math.min(n - 2, fj | 0));
    const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
    const k = j0 * n + i0;
    const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, e = tx * ty;
    const bil = (g) => g[k] * a + g[k + 1] * b + g[k + n] * c + g[k + n + 1] * e;
    out.base = bil(F.base);
    out.gx = bil(this.bgx); out.gy = bil(this.bgy);
    const agl = F.agl;
    const dd = Math.max(0, Math.min(agl[agl.length - 1], d));
    const li = this.lut[dd | 0];
    const tz = Math.max(0, Math.min(1, (dd - agl[li]) / (agl[li + 1] - agl[li])));
    // below the lowest layer, taper toward the ground with the log profile
    const low = d < agl[0] ? Math.max(0.15, windProfile(Math.max(d, 0.5)) / windProfile(agl[0])) : 1;
    const L = (arr) => (bil(arr[li]) * (1 - tz) + bil(arr[li + 1]) * tz) * low;
    out.w = L(F.layers);
    out.s = L(F.spd);
    out.c = L(F.cross);
    // turbulence: terrain rotor (25 m) and obstacle wakes (8 m)
    const alt = out.base + d;
    let I = 0;
    const T = this.turb;
    if (T && alt < T.top[k]) I = T.intensity[k];
    const W = this.fine;
    if (W) {
      const fi2 = ((x + half) / W.cell) | 0, fj2 = ((y + half) / W.cell) | 0;
      if (fi2 >= 0 && fj2 >= 0 && fi2 < W.n && fj2 < W.n) {
        const q = fj2 * W.n + fi2;
        if (alt < W.top[q]) I = Math.max(I, Math.min(1, W.intensity[q] * this.speedFac));
      }
    }
    out.turb = I;
    return out;
  }

  // ------------------------------------------------------------------ tracers
  _initTracers() {
    const NV = this.N * TRAIL;
    this.tp = new Float32Array(this.N * 3);       // x, y, d (physics metres)
    this.tv = new Float32Array(this.N * 3);       // eddy velocity
    this.age = new Float32Array(this.N);
    this.life = new Float32Array(this.N);
    this.trailClock = new Float32Array(this.N);
    this.pos = new Float32Array(NV * 3);
    this.col = new Float32Array(NV * 3);
    this.recA = new Float32Array(NV);                // alpha recorded with each point
    this.alpha = new Float32Array(NV);
    const idx = [];
    for (let p = 0; p < this.N; p++) for (let t = 0; t < TRAIL - 1; t++) idx.push(p * TRAIL + t, p * TRAIL + t + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC;
        void main(){ vA = alpha; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(vC, vA); }`,
    });
    this.trails = new THREE.LineSegments(g, mat);
    this.trails.frustumCulled = false;
    this.group.add(this.trails);

    // bright heads
    this.headPos = new Float32Array(this.N * 3);
    this.headCol = new Float32Array(this.N * 3);
    this.headA = new Float32Array(this.N);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute("color", new THREE.BufferAttribute(this.headCol, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute("alpha", new THREE.BufferAttribute(this.headA, 1).setUsage(THREE.DynamicDrawUsage));
    this.headMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: 800 } },
      vertexShader: `attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC; uniform float scale;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = clamp(5.0 * scale / -mv.z, 1.5, 7.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ vec2 q = gl_PointCoord - 0.5; float r = dot(q,q); if (r > 0.25) discard;
          gl_FragColor = vec4(vC, vA * (1.0 - r * 3.2)); }`,
    });
    this.heads = new THREE.Points(hg, this.headMat);
    this.heads.frustumCulled = false;
    this.group.add(this.heads);
    this._s = {};
    this._spawnAll = true;
  }

  _spawn(p) {
    const half = this.phys.windowM / 2 - 180;
    let x, y;
    if (rand() < 0.6) {           // concentrate around take-off, where it matters
      const r = 950 * Math.sqrt(rand()), a = rand() * Math.PI * 2;
      x = r * Math.cos(a); y = r * Math.sin(a);
    } else {
      x = (rand() * 2 - 1) * half; y = (rand() * 2 - 1) * half;
    }
    // upwind bias: start some from upwind so streams cross the ridge
    const d = 3 + 260 * Math.pow(rand(), 1.9);
    this.tp[p * 3] = x; this.tp[p * 3 + 1] = y; this.tp[p * 3 + 2] = d;
    this.tv[p * 3] = this.tv[p * 3 + 1] = this.tv[p * 3 + 2] = 0;
    this.age[p] = 0;
    this.life[p] = 9 + rand() * 9;
    this.trailClock[p] = 0;
    // collapse the trail onto the spawn point
    const s = this._sample(x, y, d, this._s);
    const X = x, Y = this.worldY(s.base + d), Z = -y;
    for (let t = 0; t < TRAIL; t++) {
      const v = (p * TRAIL + t) * 3;
      this.pos[v] = X; this.pos[v + 1] = Y; this.pos[v + 2] = Z;
      this.recA[p * TRAIL + t] = 0;
    }
  }

  // what a glider would feel here -> colour & alpha
  _classify(s, out) {
    const net = s.w - sinkRate(this.wing, s.s) - this.margin;
    if (s.turb > 0.22) {
      const t = Math.min(1, (s.turb - 0.22) / 0.6);
      out[0] = 1.0; out[1] = 0.55 - 0.35 * t; out[2] = 0.2 - 0.1 * t; out[3] = 0.55 + 0.4 * t;
    } else if (net > 0) {
      const t = Math.min(1, net / 2);
      out[0] = 0.78 - 0.18 * t; out[1] = 0.6 - 0.25 * t; out[2] = 1.0; out[3] = 0.6 + 0.35 * t;
    } else {
      out[0] = 0.93; out[1] = 0.96; out[2] = 1.0; out[3] = 0.22;
    }
    return out;
  }

  update(dtReal, camera, renderer) {
    if (!this.field) return;
    const dt = Math.min(0.05, dtReal) * TIME_SCALE;
    const F = this.field, fe = F.fe, fn = F.fn, half = this.phys.windowM / 2 - 120;
    const s = this._s, cls = [0, 0, 0, 0];
    const U = Math.max(1, F.U);
    if (this._spawnAll) {
      for (let p = 0; p < this.N; p++) { this._spawn(p); this.age[p] = rand() * this.life[p]; }
      this._spawnAll = false;
    }
    for (let p = 0; p < this.N; p++) {
      let x = this.tp[p * 3], y = this.tp[p * 3 + 1], d = this.tp[p * 3 + 2];
      this._sample(x, y, d, s);
      // Ornstein–Uhlenbeck eddy velocity: turbulence kicks tracers around
      const sig = s.turb * U * 0.55, tau = 1.6;
      const kk = Math.sqrt((2 * dt) / tau) * sig;
      for (let c = 0; c < 3; c++) {
        const q = p * 3 + c;
        this.tv[q] += (-this.tv[q] / tau) * dt + kk * gauss() * (c === 2 ? 0.7 : 1);
      }
      const vx = fe * s.s - fn * s.c + this.tv[p * 3];
      const vy = fn * s.s + fe * s.c + this.tv[p * 3 + 1];
      const vz = s.w + this.tv[p * 3 + 2];
      x += vx * dt; y += vy * dt;
      d += (vz - (vx * s.gx + vy * s.gy)) * dt;
      if (d < 1.2) { d = 1.2; this.tv[p * 3 + 2] = Math.abs(this.tv[p * 3 + 2]); }
      this.age[p] += dtReal;
      if (Math.abs(x) > half || Math.abs(y) > half || d > 470 || this.age[p] > this.life[p]) {
        this._spawn(p);
        continue;
      }
      this.tp[p * 3] = x; this.tp[p * 3 + 1] = y; this.tp[p * 3 + 2] = d;

      const X = x, Y = this.worldY(s.base + d), Z = -y;
      this._classify(s, cls);
      const base = p * TRAIL;
      this.trailClock[p] += dt;
      if (this.trailClock[p] >= TRAIL_DT) {
        this.trailClock[p] = 0;
        this.pos.copyWithin((base + 1) * 3, base * 3, (base + TRAIL - 1) * 3);
        this.col.copyWithin((base + 1) * 3, base * 3, (base + TRAIL - 1) * 3);
        this.recA.copyWithin(base + 1, base, base + TRAIL - 1);
      }
      const v = base * 3;
      this.pos[v] = X; this.pos[v + 1] = Y; this.pos[v + 2] = Z;
      this.col[v] = cls[0]; this.col[v + 1] = cls[1]; this.col[v + 2] = cls[2];
      this.recA[base] = cls[3];
      const age = this.age[p], life = this.life[p];
      const fade = Math.min(1, age / 0.8, (life - age) / 1.2);
      for (let t = 0; t < TRAIL; t++) {
        this.alpha[base + t] = this.recA[base + t] * fade * Math.pow(1 - t / TRAIL, 1.3);
      }
      this.headPos[p * 3] = X; this.headPos[p * 3 + 1] = Y; this.headPos[p * 3 + 2] = Z;
      this.headCol[p * 3] = cls[0]; this.headCol[p * 3 + 1] = cls[1]; this.headCol[p * 3 + 2] = cls[2];
      this.headA[p] = cls[3] * fade;
    }
    const g = this.trails.geometry.attributes;
    g.position.needsUpdate = g.color.needsUpdate = g.alpha.needsUpdate = true;
    const h = this.heads.geometry.attributes;
    h.position.needsUpdate = h.color.needsUpdate = h.alpha.needsUpdate = true;
    const scale = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.headMat.uniforms.scale.value = scale;
    if (this.rotor) {
      this.rotor.material.uniforms.time.value += dtReal;
      this.rotor.material.uniforms.scale.value = scale;
    }
    if (this.band) this.band.material.uniforms.time.value += dtReal;
    this.trails.visible = this.heads.visible = this.show.tracers;
    if (this.band) this.band.visible = this.show.band;
    if (this.rotor) this.rotor.visible = this.show.rotor;
    for (const sh of this.shells || []) { sh.visible = this.show.rotor; sh.material.uniforms.time.value += dtReal; }
  }

  // ------------------------------------------------------------------ lift band
  _buildBand(F, net) {
    if (this.band) { this.group.remove(this.band); this.band.geometry.dispose(); this.band.material.dispose(); }
    const p = this.phys, n = p.n, half = p.windowM / 2, cell = p.cell, NN = n * n;
    // per column: lowest and highest altitude of usable (net > 0) air
    const top = new Float32Array(NN).fill(NaN), bot = new Float32Array(NN).fill(NaN), climb = new Float32Array(NN);
    const cross = (li, k, c) => {             // interpolate the net = 0 crossing between li and li+1
      const c2 = net[li + 1][k];
      return c2 > 0 ? 1 : Number.isFinite(c2) ? c / (c - c2) : 0;
    };
    let cells = 0, volume = 0;
    for (let k = 0; k < NN; k++) {
      let t = NaN, b = NaN, mc = 0;
      for (let li = 0; li < net.length; li++) {
        const c = net[li][k];
        if (!(c > 0)) continue;
        mc = Math.max(mc, c);
        const z = F.base[k] + F.agl[li];
        if (!(b === b)) {
          // bottom: back off toward the unusable layer below, if it was finite
          const c0 = li > 0 ? net[li - 1][k] : -Infinity;
          b = Number.isFinite(c0) ? z - (c / (c - c0)) * (F.agl[li] - F.agl[li - 1]) : z;
        }
        t = li + 1 < net.length ? z + cross(li, k, c) * (F.agl[li + 1] - F.agl[li]) : z;
      }
      top[k] = t; bot[k] = b; climb[k] = mc;
      if (t === t) { cells++; volume += (t - b) * cell * cell; }
    }
    // Two surfaces (top, bottom) forming a lens. Columns just outside the band
    // pinch both surfaces to the neighbours' mid-height with zero opacity, so
    // the band closes softly instead of hanging curtains down to the ground.
    const pos = new Float32Array(NN * 2 * 3), col = new Float32Array(NN * 2 * 3);
    const alpha = new Float32Array(NN * 2), alt = new Float32Array(NN * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i, has = top[k] === top[k];
        let ht = top[k], hb = bot[k];
        if (!has) {
          let s = 0, c = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const q = jj * n + ii;
            if (top[q] === top[q]) { s += (top[q] + bot[q]) / 2; c++; }
          }
          ht = hb = c ? s / c : F.base[k] + 2;
        }
        const t = Math.min(1, climb[k] / 2);
        const a = has ? 0.35 + 0.65 * Math.min(1, climb[k] / 0.6) : 0;
        for (const [side, h] of [[0, ht], [1, hb]]) {
          const v = side * NN + k;
          pos[v * 3] = -half + i * cell; pos[v * 3 + 1] = this.worldY(h); pos[v * 3 + 2] = -(-half + j * cell);
          alt[v] = h;
          alpha[v] = side ? a * 0.55 : a;
          col[v * 3] = 0.2 + 0.25 * t; col[v * 3 + 1] = 0.75 + 0.25 * t; col[v * 3 + 2] = 0.55 - 0.1 * t;
        }
      }
    }
    const idx = [];
    for (const off of [0, NN]) {
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        if (alpha[off + a] + alpha[off + b] + alpha[off + c] > 0) idx.push(off + a, off + c, off + b);
        if (alpha[off + b] + alpha[off + c] + alpha[off + d] > 0) idx.push(off + b, off + c, off + d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1));
    g.setAttribute("alt", new THREE.BufferAttribute(alt, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 } },
      vertexShader: `attribute float alpha; attribute float alt; attribute vec3 color;
        varying float vA; varying float vAlt; varying vec3 vC; varying vec3 vN; varying vec3 vV;
        void main(){ vA = alpha; vAlt = alt; vC = color;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying float vAlt; varying vec3 vC; varying vec3 vN; varying vec3 vV; uniform float time;
        void main(){
          if (vA < 0.01) discard;
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          // altitude contours: minor every 25 ft, major every 100 ft — soft,
          // anti-aliased light lines. Violet (as in pilots' lift-band diagrams)
          // appears nowhere in grass, woods, chalk or sea, so it reads everywhere.
          float u = vAlt / 7.62;
          float dm = min(fract(u), 1.0 - fract(u)) / max(fwidth(u), 1e-4);
          float U4 = vAlt / 30.48;
          float dM = min(fract(U4), 1.0 - fract(U4)) / max(fwidth(U4), 1e-4);
          float line = max((1.0 - smoothstep(0.2, 1.1, dm)) * 0.55, 1.0 - smoothstep(0.5, 1.6, dM));
          vec3 fill = vec3(0.56, 0.24, 0.95);
          vec3 col = mix(fill, vec3(0.93, 0.84, 1.0), max(line, fres * 0.7));
          float shimmer = 0.5 + 0.5 * sin(vAlt * 0.35 - time * 1.6);
          float a = vA * (0.2 + 0.5 * fres + 0.45 * line + 0.04 * shimmer);
          gl_FragColor = vec4(col, min(a, 0.85));
        }`,
    });
    mat.extensions = { derivatives: true };
    this.band = new THREE.Mesh(g, mat);
    this.band.renderOrder = 2;
    this.group.add(this.band);
    this.stats.bandCells = cells;
    this.stats.bandVolume = volume;     // m³ of usable soarable air
    this.bandTop = top;
    this.bandBottom = bot;
  }

  // ------------------------------------------------------------------ rotor shells
  // Translucent volumes over the turbulent air, like the lift band: red for
  // terrain rotor (25 m grid), amber for tree / building wakes (8 m grid).
  // Drifting diagonal hatching reads as "churning" and distinguishes them from lift.
  _buildRotorShells() {
    for (const sh of this.shells || []) { this.group.remove(sh); sh.geometry.dispose(); sh.material.dispose(); }
    this.shells = [];
    const p = this.phys;
    if (this.turb) {
      const I = this.turb.intensity, n = p.n;
      this.shells.push(this._shell(n, p.cell, (k) => p.hs[k], (k) => this.turb.top[k], (k) => I[k], 0.12,
        [1.0, 0.32, 0.12], 0));
    }
    if (this.fine) {
      const W = this.fine, f = this.speedFac;
      this.shells.push(this._shell(W.n, W.cell, (k) => p.fine.ground[k], (k) => W.top[k],
        (k) => Math.min(1, W.intensity[k] * f), 0.4, [1.0, 0.68, 0.12], 0.5, 0.6));   // only significant wakes, fainter
    }
    for (const sh of this.shells) this.group.add(sh);
  }

  // n×n grid (cell centres at −W/2 + (i+offset)·cell) -> dome mesh over [ground, top]
  _shell(n, cell, ground, top, inten, thr, rgb, offset, opacity = 1) {
    const half = this.phys.windowM / 2, NN = n * n;
    const pos = new Float32Array(NN * 3), alpha = new Float32Array(NN), hgt = new Float32Array(NN);
    const on = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) on[k] = inten(k) >= thr && top(k) > ground(k) + 1 ? 1 : 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i, g = ground(k);
        const h = on[k] ? top(k) : g + 0.5;
        pos[k * 3] = -half + (i + offset) * cell;
        pos[k * 3 + 1] = this.worldY(h);
        pos[k * 3 + 2] = -(-half + (j + offset) * cell);
        alpha[k] = on[k] ? (0.35 + 0.65 * Math.min(1, (inten(k) - thr) / 0.5)) * opacity : 0;
        hgt[k] = h - g;
      }
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (on[a] || on[b] || on[c]) idx.push(a, c, b);
      if (on[b] || on[c] || on[d]) idx.push(b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1));
    g.setAttribute("hgt", new THREE.BufferAttribute(hgt, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color(...rgb) } },
      vertexShader: `attribute float alpha; attribute float hgt; varying float vA; varying vec3 vN; varying vec3 vV; varying vec3 vW;
        void main(){ vA = alpha; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
          vec4 mv = viewMatrix * w; vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float time; uniform vec3 color; varying float vA; varying vec3 vN; varying vec3 vV; varying vec3 vW;
        void main(){
          if (vA < 0.01) discard;
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);
          float u = (vW.x + vW.z + vW.y * 1.5) / 14.0 - time * 1.8;     // drifting hatch
          float dh = abs(fract(u) - 0.5) / max(fwidth(u), 1e-4);     // px from stripe centre
          float stripe = 1.0 - smoothstep(0.8, 2.2, dh);
          vec3 c = mix(color, vec3(1.0, 0.93, 0.82), max(stripe * 0.55, fres * 0.5));
          float a = vA * (0.2 + 0.4 * fres + 0.3 * stripe);
          gl_FragColor = vec4(c, min(a, 0.85));
        }`,
    });
    mat.extensions = { derivatives: true };
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 3;
    return m;
  }

  // ------------------------------------------------------------------ rotor
  _buildRotor() {
    if (this.rotor) { this.group.remove(this.rotor); this.rotor.geometry.dispose(); this.rotor.material.dispose(); }
    const p = this.phys, half = p.windowM / 2;
    const cand = [];      // [x, y, ground, top, intensity, size, kind]
    const T = this.turb;
    if (T) {
      for (let k = 0; k < p.n * p.n; k++) {
        const I = T.intensity[k];
        if (I < 0.12) continue;
        const i = k % p.n, j = (k / p.n) | 0;
        cand.push([-half + i * p.cell, -half + j * p.cell, p.cell, p.hs[k], T.top[k], I, 0]);
      }
    }
    const W = this.fine;
    if (W) {
      for (let q = 0; q < W.n * W.n; q++) {
        const I = Math.min(1, W.intensity[q] * this.speedFac);
        if (I < 0.4) continue;                     // only significant tree / building wakes
        const i = q % W.n, j = (q / W.n) | 0;
        const g = this.phys.fine.ground[q];
        cand.push([-half + (i + 0.5) * W.cell, -half + (j + 0.5) * W.cell, W.cell, g, W.top[q], I, 1]);
      }
    }
    let want = 0;
    for (const c of cand) want += c[6] ? c[5] * 0.5 : c[5] * 3.2;
    const scale = want > MAX_ROTOR_SPRITES ? MAX_ROTOR_SPRITES / want : 1;
    const pos = [], col = [], ph = [], amp = [], size = [], al = [];
    for (const [x, y, cs, g, top, I, kind] of cand) {
      let cnt = (kind ? I * 0.5 : I * 3.2) * scale;
      cnt = Math.floor(cnt) + (rand() < cnt % 1 ? 1 : 0);
      for (let c = 0; c < cnt; c++) {
        const px = x + (rand() - 0.5) * cs * 1.1, py = y + (rand() - 0.5) * cs * 1.1;
        const fr = Math.pow(rand(), 1.4);
        const h = g + 1 + fr * Math.max(2, top - g);
        pos.push(px, this.worldY(h), -py);
        const t = Math.min(1, I);
        if (kind) col.push(1.0, 0.62 - 0.2 * t, 0.25);          // obstacle wake: amber
        else col.push(0.95, 0.32 - 0.15 * t, 0.2 - 0.08 * t);   // terrain rotor: red
        ph.push(rand() * 100);
        amp.push((kind ? 2.5 : 9) * (0.5 + I));
        size.push((kind ? 5 : 16) * (0.7 + rand() * 0.6));
        al.push((kind ? 0.22 : 0.28) * (0.4 + 0.6 * I));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute("phase", new THREE.Float32BufferAttribute(ph, 1));
    g.setAttribute("amp", new THREE.Float32BufferAttribute(amp, 1));
    g.setAttribute("size", new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute("alpha", new THREE.Float32BufferAttribute(al, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { time: { value: 0 }, scale: { value: 800 } },
      vertexShader: `attribute vec3 color; attribute float phase; attribute float amp; attribute float size; attribute float alpha;
        uniform float time; uniform float scale; varying vec3 vC; varying float vA;
        void main(){
          float t = time * 1.4 + phase;
          vec3 off = vec3(sin(t) + 0.5*sin(2.3*t+1.0), 0.7*sin(1.7*t+2.0), cos(1.2*t) + 0.5*cos(2.9*t));
          vec4 mv = modelViewMatrix * vec4(position + off * amp, 1.0);
          vC = color; vA = alpha * (0.75 + 0.25 * sin(t * 2.1));
          gl_PointSize = clamp(size * scale / -mv.z, 1.0, 90.0);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 q = gl_PointCoord - 0.5; float r = dot(q,q) * 4.0; if (r > 1.0) discard;
          gl_FragColor = vec4(vC, vA * pow(1.0 - r, 1.6)); }`,
    });
    this.rotor = new THREE.Points(g, mat);
    this.rotor.frustumCulled = false;
    this.rotor.renderOrder = 3;
    this.group.add(this.rotor);
    this.stats.rotorSprites = pos.length / 3;
  }
}
