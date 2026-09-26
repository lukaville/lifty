// Site terrain and landcover for the flow solvers (make-case.mjs, lbm-case.mjs):
// the bare surface the air flows over, and the canopy displacement and surface
// roughness from the LiDAR landcover.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { decodePNG } = await import(path.join(ROOT, "scripts/lib/png.mjs"));
const { decodeLandcover } = await import(path.join(ROOT, "public/js/landcover.js"));

export const W = 3200, HALF = W / 2;
const clampI = (v, n) => Math.max(0, Math.min(n - 1, v));

// src: a site slug, or a terrain JSON file (e.g. cfd/runs/synthetic/*.json,
// with an optional <name>.landcover.png next to it)
export function loadSite(src) {
  let terrain, lc = null, slug, lcFile;
  if (src.endsWith(".json")) {
    terrain = JSON.parse(fs.readFileSync(src, "utf8"));
    slug = path.basename(src, ".json");
    lcFile = src.replace(/\.json$/, ".landcover.png");
  } else {
    slug = src;
    terrain = JSON.parse(fs.readFileSync(path.join(ROOT, `public/data/terrain/${slug}.json`), "utf8"));
    lcFile = path.join(ROOT, `public/data/landcover/${slug}.png`);
  }
  if (fs.existsSync(lcFile)) { const png = decodePNG(fs.readFileSync(lcFile)); lc = decodeLandcover(png.data, png.width, W, png.channels); }
  const R = terrain.render || terrain;
  const RN = R.n, RC = W / (RN - 1);
  const rh = (() => {
    const raw = Buffer.from(R.heights_b64, "base64"), h = new Float32Array(RN * RN);
    for (let k = 0; k < RN * RN; k++) h[k] = R.offset + raw.readUInt16LE(2 * k) * R.scale;
    return h;
  })();
  // bare surface the air flows over: ground, or the sea surface offshore
  function ground(e, n) {
    const fi = (e + HALF) / RC, fj = (n + HALF) / RC;
    const i0 = clampI(Math.floor(fi), RN - 1), j0 = clampI(Math.floor(fj), RN - 1);
    const i1 = Math.min(RN - 1, i0 + 1), j1 = Math.min(RN - 1, j0 + 1);
    const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
    const g = (i, j) => Math.max(0, rh[j * RN + i]);
    return g(i0, j0) * (1 - tx) * (1 - ty) + g(i1, j0) * tx * (1 - ty) + g(i0, j1) * (1 - tx) * ty + g(i1, j1) * tx * ty;
  }
  // landcover at (e, n), averaged over a footprint of radius r (m)
  function cover(e, n, r) {
    if (!lc) return { disp: 0, z0: ground(e, n) <= 0.2 ? 0.0002 : 0.03 };
    const c = lc.cell, rr = Math.max(0, Math.round(r / c));
    const ci = Math.floor((e + HALF) / c), cj = Math.floor((n + HALF) / c);
    let disp = 0, lnz0 = 0, cnt = 0;
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const i = clampI(ci + di, lc.n), j = clampI(cj + dj, lc.n), q = j * lc.n + i;
      const cls = lc.cls[q], h = lc.height[q], cv = lc.cover[q];
      disp += 0.7 * h * cv;
      // roughness length per class (Wieringa-type values); sea is aerodynamically smooth
      const z0 = cls === 2 ? Math.min(2, Math.max(0.5, 0.1 * h)) : cls === 3 ? 0.5 : cls === 1 ? 0.1
        : ground(-HALF + (i + 0.5) * c, -HALF + (j + 0.5) * c) <= 0.2 ? 0.0002 : 0.03;
      lnz0 += Math.log(z0); cnt++;
    }
    return { disp: disp / cnt, z0: Math.exp(lnz0 / cnt) };   // log-average: how roughness combines
  }
  return { slug, terrain, lc, ground, cover };
}

// Frame rotated so the wind blows along +X (Y to its left), for wind FROM dir°:
// site coords e = X fe − Y fn, n = X fn + Y fe
export function flowFrame(dir) {
  const b = (dir * Math.PI) / 180, fe = -Math.sin(b), fn = -Math.cos(b);
  return { fe, fn, toSite: (X, Y) => [X * fe - Y * fn, X * fn + Y * fe], toFlow: (e, n) => [e * fe + n * fn, -e * fn + n * fe] };
}

// weight of the real terrain at (X, Y): 1 inside the core, 0 beyond flat, cosine between
export const taper = (X, Y, core, flat) => {
  const r = Math.max(Math.abs(X), Math.abs(Y));
  if (r <= core) return 1;
  if (r >= flat) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * (r - core)) / (flat - core));
};

// Far-field ground level: the mean ground along the upwind edge of the core
// (hUp: sea level for an onshore wind) blending smoothly to the downwind edge's
// (hDown), so no artificial ramp is created (e.g. out at sea at a coastal site).
export function farField(ground, toSite, core) {
  const edgeMean = (X) => { let sum = 0; for (let q = 0; q < 64; q++) { const [e, n] = toSite(X, -core + (2 * core * q) / 63); sum += ground(e, n); } return sum / 64; };
  const hUp = edgeMean(-core), hDown = edgeMean(core);
  const at = (X) => { const t = Math.max(0, Math.min(1, (X + core) / (2 * core))); const sm = t * t * (3 - 2 * t); return hUp + (hDown - hUp) * sm; };
  return { hUp, hDown, at };
}
