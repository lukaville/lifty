// Visual regression tests of the WIND SIMULATION (no viewer): cross-sections
// through the physics solution for a set of hill shapes, with the wind blowing
// onto or off the hill. Each image has three panels — vertical velocity with
// streamlines, usable climb (EN-B), rotor intensity — see tests/helpers/section-render.mjs.
//
// Images are pure JS maths, so they are identical on every OS. Baselines live in
// tests/golden/sections/; on a mismatch the actual image and a diff are written
// to test-results/sections/. After an intended physics change:
//   UPDATE_GOLDEN=1 npm run test:unit      (then review the PNGs before committing)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, physics, syntheticTerrain, shapes } from "../helpers/terrain.mjs";
import { renderSection, diffImages } from "../helpers/section-render.mjs";

const { encodePNG, decodePNG } = await import(`${ROOT}/scripts/lib/png.mjs`);
const { SitePhysics, WINGS } = physics;
const GOLDEN = path.join(ROOT, "tests/golden/sections");
const OUT = path.join(ROOT, "test-results/sections");
const MPH = 0.44704;
const EN_B = WINGS["pg-typical"];
// Pure maths, so identical everywhere up to float rounding at colour edges.
// Tight on purpose: a small rotor bubble is only ~0.1% of the image.
const MAX_DIFF = 0.0003;

// ---- hill shapes (x east, metres; heights metres AMSL) ------------------------
const halfGauss = (H, aUp, aDown) => (x) => 20 + H * Math.exp(-(x * x) / (x < 0 ? aUp * aUp : aDown * aDown));
const slope = (H, run, form) => (x) => {
  const t = Math.max(0, Math.min(1, (x + run) / run));            // 0 at the foot (x = -run), 1 at the top (x = 0)
  return 20 + H * (form === "concave" ? t * t : 1 - (1 - t) * (1 - t));
};
const escarpmentUp = (H, deg) => (x) => shapes.escarpment(H, deg)(-x);   // rises toward +x
const seaCliff = (H, deg, seaSide) => (x) => {
  const run = H / Math.tan((deg * Math.PI) / 180), xs = seaSide === "west" ? x : -x;
  return xs < -run ? -12 : xs > 0 ? H : H * (1 + xs / run) - 12 * (xs < -run * 0.9 ? 1 : 0);
};
const doubleRidge = (x) => 20 + 140 * Math.exp(-((x + 300) ** 2) / 200 ** 2) + 110 * Math.exp(-((x - 450) ** 2) / 220 ** 2);

// wind from the west (270°) blows toward +x ("into" a face on the west side);
// from the east (90°) it blows toward −x. Sections always run with the wind.
const CASES = [
  { name: "ridge-gentle-12deg-into-14mph", f: shapes.ridge(120, 480), from: 270, mph: 14, expect: "lift" },
  { name: "ridge-steep-25deg-into-10mph", f: shapes.ridge(150, 300), from: 270, mph: 10, expect: "lift" },
  { name: "ridge-steep-25deg-into-20mph", f: shapes.ridge(150, 300), from: 270, mph: 20, expect: "lift+rotor" },
  { name: "asymmetric-steep-face-into-14mph", f: halfGauss(150, 200, 600), from: 270, mph: 14, expect: "lift" },
  { name: "asymmetric-steep-face-off-14mph", f: halfGauss(150, 200, 600), from: 90, mph: 14, expect: "rotor" },
  { name: "escarpment-35deg-into-14mph", f: escarpmentUp(150, 35), from: 270, mph: 14, expect: "lift" },
  { name: "escarpment-35deg-off-14mph", f: escarpmentUp(150, 35), from: 90, mph: 14, expect: "rotor" },
  { name: "escarpment-35deg-off-25mph", f: escarpmentUp(150, 35), from: 90, mph: 25, expect: "rotor" },
  { name: "slope-concave-into-14mph", f: slope(150, 800, "concave"), from: 270, mph: 14, expect: "lift" },
  { name: "slope-convex-into-14mph", f: slope(150, 800, "convex"), from: 270, mph: 14, expect: "lift" },
  { name: "sea-cliff-60deg-onshore-14mph", f: seaCliff(80, 60, "west"), from: 270, mph: 14, expect: "lift" },
  { name: "sea-cliff-60deg-offshore-14mph", f: seaCliff(80, 60, "west"), from: 90, mph: 14, expect: "rotor" },
  { name: "double-ridge-14mph", f: doubleRidge, from: 270, mph: 14, expect: "lift+rotor" },
  { name: "dome-3d-14mph", f: shapes.dome(150, 400), from: 270, mph: 14, expect: "lift" },
];

const update = Boolean(process.env.UPDATE_GOLDEN);
fs.mkdirSync(update ? GOLDEN : OUT, { recursive: true });

for (const c of CASES) {
  test(`cross-section: ${c.name}`, () => {
    const p = new SitePhysics(syntheticTerrain(c.f));
    const b = (c.from * Math.PI) / 180, fe = -Math.sin(b), fn = -Math.cos(b);
    const img = renderSection(p, { fe, fn, U: c.mph * MPH, wing: EN_B });

    // physical sanity, so a baseline can never silently encode nonsense
    const hasLift = img.net.some((layer) => layer.some((v) => v > 0));
    const maxRotor = Math.max(...img.turb.intensity);
    if (c.expect.includes("lift")) assert.ok(hasLift, "expected usable lift");
    if (c.expect.includes("rotor")) assert.ok(maxRotor > 0.3, `expected rotor, max ${maxRotor}`);

    const file = path.join(GOLDEN, `${c.name}.png`);
    const png = encodePNG(img.width, img.height, Buffer.from(img.rgb));
    if (update) { fs.writeFileSync(file, png); return; }
    assert.ok(fs.existsSync(file), `missing baseline ${file} — run UPDATE_GOLDEN=1 npm run test:unit`);
    const g = decodePNG(fs.readFileSync(file));
    const { ratio, diff } = diffImages(img, { width: g.width, height: g.height, rgb: g.data });
    if (ratio > MAX_DIFF) {
      fs.writeFileSync(path.join(OUT, `${c.name}.actual.png`), png);
      if (diff) fs.writeFileSync(path.join(OUT, `${c.name}.diff.png`), encodePNG(diff.width, diff.height, Buffer.from(diff.rgb)));
    }
    assert.ok(ratio <= MAX_DIFF, `${(ratio * 100).toFixed(2)}% of pixels differ — see test-results/sections/${c.name}.diff.png`);
  });
}
