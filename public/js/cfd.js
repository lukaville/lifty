// Precomputed OpenFOAM flow (see cfd/README.md). For a site with stored
// results this loads the two simulated wind directions either side of the one
// asked for, blends them, and returns fields shaped like SitePhysics'
// computeLift / computeTurbulence output, so the viewer and the band
// statistics don't care which model produced them.
//
// The simulations are neutral and Reynolds-number independent, so each stores
// velocities as fractions of the 10 m reference wind; multiplying by the wind
// you set gives m/s.

import { windProfile } from "./physics.js";

// Rotor has two parts.
//
// 1. The core: where the solved mean flow recirculates (moves against the
//    wind) or nearly stops, below 15% of the undisturbed wind at the same
//    height. Its size is set by the terrain: in fully turbulent flow a
//    separation bubble behind a sharp edge is nearly independent of wind speed
//    (backward-facing steps; dunes at 0.2–0.8 m/s friction velocity reattach
//    at ≈ 6 H either way). Its strength grows with the wind.
//
// 2. The turbulent wake shed downstream of the core, which is what makes the
//    rotor pilots meet longer in stronger wind. Gusts scale with the wind
//    (turbulent energy with its square), and the extra turbulence decays with
//    distance behind the bubble, so the distance over which gusts stay strong
//    enough to upset a wing grows with wind speed:
//      σ_wake = U · WAKE_TI · exp(−x / (WAKE_DECAY_H · H))
//    x = distance downstream of the core, H = the core's depth there.
//    WAKE_TI 0.2: turbulence intensity rose from 12% to 31% downwind of the
//    recirculation zones measured at Perdigão (Menke et al. 2019, ACP 19:2713),
//    WAKE_DECAY_H 4: the excess falls to 10% within ~10 H. The wake counts as
//    rotor from σ = GUST_CRITICAL (0.8 m/s, peak gusts ≈ 3σ ≈ 2.4 m/s, a fifth of
//    a paraglider's trim speed), full strength at twice that. Behind a sharp
//    drop this gives ≈ 7 H of rotor at 14 mph, ≈ 8 H at 20 and ≈ 10 H at 30
//    mph, none of the wake below ≈ 9 mph: the "5–10 × the height, further in
//    stronger wind" of the soaring literature.
//
// The solver's own turbulence field is not used: steady RANS averages out the
// unsteady eddy shedding that makes rotor gusty, so its turbulence is lowest
// exactly inside the lee rotor, and highest in the shear layer above
// windward cliff edges.
const STAGNANT = 0.15;
// first well-resolved height of the simulations (≥ 3 cells of the 10 m LES,
// above the 4–12 m RANS wall cells): take-off wind is derived from here
const SURFACE_REF_M = 30;
// In light wind the rotor weakens and shrinks toward nothing in calm air: its
// depth scales with √(U / 4 m/s) below 9 mph (strength fades linearly).
const LIGHT_WIND_SIZE = (U) => Math.sqrt(Math.min(1, Math.max(0, U) / 4));
export const WAKE_TI = 0.2, WAKE_DECAY_H = 4, GUST_CRITICAL = 0.8;
// gusts (σ, m/s) at which rotor is coloured at full strength: peak gusts ≈ 9 m/s
export const GUST_SEVERE = 3;
export function rotorSeverity(s, d) {
  const ratio = s / windProfile(d);                  // along-wind speed / undisturbed
  return ratio <= 0 ? 1 : Math.max(0, (STAGNANT - ratio) / STAGNANT);
}
// gust σ (m/s) in the wake x m behind a rotor core H m deep, for 10 m wind U
export const wakeGust = (U, x, H) => U * WAKE_TI * Math.exp(-x / (WAKE_DECAY_H * Math.max(H, 1)));
export const gustSeverity = (sigma) => Math.min(1, Math.max(0, (sigma - GUST_CRITICAL) / GUST_CRITICAL));

// Decode a lifty-cfd-2 file (cfd/pack.mjs) into Float32 fields in units of
// the reference wind: { h, base, f: { w|s|c|t: [layer][k] } }.
export async function decodeCfd(buffer) {
  const raw = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const bytes = new Uint8Array(raw);
  const nl = bytes.indexOf(10);
  const h = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
  if (h.format !== "lifty-cfd-2") throw new Error(`unknown CFD format ${h.format}`);
  const NN = h.n * h.n;
  let off = nl + 1;
  const view = new DataView(raw);
  const base = new Float32Array(NN);
  for (let k = 0; k < NN; k++, off += 2) base[k] = view.getInt16(off, true) * h.baseScale;
  const f = {};
  for (const key of h.fields) {
    const acc = new Int32Array(NN), scale = h.scales?.[key] ?? h.scale;
    f[key] = h.agl.map(() => {
      const lo = bytes.subarray(off, off + NN), hi = bytes.subarray(off + NN, off + 2 * NN);
      off += 2 * NN;
      const out = new Float32Array(NN);
      for (let k = 0; k < NN; k++) {
        acc[k] += ((hi[k] << 24) >> 16) | lo[k];      // signed 16-bit difference from the layer below
        out[k] = acc[k] * scale;
      }
      return out;
    });
  }
  return { h, base, f };
}

// the two stored directions bracketing `deg`, with blend weights
export function bracket(dirs, deg) {
  const sorted = [...dirs].sort((a, b) => a - b);
  const d = ((deg % 360) + 360) % 360;
  let lo = sorted[sorted.length - 1], hi = sorted[0];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= d) lo = sorted[i];
    if (sorted[i] >= d) { hi = sorted[i]; break; }
  }
  const span = ((hi - lo) % 360 + 360) % 360;
  const t = span === 0 ? 0 : (((d - lo) % 360 + 360) % 360) / span;
  return [{ dir: lo, w: 1 - t }, { dir: hi, w: t }];
}

export const cfdFile = (slug, dir) => `${slug}/d${String(Math.round(dir)).padStart(3, "0")}.bin`;

export class CfdStore {
  constructor(root = "./data/les/") {
    this.root = root;
    this.index = null;
    this.files = new Map();      // path -> decoded | Promise | null (failed)
  }

  async loadIndex() {
    this.indexError = null;
    try {
      const r = await fetch(this.root + "index.json");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.index = await r.json();
    } catch (e) { this.index = {}; this.indexError = `the simulation index (${this.root}index.json) failed to load: ${e.message}`; }
    return this.index;
  }

  dirs(slug) { return this.index?.[slug] ?? null; }

  // Why (slug, deg) can't be served from the simulations, or null if it can
  // (possibly after loading). The app shows this instead of falling back to
  // another model.
  problem(slug, deg) {
    if (this.indexError) return this.indexError;
    const dirs = this.dirs(slug);
    if (!dirs || dirs.length < 2) return `there are no simulation results for this site (${slug})`;
    const br = bracket(dirs, deg);
    if ((((br[1].dir - br[0].dir) % 360) + 360) % 360 > 45) return `simulation results for ${slug} are missing directions between ${br[0].dir}° and ${br[1].dir}°`;
    for (const b of br) { const g = this.files.get(cfdFile(slug, b.dir)); if (g?.error) return g.error; }
    return null;
  }

  // The decoded pair for (slug, deg) if both are in memory; otherwise starts
  // loading them (calling onReady when they arrive) and returns null. Check
  // problem() when it returns null.
  pair(slug, deg, onReady) {
    if (this.problem(slug, deg)) return null;
    const br = bracket(this.dirs(slug), deg);
    const got = br.map((b) => this.files.get(cfdFile(slug, b.dir)));
    if (got.every((g) => g && !(g instanceof Promise))) return br.map((b, i) => ({ ...b, data: got[i] }));
    for (const b of br) {
      const path = cfdFile(slug, b.dir);
      if (this.files.has(path)) continue;
      this.files.set(path, fetch(this.root + path)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then(decodeCfd)
        .then((d) => { this.files.set(path, d); onReady?.(); })
        .catch((e) => { this.files.set(path, { error: `${this.root}${path} failed to load: ${e.message}` }); onReady?.(); }));
    }
    return null;
  }

  pending() { return [...this.files.values()].filter((v) => v instanceof Promise); }

  // resolves once the pair for (slug, deg) is in memory (or has failed to load)
  async ensure(slug, deg) {
    this.pair(slug, deg);
    await Promise.all(this.pending());
  }
}

// Blend a bracketing pair into lift + turbulence fields for 10 m wind U (m/s)
// blowing toward (fe, fn).
export function cfdFields(phys, pair, fe, fn, U) {
  const [A, B] = pair, n = phys.n, NN = n * n;
  const h = A.data.h;
  if (h.n !== n || h.windowM !== phys.windowM) throw new Error("CFD grid does not match the site grid");
  const agl = h.agl;
  const base = new Float32Array(NN);
  for (let k = 0; k < NN; k++) base[k] = A.data.base[k] * A.w + B.data.base[k] * B.w;
  const mix = (key, li, k) => A.data.f[key][li][k] * A.w + B.data.f[key][li][k] * B.w;

  const layers = [], spd = [], cross = [];
  const intensity = new Float32Array(NN), top = new Float32Array(NN);
  let max = 0;
  for (let li = 0; li < agl.length; li++) {
    const w = new Float32Array(NN), s = new Float32Array(NN), c = new Float32Array(NN);
    for (let k = 0; k < NN; k++) {
      w[k] = mix("w", li, k) * U;
      s[k] = mix("s", li, k) * U;          // negative = reversed flow
      c[k] = mix("c", li, k) * U;
      if (w[k] > max) max = w[k];
    }
    layers.push(w); spd.push(s); cross.push(c);
  }
  if (A.data.f.r && A.data.f.t) {
    const turb = lesRotor(A, B, agl, NN, base, U, fe, fn);
    return { field: { layers, spd, cross, base, agl, max, U, fe, fn, source: "cfd", les: true, surfaceRef: SURFACE_REF_M, dirs: pair.map((p) => p.dir) }, turb };
  }
  // 1. rotor core: the column's worst severity, up to the top of the
  //    contiguous recirculating layer above the surface
  // as SitePhysics.computeTurbulence, but fading linearly to zero in calm air
  // rather than cutting off below 1.5 m/s
  const speedFac = U >= 4 ? Math.min(1.4, (U - 1.5) / 6) : (2.5 / 6) * Math.max(0, U) / 4;
  const core = new Float32Array(NN), depth = new Float32Array(NN);
  for (let k = 0; k < NN; k++) {
    let worst = 0, topD = 0;
    for (let li = 0; li < agl.length; li++) {
      const sev = rotorSeverity(mix("s", li, k), agl[li]);
      if (sev < 0.2) { if (li > 1) break; else continue; }
      worst = Math.max(worst, sev);
      topD = agl[li];
    }
    core[k] = worst; depth[k] = worst > 0 ? topD + 5 : 0;
    intensity[k] = Math.min(1, worst * speedFac);
    top[k] = base[k] + depth[k] * LIGHT_WIND_SIZE(U);
  }
  // 2. turbulent wake: walk upwind from each column to the nearest core,
  //    and apply the gust decay from there
  const cell = phys.cell, maxSteps = Math.ceil(2000 / cell);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (core[k] >= 0.5) continue;
      for (let st = 1; st <= maxSteps; st++) {
        const ii = Math.round(i - fe * st), jj = Math.round(j - fn * st);
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) break;
        const q = jj * n + ii;
        if (core[q] < 0.5) continue;
        const H = depth[q], x = st * cell;
        const sev = gustSeverity(wakeGust(U, x, H));
        if (sev > intensity[k]) {
          intensity[k] = sev;
          // the wake thickens slowly as it recovers
          top[k] = Math.max(top[k], base[k] + H * (1 + 0.1 * x / H));
        }
        break;
      }
    }
  }
  return {
    field: { layers, spd, cross, base, agl, max, U, fe, fn, source: "cfd", surfaceRef: SURFACE_REF_M, dirs: pair.map((p) => p.dir) },
    turb: { intensity, top },
  };
}

// Rotor straight from a large-eddy simulation, which resolves the gusts:
//   · the core: air reversed more than half the time;
//   · the turbulent wake: gusts well above what the local wind and surface
//     produce on their own. A rough surface layer has turbulence ≈ TI_SURFACE
//     (20%) of the local wind; separation and wakes add more on top, often in
//     slow air (Perdigão: 12% upwind → 31% downwind of recirculation). The excess
//     σ = U · √(t² − (TI_SURFACE · s)²), t the resolved turbulent velocity and
//     s the mean along-wind speed (both ÷ the 10 m wind), counts as rotor from
//     GUST_CRITICAL, full at twice that. Gusts scale with the wind, so the
//     rotor reaches further in stronger wind.
const TI_SURFACE = 0.2;
function lesRotor(A, B, agl, NN, base, U, fe, fn) {
  const mix = (key, li, k) => A.data.f[key][li][k] * A.w + B.data.f[key][li][k] * B.w;
  // recirculating air is rotor at any wind, its strength (and, through the
  // threshold below, its size) fading in proportion to the wind below 4 m/s (9 mph)
  const coreFac = Math.min(1, Math.max(0, U / 4));
  const n = Math.round(Math.sqrt(NN));
  // ~80 m across the wind, and only downstream along it: turbulence is carried
  // with the flow, never against it, so smoothing must not put rotor on the
  // attached air approaching a cliff edge
  const blur = (f) => { for (let q = 0; q < 4; q++) f = smoothDownstream(f, n, fe, fn, base); return f; };
  // severity per layer, smoothed horizontally: the scale a wing meets
  // turbulence at, and it removes the cell-to-cell flicker of thresholding
  // noisy gust statistics
  // alongside, a strength that keeps rising past "unusable", for colouring:
  // excess gusts from GUST_CRITICAL (0) to GUST_SEVERE (1)
  const strengthL = [];
  const sev = agl.map((_, li) => {
    const f = new Float32Array(NN), g = new Float32Array(NN);
    for (let k = 0; k < NN; k++) {
      const rev = mix("r", li, k);
      const core = Math.min(1, Math.max(0, (rev - 0.2) / 0.3)) * coreFac;      // reversed 20% → 50% of the time
      const t = mix("t", li, k), sl = TI_SURFACE * mix("s", li, k);
      const excess = U * Math.sqrt(Math.max(0, t * t - sl * sl));
      f[k] = Math.max(core, gustSeverity(excess));
      // colour follows the gusts (they scale with the wind); recirculating air
      // shows at least mid-orange however calm
      g[k] = Math.max(0.5 * Math.min(1, rev / 0.5) * coreFac, Math.min(1, Math.max(0, (excess - GUST_CRITICAL) / (GUST_SEVERE - GUST_CRITICAL))));
    }
    strengthL.push(blur(g));
    return blur(f);
  });
  const intensity = new Float32Array(NN), depth = new Float32Array(NN), strength = new Float32Array(NN);
  for (let k = 0; k < NN; k++) {
    let worst = 0, topD = 0, strong = 0;
    for (let li = 0; li < agl.length; li++) {
      const v = sev[li][k];
      if (v > worst) worst = v;
      if (strengthL[li][k] > strong) strong = strengthL[li][k];
      if (v >= 0.2) topD = agl[li];               // highest disturbed layer
    }
    intensity[k] = Math.min(1, worst);
    strength[k] = Math.min(intensity[k], strong);
    depth[k] = topD > 0 ? topD + 5 : 0;
  }
  // smooth the rotor's depth too (weighted by its strength), so its top is a
  // surface rather than a set of columns
  const wd = blur(depth.map((d, k) => d * intensity[k])), wi = blur(intensity);
  const top = new Float32Array(NN), size = LIGHT_WIND_SIZE(U);
  for (let k = 0; k < NN; k++) top[k] = base[k] + (intensity[k] > 0 && wi[k] > 1e-4 ? size * wd[k] / wi[k] : 0);
  return { intensity, top, strength };
}

// One smoothing pass over an n×n grid: 1-2-1 across the wind, and along it
// each cell mixes with the cell one step upwind only (so values spread
// downstream). Neighbours are sampled bilinearly (edges clamp) and weighted
// down where their ground differs in height, exp(−(Δh / 15 m)²), so nothing
// blends across a cliff.
function smoothDownstream(f, n, fe, fn, base) {
  const at = (g, x, y) => {
    x = Math.max(0, Math.min(n - 1.001, x)); y = Math.max(0, Math.min(n - 1.001, y));
    const i = x | 0, j = y | 0, tx = x - i, ty = y - j, k = j * n + i;
    return g[k] * (1 - tx) * (1 - ty) + g[k + 1] * tx * (1 - ty) + g[k + n] * (1 - tx) * ty + g[k + n + 1] * tx * ty;
  };
  const out = new Float32Array(f.length);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, h = base[k];
    let sum = 0.5 * f[k], wsum = 0.5;
    for (const [x, y, w0] of [[i - fn, j + fe, 0.25], [i + fn, j - fe, 0.25], [i - fe, j - fn, 0.25]]) {
      const w = w0 * Math.exp(-(((at(base, x, y) - h) / 15) ** 2));
      sum += w * at(f, x, y); wsum += w;
    }
    out[k] = sum / wsum;
  }
  return out;
}
