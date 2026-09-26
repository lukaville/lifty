// Generate a FluidX3D large-eddy simulation case (cfd/fluidx3d/setup.cpp) for
// one site and one wind direction.
//
//   node cfd/lbm-case.mjs <slug|terrain.json> <windFromDeg> [--dx 10] [--spinup 1500] [--average 1800] [--sample 1.5]
//                         [--lx 8000] [--ly 4400] [--top 900] [--out cfd/runs/lbm]
// (--dx 5 --lx 7000 --ly 4000 --top 700: ~200 M cells, ~14 GB of VRAM)
//
// Writes <out>/<slug>/dNNN/case.bin (the lattice terrain and the app's sample
// points) and lifty.json (what lbm-extract.mjs needs to map the results back).
// The lattice is uniform (dx) in a frame where the wind blows along +x; the
// terrain is the same as the OpenFOAM cases' (lib/site.mjs), relaxed to a flat
// far field toward the edges. The domain is periodic both ways: 8 km along the
// wind, so the flow crossing the edge has had ~6 km of flat fetch to recover
// from the site. Times in seconds of flow; the solver averages over --average
// after --spinup. 64 reference columns over the flat upwind far field record
// the undisturbed wind the results are scaled by.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSite, flowFrame, taper, farField } from "./lib/site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [src, dirS] = positional;
if (!src || dirS === undefined) { console.error("usage: lbm-case.mjs <slug|terrain.json> <windFromDeg> [--dx 10]"); process.exit(2); }
const DIR = Number(dirS);
const DX = Number(opt("dx", 10));
const SPINUP = Number(opt("spinup", 1500)), AVERAGE = Number(opt("average", 1800)), SAMPLE = Number(opt("sample", 1.5));   // gusts stay correlated for 5–10 s: 1.5 s loses nothing
const OUT = opt("out", path.join(ROOT, "cfd/runs/lbm"));
const CORE = 1300, FLAT = 1900;          // real terrain within |X|,|Y| < CORE, flat beyond FLAT (as make-case)
const LX = Number(opt("lx", 8000)), LY = Number(opt("ly", 4400));   // periodic domain, m
const TOP = Number(opt("top", 900));     // lattice top above the highest ground, m
const U_LATTICE = 0.06;                  // lattice velocity of the 10 m/s reference: ~0.17 at the fastest speed-ups (Mach < 0.3)
const Z0 = 0.05;                         // inflow profile roughness (as the OpenFOAM inlet)
const TRIP = [-LX / 2 + 250, -LX / 2 + 850];   // roughness blocks tripping the flow into turbulence
const REF_X = -2200, REF_D = [10, 30, 80, 200];  // reference columns (flat far field) and their heights

const { slug, ground, cover } = loadSite(src);
const { fe, fn, toSite, toFlow } = flowFrame(DIR);
const FF0 = farField(ground, toSite, CORE);
// periodic along the wind: well downstream the far field ramps gently back to
// the upwind level so the ground matches across the seam
const RAMP = [FLAT + 300, LX / 2];
const FF = { ...FF0, at: (X) => {
  if (X <= RAMP[0]) return FF0.at(X);
  const t = Math.min(1, (X - RAMP[0]) / (RAMP[1] - RAMP[0])), sm = t * t * (3 - 2 * t);
  return FF0.hDown + (FF0.hUp - FF0.hDown) * sm;
} };

const NX = Math.round(LX / DX), NY = Math.round(LY / DX);
const surface = new Float32Array(NX * NY), z0s = new Float32Array(NX * NY), rough = new Uint8Array(NX * NY);
// deterministic pseudo-random block layout (2×2-cell blocks, 1–2 cells high, ~12% cover)
const hash = (i, j) => { let h = (i * 73856093) ^ (j * 19349663); h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
let hMax = -Infinity, hMin = Infinity;
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const X = -LX / 2 + (i + 0.5) * DX, Y = -LY / 2 + (j + 0.5) * DX;
  const t = taper(X, Y, CORE, FLAT);
  let g = FF.at(X), z0 = Z0;
  if (t > 0) {
    const [e, n] = toSite(X, Y), c = cover(e, n, DX / 2);
    g = t * (ground(e, n) + c.disp) + (1 - t) * g;
    z0 = Math.exp(t * Math.log(c.z0) + (1 - t) * Math.log(Z0));
  }
  surface[j * NX + i] = g; z0s[j * NX + i] = z0;
  hMax = Math.max(hMax, g); hMin = Math.min(hMin, g);
  if (X > TRIP[0] && X < TRIP[1]) { const r = hash(i >> 1, j >> 1); if (r < 0.12) rough[j * NX + i] = r < 0.05 ? 2 : 1; }
}
const zFloor = Math.floor(hMin / DX) * DX - DX;           // at least one solid layer under the lowest ground
const NZ = Math.ceil((hMax + TOP - zFloor) / DX);

// the app's grid and layers (must match public/js/physics.js)
const N = 128, W = 3200, cell = W / (N - 1), HALF = W / 2;
const agl = []; { let d = 6, dd = 8; while (d <= 480) { agl.push(d); d += dd; dd *= 1.12; } }
const base = new Float32Array(N * N);
const NREF = 64 * REF_D.length;
const pts = new Float32Array((N * N * agl.length + NREF) * 3);
for (let jj = 0; jj < N; jj++) for (let ii = 0; ii < N; ii++) {
  const e = -HALF + ii * cell, n = -HALF + jj * cell, g = jj * N + ii;
  const [X, Y] = toFlow(e, n);
  const t = taper(X, Y, CORE, FLAT);
  base[g] = t * (ground(e, n) + cover(e, n, DX / 2).disp) + (1 - t) * FF.at(X);
  for (let li = 0; li < agl.length; li++) {
    const p = 3 * (li * N * N + g);
    pts[p] = (X + LX / 2) / DX; pts[p + 1] = (Y + LY / 2) / DX; pts[p + 2] = (base[g] + agl[li] - zFloor) / DX;
  }
}

for (let r = 0; r < NREF; r++) {
  const d = REF_D[Math.floor(r / 64)], Y = -LY / 2 + ((r % 64) + 0.5) * (LY / 64), p = 3 * (N * N * agl.length + r);
  pts[p] = (REF_X + LX / 2) / DX; pts[p + 1] = (Y + LY / 2) / DX; pts[p + 2] = (FF.at(REF_X) + d - zFloor) / DX;
}

const dt = (DX * U_LATTICE) / 10;
// driving pressure gradient: balances the surface stress u*² of the reference
// log profile over the boundary layer depth (the lattice height above ground)
const uStar = (0.41 * 10) / Math.log((10 + Z0) / Z0);
const depth = zFloor + NZ * DX - FF.hUp;
const FX = ((uStar * uStar) / depth) * (dt * dt) / DX;
const steps = (s) => Math.max(1, Math.round(s / dt));
const header = Buffer.alloc(4 * 14);
[NX, NY, NZ].forEach((v, q) => header.writeUInt32LE(v, 4 * q));
[DX, zFloor, U_LATTICE, Z0, FF.hUp, FF.hDown, FX].forEach((v, q) => header.writeFloatLE(v, 12 + 4 * q));
[steps(SPINUP), steps(AVERAGE), steps(SAMPLE), N * N * agl.length + NREF].forEach((v, q) => header.writeUInt32LE(v, 40 + 4 * q));

const caseDir = path.join(OUT, slug, `d${String(Math.round(DIR)).padStart(3, "0")}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, "case.bin"), Buffer.concat([header, Buffer.from(surface.buffer), Buffer.from(z0s.buffer), Buffer.from(rough.buffer), Buffer.from(pts.buffer)]));
fs.writeFileSync(path.join(caseDir, "lifty.json"), JSON.stringify({ slug, dir: DIR, N, W, agl, base: Array.from(base, (v) => +v.toFixed(2)),
  lattice: [NX, NY, NZ], dx: DX, zFloor, dt, spinup: SPINUP, average: AVERAGE, sample: SAMPLE, uref: 10, zref: 10, z0: Z0, refD: REF_D, nRef: NREF }));
console.log(caseDir);
console.log(`  ${NX}×${NY}×${NZ} = ${((NX * NY * NZ) / 1e6).toFixed(1)} M cells at ${DX} m, dt ${dt.toFixed(3)} s, ` +
  `${steps(SPINUP) + steps(AVERAGE)} steps; far field ${FF.hUp.toFixed(0)} m upwind → ${FF.hDown.toFixed(0)} m downwind`);
