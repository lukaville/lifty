// Convert a finished FluidX3D case (lbm-case.mjs → fluidx3d/setup.cpp) into the
// app's full-precision format (lifty-cfd-1, as extract.mjs writes for OpenFOAM).
//   node cfd/lbm-extract.mjs cfd/runs/lbm/<slug>/dNNN [--out cfd/runs/_lbm]
// Fields, all ÷ the 10 m/s reference wind unless noted:
//   w, s, c  mean vertical / along-wind / cross-wind velocity (s < 0: reversed);
//   t        resolved turbulent velocity √((σu² + σv² + σw²)/3);
//   g        vertical gust σw;
//   r        fraction of the time the flow is reversed (0..1, not scaled by the wind).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const caseDir = path.resolve(args.find((a) => !a.startsWith("--")));
const outRoot = (() => { const i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : path.join(ROOT, "cfd/runs/_lbm"); })();
const meta = JSON.parse(fs.readFileSync(path.join(caseDir, "lifty.json"), "utf8"));
const buf = fs.readFileSync(path.join(caseDir, "case.bin.stats"));
const st = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const { N, agl } = meta, NN = N * N, nRef = meta.nRef || 0;
if (st.length !== (NN * agl.length + nRef) * 7) throw new Error(`stats: expected ${(NN * agl.length + nRef) * 7} values, got ${st.length}`);
// the undisturbed wind over the flat upwind far field: results are scaled by
// its 10 m speed, so they are fractions of the 10 m wind upwind like the RANS ones
const ref = (meta.refD || []).map((d, q) => {
  let u = 0, v = 0;
  for (let r = 0; r < 64; r++) { const p = 7 * (NN * agl.length + 64 * q + r); u += st[p]; v += st[p + 3] + st[p + 4] + st[p + 5]; }
  return { d, u: u / 64, t: Math.sqrt(v / 64 / 3) };
});
const uref = ref.length ? ref[0].u : meta.uref;
// an averaged LES always has turbulence; none means the samples saw a frozen field
if (ref.length && ref.every((r) => r.t / uref < 0.02)) throw new Error("no resolved turbulence at the reference columns: the sampled field did not change");
for (const r of ref) console.log(`  reference ${String(r.d).padStart(3)} m: ${(r.u / uref).toFixed(2)} × U10 (log law ${(Math.log((r.d + 0.05) / 0.05) / Math.log(10.05 / 0.05)).toFixed(2)}), turbulence ${(r.t / uref).toFixed(3)} × U10`);

const q16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 1000)));
const keys = ["w", "s", "c", "t", "g", "r"];
const fields = Object.fromEntries(keys.map((k) => [k, agl.map(() => new Int16Array(NN))]));
for (let li = 0; li < agl.length; li++) for (let g = 0; g < NN; g++) {
  const p = 7 * (li * NN + g);
  const [ux, uy, uz, vx, vy, vz, rev] = st.subarray(p, p + 7);
  // the lattice x is the flow direction, y its left: s = ux, c = uy
  fields.w[li][g] = q16(uz / uref);
  fields.s[li][g] = q16(ux / uref);
  fields.c[li][g] = q16(uy / uref);
  fields.t[li][g] = q16(Math.sqrt((vx + vy + vz) / 3) / uref);
  fields.g[li][g] = q16(Math.sqrt(vz) / uref);
  fields.r[li][g] = q16(rev);
}
const outDir = path.join(outRoot, meta.slug);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, path.basename(caseDir) + ".bin");
const header = { format: "lifty-cfd-1", slug: meta.slug, dir: meta.dir, n: N, windowM: meta.W, agl, fields: keys,
  scale: 0.001, uref, zref: meta.zref, solver: "FluidX3D lattice Boltzmann LES (D3Q19, Smagorinsky), neutral",
  mesh: `${meta.lattice.join("x")}, ${meta.dx} m`, iterations: 0, averagedS: meta.average };
const parts = [Buffer.from(JSON.stringify(header) + "\n"), Buffer.from(Float32Array.from(meta.base).buffer)];
for (const key of keys) for (const a of fields[key]) parts.push(Buffer.from(a.buffer));
fs.writeFileSync(file, Buffer.concat(parts));
console.log(`${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
