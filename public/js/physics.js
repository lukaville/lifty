// Airflow physics for a single site.
//
// LIFT — linear potential-flow (neutral, streaming flow) over real terrain:
//   Surface boundary condition:  w(x,y,0) = U · ∇h   (wind climbs windward slopes)
//   Each terrain wavelength decays vertically as exp(-|k|·d)  (Laplace / irrotational).
//   The field is solved in the spectral domain; the along-wind speed-up (the air
//   accelerating over the crest) comes out of the same inverse FFT for free.
//   Refinements that keep it close to real air:
//     · the surface the wind sees is the SEA SURFACE offshore, not the DEM seabed;
//     · lee slopes steep enough to separate are replaced by the separating shear
//       layer (a separation bubble), so the lee shows a wake, not potential-flow
//       sink hugging a cliff face;
//     · windward slopes are capped at the separation angle;
//     · heights are TERRAIN-FOLLOWING (height above local ground), as in WAsP-style
//       linear models, so the boundary condition holds on the real surface rather
//       than on a flat plane at mean terrain height;
//     · the wind has a logarithmic boundary-layer profile (wind gradient): slow
//       near the grass, stronger aloft. The hill perturbation is scaled by the
//       wind at the Jackson–Hunt middle-layer height, and the horizontal wind a
//       glider must penetrate grows with height all the way up.
//
// VEGETATION & BUILDINGS — from 1 m LiDAR + imagery (scripts/fetch-surface.mjs):
//   · at hill scale, woods and built-up areas lift the effective surface by their
//     zero-plane DISPLACEMENT height (≈0.7 × canopy height × cover) — a wood on a
//     crest makes the ridge effectively taller, as pilots know;
//   · at obstacle scale (8 m grid), each tree line, wood edge, hedge and building
//     sheds a turbulent wake: cavity and near wake at full strength to ~3H, then a
//     recovering wake that grows to ~2H high and fades out by ~10H downwind
//     (wind-break and building-wake studies).
//
// TURBULENCE / ROTOR — a diagnostic wake model: from every column we march upwind
//   looking for a crest where the lee slope is steep enough to separate (~18°).
//   Distances are measured in obstacle heights H (crest above the lowest lee
//   ground); the bubble length grows with lee steepness (≈3 H for a 26° lee,
//   ≈6.5 H for a cliff), followed by a ~4 H recovering wake. Empirical, from
//   published hill / step studies — not a solved separated flow.
//   Intensity grows with wind speed and obstacle height; steep lee faces add
//   their own turbulence. This mirrors the SHGC guide's "wind-shadow / rotor".

import { fft2d } from "./fft.js";

// Glider polars, as a parabola through min sink and full speed:
//   sink(V) = minSink + c·(V − vMinSink)²,   c set by (vMax, sinkAtVMax).
// To stay in the lift band a wing must fly at least as fast as the local wind
// (otherwise it is blown back over the hill), so in strong wind — and in the
// stronger wind aloft — the wing sinks faster than its minimum. Speeds in m/s.
export const WINGS = {
  "pg-school":  { label: "Paraglider — EN-A/school", minSink: 1.15, vMinSink: 8.9, trim: 10.0, vMax: 12.5, sinkAtVMax: 1.75 },
  "pg-typical": { label: "Paraglider — EN-B",        minSink: 1.10, vMinSink: 9.2, trim: 10.6, vMax: 14.2, sinkAtVMax: 1.95 },
  "pg-perf":    { label: "Paraglider — EN-C/D",      minSink: 1.00, vMinSink: 9.4, trim: 11.1, vMax: 15.8, sinkAtVMax: 2.10 },
  "hg":         { label: "Hang glider",              minSink: 0.85, vMinSink: 8.3, trim: 11.0, vMax: 22.0, sinkAtVMax: 3.00 },
};
export const DEFAULT_WING = "pg-typical";

// Sink rate (m/s, positive down) when the wing must fly at least `wind` m/s to
// hold its ground. Beyond full speed the wing is blown backwards, so the air is
// unusable: the sink rises steeply (4 m/s per m/s of excess wind) instead of
// jumping to infinity, which keeps the edge of the band a smooth surface
// (an infinite step between two layers draws staircases).
// Ridge soaring is flown as beats along the slope with a turn at each end; a
// 30–40° banked turn sinks 25–50% faster (∝ load factor^1.5) and takes ~15–20%
// of the time, so the average sink over a beat is ~8% above the straight-line polar.
export const BEAT_SINK_FACTOR = 1.08;

export function sinkRate(wing, wind) {
  if (wind > wing.vMax) return (wing.sinkAtVMax + 4 * (wind - wing.vMax)) * BEAT_SINK_FACTOR;
  const v = Math.max(wing.vMinSink, wind);
  const c = (wing.sinkAtVMax - wing.minSink) / (wing.vMax - wing.vMinSink) ** 2;
  return (wing.minSink + c * (v - wing.vMinSink) ** 2) * BEAT_SINK_FACTOR;
}

// Beyond roughly this angle the windward flow cannot follow the ground and rides
// over a separation bubble instead. Linear theory (w = U·∇h) blows up without
// this limit — a 61° DEM cell would otherwise produce w = 1.8·U.
const SEPARATION_ANGLE_DEG = 35;
// Lee slopes steeper than this separate (≈18° for rough 2-D ridges, Wood 1995).
const LEE_SEPARATION_DEG = 18;
// Lee rotor geometry, in obstacle heights H (crest above the lowest lee ground).
// This is an EMPIRICAL parameterisation, not a solved flow: separated flow needs
// turbulence-resolving CFD. How far the separation bubble reaches depends on how
// steep the lee is — anchored to published cases: no separation below ~18°,
// ~3 H for 2-D ridges with ~26° lee slopes, ~5–6 H for 35–45°, and ~6.5 H for a
// vertical cliff / backward-facing step. Beyond reattachment a weaker recovering
// wake lasts ~4 H more.
export const reattachH = (tanLee) => {
  const deg = (Math.atan(tanLee) * 180) / Math.PI;
  return deg <= 18 ? 0 : 6.5 * (1 - Math.exp(-(deg - 18) / 12));
};
export const ROTOR_RECOVERY_H = 4;
const WAKE_MAX_M = 1800;
// a lee drop this high (m) produces full-strength rotor; smaller banks less
const ROTOR_FULL_H = 50;
// Boundary layer: roughness of open downland / farmland, and the height the
// wind-speed slider refers to (standard 10 m forecast/anemometer wind).
const Z0 = 0.05;
const Z_REF = 10;
const ANEMOMETER_M = 2;
// Jackson–Hunt middle-layer height (~L/√ln(L/z0) for South Downs hill lengths).
// The hill's perturbation is driven by the wind at about this height: below it
// w follows the log profile toward zero at the grass, but above it w does NOT
// keep growing with the wind — in shear flow it is w itself that decays as
// e^{-|k|d}, not the streamline slope.
const H_MIDDLE = 80;
// Obstacles: zero-plane displacement ≈ 0.7 h for a closed canopy; wake length
// in obstacle heights, and how strongly each class sheds turbulence (a solid
// building more than a porous tree line, a tree line more than a low hedge).
const DISPLACEMENT = 0.7;
export const OBST_WAKE_H = 10;
const OBST_SEVERITY = [0, 0.55, 0.85, 1.0];   // open, bush, tree, building
const FINE_CELL = 8;
// Minimum terrain clearance for usable ridge lift (m above the effective surface).
export const MIN_CLEARANCE = 15;
// Lift is USABLE only where it beats the sink by a margin. net = 0 is break-even
// in perfectly smooth air; near a hill gusts, corrections and gust-induced losses
// cost height, so a band where you can merely hold 0–0.2 m/s is one you slowly
// sink out of. What pilots call "the lift band" is where they can gain height.
export const USABLE_CLIMB = 0.2;
export const ROTOR_UNUSABLE = 0.35;

export const windProfile = (d) => Math.log((Math.max(d, 0) + Z0) / Z0) / Math.log((Z_REF + Z0) / Z0);

export class SitePhysics {
  constructor(terrain, landcover = null) {
    const n = terrain.n;
    this.n = n;
    this.cell = terrain.cell;           // metres per grid step
    this.windowM = terrain.windowM;
    this.minH = terrain.minH;
    this.maxH = terrain.maxH;
    this.meanH = terrain.meanH;

    // decode heights (metres AMSL). `h` is the DEM (seabed offshore, used for
    // rendering); `hs` is the surface the air actually flows over — the sea
    // surface wherever the DEM is below sea level.
    const raw = atob(terrain.heights_b64);
    const h = new Float64Array(n * n);
    const hs = new Float64Array(n * n);
    let sMin = Infinity;
    for (let k = 0; k < n * n; k++) {
      const lo = raw.charCodeAt(k * 2), hi = raw.charCodeAt(k * 2 + 1);
      h[k] = terrain.offset + (lo | (hi << 8)) * terrain.scale;
      hs[k] = Math.max(0, h[k]);
      if (hs[k] < sMin) sMin = hs[k];
    }
    this.h = h;
    this.hs = hs;
    this.relief = terrain.maxH - sMin;
    this.ground = hs.slice();       // bare surface, before canopy displacement

    // high-resolution render grid (LiDAR DTM) for obstacle-scale work
    this.render = null;
    if (terrain.render) {
      const r = terrain.render, rr = atob(r.heights_b64), rn = r.n;
      const rh = new Float32Array(rn * rn);
      for (let k = 0; k < rn * rn; k++) {
        rh[k] = r.offset + (rr.charCodeAt(k * 2) | (rr.charCodeAt(k * 2 + 1) << 8)) * r.scale;
      }
      this.render = { n: rn, cell: this.windowM / (rn - 1), h: rh };
    }

    this.landcover = landcover;
    this.canopy = new Float64Array(n * n);
    if (landcover) this._applyLandcover(landcover);

    const g = this._gradient(hs);
    this.gx = g.gx;
    this.gy = g.gy;

    this._prepareSpectral();
    this._prepareLayers();
    this._wakeCache = new Map();
  }

  // Woods, hedges and buildings. `lc` = { n, cell, height[m], cls[0..3], cover[0..1] }
  // on a grid covering the same window (cell centres at −W/2 + (i+½)·cell).
  _applyLandcover(lc) {
    const n = this.n, half = this.windowM / 2;
    // hill scale: mean displacement height over each physics cell's footprint
    const r = Math.round(this.cell / lc.cell / 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (this.h[k] < 0) continue;                  // sea
        const ci = Math.floor((i * this.cell) / lc.cell), cj = Math.floor((j * this.cell) / lc.cell);
        let s = 0, c = 0;
        for (let dj = -r; dj < r; dj++) for (let di = -r; di < r; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= lc.n || jj >= lc.n) continue;
          const q = jj * lc.n + ii;
          s += DISPLACEMENT * lc.height[q] * lc.cover[q];
          c++;
        }
        this.canopy[k] = c ? s / c : 0;
        this.hs[k] += this.canopy[k];
      }
    }
    const g = this._gradient(this.hs);
    this.gx = g.gx;
    this.gy = g.gy;

    // obstacle scale: 8 m grid of tallest obstacle per cell, and bare ground
    const f = FINE_CELL / lc.cell, fn = lc.n / f;
    const oh = new Float32Array(fn * fn), oc = new Uint8Array(fn * fn), og = new Float32Array(fn * fn);
    for (let J = 0; J < fn; J++) {
      for (let I = 0; I < fn; I++) {
        let hm = 0, cm = 0;
        for (let dj = 0; dj < f; dj++) for (let di = 0; di < f; di++) {
          const q = (J * f + dj) * lc.n + I * f + di;
          if (lc.cls[q] && lc.height[q] > hm) { hm = lc.height[q]; cm = lc.cls[q]; }
        }
        const K = J * fn + I;
        oh[K] = hm; oc[K] = cm;
        og[K] = this.groundAt(-half + (I + 0.5) * FINE_CELL, -half + (J + 0.5) * FINE_CELL);
      }
    }
    this.fine = { n: fn, cell: FINE_CELL, h: oh, cls: oc, ground: og };
    this._fineCache = new Map();
  }

  // bare ground height (m AMSL, sea surface offshore) at (x east, y north)
  groundAt(x, y) {
    if (this.render) {
      const R = this.render;
      return Math.max(0, this._sampleGrid(R.h, R.n, R.cell, x, y));
    }
    return this._sample(this.ground, x, y);
  }

  // Obstacle wakes for a flow direction, on the 8 m grid. For every cell:
  // intensity (0..1, before wind-speed scaling) and top of the turbulent layer
  // (m AMSL). March upwind; any obstacle within OBST_WAKE_H heights casts a wake:
  //   · separation cavity immediately behind it (strongest, to ~1.2 H),
  //   · a wake that thickens to ~2 H by ~10 H and decays over ~15 H,
  //   · sheltered only if the ground here isn't higher than the obstacle top.
  // Canopy tops themselves carry mild roughness-sublayer turbulence.
  obstacleWakes(fe, fn) {
    if (!this.fine) return null;
    const key = Math.round(Math.atan2(fe, fn) * 180 / Math.PI);
    const hit = this._fineCache.get(key);
    if (hit) return hit;
    const F = this.fine, N = F.n, cell = F.cell;
    const intensity = new Float32Array(N * N), top = new Float32Array(N * N);
    let hMax = 0;
    for (const v of F.h) if (v > hMax) hMax = v;
    const steps = Math.ceil((OBST_WAKE_H * Math.min(hMax, 25)) / cell);
    // integer offsets of the upwind march (nearest cell), precomputed per direction
    const di = new Int32Array(steps + 1), dj = new Int32Array(steps + 1);
    for (let s = 1; s <= steps; s++) { di[s] = Math.round(-fe * s); dj[s] = Math.round(-fn * s); }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const K = j * N + i, g = F.ground[K];
        let best = 0, bestTop = 0;
        // canopy / roof top turbulence over the obstacle itself
        if (F.h[K] > 1) { best = 0.22 * OBST_SEVERITY[F.cls[K]] * Math.min(1, F.h[K] / 10); bestTop = g + F.h[K] * 1.6; }
        for (let s = 1; s <= steps; s++) {
          const ii = i + di[s], jj = j + dj[s];
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) break;
          const Q = jj * N + ii, H = F.h[Q];
          if (H < 1.2) continue;
          const x = (s * cell) / H;                   // distance downwind in obstacle heights
          if (x > OBST_WAKE_H) continue;
          const obTop = F.ground[Q] + H;
          if (g > obTop - 0.3 * H) continue;          // ground rises above it: no shelter
          // sheltered only at a real edge: the cell just downwind must be lower
          const Q1 = (jj - dj[1]) * N + ii - di[1];
          if (F.h[Q1] > 0.6 * H) continue;
          const sev = OBST_SEVERITY[F.cls[Q]] * Math.min(1, H / 12);
          // cavity + near wake at full strength to ~3 H, fading out by ~10 H
          // (the "turbulence to 5–10× the obstacle height" rule for sharp obstacles)
          const inten = sev * (x <= 3 ? 1 : Math.max(0, 1 - (x - 3) / (OBST_WAKE_H - 3)));
          if (inten > best) {
            best = inten;
            bestTop = obTop + H * Math.min(1, x / 10);
          }
        }
        intensity[K] = best;
        top[K] = bestTop;
      }
    }
    const out = { n: N, cell, intensity, top };
    this._fineCache.set(key, out);
    return out;
  }

  // central-difference gradient of a grid, m/m
  _gradient(f) {
    const n = this.n;
    const gx = new Float64Array(n * n), gy = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const iL = Math.max(0, i - 1), iR = Math.min(n - 1, i + 1);
        const jD = Math.max(0, j - 1), jU = Math.min(n - 1, j + 1);
        gx[k] = (f[j * n + iR] - f[j * n + iL]) / ((iR - iL) * this.cell);
        gy[k] = (f[jU * n + i] - f[jD * n + i]) / ((jU - jD) * this.cell);
      }
    }
    return { gx, gy };
  }

  _prepareSpectral() {
    const n = this.n;
    // Tukey taper to suppress FFT wrap-around at the domain edges.
    const taper = new Float64Array(n);
    const edge = Math.floor(n * 0.12);
    for (let i = 0; i < n; i++) {
      let w = 1;
      if (i < edge) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
      else if (i >= n - edge) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / edge);
      taper[i] = w;
    }
    this.taper = taper;

    // wavenumbers (rad/m); domain period L = n*cell
    const L = n * this.cell;
    const kAxis = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      const idx = p <= n / 2 ? p : p - n;
      kAxis[p] = (2 * Math.PI * idx) / L;
    }
    this.kx = new Float64Array(n * n);
    this.ky = new Float64Array(n * n);
    this.kmag = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        this.kx[k] = kAxis[i];
        this.ky[k] = kAxis[j];
        this.kmag[k] = Math.hypot(kAxis[i], kAxis[j]);
      }
    }
  }

  _prepareLayers() {
    const n = this.n;
    // Sample heights ABOVE LOCAL GROUND (terrain-following). Graded: the
    // soarable band is only ~50-150 m deep, so resolve it finely and let the
    // spacing coarsen higher up where only weak residual flow remains.
    const agl = [];
    let d = 6, dd = 8;
    while (d <= 480) { agl.push(d); d += dd; dd *= 1.12; }
    this.agl = agl;
    this.profile = agl.map((d) => windProfile(Math.min(d, H_MIDDLE)));   // perturbation scale
    this.meanWind = agl.map(windProfile);                                   // upwind wind speed
    // Jackson–Hunt inner layer: the hill's pressure field is imposed on the
    // slow air near the ground, so the FRACTIONAL speed change there is larger
    // than in the outer flow — ≈ (ln(hm/z0) / ln(z/z0))², about 2× at 10 m.
    // This is the well-measured near-surface crest speed-up (Askervein ΔS≈0.8
    // at 10 m) and, equally, the slow "dead" air at the windward foot.
    // Hunt–Leibovich–Richards: the amplification (U(hm)/U(z))² multiplies the
    // potential-flow SURFACE speed-up, giving the classic ≈2H/L near the ground.
    this.innerAmp = agl.map((d) => d >= H_MIDDLE ? 1
      : Math.min(2.2, (Math.log(H_MIDDLE / Z0) / Math.log(Math.max(d, 2) / Z0)) ** 2));

    // exp(-|k|·d) decay per level (wind-independent -> precompute once).
    // The k=0 (domain-mean) mode is the net updraught of air rising over the
    // whole window — e.g. up off the sea onto the Downs. On a periodic grid it
    // would never decay; in reality it fades once the height becomes comparable
    // with the window, so use the Poisson solution for a uniform square patch.
    const a = (this.windowM / 2) * (1 - 0.12);
    this.decay = agl.map((z) => {
      const dec = new Float64Array(n * n);
      for (let k = 0; k < n * n; k++) dec[k] = Math.exp(-this.kmag[k] * z);
      dec[0] = (2 / Math.PI) * Math.atan((a * a) / (z * Math.sqrt(2 * a * a + z * z)));
      return dec;
    });
  }

  // Separation envelope for a flow direction (unit fe,fn). For every column:
  // `top` = height of the separated shear layer above it (−Infinity if none),
  // `dist` = distance back to the separating crest. Direction-only, so cached.
  wakeEnvelope(fe, fn) {
    const key = Math.round(Math.atan2(fe, fn) * 180 / Math.PI);
    const hit = this._wakeCache.get(key);
    if (hit) return hit;
    const n = this.n, cell = this.cell, half = this.windowM / 2;
    const top = new Float32Array(n * n), dist = new Float32Array(n * n);
    // rotor: strongest lee-wake influence at each column, and its turbulent top
    const rotorI = new Float32Array(n * n), rotorTop = new Float32Array(n * n);
    const tanSep = Math.tan((LEE_SEPARATION_DEG * Math.PI) / 180);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -half + i * cell, y = -half + j * cell, g = this.hs[k];
        let wakeTop = -Infinity, sBest = 0, hPrev = g, gMin = g, steepest = 0;
        let bestI = 0, bestTop = g;
        for (let s = cell; s <= WAKE_MAX_M; s += cell) {
          const hUp = this._sample(this.hs, x - fe * s, y - fn * s);
          const seg = (hUp - hPrev) / cell;         // descent of the lee toward this column
          // steepness from the LiDAR ground at 12.5 m: the 25 m physics grid
          // smooths a 28° scarp to ~23°, which would halve the rotor
          const hMid = this.groundAt(x - fe * (s - cell / 2), y - fn * (s - cell / 2));
          const gUp = this.groundAt(x - fe * s, y - fn * s), gPrev = this.groundAt(x - fe * (s - cell), y - fn * (s - cell));
          const fine = Math.max(gUp - hMid, hMid - gPrev) / (cell / 2);
          if (Math.max(seg, fine) > steepest) steepest = Math.max(seg, fine);
          // the flow separates only where it is asked to descend a steep lee slope
          if (seg > tanSep) {
            const H = hUp - gMin;                   // drop from this crest to the lowest lee ground
            const xr = reattachH(steepest);         // bubble length in H, from the steepest lee slope
            if (H > 3 && xr > 0) {
              // separated shear layer: from the crest down to reattachment at xr·H
              const line = hUp - s * (H / (xr * H));
              if (line > wakeTop) { wakeTop = line; sBest = s; }
              const xh = s / H;
              const inten = this._rotorProfile(xh, xr) * Math.min(1, H / ROTOR_FULL_H) * Math.min(1, xr / 3);
              if (inten > bestI) {
                bestI = inten;
                bestTop = xh <= xr
                  ? Math.max(line, g) + 0.15 * H * Math.min(1, xh / 2)          // bubble + shear layer
                  : g + H * 0.35 * (1 - (xh - xr) / ROTOR_RECOVERY_H);         // thinning recovery wake
              }
            }
          }
          hPrev = hUp;
          if (hUp < gMin) gMin = hUp;
        }
        top[k] = wakeTop;
        dist[k] = sBest;
        rotorI[k] = bestI;
        rotorTop[k] = bestTop;
      }
    }
    const env = { top, dist, rotorI, rotorTop };
    this._wakeCache.set(key, env);
    return env;
  }

  // Rotor strength vs distance x behind the separating crest (in H), for a
  // bubble reattaching at xr: full through the core, easing toward reattachment,
  // then a recovering wake fading out over ROTOR_RECOVERY_H.
  _rotorProfile(x, xr) {
    if (x <= 0.6 * xr) return 1;
    if (x <= xr) return 1 - 0.4 * (x - 0.6 * xr) / (0.4 * xr);
    if (x <= xr + ROTOR_RECOVERY_H) return 0.6 * (1 - (x - xr) / ROTOR_RECOVERY_H);
    return 0;
  }

  // Ridge-lift field for horizontal wind (u,v) m/s (east, north), where |(u,v)|
  // is the 10 m wind upwind. Returns terrain-following layers:
  //   w[li][k]   vertical air velocity, m/s
  //   spd[li][k] local along-wind speed (incl. gradient + crest speed-up), m/s
  //   cross[li][k] cross-wind velocity (to the left of the flow), m/s
  //   base[k]    effective surface (ground, sea, or top of a separation bubble)
  //   agl[li]    height of layer li above `base`
  computeLift(u, v) {
    const n = this.n;
    const U = Math.hypot(u, v);
    const fe = U > 0 ? u / U : 0, fn = U > 0 ? v / U : 1;
    const env = this.wakeEnvelope(fe, fn);

    // the surface the outer flow follows: ground, with lee separation bubbles filled
    const base = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) base[k] = Math.max(this.hs[k], env.top[k]);
    const { gx, gy } = this._gradient(base);

    // Surface vertical velocity in PHYSICAL space, from the separation-limited
    // gradient: w0 = U · ∇h|clamped. Building it here rather than spectrally
    // (i·k·Ĥ) is what makes the clamp enforceable — it is a per-point
    // nonlinear operation with no spectral equivalent.
    const gmax = Math.tan((SEPARATION_ANGLE_DEG * Math.PI) / 180);
    const S0r = new Float64Array(n * n);
    const S0i = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        let ax = gx[k], ay = gy[k];
        const mag = Math.hypot(ax, ay);
        if (mag > gmax) { const s = gmax / mag; ax *= s; ay *= s; }
        S0r[k] = (u * ax + v * ay) * this.taper[i] * this.taper[j];
      }
    }
    fft2d(S0r, S0i, n, false);

    // Along-wind speed perturbation from the same potential: φ̂ = −Ŵ/|k|,
    // u' = ∂φ/∂x  →  Ŝ = −i·kf·Ŵ with kf = (k·f)/|k|. Both w and s are real
    // fields, so pack them into ONE inverse FFT as Ŵ + iŜ = (1 + kf)·Ŵ:
    // the real part comes back as w, the imaginary part as s.
    // (kf is zeroed on the Nyquist row/column, which has no odd partner.)
    const kf = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (k === 0 || i === n / 2 || j === n / 2) continue;
        kf[k] = (this.kx[k] * fe + this.ky[k] * fn) / this.kmag[k];
      }
    }

    const layers = [], spd = [], cross = [];
    let max = 0;
    const fr = new Float64Array(n * n);
    const fi = new Float64Array(n * n);
    for (let li = 0; li < this.agl.length; li++) {
      const dec = this.decay[li], p = this.profile[li], U0 = U * this.meanWind[li], A = this.innerAmp[li];
      for (let k = 0; k < n * n; k++) {
        const m = (1 + kf[k]) * dec[k];
        fr[k] = S0r[k] * m;
        fi[k] = S0i[k] * m;
      }
      fft2d(fr, fi, n, true);
      const w = new Float32Array(n * n), s = new Float32Array(n * n);
      for (let k = 0; k < n * n; k++) {
        // Air moves along streamlines at the LOCAL speed: w = u_local × slope.
        // Linear theory gives the streamline slope (w_lin / U) but multiplies it
        // by the undisturbed U. Using the local along-wind speed instead takes
        // lift away from the decelerated foot of the hill and concentrates it
        // toward the accelerated crest — the "compression zone". Checked against
        // exact 2-D potential flow: this closes most of linear theory's 20–35%
        // shortfall on the upper slope. Near the ground the speed change is
        // amplified by the inner layer (A).
        const frac = (A * fi[k]) / Math.max(U, 0.1);
        // bounded by the largest near-surface speed changes measured on real
        // hills (Askervein ≈ +80–100% at 10 m); linear theory overshoots at cliff lips
        const speedUp = Math.min(1.8, Math.max(0.3, 1 + frac));
        w[k] = fr[k] * p * speedUp;
        s[k] = Math.max(0, A > 1 ? U0 * speedUp : U0 + fi[k] * p);
        if (w[k] > max) max = w[k];
      }
      layers.push(w);
      spd.push(s);
    }

    // Cross-wind perturbation (air deflected around a hill rather than over it),
    // Ĉ = −i·kc·Ŵ with kc = (k·f⊥)/|k|. Two layers per inverse FFT:
    //   Ĉa + i·Ĉb = kc·(−i·Ŵa + Ŵb)  →  real part c_a, imaginary part c_b.
    const kc = new Float64Array(n * n);
    for (let k = 1; k < n * n; k++) kc[k] = kf[k] === 0 ? 0 : (this.kx[k] * -fn + this.ky[k] * fe) / this.kmag[k];
    for (let li = 0; li < this.agl.length; li += 2) {
      const da = this.decay[li], db = this.decay[Math.min(li + 1, this.agl.length - 1)];
      for (let k = 0; k < n * n; k++) {
        const r = S0r[k], m = S0i[k];
        fr[k] = kc[k] * (m * da[k] + r * db[k]);
        fi[k] = kc[k] * (-r * da[k] + m * db[k]);
      }
      fft2d(fr, fi, n, true);
      const ca = new Float32Array(n * n), cb = new Float32Array(n * n);
      const pa = this.profile[li], pb = this.profile[Math.min(li + 1, this.agl.length - 1)];
      for (let k = 0; k < n * n; k++) { ca[k] = fr[k] * pa; cb[k] = fi[k] * pb; }
      cross.push(ca);
      if (li + 1 < this.agl.length) cross.push(cb);
    }
    return { layers, spd, cross, base, agl: this.agl, max, U, fe, fn };
  }

  // Net climb a wing would see in each sample: updraught minus the wing's sink
  // at the airspeed it needs to hold position against the local wind. −Infinity
  // where the wind exceeds the wing's top speed (blown back).
  // Air closer than MIN_CLEARANCE to the surface doesn't count: a wing on a beat
  // needs about a span plus margin from the slope, trees or roofs to turn safely,
  // so the thin film of lift hugging the lower slope is not a usable band.
  // Air inside a rotor / separation bubble (turb.intensity ≥ ROTOR_UNUSABLE, below
  // its turbulent top) isn't usable either, whatever its mean updraught.
  netClimb(field, wing, margin = USABLE_CLIMB, turb = null) {
    const out = field.layers.map((w, li) => {
      const s = field.spd[li], net = new Float32Array(w.length);
      if (field.agl[li] < MIN_CLEARANCE) return net.fill(-Infinity);
      // stored relative to the usable-climb margin: > 0 means usable lift
      for (let k = 0; k < w.length; k++) {
        net[k] = w[k] - sinkRate(wing, s[k]) - margin;
        if (turb && turb.intensity[k] >= ROTOR_UNUSABLE && field.base[k] + field.agl[li] < turb.top[k]) net[k] = -Infinity;
      }
      return net;
    });
    out.margin = margin;
    return out;
  }

  // What a pilot actually cares about, near take-off: the best net climb, and
  // the realistic ceiling — the altitude above which the air no longer rises
  // fast enough to hold that wing up (or the wind aloft is too strong to stay).
  bandStats(field, wing, net = this.netClimb(field, wing), radius = 1200) {
    // (pass a netClimb that includes turbulence to exclude rotor air)
    const n = this.n, cell = this.cell, half = this.windowM / 2;
    let bestClimb = -Infinity, ceiling = null, bestAlt = null;
    const r2 = radius * radius;
    // the wind in the air a pilot soars in: rising faster than the wing's
    // best sink (whether or not the wing can hold position there), clear of the
    // surface and of rotor. Penetration is judged against this, not the wind
    // right above the crest, where the speed-up is strongest.
    const rising = wing.minSink * BEAT_SINK_FACTOR + (net.margin ?? USABLE_CLIMB), bandWind = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -half + i * cell, y = -half + j * cell;
        if (x * x + y * y > r2) continue;
        const k = j * n + i, b = field.base[k];
        for (let li = 0; li < net.length; li++) {
          const c = net[li][k];
          if (Number.isFinite(c) && field.layers[li][k] > rising) bandWind.push(field.spd[li][k]);
          if (!(c > 0)) continue;
          const alt = b + field.agl[li];
          if (c > bestClimb) { bestClimb = c; bestAlt = alt; }
          // interpolate to where the climb falls to zero before the next level
          let top = alt;
          if (li + 1 < net.length) {
            const c2 = net[li + 1][k];
            const f = c2 > 0 ? 1 : (Number.isFinite(c2) ? c / (c - c2) : 0);
            top = alt + f * (field.agl[li + 1] - field.agl[li]);
          }
          if (ceiling === null || top > ceiling) ceiling = top;
        }
      }
    }
    const takeoff = this._sample(this.h, 0, 0);
    return {
      maxClimb: bestClimb + (net.margin ?? USABLE_CLIMB),   // m/s net climb (vario)
      bestAlt,                                              // m amsl of best climb
      ceiling,                                              // m amsl, null = unsoarable
      ceilingAboveTakeoff: ceiling === null ? null : ceiling - takeoff,
      takeoff,
      soarable: ceiling !== null && bestClimb > 0,
      // what a pilot's hand-held anemometer reads on launch (~2 m); the site
      // strength bands come from readings like these
      windTakeoff: this.surfaceWind(field, 0, 0),           // m/s
      windAloft: this.windAt(field, 0, 0, 60),              // m/s, 60 m above take-off
      // median wind in the rising air (null if nothing rises fast enough)
      windBand: bandWind.length ? bandWind.sort((a, b) => a - b)[bandWind.length >> 1] : null,
    };
  }

  // Wind a hand-held anemometer (~2 m) reads at (x,y). A simulated field
  // (field.surfaceRef set) doesn't resolve the lowest metres: its first cells
  // sit inside the wall model, so the reading comes from its first well-resolved
  // height, brought down to 2 m with the log law.
  surfaceWind(field, x, y) {
    const d0 = field.surfaceRef;
    if (!d0) return this.windAt(field, x, y, ANEMOMETER_M);
    return this.windAt(field, x, y, d0) * windProfile(ANEMOMETER_M) / windProfile(d0);
  }

  // local wind speed at height d above the surface at (x,y)
  windAt(field, x, y, d) {
    const a = field.agl;
    // below the lowest layer the wind falls off with the log law toward the grass
    if (d < a[0]) return this.windAt(field, x, y, a[0]) * windProfile(d) / windProfile(a[0]);
    let li = 0;
    while (li < a.length - 2 && a[li + 1] < d) li++;
    const t = Math.max(0, Math.min(1, (d - a[li]) / (a[li + 1] - a[li])));
    return this._sample(field.spd[li], x, y) * (1 - t) + this._sample(field.spd[li + 1], x, y) * t;
  }

  // bilinear sample of any n×n point grid spanning the window
  _sampleGrid(f, n, cell, x, y) {
    const half = this.windowM / 2;
    const fi = (x + half) / cell, fj = (y + half) / cell;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(n - 2, Math.floor(fj)));
    const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
    const k = j0 * n + i0;
    return f[k] * (1 - tx) * (1 - ty) + f[k + 1] * tx * (1 - ty) + f[k + n] * (1 - tx) * ty + f[k + n + 1] * tx * ty;
  }

  // bilinear sample of a grid; x east, y north, both in metres centred on site
  _sample(f, x, y) {
    const n = this.n, half = this.windowM / 2;
    const fi = (x + half) / this.cell;
    const fj = (y + half) / this.cell;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(n - 2, Math.floor(fj)));
    const tx = Math.max(0, Math.min(1, fi - i0));
    const ty = Math.max(0, Math.min(1, fj - j0));
    const a = f[j0 * n + i0], b = f[j0 * n + i0 + 1];
    const c = f[(j0 + 1) * n + i0], d = f[(j0 + 1) * n + i0 + 1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  _sampleH(x, y) { return this._sample(this.h, x, y); }

  // Lee turbulence / rotor field. Returns per-column { intensity:[0..1], top:[m AMSL] }.
  // fe,fn = unit flow direction (east,north); speed = 10 m wind in m/s.
  computeTurbulence(fe, fn, speed) {
    const n = this.n;
    const intensity = new Float32Array(n * n);
    const top = new Float32Array(n * n);
    // turbulence intensity scales with the wind; below ~3 mph nothing separates
    const speedFac = Math.min(1.4, Math.max(0, (speed - 1.5) / 6));
    if (speedFac <= 0) return { intensity, top };
    const env = this.wakeEnvelope(fe, fn);

    for (let k = 0; k < n * n; k++) {
      const hc = this.hs[k];
      const wakeInt = env.rotorI[k];
      // turbulence on the lee face itself: none on gentle slopes where the flow
      // stays attached, rising from ~15° (incipient separation) to full at ~30°
      const leeSlope = -(fe * this.gx[k] + fn * this.gy[k]); // +ve = going downhill
      const leeInt = Math.min(1, Math.max(0, (leeSlope - 0.27) / 0.31));

      intensity[k] = Math.min(1, Math.max(wakeInt, leeInt * 0.85) * speedFac);
      top[k] = wakeInt >= leeInt * 0.85
        ? Math.max(hc + 5, env.rotorTop[k])
        : hc + this.relief * 0.18 * leeInt + 20;
      // the turbulent zone always covers the separation bubble itself
      if (intensity[k] > 0 && env.top[k] > hc) top[k] = Math.max(top[k], env.top[k] + 5);
    }
    return { intensity, top };
  }
}
