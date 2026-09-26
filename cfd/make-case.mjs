// Generate an OpenFOAM case (steady RANS, k-ω SST, neutral atmospheric
// boundary layer) for one site and one wind direction.
//
//   node cfd/make-case.mjs <slug|terrain.json> <windFromDeg> [--dx 25] [--nz 30] [--iter 1500] [--out cfd/runs]
//
// The mesh is written directly (no snappyHexMesh): a structured, terrain-
// following hex grid in a frame rotated so the wind blows along +x.
//   · ground = terrain (sea surface offshore) raised by canopy / building
//     displacement (0.7 × height × cover), with the surface roughness z0 per
//     ground face from the landcover (grass, scrub, woods, buildings, sea);
//   · the site's 3.2 km window sits in the middle of a 4.4 km domain; the
//     terrain blends smoothly to a flat plane toward the domain edges, so the
//     inlet profile is undisturbed and the outlet is clean;
//   · cell heights grow geometrically from the ground to a flat top.
// Boundary conditions: Richards–Hoxey log-law inlet (U, k, ω) at Uref = 10 m/s
// at 10 m, rough-wall functions on the ground, slip top, symmetric sides,
// zero-pressure outlet. Results are normalised by Uref when extracted; in
// neutral flow over rough terrain they scale with wind speed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { loadSite, flowFrame, taper: taperAt, farField: farFieldOf } = await import("./lib/site.mjs");

// ------------------------------------------------------------------ options
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [src, dirS] = positional;
if (!src || dirS === undefined) { console.error("usage: make-case.mjs <slug|terrain.json> <windFromDeg> [--n 100] [--nz 30]"); process.exit(2); }
const DIR = Number(dirS);
const NZ = Number(opt("nz", 30));
const CORE_DX = Number(opt("dx", 25));             // horizontal cell size over the site window (m)
const GROW = 1.15;                                 // cell growth outside the window
const L = Number(opt("domain", 4400));            // domain side (m), centred on take-off
const CORE = 1300, FLAT = 1900;                    // terrain kept to |x|,|y| < CORE, flat beyond FLAT
const DZ1 = Number(opt("dz1", 4));                 // first cell height (m)
const TOP = Number(opt("top", 1500));              // domain top above the highest ground (m)
const UREF = 10, ZREF = 10, Z0_INLET = 0.05;
const OUT = opt("out", path.join(ROOT, "cfd/runs"));

// ------------------------------------------------------------------ terrain + landcover
const { slug, ground, cover } = loadSite(src);

// ------------------------------------------------------------------ rotated frame
// X along the flow, Y to its left; site coords e = X fe − Y fn, n = X fn + Y fe
const { fe, fn, toSite } = flowFrame(DIR);
const taper = (X, Y) => taperAt(X, Y, CORE, FLAT);

// horizontal node coordinates: uniform CORE_DX over the window (and a margin),
// growing geometrically toward the domain edges
function axis() {
  const inner = CORE + 100, nIn = Math.ceil((2 * inner) / CORE_DX), d0 = (2 * inner) / nIn;
  const nodes = []; for (let q = 0; q <= nIn; q++) nodes.push(-inner + q * d0);
  let x = inner, d = d0; const out = [];
  while (x < L / 2 - 1e-6) { d *= GROW; x = Math.min(L / 2, x + d); if (L / 2 - x < 0.5 * d) x = L / 2; out.push(x); }
  return [...out.map((v) => -v).reverse(), ...nodes, ...out];
}
const XS = axis(), YS = XS;
const NX = XS.length - 1, NY = YS.length - 1;
const dx = CORE_DX, dy = CORE_DX;
const surf = new Float64Array((NX + 1) * (NY + 1));
const colZ0 = new Float64Array(NX * NY);
// Outside the window the ground relaxes to a flat far field (see lib/site.mjs)
const FF = farFieldOf(ground, toSite, CORE);
const HUP = FF.hUp, HDOWN = FF.hDown, farField = FF.at;
const HREF = HUP;                                   // the inlet's ground level
for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
  const X = XS[i], Y = YS[j], [e, n] = toSite(X, Y);
  const t = taper(X, Y);
  const g = t > 0 ? ground(e, n) + cover(e, n, dx / 2).disp : 0;
  surf[j * (NX + 1) + i] = t * g + (1 - t) * farField(X);
}
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const X = (XS[i] + XS[i + 1]) / 2, Y = (YS[j] + YS[j + 1]) / 2, [e, n] = toSite(X, Y);
  const t = taper(X, Y);
  const z0 = t > 0 ? cover(e, n, dx / 2).z0 : Z0_INLET;
  colZ0[j * NX + i] = Math.exp(t * Math.log(z0) + (1 - t) * Math.log(Z0_INLET));
}
let hMax = -Infinity;
for (const v of surf) hMax = Math.max(hMax, v);
const ZTOP = hMax + TOP;

// vertical stretching: geometric growth from DZ1 so that NZ cells span the
// thinnest column (the highest ground); every column uses the same fractions
let ratio = 1.001;
{
  const H = ZTOP - hMax, f = (r) => DZ1 * (r ** NZ - 1) / (r - 1) - H;
  let lo = 1.0001, hi = 2;
  for (let it = 0; it < 200; it++) { const mid = (lo + hi) / 2; if (f(mid) > 0) hi = mid; else lo = mid; }
  ratio = (lo + hi) / 2;
}
const sigma = new Float64Array(NZ + 1);
{ let s = 0, dz = 1; for (let k = 0; k <= NZ; k++) { sigma[k] = s; s += dz; dz *= ratio; } for (let k = 0; k <= NZ; k++) sigma[k] /= sigma[NZ]; }

// ------------------------------------------------------------------ polyMesh
const caseDir = path.join(OUT, slug, `d${String(Math.round(DIR)).padStart(3, "0")}`);
const meshDir = path.join(caseDir, "constant/polyMesh");
fs.mkdirSync(meshDir, { recursive: true });
for (const d of ["0", "system"]) fs.mkdirSync(path.join(caseDir, d), { recursive: true });

const header = (cls, obj, note = "") => `FoamFile\n{\n    format      ascii;\n    class       ${cls};\n${note ? `    note        "${note}";\n` : ""}    location    "constant/polyMesh";\n    object      ${obj};\n}\n\n`;
const P = (i, j, k) => i + (NX + 1) * (j + (NY + 1) * k);
const C = (i, j, k) => i + NX * (j + NY * k);
const nPoints = (NX + 1) * (NY + 1) * (NZ + 1), nCells = NX * NY * NZ;

{ // points
  const out = [header("vectorField", "points"), `${nPoints}\n(\n`];
  for (let k = 0; k <= NZ; k++) for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const s0 = surf[j * (NX + 1) + i];
    out.push(`(${XS[i].toFixed(3)} ${YS[j].toFixed(3)} ${(s0 + (ZTOP - s0) * sigma[k]).toFixed(3)})\n`);
  }
  out.push(")\n");
  fs.writeFileSync(path.join(meshDir, "points"), out.join(""));
}

// faces: internal (upper-triangular order), then boundary patches
const faces = [], owner = [], neighbour = [];
const f4 = (a, b2, c, d) => `4(${a} ${b2} ${c} ${d})\n`;
for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const c = C(i, j, k);
  if (i < NX - 1) { faces.push(f4(P(i + 1, j, k), P(i + 1, j + 1, k), P(i + 1, j + 1, k + 1), P(i + 1, j, k + 1))); owner.push(c); neighbour.push(C(i + 1, j, k)); }
  if (j < NY - 1) { faces.push(f4(P(i, j + 1, k), P(i, j + 1, k + 1), P(i + 1, j + 1, k + 1), P(i + 1, j + 1, k))); owner.push(c); neighbour.push(C(i, j + 1, k)); }
  if (k < NZ - 1) { faces.push(f4(P(i, j, k + 1), P(i + 1, j, k + 1), P(i + 1, j + 1, k + 1), P(i, j + 1, k + 1))); owner.push(c); neighbour.push(C(i, j, k + 1)); }
}
const nInternal = faces.length;
const patches = [];
function patch(name, type, fn) {
  const start = faces.length;
  fn();
  patches.push({ name, type, start, n: faces.length - start });
}
patch("ground", "wall", () => { for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { faces.push(f4(P(i, j, 0), P(i, j + 1, 0), P(i + 1, j + 1, 0), P(i + 1, j, 0))); owner.push(C(i, j, 0)); } });
patch("top", "patch", () => { for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { faces.push(f4(P(i, j, NZ), P(i + 1, j, NZ), P(i + 1, j + 1, NZ), P(i, j + 1, NZ))); owner.push(C(i, j, NZ - 1)); } });
patch("inlet", "patch", () => { for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) { faces.push(f4(P(0, j, k), P(0, j, k + 1), P(0, j + 1, k + 1), P(0, j + 1, k))); owner.push(C(0, j, k)); } });
patch("outlet", "patch", () => { for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) { faces.push(f4(P(NX, j, k), P(NX, j + 1, k), P(NX, j + 1, k + 1), P(NX, j, k + 1))); owner.push(C(NX - 1, j, k)); } });
patch("sides", "symmetry", () => {
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { faces.push(f4(P(i, 0, k), P(i + 1, 0, k), P(i + 1, 0, k + 1), P(i, 0, k + 1))); owner.push(C(i, 0, k)); }
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { faces.push(f4(P(i, NY, k), P(i, NY, k + 1), P(i + 1, NY, k + 1), P(i + 1, NY, k))); owner.push(C(i, NY - 1, k)); }
});
const note = `nPoints:${nPoints}  nCells:${nCells}  nFaces:${faces.length}  nInternalFaces:${nInternal}`;
fs.writeFileSync(path.join(meshDir, "faces"), header("faceList", "faces") + `${faces.length}\n(\n` + faces.join("") + ")\n");
fs.writeFileSync(path.join(meshDir, "owner"), header("labelList", "owner", note) + `${owner.length}\n(\n` + owner.join("\n") + "\n)\n");
fs.writeFileSync(path.join(meshDir, "neighbour"), header("labelList", "neighbour", note) + `${neighbour.length}\n(\n` + neighbour.join("\n") + "\n)\n");
fs.writeFileSync(path.join(meshDir, "boundary"), header("polyBoundaryMesh", "boundary") + `${patches.length}\n(\n` +
  patches.map((p) => `    ${p.name}\n    {\n        type            ${p.type};\n${p.type === "wall" ? "        inGroups        List<word> 1(wall);\n" : ""}        nFaces          ${p.n};\n        startFace       ${p.start};\n    }\n`).join("") + ")\n");

// ------------------------------------------------------------------ fields and dictionaries
const fh = (cls, obj, loc = "0") => `FoamFile\n{\n    format      ascii;\n    class       ${cls};\n    location    "${loc}";\n    object      ${obj};\n}\n\n`;
const z0List = `nonuniform List<scalar> ${NX * NY}\n(\n${Array.from(colZ0, (v) => v.toPrecision(4)).join("\n")}\n)`;
const abl = `        flowDir         (1 0 0);\n        zDir            (0 0 1);\n        Uref            ${UREF};\n        Zref            ${ZREF};\n        z0              uniform ${Z0_INLET};\n        d               uniform 0;\n        zGround         uniform ${HREF.toFixed(3)};\n`;
const write = (rel, text) => fs.writeFileSync(path.join(caseDir, rel), text);

write("0/U", fh("volVectorField", "U") + `dimensions      [0 1 -1 0 0 0 0];\ninternalField   uniform (${UREF} 0 0);\nboundaryField\n{\n    inlet\n    {\n        type            atmBoundaryLayerInletVelocity;\n${abl}        value           uniform (${UREF} 0 0);\n    }\n    outlet\n    {\n        type            inletOutlet;\n        inletValue      uniform (0 0 0);\n        value           uniform (${UREF} 0 0);\n    }\n    ground\n    {\n        type            noSlip;\n    }\n    top\n    {\n        type            slip;\n    }\n    sides\n    {\n        type            symmetry;\n    }\n}\n`);
write("0/p", fh("volScalarField", "p") + `dimensions      [0 2 -2 0 0 0 0];\ninternalField   uniform 0;\nboundaryField\n{\n    inlet\n    {\n        type            zeroGradient;\n    }\n    outlet\n    {\n        type            fixedValue;\n        value           uniform 0;\n    }\n    ground\n    {\n        type            zeroGradient;\n    }\n    top\n    {\n        type            slip;\n    }\n    sides\n    {\n        type            symmetry;\n    }\n}\n`);
// initial turbulence: log-law values at mid-height
const ustar = (0.41 * UREF) / Math.log((ZREF + Z0_INLET) / Z0_INLET), k0 = ustar ** 2 / Math.sqrt(0.09);
write("0/k", fh("volScalarField", "k") + `dimensions      [0 2 -2 0 0 0 0];\ninternalField   uniform ${k0.toPrecision(4)};\nboundaryField\n{\n    inlet\n    {\n        type            atmBoundaryLayerInletK;\n${abl}        value           uniform ${k0.toPrecision(4)};\n    }\n    outlet\n    {\n        type            inletOutlet;\n        inletValue      uniform ${k0.toPrecision(4)};\n        value           uniform ${k0.toPrecision(4)};\n    }\n    ground\n    {\n        type            kqRWallFunction;\n        value           uniform ${k0.toPrecision(4)};\n    }\n    top\n    {\n        type            zeroGradient;\n    }\n    sides\n    {\n        type            symmetry;\n    }\n}\n`);
const om0 = ustar / (Math.sqrt(0.09) * 0.41 * 100);
write("0/omega", fh("volScalarField", "omega") + `dimensions      [0 0 -1 0 0 0 0];\ninternalField   uniform ${om0.toPrecision(4)};\nboundaryField\n{\n    inlet\n    {\n        type            atmBoundaryLayerInletOmega;\n${abl}        value           uniform ${om0.toPrecision(4)};\n    }\n    outlet\n    {\n        type            inletOutlet;\n        inletValue      uniform ${om0.toPrecision(4)};\n        value           uniform ${om0.toPrecision(4)};\n    }\n    ground\n    {\n        type            atmOmegaWallFunction;\n        z0              ${z0List};\n        value           uniform ${om0.toPrecision(4)};\n    }\n    top\n    {\n        type            zeroGradient;\n    }\n    sides\n    {\n        type            symmetry;\n    }\n}\n`);
write("0/nut", fh("volScalarField", "nut") + `dimensions      [0 2 -1 0 0 0 0];\ninternalField   uniform 1;\nboundaryField\n{\n    inlet\n    {\n        type            calculated;\n        value           uniform 1;\n    }\n    outlet\n    {\n        type            calculated;\n        value           uniform 1;\n    }\n    ground\n    {\n        type            atmNutkWallFunction;\n        z0              ${z0List};\n        value           uniform 1;\n    }\n    top\n    {\n        type            calculated;\n        value           uniform 1;\n    }\n    sides\n    {\n        type            symmetry;\n    }\n}\n`);

write("constant/transportProperties", fh("dictionary", "transportProperties", "constant") + `transportModel  Newtonian;\nnu              1.5e-05;\n`);
write("constant/turbulenceProperties", fh("dictionary", "turbulenceProperties", "constant") + `simulationType  RAS;\nRAS\n{\n    RASModel        kOmegaSST;\n    turbulence      on;\n    printCoeffs     on;\n}\n`);

const ITER = Number(opt("iter", 1500));
write("system/controlDict", fh("dictionary", "controlDict", "system") + `application     simpleFoam;\nstartFrom       latestTime;\nstartTime       0;\nstopAt          endTime;\nendTime         ${ITER};\ndeltaT          1;\nwriteControl    timeStep;\nwriteInterval   ${ITER};\npurgeWrite      1;\nwriteFormat     ascii;\nwritePrecision  7;\nwriteCompression off;\ntimeFormat      general;\nrunTimeModifiable true;\n`);
write("system/fvSchemes", fh("dictionary", "fvSchemes", "system") + `ddtSchemes { default steadyState; }\ngradSchemes { default cellLimited Gauss linear 1; }\ndivSchemes\n{\n    default         none;\n    div(phi,U)      bounded Gauss linearUpwind grad(U);\n    div(phi,k)      bounded Gauss upwind;\n    div(phi,omega)  bounded Gauss upwind;\n    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n}\nlaplacianSchemes { default Gauss linear limited corrected 0.5; }\ninterpolationSchemes { default linear; }\nsnGradSchemes { default limited corrected 0.5; }\nwallDist { method meshWave; }\n`);
write("system/fvSolution", fh("dictionary", "fvSolution", "system") + `solvers\n{\n    p\n    {\n        solver          GAMG;\n        smoother        GaussSeidel;\n        tolerance       1e-7;\n        relTol          0.05;\n    }\n    "(U|k|omega)"\n    {\n        solver          smoothSolver;\n        smoother        symGaussSeidel;\n        tolerance       1e-7;\n        relTol          0.1;\n    }\n}\nSIMPLE\n{\n    nNonOrthogonalCorrectors 2;\n    consistent      yes;\n    residualControl\n    {\n        p               2e-4;\n        U               2e-5;\n        "(k|omega)"     2e-5;\n    }\n}\nrelaxationFactors\n{\n    equations\n    {\n        U               0.8;\n        "(k|omega)"     0.6;\n    }\n}\n`);
const NP = Number(opt("np", 4));
write("system/decomposeParDict", fh("dictionary", "decomposeParDict", "system") + `numberOfSubdomains ${NP};\nmethod          scotch;\n`);

// metadata the extractor needs to map cells back to the site
fs.writeFileSync(path.join(caseDir, "lifty.json"), JSON.stringify({ slug, dir: DIR, NX, NY, NZ, L, dx, dy, XS, YS, ZTOP, HREF, HUP, HDOWN, sigma: Array.from(sigma), surf: Array.from(surf, (v) => +v.toFixed(2)), fe, fn, UREF, ZREF, created: new Date().toISOString() }));
console.log(`${caseDir}\n  ${nCells.toLocaleString()} cells (${NX}×${NY}×${NZ}), ${CORE_DX} m over the site, first cell ${DZ1} m, vertical ratio ${ratio.toFixed(3)}, top ${ZTOP.toFixed(0)} m, far field ${HUP.toFixed(0)} m upwind → ${HDOWN.toFixed(0)} m downwind`);
