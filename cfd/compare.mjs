// Compare an extracted CFD field with the app's linear model and empirical
// rotor, along the wind through a point (default: take-off).
//   node cfd/compare.mjs <slug|terrain.json> <windFromDeg> [mph=14] [--bin file] [--at e,n]
// Prints an ASCII cross-section for each (digits = vertical air speed in
// 0.5 m/s steps, '-' sink, 'R' reversed flow / rotor, '#' ground) and a table
// of vertical speed at fixed heights along the section.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
const { SitePhysics } = await import(path.join(ROOT, "public/js/physics.js"));
const { decodeLandcover } = await import(path.join(ROOT, "public/js/landcover.js"));
const { decodePNG } = await import(path.join(ROOT, "scripts/lib/png.mjs"));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [slug, dirS, mphS = "14"] = pos;
const DIR = Number(dirS), MPH = Number(mphS), U = MPH * 0.44704;
const binFile = opt("bin", path.join(ROOT, `public/data/cfd/${slug}/d${String(Math.round(DIR)).padStart(3, "0")}.bin`));
const [E0, N0] = (opt("at", "0,0")).split(",").map(Number);

export function readCfd(file) {
  const buf = fs.readFileSync(file), nl = buf.indexOf(10);
  const h = JSON.parse(buf.subarray(0, nl).toString());
  let off = nl + 1;
  const take = (T, n) => { const a = new T(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * T.BYTES_PER_ELEMENT)); off += n * T.BYTES_PER_ELEMENT; return a; };
  const NN = h.n * h.n, base = take(Float32Array, NN), f = {};
  for (const key of h.fields) f[key] = h.agl.map(() => take(Int16Array, NN));
  return { h, base, f };
}

const cfd = readCfd(binFile);
// a site slug, or a terrain JSON file (e.g. cfd/runs/synthetic/*.json, no landcover)
const isFile = slug.endsWith(".json");
const t = JSON.parse(fs.readFileSync(isFile ? slug : path.join(ROOT, `public/data/terrain/${slug}.json`), "utf8"));
const lcFile = path.join(ROOT, `public/data/landcover/${slug}.png`);
const lc = !isFile && fs.existsSync(lcFile) ? (() => { const png = decodePNG(fs.readFileSync(lcFile)); return decodeLandcover(png.data, png.width, 3200, png.channels); })() : null;
const p = new SitePhysics(t, lc);
const b = (DIR * Math.PI) / 180, fe = -Math.sin(b), fn = -Math.cos(b);
const F = p.computeLift(fe * U, fn * U), T = p.computeTurbulence(fe, fn, U);

const scaleU = U;              // fields are velocity / (10 m reference wind): × the actual 10 m wind
const lin = (arr, x, y, d) => { const a = F.agl; let li = 0; while (li < a.length - 2 && a[li + 1] < d) li++; const tt = Math.max(0, Math.min(1, (d - a[li]) / (a[li + 1] - a[li]))); return p._sample(arr[li], x, y) * (1 - tt) + p._sample(arr[li + 1], x, y) * tt; };
const cfdAt = (key, x, y, d) => {
  const a = cfd.h.agl; let li = 0; while (li < a.length - 2 && a[li + 1] < d) li++;
  const tt = Math.max(0, Math.min(1, (d - a[li]) / (a[li + 1] - a[li])));
  return (p._sample(cfd.f[key][li], x, y) * (1 - tt) + p._sample(cfd.f[key][li + 1], x, y) * tt) * cfd.h.scale * scaleU;
};
const cell = (w, rev) => (rev ? "R" : w < -0.25 ? "-" : w < 0.25 ? "." : String(Math.min(9, Math.floor(w / 0.5))));

const xs = []; for (let s = -1100; s <= 700; s += 25) xs.push(s);
console.log(`${slug} wind from ${DIR}° at ${MPH} mph — left: OpenFOAM (${cfd.h.mesh}, ${cfd.h.iterations} it)   right: linear model + empirical rotor`);
for (let z = 420; z >= 0; z -= 14) {
  let a = String(z).padStart(4) + " ", c = "  ";
  for (const s of xs) {
    const x = E0 + fe * s, y = N0 + fn * s, g = p.groundAt(x, y);
    if (z < g) { a += "#"; c += "#"; continue; }
    const dC = z - p._sample(cfd.base, x, y), dL = z - p._sample(F.base, x, y);
    a += dC < 3 ? "#" : cell(cfdAt("w", x, y, dC), cfdAt("s", x, y, dC) < 0);
    const rot = p._sample(T.intensity, x, y) >= 0.35 && z < p._sample(T.top, x, y);
    c += dL < 0 ? "~" : cell(lin(F.layers, x, y, Math.max(dL, F.agl[0])), rot);
  }
  console.log(a + c);
}
console.log("\n   s(m)  ground |  w@30m CFD   lin |  w@80m CFD   lin | rev.flow CFD | turb.vel CFD");
for (let s = -900; s <= 600; s += 100) {
  const x = E0 + fe * s, y = N0 + fn * s;
  const row = [s, p.groundAt(x, y).toFixed(0), cfdAt("w", x, y, 30).toFixed(2), lin(F.layers, x, y, 30).toFixed(2),
    cfdAt("w", x, y, 80).toFixed(2), lin(F.layers, x, y, 80).toFixed(2), cfdAt("s", x, y, 10) < 0 ? "yes" : "", cfdAt("t", x, y, 20).toFixed(2)];
  console.log(`${String(row[0]).padStart(7)} ${row[1].padStart(7)} | ${row[2].padStart(10)} ${row[3].padStart(5)} | ${row[4].padStart(10)} ${row[5].padStart(5)} | ${row[6].padStart(12)} | ${row[7].padStart(12)}`);
}
