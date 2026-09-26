// Render one site at a given wind and save a screenshot (a dev tool; the
// regression suite is tests/e2e/screenshots.spec.mjs).
//   node scripts/snapshot.mjs <slug> <dirDeg> <mph> <out.png> [url]
//   CAM=default|side|close|profile   camera preset
//   MOBILE=1                         390×844 phone viewport with touch
//   TEST=1                           deterministic test mode (no imagery)
//   QUERY="cfd=on"                   extra URL options
//   EVAL='js'                        run JS in the page before the screenshot
import { chromium } from "@playwright/test";

const [slug = "devils-dyke", dir = "326", mph = "14", out = "snapshot.png", url = "http://127.0.0.1:8123/"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage(process.env.MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if ((m.type() === "error" || m.type() === "warning") && !/GPU stall due to ReadPixels/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`);
});

const q = new URLSearchParams({ site: slug, dir, mph });
if (process.env.TEST) q.set("test", "");
// extra URL options, e.g. QUERY="cfd=on"
for (const [k, v] of new URLSearchParams(process.env.QUERY || "")) q.set(k, v);
await page.goto(`${url}?${q}`);
await page.waitForFunction(() => window.__view?.app?.viz && !window.__view.app.loading, null, { timeout: 90_000 });
await page.evaluate(() => window.__view.whenIdle());
if (!process.env.TEST) await page.waitForFunction(() => window.__view.app.satLoaded, null, { timeout: 30_000 }).catch(() => {});

await page.evaluate((cam) => {
  const v = window.__view, t = v.app.terrain, wm = t.windowM, b = (v.app.dirDeg * Math.PI) / 180;
  const ex = -Math.sin(b), en = -Math.cos(b), ty = (t.meanH - t.minH) * 1.4;
  if (cam === "side") { v.camera.position.set(-ex * wm * 0.78, wm * 0.22, en * wm * 0.78); v.controls.target.set(0, ty + 40, 0); }
  if (cam === "close") { v.camera.position.set(-ex * 380 + en * 260, ty + 260, en * 380 + ex * 260); v.controls.target.set(0, ty + 40, 0); }
  // perpendicular to the wind, level with the ridge (wind blows right -> left)
  if (cam === "profile") { v.camera.position.set(-en * 1500, ty + 120, -ex * 1500); v.controls.target.set(0, ty + 60, 0); }
  v.controls.update();
}, process.env.CAM || "default");
if (process.env.EVAL) await page.evaluate(process.env.EVAL);
if (process.env.TEST) await page.evaluate(() => window.__view.settle(180));
else await page.waitForTimeout(Number(process.env.WAIT || 3000));

await page.screenshot({ path: out });
console.log(`${slug} @ ${dir}° ${mph} mph -> ${out}`);
console.log("  " + (await page.locator("#bandInfo").textContent()));
if (errors.length) console.log("  ERRORS:\n   " + errors.join("\n   "));
await browser.close();
