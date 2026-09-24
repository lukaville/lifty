// Helpers for physics tests: synthetic terrain in the same JSON format the app
// loads (so SitePhysics is exercised exactly as in production), plus loaders
// for the real site data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WINDOW = 3200;
export const MPH = 0.44704;

const { decodePNG } = await import(path.join(ROOT, "scripts/lib/png.mjs"));
const { decodeLandcover } = await import(path.join(ROOT, "public/js/landcover.js"));
export const physics = await import(path.join(ROOT, "public/js/physics.js"));

function encodeGrid(n, f) {
  const cell = WINDOW / (n - 1), h = new Float64Array(n * n);
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = f(-WINDOW / 2 + i * cell, -WINDOW / 2 + j * cell);
    h[j * n + i] = v; mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v;
  }
  const scale = Math.max(1e-6, mx - mn) / 65535;
  const b = Buffer.alloc(n * n * 2);
  h.forEach((v, k) => b.writeUInt16LE(Math.round((v - mn) / scale), 2 * k));
  return { n, cell, minH: mn, maxH: mx, meanH: sum / (n * n), offset: mn, scale, heights_b64: b.toString("base64") };
}

// Terrain JSON from a height function f(x east, y north) in metres
export function syntheticTerrain(f) {
  const g = encodeGrid(128, f), r = encodeGrid(512, f);
  return {
    n: 128, cell: g.cell, windowM: WINDOW, minH: g.minH, maxH: g.maxH, meanH: g.meanH,
    offset: g.offset, scale: g.scale, heights_b64: g.heights_b64,
    render: { n: 512, minH: r.minH, maxH: r.maxH, offset: r.offset, scale: r.scale, heights_b64: r.heights_b64 },
  };
}

// Landcover raster (4 m, 800²) from a function (x, y) -> [class, height, cover]
export function syntheticLandcover(f, n = 800) {
  const cell = WINDOW / n, height = new Float32Array(n * n), cls = new Uint8Array(n * n), cover = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [c, h, cv] = f(-WINDOW / 2 + (i + 0.5) * cell, -WINDOW / 2 + (j + 0.5) * cell);
    const k = j * n + i; cls[k] = c; height[k] = h; cover[k] = cv;
  }
  return { n, cell, height, cls, cover };
}

// Classic shapes. H height, a half-width; ridge runs north–south (wind from the west = +x flow).
export const shapes = {
  flat: () => 50,
  ridge: (H = 150, a = 300) => (x) => 20 + H * Math.exp(-(x * x) / (a * a)),
  dome: (H = 150, a = 400) => (x, y) => 20 + H * Math.exp(-(x * x + y * y) / (a * a)),
  // plateau at +H that drops to 0 across x = 0 with a lee face of the given angle
  // (a "downward escarpment" for wind blowing toward +x)
  escarpment: (H = 150, deg = 30) => (x) => {
    const run = H / Math.tan((deg * Math.PI) / 180);
    return x < -600 ? 20 + H : x > -600 + run ? 20 : 20 + H * (1 - (x + 600) / run);
  },
};

export function sitePhysics(slug, { landcover = true } = {}) {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, `public/data/terrain/${slug}.json`), "utf8"));
  let lc = null;
  if (landcover) {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, `public/data/landcover/${slug}.png`)));
    lc = decodeLandcover(png.data, png.width, WINDOW, png.channels);
  }
  return new physics.SitePhysics(t, lc);
}

export const sites = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/sites.json"), "utf8")).sites;

// wind from `deg` at `mph`: flow unit vector and (u, v)
export function wind(deg, mph) {
  const b = (deg * Math.PI) / 180, fe = -Math.sin(b), fn = -Math.cos(b), U = mph * MPH;
  return { fe, fn, U, u: fe * U, v: fn * U };
}
export const arcCentre = (s) => (s.windFrom[0] + ((s.windFrom[1] - s.windFrom[0] + 360) % 360) / 2) % 360;

// value of a terrain-following field at (x, y) and height d above the effective surface
export function fieldAt(p, F, layers, x, y, d) {
  const a = F.agl;
  let li = 0;
  while (li < a.length - 2 && a[li + 1] < d) li++;
  const t = Math.max(0, Math.min(1, (d - a[li]) / (a[li + 1] - a[li])));
  return p._sample(layers[li], x, y) * (1 - t) + p._sample(layers[li + 1], x, y) * t;
}
