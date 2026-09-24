import { test } from "@playwright/test";
test("debug", async ({ page }) => {
  let n = 0; const urls = new Set();
  page.on("request", (r) => { if (/arcgis/.test(r.url())) urls.add(r.url().slice(0, 60)); });
  await page.route("**/arcgis/**", (r) => { n++; return r.abort(); });
  await page.goto("/?seed=1");
  await page.waitForTimeout(8000);
  console.log("routed", n, "distinct", [...urls].slice(0, 3), await page.evaluate(() => window.__view.app.satLoaded));
});
