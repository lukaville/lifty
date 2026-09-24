// Functional tests of the app in a real browser (desktop layout).
import { test, expect, SITES as SITE_DATA } from "./fixtures.mjs";

const SITES = SITE_DATA.map((s) => s.slug);

test.describe("boot", () => {
  test("loads the default site with terrain, trees, lift band and rotor", async ({ page, app }) => {
    await app.open();
    await expect(page.locator("h1")).toHaveText("Lifty");
    await expect(page.locator("#siteButtonName")).toHaveText("Devil's Dyke");
    await expect(page.locator("#siteName")).toHaveText("Devil's Dyke");
    const s = await app.state();
    expect(s.loading).toBe("none");
    expect(s.soarable).toBe(true);
    expect(s.bandCells).toBeGreaterThan(100);
    expect(s.rotorSprites).toBeGreaterThan(0);
    expect(s.trees).toBeGreaterThan(10000);
    await expect(page.locator("#status .txt")).toHaveText(/Good soaring window/);
  });

  test("deep link sets site, wind, lift threshold and wing", async ({ page, app }) => {
    await app.open("site=beachy-head&dir=150&mph=12&lift=0.5&wing=hg");
    const s = await app.state();
    expect(s).toMatchObject({ site: "beachy-head", dirDeg: 150, speedMph: 12, minLift: 0.5, wing: "hg" });
    await expect(page.locator("#siteName")).toHaveText("Beachy Head");
    await expect(page.locator("#dirDeg")).toHaveText("150°");
    await expect(page.locator("#spdVal")).toHaveText("12");
    await expect(page.locator("#minLiftVal")).toHaveText("0.5");
    await expect(page.locator("#wing")).toHaveValue("hg");
  });

  test("invalid deep-link values are clamped or ignored", async ({ app }) => {
    await app.open("site=nowhere&mph=99&lift=-3&wing=rocket");
    const s = await app.state();
    expect(s.site).toBe("devils-dyke");
    expect(s.speedMph).toBe(35);
    expect(s.minLift).toBe(0);
    expect(s.wing).toBe("pg-typical");
  });
});

test("page metadata, icons, manifest and social image are in place", async ({ page, app, request }) => {
  await app.open();
  await expect(page).toHaveTitle(/Lifty/);
  const meta = (sel) => page.locator(sel).first().getAttribute("content");
  expect((await meta('meta[name="description"]')).length).toBeGreaterThan(50);
  for (const p of ["og:title", "og:description", "og:image", "og:url"]) expect(await meta(`meta[property="${p}"]`), p).toBeTruthy();
  expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  expect(await meta('meta[name="theme-color"]')).toBe("#0b1016");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /^https:\/\//);
  // every linked asset is served
  const hrefs = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  for (const h of [...hrefs, "./og-image.png", "./robots.txt"]) expect((await request.get(h)).status(), h).toBe(200);
  const manifest = await (await request.get("./manifest.webmanifest")).json();
  expect(manifest.name).toBe("Lifty");
  for (const i of manifest.icons) expect((await request.get("./" + i.src)).status(), i.src).toBe(200);
});

test.describe("status logic", () => {
  test.beforeEach(async ({ app }) => app.open());

  test("calm", async ({ page, app }) => {
    await app.setSpeed(1);
    await expect(page.locator("#status .txt")).toHaveText(/Calm/);
  });

  test("off wind (the lee side)", async ({ page, app }) => {
    await app.setDir(146);
    await expect(page.locator("#status .txt")).toHaveText(/Off wind/);
  });

  test("too strong: can't penetrate", async ({ page, app }) => {
    await app.setSpeed(30);
    await expect(page.locator("#status .txt")).toHaveText(/Too strong/);
  });

  test("good window mid-arc in a moderate wind", async ({ page, app }) => {
    await app.setSpeed(13);
    await expect(page.locator("#status .txt")).toHaveText(/Good soaring window/);
  });
});

test.describe("controls", () => {
  test.beforeEach(async ({ app }) => app.open());

  test("wind slider updates readouts and recomputes the field", async ({ page, app }) => {
    const before = await app.state();
    await app.setSpeed(20);
    await expect(page.locator("#spdVal")).toHaveText("20");
    await expect(page.locator("#spdKmh")).toHaveText("32 km/h");
    const after = await app.state();
    expect(after.speedMph).toBe(20);
    expect(after.rotorSprites).not.toBe(before.rotorSprites);
  });

  test("dragging the compass dial sets the wind direction", async ({ page, app }) => {
    const box = await page.locator("#dial").boundingBox();
    const s = box.width / 200;                          // dial canvas is 200 px internally
    // the dial's east tick: centre (100,100), radius 78 in canvas pixels
    await page.mouse.click(box.x + (100 + 70) * s, box.y + 100 * s);
    await app.idle();
    const { dirDeg } = await app.state();
    expect(Math.abs(dirDeg - 90)).toBeLessThanOrEqual(3);
    await expect(page.locator("#dirCard")).toHaveText("E");
  });

  test("raising the minimum-lift threshold shrinks the band, then removes it", async ({ page, app }) => {
    const vol = [];
    for (const v of [0, 1, 2.5]) { await app.setMinLift(v); vol.push((await app.state()).bandVolume); }
    expect(vol[0]).toBeGreaterThan(vol[1]);
    expect(vol[1]).toBeGreaterThan(vol[2]);
    await app.setMinLift(5);
    expect((await app.state()).soarable).toBe(false);
    await expect(page.locator("#status .txt")).toHaveText(/Not soarable/);
  });

  test("a hang glider reaches higher than a school paraglider", async ({ page, app }) => {
    await page.selectOption("#wing", "pg-school");
    await app.idle();
    const school = (await app.state()).ceilingFt;
    await page.selectOption("#wing", "hg");
    await app.idle();
    const hg = (await app.state()).ceilingFt;
    expect(hg).toBeGreaterThan(school + 50);
    await expect(page.locator("#wingSink")).toContainText("min sink 0.85");
  });

  test("layer toggles show and hide their objects", async ({ page }) => {
    const vis = () => page.evaluate(() => {
      const a = window.__view.app;
      return { band: a.viz.band.visible, flow: a.viz.trails.visible, rotor: a.viz.rotor.visible, trees: a.veg.visible, arrow: a.windArrow.visible };
    });
    await page.evaluate(() => window.__view.settle(1));
    expect(await vis()).toEqual({ band: true, flow: true, rotor: true, trees: true, arrow: true });
    for (const id of ["#tBand", "#tFlow", "#tRotor", "#tVeg", "#tWind"]) await page.locator(id).uncheck();
    await page.evaluate(() => window.__view.settle(1));
    expect(await vis()).toEqual({ band: false, flow: false, rotor: false, trees: false, arrow: false });
    await page.locator("#tBand").check();
    await page.evaluate(() => window.__view.settle(1));
    expect((await vis()).band).toBe(true);
  });
});

test.describe("sites", () => {
  test("every site loads with its terrain, landcover and airflow", async ({ page, app }) => {
    test.setTimeout(300_000);
    await app.open();
    for (const slug of SITES) {
      if (slug !== "devils-dyke") await app.pickSite(slug);
      const s = await app.state();
      expect(s.site).toBe(slug);
      // trees and buildings only exist where there is LiDAR (England)
      const lidar = await page.evaluate(() => /LiDAR/.test(window.__view.app.terrain.source || ""));
      if (lidar) expect(s.trees, slug).toBeGreaterThan(1000);
      expect(s.bandCells + s.rotorSprites, slug).toBeGreaterThan(0);
      await expect(page).toHaveURL(new RegExp(`site=${slug}`));
      // default wind is the middle of the working arc -> not "off wind"
      await expect(page.locator("#status .txt")).not.toHaveText(/Off wind/);
    }
  });

  test("rapid site switching settles on the last site clicked", async ({ page, app }) => {
    await app.open();
    // several loads in flight at once, via the programmatic API
    await page.evaluate(() => { for (const s of ["firle", "bo-peep", "high-and-over"]) window.__view.loadSite(s); });
    await page.waitForFunction(() => window.__view.app.site.slug === "high-and-over");
    await app.idle();
    expect((await app.state()).site).toBe("high-and-over");
    await expect(page.locator("#siteName")).toHaveText("High & Over");
    // exactly one site's scene graph remains
    const terrains = await page.evaluate(() => window.__view.scene.children.filter((c) => c.type === "Group").length);
    expect(terrains).toBe(1);
  });
});

test.describe("resilience", () => {
  test("works without landcover data (no trees, physics still runs)", async ({ page, app, problems }) => {
    await page.route("**/data/landcover/**", (r) => r.fulfill({ status: 404, body: "" }));
    problems.allow.push(/Failed to load resource.*404/);   // the provoked 404s themselves
    await app.open();
    const s = await app.state();
    expect(s.trees).toBe(0);
    expect(s.soarable).toBe(true);
  });

  test("satellite imagery failing falls back to elevation colours without errors", async ({ page, app, problems }) => {
    // both imagery sources (Clarity, then the standard /ArcGIS/ fallback)
    await page.route(/arcgis/i, (r) => r.abort());
    problems.allow.push(/Failed to load resource/);        // the provoked network failures
    await app.open("seed=1", { test: false });
    await page.waitForTimeout(1500);
    const s = await app.state();
    expect(s.satLoaded).toBe(false);
    const map = await page.evaluate(() => Boolean(window.__view.app.terrainMesh.material.map));
    expect(map).toBe(false);
  });
});
