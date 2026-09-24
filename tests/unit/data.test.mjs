// Integrity of the shipped data: every site has complete, well-formed terrain
// and landcover, consistent with the site metadata.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, sites, sitePhysics } from "../helpers/terrain.mjs";
const { decodePNG } = await import(`${ROOT}/scripts/lib/png.mjs`);

const FT = 3.28084;
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const decode = (g, n) => {
  const raw = Buffer.from(g.heights_b64, "base64");
  assert.equal(raw.length, n * n * 2, "grid size");
  return Array.from({ length: n * n }, (_, k) => g.offset + raw.readUInt16LE(2 * k) * g.scale);
};

test("sites.json: sites with complete, sane metadata", () => {
  assert.ok(sites.length >= 8);
  assert.equal(new Set(sites.map((s) => s.slug)).size, 8, "unique slugs");
  for (const s of sites) {
    assert.match(s.slug, /^[a-z-]+$/);
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180, `${s.name} coordinates`);
    assert.ok(s.windFrom.every((d) => d >= 0 && d <= 360), `${s.name} arc`);
    assert.ok(s.strengthBand_mph[0] < s.strengthBand_mph[1], `${s.name} band`);
    assert.ok(s.takeoffAmsl_ft > 100 && s.takeoffAmsl_ft < 1000);
    for (const k of ["name", "region", "country", "workingWind", "character", "hazards"]) assert.ok(s[k], `${s.name}.${k}`);
    if (s.club) assert.match(s.source, /^https:\/\//, `${s.name}: club sites cite their guide`);
    assert.match(s.country, /^[A-Z]{2}$/, "ISO country code");
  }
});

for (const s of sites) {
  describe(s.name, () => {
    const t = readJSON(`public/data/terrain/${s.slug}.json`);

    test("terrain grids decode and are consistent", () => {
      assert.equal(t.n, 128); assert.equal(t.windowM, 3200);
      const h = decode(t, t.n);
      assert.ok(Math.abs(Math.min(...h) - t.minH) < 0.05 && Math.abs(Math.max(...h) - t.maxH) < 0.05);
      assert.equal(t.render.n, 512);
      const r = decode(t.render, 512);
      assert.ok(r.every(Number.isFinite));
      assert.ok(t.terrarium_b64 && t.terrarium, "terrarium bathymetry kept for the sea");
    });

    test("take-off height matches the published take-off (15 m with LiDAR, 40 m without)", () => {
      const p = sitePhysics(s.slug, { landcover: false });
      const dz = Math.abs(p._sampleH(0, 0) - s.takeoffAmsl_ft / FT);
      assert.ok(dz < (/LiDAR/.test(t.source) ? 15 : 40), `${dz.toFixed(1)} m`);
    });

    test("landcover raster: 800², valid classes, heights and cover", () => {
      const png = decodePNG(fs.readFileSync(path.join(ROOT, `public/data/landcover/${s.slug}.png`)));
      assert.equal(png.width, 800); assert.equal(png.height, 800);
      const counts = [0, 0, 0, 0];
      for (let k = 0; k < 800 * 800; k++) {
        const c = png.data[k * 3 + 1];
        assert.ok(c <= 3, "class");
        counts[c]++;
        if (c === 0) assert.equal(png.data[k * 3 + 2], 0, "open ground has no cover");
      }
      assert.ok(counts[0] > 0.3 * 640000, "mostly open ground");
      if (/LiDAR/.test(t.source)) assert.ok(counts[2] > 5000, "LiDAR sites have woodland");
    });

    test("no phantom trees on cliff faces (DSM/DTM mismatch on near-vertical ground)", () => {
      const lc = readJSON(`public/data/landcover/${s.slug}.json`);
      const p = sitePhysics(s.slug, { landcover: false });
      const slopeDeg = (e, n) => {
        const d = 4, sx = (p.groundAt(e + d, n) - p.groundAt(e - d, n)) / (2 * d), sy = (p.groundAt(e, n + d) - p.groundAt(e, n - d)) / (2 * d);
        return (Math.atan(Math.hypot(sx, sy)) * 180) / Math.PI;
      };
      const phantom = lc.trees.filter(([e, n, h, , rgb]) => {
        const bright = (((rgb >> 16) & 255) + ((rgb >> 8) & 255) + (rgb & 255)) / 3 > 155;
        return h > 15 && slopeDeg(e, n) > 60 && bright;
      });
      assert.equal(phantom.length, 0, `${phantom.length} tall chalk-coloured "trees" on cliff faces: ${JSON.stringify(phantom.slice(0, 3))}`);
    });

    test("3-D instances are well-formed and inside the window", () => {
      const lc = readJSON(`public/data/landcover/${s.slug}.json`);
      const inside = (e, n) => Math.abs(e) <= 1600 && Math.abs(n) <= 1600;
      if (/LiDAR/.test(t.source)) assert.ok(lc.trees.length > 1000, "trees");
      for (const [e, n, h, r, rgb] of lc.trees) {
        assert.ok(inside(e, n) && h >= 2.5 && h <= 60 && r >= 1 && r <= 8 && rgb >= 0 && rgb <= 0xffffff);
      }
      for (const [e, n, h, r] of lc.bushes) assert.ok(inside(e, n) && h > 0 && h <= 3.5 && r > 0);
      for (const b of lc.buildings) {
        assert.equal(b.length, 8);
        const [e, n, len, wid, ang, eaves, rise] = b;
        assert.ok(inside(e, n) && len > 0 && wid > 0 && Math.abs(ang) <= Math.PI && eaves >= 2.5 && rise >= 0);
      }
    });
  });
}

test("slugs match the data files, and every data file belongs to a site", () => {
  const slugs = new Set(sites.map((s) => s.slug));
  for (const dir of ["terrain", "landcover"]) {
    for (const f of fs.readdirSync(path.join(ROOT, "public/data", dir))) assert.ok(slugs.has(f.replace(/\.(json|png)$/, "")), `orphan ${dir}/${f}`);
  }
});

test("Newhaven's town is detected as buildings", () => {
  assert.ok(readJSON("public/data/landcover/newhaven-cliffs.json").buildings.length > 300);
});
