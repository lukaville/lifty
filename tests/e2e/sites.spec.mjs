// The site browser: list, search, filters, favourites, map, keyboard, URLs.
import { test, expect, SITES } from "./fixtures.mjs";

const rows = (page) => page.locator("#siteResults .site-row");
const rowNames = (page) => page.locator("#siteResults .site-row .nm").allTextContents();
// OpenStreetMap tiles would make the map test depend on the network: serve a blank tile
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

test.beforeEach(async ({ page, app }) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG }));
  await app.open();
});

test("the site button opens a panel listing every site; ✕ and Esc close it", async ({ page }) => {
  await expect(page.locator("#sitesPanel")).toBeHidden();
  await page.locator("#siteButton").click();
  await expect(page.locator("#sitesPanel")).toBeVisible();
  await expect(rows(page)).toHaveCount(SITES.length);
  await expect(page.locator("#sitesCount")).toHaveText(`${SITES.length} of ${SITES.length}`);
  await expect(page.locator(".site-row.current .nm")).toHaveText("Devil's Dyke");
  await page.locator("#sitesClose").click();
  await expect(page.locator("#sitesPanel")).toBeHidden();
  await page.keyboard.press("/");
  await expect(page.locator("#siteSearch")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sitesPanel")).toBeHidden();
});

test("search narrows the list and shows an empty state", async ({ page }) => {
  await page.locator("#siteButton").click();
  await page.locator("#siteSearch").fill("beach");
  expect(await rowNames(page)).toEqual(["Beachy Head"]);
  await page.locator("#siteSearch").fill("east sussex");
  await expect(rows(page)).toHaveCount(SITES.filter((s) => /east sussex/i.test(s.region)).length);
  await page.locator("#siteSearch").fill("zzzz");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("#siteResults .empty")).toBeVisible();
});

test("typing a wind direction lists the sites that work in it", async ({ page }) => {
  await page.locator("#siteButton").click();
  await page.locator("#siteSearch").fill("NW");
  const names = await rowNames(page);
  expect(names).toContain("Devil's Dyke");
  expect(names).toContain("Firle");
  expect(names).not.toContain("Beachy Head");
});

test("rows show whether each site works in the current wind, following the dial", async ({ page, app }) => {
  await page.locator("#siteButton").click();
  await expect(page.locator('[data-filter="works"]')).toHaveCount(0);
  const label = (slug) => page.locator(`.site-row[data-slug="${slug}"] .ww span`);
  await expect(label("devils-dyke")).toHaveText("works now");
  await expect(label("beachy-head")).toHaveText("off wind");
  await app.setDir(146);                                         // SE
  await expect(label("devils-dyke")).toHaveText("off wind");
  await expect(label("beachy-head")).toHaveText("works now");
});

test("favourites: star from the list or the site card, filter, and persist across reloads", async ({ page, app }) => {
  await page.locator("#siteButton").click();
  await page.locator('.site-row[data-slug="firle"] .star').click();
  await expect(page.locator('.site-row[data-slug="firle"] .star')).toHaveAttribute("aria-pressed", "true");
  expect((await rowNames(page))[0]).toBe("Firle");                   // favourites sort first
  await page.locator("#sitesClose").click();
  await page.locator("#favStar").click();                             // current site: Devil's Dyke
  await expect(page.locator("#favStar")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await page.waitForFunction(() => window.__view?.app?.viz);
  await app.idle();
  await expect(page.locator("#favStar")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#siteButton").click();
  await page.locator('[data-filter="fav"]').click();
  expect((await rowNames(page)).sort()).toEqual(["Devil's Dyke", "Firle"]);
  await page.locator('.site-row[data-slug="firle"] .star').click();   // un-star
  expect(await rowNames(page)).toEqual(["Devil's Dyke"]);
});

test("picking a site loads it, updates the header, and makes the URL shareable", async ({ page, app }) => {
  await app.pickSite("beachy-head");
  await expect(page.locator("#siteButtonName")).toHaveText("Beachy Head");
  await expect(page.locator("#siteButtonRegion")).toContainText("East Sussex");
  await expect(page).toHaveURL(/site=beachy-head/);
  await expect(page.locator("#siteSource a")).toHaveAttribute("href", "https://shgc.org.uk/siteguide");
});

test("keyboard: search, arrow down, Enter", async ({ page, app }) => {
  await page.keyboard.press("/");
  await page.keyboard.type("o");                                      // Bo Peep, High & Over, …
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const second = (await rowNames(page))[1];
  await page.keyboard.press("Enter");
  await app.idle();
  await expect(page.locator("#siteName")).toHaveText(second);
});

test("map view: a marker per site, coloured by the wind, click to open", async ({ page, app }) => {
  await page.locator("#siteButton").click();
  await page.locator('[data-view="map"]').click();
  const markers = page.locator("#siteMap path.leaflet-interactive");
  await expect(markers).toHaveCount(SITES.length);
  const fills = await markers.evaluateAll((els) => els.map((e) => e.getAttribute("fill")));
  expect(fills).toContain("#46e08a");                                  // some work in NW
  expect(fills).toContain("#8a96a3");                                  // some don't
  await page.locator("#siteSearch").fill("newhaven");
  await expect(markers).toHaveCount(1);
  await markers.first().click();
  await page.waitForFunction(() => window.__view.app.site.slug === "newhaven-cliffs");
  await expect(page.locator("#sitesPanel")).toBeHidden();
});

test("contributed site data can't inject markup", async ({ page, app, problems }) => {
  await page.route("**/data/sites.json", async (r) => {
    const res = await r.fetch();
    const data = await res.json();
    data.sites[0].name = '<img src=x onerror="window.__pwned=1">Evil';
    data.sites[0].hazards = '<b id="inj">x</b>';
    await r.fulfill({ response: res, json: data });
  });
  problems.allow.push(/Failed to load resource/);
  await app.open();
  await page.locator("#siteButton").click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator("#siteResults img")).toHaveCount(0);
  await expect(page.locator("#inj")).toHaveCount(0);
  await expect(page.locator("#siteName")).toContainText("<img");      // shown as text
});
