// Shared Playwright fixtures: open the app in deterministic test mode, wait for
// it to be idle, read state, and fail any test that logs a console error or
// throws in the page.
import fs from "node:fs";
import { test as base, expect } from "@playwright/test";

// the site list the app ships with, so tests follow when sites are added
export const SITES = JSON.parse(fs.readFileSync(new URL("../../public/data/sites.json", import.meta.url), "utf8")).sites;

export const test = base.extend({
  // collected page problems; asserted empty after every test
  // tests that provoke failures on purpose push patterns onto problems.allow
  problems: [async ({ page }, use) => {
    const problems = [];
    problems.allow = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
    await use(problems);
    const unexpected = problems.filter((p) => !problems.allow.some((re) => re.test(p)));
    expect(unexpected, "no console errors or uncaught exceptions").toEqual([]);
  }, { auto: true }],

  app: async ({ page }, use) => {
    const app = {
      // open with ?test (seeded, frozen clock, no network imagery) plus extra params
      async open(params = "", { test: testMode = true } = {}) {
        const q = [testMode ? "test" : "", params].filter(Boolean).join("&");
        await page.goto(`/?${q}`);
        await page.waitForFunction(() => window.__view?.app?.viz, null, { timeout: 60_000 });
        await app.idle();
      },
      idle: () => page.evaluate(() => window.__view.whenIdle()),
      settle: (frames = 150) => page.evaluate((f) => window.__view.settle(f), frames),
      state: () => page.evaluate(() => {
        const a = window.__view.app;
        return {
          site: a.site.slug, dirDeg: a.dirDeg, speedMph: a.speedMph, minLift: a.minLift, wing: a.wing,
          status: document.querySelector("#status .txt").textContent,
          soarable: a.stats.soarable, ceilingFt: a.stats.ceilingAboveTakeoff * 3.28084, maxClimb: a.stats.maxClimb,
          bandVolume: a.viz.stats.bandVolume, bandCells: a.viz.stats.bandCells, rotorSprites: a.viz.stats.rotorSprites,
          trees: a.veg?.userData.stats.trees ?? 0, buildings: a.veg?.userData.stats.buildings ?? 0,
          satLoaded: a.satLoaded, loading: getComputedStyle(document.getElementById("loading")).display,
        };
      }),
      // set the wind through the real controls
      async setSpeed(mph) {
        await page.locator("#speed").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, mph);
        await app.idle();
      },
      async setMinLift(v) {
        await page.locator("#minLift").evaluate((el, x) => { el.value = x; el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
        await app.idle();
      },
      // choose a site through the sites panel, as a user would
      async pickSite(slug, { touch = false } = {}) {
        const open = await page.locator("#sitesPanel").isVisible();
        if (!open) await (touch ? page.locator("#siteButton").tap() : page.locator("#siteButton").click());
        const row = page.locator(`.site-row[data-slug="${slug}"]`);
        await (touch ? row.tap() : row.click());
        await page.waitForFunction((s) => window.__view.app.site?.slug === s, slug);
        await app.idle();
      },
      async setDir(deg) {
        await page.evaluate((d) => { window.__view.app.dirDeg = d; window.__view.recompute(); }, deg);
        await app.idle();
      },
    };
    await use(app);
  },
});

export { expect };
