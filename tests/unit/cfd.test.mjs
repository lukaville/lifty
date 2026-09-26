// Precomputed OpenFOAM fields: the packed file format, direction blending, and
// how rotor is read off the solved flow.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { bracket, decodeCfd, rotorSeverity, cfdFields, cfdFile, wakeGust, gustSeverity, WAKE_DECAY_H, CfdStore } from "../../public/js/cfd.js";
import { physics, syntheticTerrain } from "../helpers/terrain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { SitePhysics, windProfile } = physics;

// a tiny lifty-cfd-2 file, written the way cfd/pack.mjs writes it
function packed(h, base, fields) {
  const NN = h.n * h.n, parts = [Buffer.from(JSON.stringify(h) + "\n"), Buffer.from(Int16Array.from(base, (v) => Math.round(v / h.baseScale)).buffer)];
  for (const key of h.fields) {
    let prev = new Int16Array(NN);
    for (const layer of fields[key]) {
      const q = Int16Array.from(layer, (v) => Math.round(v / (h.scales?.[key] ?? h.scale)));
      const lo = Buffer.alloc(NN), hi = Buffer.alloc(NN);
      for (let g = 0; g < NN; g++) { const d = q[g] - prev[g]; lo[g] = d & 255; hi[g] = (d >> 8) & 255; }
      parts.push(lo, hi); prev = q;
    }
  }
  const gz = zlib.gzipSync(Buffer.concat(parts));
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length);
}

describe("direction bracketing", () => {
  const dirs = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5];
  test("between two stored directions, weighted by closeness", () => {
    const [a, b] = bracket(dirs, 30);
    assert.equal(a.dir, 22.5); assert.equal(b.dir, 45);
    assert.ok(Math.abs(a.w - 2 / 3) < 1e-9 && Math.abs(b.w - 1 / 3) < 1e-9);
  });
  test("wraps through north", () => {
    const [a, b] = bracket(dirs, 350);
    assert.equal(a.dir, 337.5); assert.equal(b.dir, 0);
    assert.ok(Math.abs(b.w - 12.5 / 22.5) < 1e-9);
  });
  test("exactly on a stored direction uses it alone", () => {
    const br = bracket(dirs, 90);
    assert.equal(br.find((x) => x.w === 1)?.dir, 90);
  });
  test("file names round like the pipeline (22.5° → d023)", () => {
    assert.equal(cfdFile("x", 22.5), "x/d023.bin");
    assert.equal(cfdFile("x", 337.5), "x/d338.bin");
  });
});

describe("packed file format", () => {
  test("round-trips values, including negatives and large layer-to-layer jumps", async () => {
    const n = 4, NN = n * n, agl = [6, 14, 23];
    const h = { format: "lifty-cfd-2", n, windowM: 3200, agl, fields: ["w", "s"], scale: 0.004, baseScale: 0.25 };
    const base = Float32Array.from({ length: NN }, (_, k) => k * 10.25 - 3);
    const w = agl.map((_, li) => Float32Array.from({ length: NN }, (_, k) => ((k % 5) - 2) * 0.1 * (li + 1)));
    const s = agl.map((_, li) => Float32Array.from({ length: NN }, (_, k) => (k === 3 ? -0.8 : 1.2) * (li ? 1 : -1)));
    const d = await decodeCfd(packed(h, base, { w, s }));
    for (let k = 0; k < NN; k++) assert.ok(Math.abs(d.base[k] - base[k]) <= 0.125);
    for (const [key, src] of [["w", w], ["s", s]]) {
      for (let li = 0; li < agl.length; li++) for (let k = 0; k < NN; k++) {
        assert.ok(Math.abs(d.f[key][li][k] - src[li][k]) <= 0.002 + 1e-9, `${key}[${li}][${k}] ${d.f[key][li][k]} vs ${src[li][k]}`);
      }
    }
  });

  test("per-field scales", async () => {
    const n = 2, NN = n * n, agl = [6, 14];
    const h = { format: "lifty-cfd-2", n, windowM: 3200, agl, fields: ["w", "r"], scales: { w: 0.01, r: 0.02 }, baseScale: 0.25 };
    const w = agl.map(() => Float32Array.from({ length: NN }, (_, k) => k * 0.33 - 0.5)), r = agl.map(() => Float32Array.from({ length: NN }, (_, k) => k / 3));
    const d = await decodeCfd(packed(h, new Float32Array(NN), { w, r }));
    for (let k = 0; k < NN; k++) { assert.ok(Math.abs(d.f.w[1][k] - w[1][k]) <= 0.005 + 1e-9); assert.ok(Math.abs(d.f.r[1][k] - r[1][k]) <= 0.01 + 1e-9); }
  });

  test("the files shipped with the app decode and match the site grid", async () => {
    const dir = path.join(ROOT, "public/data/les");
    if (!fs.existsSync(path.join(dir, "index.json"))) return;
    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    for (const [slug, dirs] of Object.entries(index)) {
      const t = JSON.parse(fs.readFileSync(path.join(ROOT, `public/data/terrain/${slug}.json`), "utf8"));
      const buf = fs.readFileSync(path.join(dir, cfdFile(slug, dirs[0])));
      const d = await decodeCfd(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      assert.equal(d.h.n, t.n ?? d.h.n);
      assert.equal(d.h.windowM, t.windowM);
      for (const f of dirs) assert.ok(fs.existsSync(path.join(dir, cfdFile(slug, f))), `${slug} ${f}`);
    }
  });
});

describe("rotor from the solved flow", () => {
  test("reversed flow is full rotor; undisturbed flow is none", () => {
    assert.equal(rotorSeverity(-0.3, 30), 1);
    assert.equal(rotorSeverity(windProfile(30), 30), 0);
  });
  test("nearly stagnant air counts; merely sheltered air (e.g. behind woods) doesn't", () => {
    assert.ok(rotorSeverity(0.03 * windProfile(20), 20) > 0.7);
    assert.equal(rotorSeverity(0.3 * windProfile(20), 20), 0);
  });
  test("fields scale with the wind and mark the reversed column as rotor", () => {
    const p = new SitePhysics(syntheticTerrain(() => 50));
    const n = p.n, NN = n * n, agl = [6, 14, 23, 33];
    const mk = (fn) => agl.map((d) => Float32Array.from({ length: NN }, (_, k) => fn(k, d)));
    const R = 5;      // one reversed column
    const data = { h: { n, windowM: p.windowM, agl, fields: ["w", "s", "c", "t"] }, base: new Float32Array(NN).fill(50),
      f: { w: mk(() => 0.1), s: mk((k, d) => (k === R && d < 20 ? -0.2 : windProfile(d))), c: mk(() => 0), t: mk(() => 0.115) } };
    const pair = [{ dir: 270, w: 0.5, data }, { dir: 292.5, w: 0.5, data }];
    const { field, turb } = cfdFields(p, pair, 1, 0, 8);
    assert.ok(Math.abs(field.layers[0][0] - 0.8) < 1e-6, "w × U");
    assert.equal(field.source, "cfd");
    assert.ok(turb.intensity[R] > 0.9, `reversed column ${turb.intensity[R]}`);
    assert.ok(turb.top[R] >= 50 + 14 && turb.top[R] < 50 + 33, `rotor top ${turb.top[R]}`);
    assert.equal(turb.intensity[R - 1], 0, "nothing upwind of the rotor");
  });

  // a 2-D rotor core 40 m deep across the whole window at x ≈ 0; wind from the west
  const coreSetup = () => {
    const p = new SitePhysics(syntheticTerrain(() => 50));
    const n = p.n, NN = n * n, agl = [6, 14, 23, 33, 44];
    const i0 = n / 2, isCore = (k) => k % n >= i0 - 2 && k % n <= i0;
    const mk = (fn) => agl.map((d) => Float32Array.from({ length: NN }, (_, k) => fn(k, d)));
    const data = { h: { n, windowM: p.windowM, agl, fields: ["w", "s", "c", "t"] }, base: new Float32Array(NN).fill(50),
      f: { w: mk(() => 0), s: mk((k, d) => (isCore(k) && d < 40 ? -0.2 : windProfile(d))), c: mk(() => 0), t: mk(() => 0.115) } };
    const lengthAt = (mph) => {
      const { turb } = cfdFields(p, [{ dir: 270, w: 1, data }, { dir: 270, w: 0, data }], 1, 0, mph * 0.44704);
      const row = (n / 2) * n;
      let last = i0;
      for (let i = i0 + 1; i < n; i++) if (turb.intensity[row + i] > 0) last = i;
      return (last - i0) * p.cell;           // wake length behind the core, m
    };
    return { lengthAt };
  };

  test("the turbulent wake behind a rotor grows with the wind", () => {
    const { lengthAt } = coreSetup();
    const L = [8, 14, 20, 30].map(lengthAt);
    assert.equal(L[0], 0, `no wake in 8 mph: ${L}`);
    assert.ok(L[1] > 0 && L[2] > L[1] && L[3] > L[2], `lengths ${L}`);
  });

  test("wake gusts: ∝ wind, decaying over ~10 core depths", () => {
    assert.ok(Math.abs(wakeGust(10, 0, 40) - 2 * wakeGust(5, 0, 40)) < 1e-9);
    assert.ok(wakeGust(10, 2.3 * WAKE_DECAY_H * 40, 40) < 0.11 * wakeGust(10, 0, 40));
    assert.equal(gustSeverity(0.5), 0);
    assert.equal(gustSeverity(2), 1);
  });
});

describe("no silent fall-back", () => {
  const all = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5];
  test("a site without results, a gap in the directions or a failed index are reported, not skipped", () => {
    const st = new CfdStore("./x/");
    st.index = { a: all, b: [0, 22.5, 45, 180] };
    assert.equal(st.problem("a", 100), null);
    assert.match(st.problem("c", 100), /no simulation results/);
    assert.match(st.problem("b", 100), /missing directions between 45° and 180°/);
    assert.equal(st.pair("c", 100), null);
    st.indexError = "the simulation index failed to load";
    assert.match(st.problem("a", 100), /index failed/);
  });
  test("a file that failed to load is reported", () => {
    const st = new CfdStore("./x/");
    st.index = { a: all };
    st.files.set(cfdFile("a", 90), { error: "./x/a/d090.bin failed to load: HTTP 404" });
    assert.match(st.problem("a", 100), /d090\.bin failed to load/);
    assert.equal(st.pair("a", 100), null);
  });
});
