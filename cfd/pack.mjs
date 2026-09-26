// Pack extracted CFD fields (extract.mjs output, "lifty-cfd-1") into the
// compact files the app loads ("lifty-cfd-2"), and rewrite index.json.
//   node cfd/pack.mjs <extract dir, e.g. cfd/runs/_lbm> [--out public/data/les] [--calibrate cfd/runs/_bins]
//
// lifty-cfd-2 is one gzip stream (the browser inflates it natively with
// DecompressionStream) containing:
//   a JSON header line (as lifty-cfd-1, with `fields`, `scales` and baseScale
//   updated);
//   base: Int16, metres × 4;
//   for each field, for each layer: Int16 in units of that field's scale × U_ref,
//   stored as the difference from the layer below, split into a low-byte plane
//   and a high-byte plane. Neighbouring layers are similar, so the planes
//   compress well.
// Steps (× the 10 m wind; × 6.3 for m/s at 14 mph) sit just below the noise of
// a 30-minute LES average, which is what dominates the file size: vertical wind
// 0.01 (0.06 m/s at 14 mph), along-wind 0.015, cross-wind 0.02, turbulence 0.01,
// reversed fraction 0.02. The vertical gust field (g) isn't used by the app and
// is dropped. About 0.5 MB per direction.
//
// --calibrate <OpenFOAM extract dir>: scale each LES case's velocities (w, s,
// c, t) by one factor so its approach wind matches the OpenFOAM case for the
// same site and direction: the along-wind speed at 50–180 m over the upwind
// edge of the window, before the flow meets the site. At 10 m cells the LES
// terrain is a staircase whose steps act as extra roughness: the boundary layer
// comes out too slow near the ground and ~10–16% too fast at soaring height
// for a given 10 m wind, while OpenFOAM's terrain-following mesh follows the
// log law. The pattern (lift, separation, gusts) stays the LES's own. Every
// case must have its OpenFOAM counterpart, or packing stops.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const src = args[0];
const out = (() => { const i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : path.join(ROOT, "public/data/les"); })();
const SCALES = { w: 0.01, s: 0.015, c: 0.02, t: 0.01, r: 0.02 }, BASE_SCALE = 0.25;

export function readV1(file) {
  const buf = fs.readFileSync(file), nl = buf.indexOf(10);
  const h = JSON.parse(buf.subarray(0, nl).toString());
  let off = nl + 1;
  const take = (T, n) => { const a = new T(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * T.BYTES_PER_ELEMENT)); off += n * T.BYTES_PER_ELEMENT; return a; };
  const NN = h.n * h.n, base = take(Float32Array, NN), f = {};
  for (const key of h.fields) f[key] = h.agl.map(() => take(Int16Array, NN));
  return { h, base, f };
}

function pack({ h, base, f }) {
  const NN = h.n * h.n, fields = h.fields.filter((key) => SCALES[key]);
  const scales = Object.fromEntries(fields.map((key) => [key, SCALES[key]]));
  const header = { ...h, format: "lifty-cfd-2", fields, scales, baseScale: BASE_SCALE };
  delete header.scale;
  const parts = [Buffer.from(JSON.stringify(header) + "\n"), Buffer.from(Int16Array.from(base, (v) => Math.round(v / BASE_SCALE)).buffer)];
  for (const key of fields) {
    const k = h.scale / scales[key];
    let prev = new Int16Array(NN);
    for (const layer of f[key]) {
      const q = Int16Array.from(layer, (v) => Math.round(v * k));
      const lo = Buffer.alloc(NN), hi = Buffer.alloc(NN);
      for (let g = 0; g < NN; g++) { const d = q[g] - prev[g]; lo[g] = d & 255; hi[g] = (d >> 8) & 255; }
      parts.push(lo, hi);
      prev = q;
    }
  }
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

const calIdx = args.indexOf("--calibrate"), calDir = calIdx >= 0 ? args[calIdx + 1] : null;
const CAL_BAND = [50, 180], CAL_EDGE = 1200;       // heights (m) and distance upwind of the take-off (m)
// ratio of OpenFOAM to LES along-wind speed over the approach
function calibration(les, rans) {
  const { n, windowM, agl } = les.h, cell = windowM / (n - 1), b = (les.h.dir * Math.PI) / 180, ue = Math.sin(b), un = Math.cos(b);
  if (rans.h.n !== n || rans.h.agl.length !== agl.length) throw new Error("LES and OpenFOAM grids differ");
  let sl = 0, so = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -windowM / 2 + i * cell, y = -windowM / 2 + j * cell;
    if (x * ue + y * un < CAL_EDGE) continue;          // only the upwind edge of the window
    for (let li = 0; li < agl.length; li++) {
      if (agl[li] < CAL_BAND[0] || agl[li] > CAL_BAND[1]) continue;
      sl += les.f.s[li][j * n + i]; so += rans.f.s[li][j * n + i];
    }
  }
  return (so * rans.h.scale) / (sl * les.h.scale);
}
function scaleVelocities(d, k) {
  for (const key of ["w", "s", "c", "t"]) if (d.f[key]) d.f[key] = d.f[key].map((a) => Int16Array.from(a, (v) => Math.max(-32767, Math.min(32767, Math.round(v * k)))));
  d.h.calibration = { factor: +k.toFixed(4), against: "OpenFOAM k-omega SST", band: CAL_BAND, upwindOf: CAL_EDGE };
  return d;
}

let n = 0, bytes = 0;
const factors = [];
for (const slug of fs.readdirSync(src).sort()) {
  const dir = path.join(src, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  fs.mkdirSync(path.join(out, slug), { recursive: true });
  for (const f of fs.readdirSync(dir).filter((x) => /^d\d{3}\.bin$/.test(x))) {
    let d = readV1(path.join(dir, f));
    if (calDir) {
      const rf = path.join(calDir, slug, f);
      if (!fs.existsSync(rf)) throw new Error(`no OpenFOAM case to calibrate ${slug}/${f} against (${rf})`);
      const k = calibration(d, readV1(rf));
      d = scaleVelocities(d, k); factors.push([`${slug}/${f}`, k]);
    }
    const packed = pack(d);
    fs.writeFileSync(path.join(out, slug, f), packed);
    n++; bytes += packed.length;
  }
}
console.log(`${n} files, ${(bytes / 1e6).toFixed(1)} MB → ${path.relative(ROOT, out)}`);
if (factors.length) {
  const ks = factors.map(([, k]) => k).sort((a, b) => a - b);
  console.log(`calibrated against OpenFOAM: factor median ${ks[ks.length >> 1].toFixed(3)}, range ${ks[0].toFixed(3)}–${ks[ks.length - 1].toFixed(3)}`);
}
execFileSync(process.execPath, [path.join(ROOT, "cfd/index.mjs"), out], { stdio: "inherit" });
