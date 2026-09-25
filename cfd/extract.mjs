// Sample a solved case back onto the app's grid and terrain-following layers.
//   node cfd/extract.mjs cfd/runs/<slug>/dNNN [--out public/data/cfd]
// Writes <out>/<slug>/dNNN.bin: a JSON header line, then Int16 arrays (×1/1000)
// for each app layer: w, s (along-wind speed; negative = reversed flow, i.e.
// rotor), c (cross-wind), t (turbulent velocity scale √(2k/3)). All velocities
// are normalised by the inlet reference wind (10 m/s at 10 m). Also writes the
// CFD ground (terrain + canopy displacement) the layers are measured from.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const caseDir = path.resolve(args.find((a) => !a.startsWith("--")));
const outRoot = (() => { const i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : path.join(ROOT, "public/data/cfd"); })();
const meta = JSON.parse(fs.readFileSync(path.join(caseDir, "lifty.json"), "utf8"));
const { NX, NY, NZ, L, ZTOP, sigma, surf, fe, fn, UREF } = meta;
// column-centre coordinates (the mesh may be graded)
const XS = meta.XS || Array.from({ length: NX + 1 }, (_, i) => -L / 2 + i * meta.dx);
const YS = meta.YS || Array.from({ length: NY + 1 }, (_, j) => -L / 2 + j * meta.dy);
const XC = XS.slice(0, -1).map((v, i) => (v + XS[i + 1]) / 2), YC = YS.slice(0, -1).map((v, j) => (v + YS[j + 1]) / 2);
// fractional index of coordinate v in increasing centres c
function frac(c, v) {
  if (v <= c[0]) return 0;
  if (v >= c[c.length - 1]) return c.length - 1;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= v) lo = m; else hi = m; }
  return lo + (v - c[lo]) / (c[hi] - c[lo]);
}

// latest time directory
const times = fs.readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== "0").sort((a, b) => a - b);
if (!times.length) throw new Error("no solution time directories — run cfd/run.sh first");
const tdir = path.join(caseDir, times[times.length - 1]);

function readField(name, comps) {
  const txt = fs.readFileSync(path.join(tdir, name), "utf8");
  const m = txt.match(/internalField\s+nonuniform\s+List<\w+>\s*(\d+)\s*\(/);
  if (!m) throw new Error(`${name}: expected a nonuniform internalField`);
  const n = Number(m[1]), out = new Float32Array(n * comps);
  const body = txt.slice(m.index + m[0].length);
  const nums = body.slice(0, body.indexOf("\n)")).match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (nums.length < n * comps) throw new Error(`${name}: short field`);
  for (let q = 0; q < n * comps; q++) out[q] = Number(nums[q]);
  return out;
}
const U = readField("U", 3), K = readField("k", 1);

// column grounds and cell-centre heights above them
const sAt = (i, j) => surf[j * (NX + 1) + i];
const colG = new Float64Array(NX * NY);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) colG[j * NX + i] = (sAt(i, j) + sAt(i + 1, j) + sAt(i, j + 1) + sAt(i + 1, j + 1)) / 4;
const cellD = (col, k) => (ZTOP - colG[col]) * (sigma[k] + sigma[k + 1]) / 2;   // centre height above ground
const C = (i, j, k) => i + NX * (j + NY * k);

// value of a cell quantity at height d above the ground of column (i, j)
function columnAt(get, i, j, d) {
  const col = j * NX + i;
  if (d <= cellD(col, 0)) return get(C(i, j, 0));
  for (let k = 0; k < NZ - 1; k++) {
    const d0 = cellD(col, k), d1 = cellD(col, k + 1);
    if (d <= d1) { const t = (d - d0) / (d1 - d0); return get(C(i, j, k)) * (1 - t) + get(C(i, j, k + 1)) * t; }
  }
  return get(C(i, j, NZ - 1));
}

// the app's grid and layers (must match public/js/physics.js)
const N = 128, W = 3200, cell = W / (N - 1), HALF = W / 2;
const agl = []; { let d = 6, dd = 8; while (d <= 480) { agl.push(d); d += dd; dd *= 1.12; } }
const flow = [fe, fn], left = [-fn, fe];
const fields = { w: [], s: [], c: [], t: [] };
const base = new Float32Array(N * N);
for (const key in fields) for (let li = 0; li < agl.length; li++) fields[key].push(new Int16Array(N * N));
const q16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 1000)));
for (let jj = 0; jj < N; jj++) for (let ii = 0; ii < N; ii++) {
  const e = -HALF + ii * cell, n = -HALF + jj * cell, g = jj * N + ii;
  const X = e * flow[0] + n * flow[1], Y = e * left[0] + n * left[1];
  const fi = frac(XC, X), fj = frac(YC, Y);
  const i0 = Math.max(0, Math.min(NX - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(NY - 2, Math.floor(fj)));
  const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
  const wts = [[i0, j0, (1 - tx) * (1 - ty)], [i0 + 1, j0, tx * (1 - ty)], [i0, j0 + 1, (1 - tx) * ty], [i0 + 1, j0 + 1, tx * ty]];
  base[g] = wts.reduce((a, [i, j, w]) => a + w * colG[j * NX + i], 0);
  for (let li = 0; li < agl.length; li++) {
    let ux = 0, uy = 0, uz = 0, kk = 0;
    for (const [i, j, w] of wts) {
      ux += w * columnAt((c) => U[3 * c], i, j, agl[li]);
      uy += w * columnAt((c) => U[3 * c + 1], i, j, agl[li]);
      uz += w * columnAt((c) => U[3 * c + 2], i, j, agl[li]);
      kk += w * columnAt((c) => K[c], i, j, agl[li]);
    }
    // the rotated frame's x is the flow direction, y its left: s = ux, c = uy
    fields.w[li][g] = q16(uz / UREF);
    fields.s[li][g] = q16(ux / UREF);
    fields.c[li][g] = q16(uy / UREF);
    fields.t[li][g] = q16(Math.sqrt((2 * Math.max(kk, 0)) / 3) / UREF);
  }
}

const outDir = path.join(outRoot, meta.slug);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, path.basename(caseDir) + ".bin");
const header = { format: "lifty-cfd-1", slug: meta.slug, dir: meta.dir, n: N, windowM: W, agl, fields: ["w", "s", "c", "t"],
  scale: 0.001, uref: UREF, zref: meta.ZREF, solver: "OpenFOAM v2512 simpleFoam, k-omega SST, neutral ABL",
  mesh: `${NX}x${NY}x${NZ}, ${meta.dx} m over the site`, iterations: Number(times[times.length - 1]) };
const parts = [Buffer.from(JSON.stringify(header) + "\n"), Buffer.from(base.buffer)];
for (const key of header.fields) for (const a of fields[key]) parts.push(Buffer.from(a.buffer));
fs.writeFileSync(file, Buffer.concat(parts));
console.log(`${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, iteration ${header.iterations})`);
