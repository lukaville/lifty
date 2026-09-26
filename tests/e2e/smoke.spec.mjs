// Smoke test for a deployed site (or the local server): real rendering, real
// satellite imagery, the production asset config.
//   BASE_URL=https://liftyapp.pages.dev npm run test:smoke
import { test, expect } from "./fixtures.mjs";

test("the deployed app boots with imagery, terrain, trees and airflow", async ({ page, app }) => {
  await app.open("", { test: false });
  await expect(page.locator("h1")).toHaveText("Lifty");
  await page.waitForFunction(() => window.__view.app.satLoaded, null, { timeout: 60_000 });
  const s = await app.state();
  expect(s.soarable).toBe(true);
  expect(s.trees).toBeGreaterThan(10000);
  expect(s.rotorSprites).toBeGreaterThan(0);
  // the default wind (14 km/h) is at the light end of the default site's range
  await expect(page.locator("#status .txt")).toHaveText(/Good soaring window|Light/);
  await expect(page.locator("#bandInfo")).toContainText("FluidX3D LES simulation");
  await expect(page.locator(".hint a")).toHaveAttribute("href", "https://github.com/lukaville/lifty");
});

test("every data file the app needs is served", async ({ request }) => {
  const sites = (await (await request.get("./data/sites.json")).json()).sites;
  for (const s of sites) {
    for (const f of [`data/terrain/${s.slug}.json`, `data/landcover/${s.slug}.json`, `data/landcover/${s.slug}.png`]) {
      const r = await request.head(f);
      expect(r.status(), f).toBe(200);
    }
  }
});

test("missing assets are real 404s, not the SPA shell", async ({ request }) => {
  const r = await request.get("data/terrain/does-not-exist.json");
  expect(r.status()).toBe(404);
});

test("wind controls respond and a coastal site loads", async ({ page, app }) => {
  await app.open("", { test: false });
  await app.setSpeed(30);
  await expect(page.locator("#status .txt")).toHaveText(/Too strong/);
  await app.pickSite("newhaven-cliffs");
  const s = await app.state();
  expect(s.site).toBe("newhaven-cliffs");
  expect(s.buildings).toBeGreaterThan(300);
});
