// Regenerate the social preview (public/og-image.png) and the README
// screenshots (docs/images/*.png). Renders the app in ?test mode — elevation
// colours, no satellite imagery — so every image in the repo is freely
// redistributable (the Esri imagery is only ever streamed at runtime).
//   npm run serve   (in another terminal)
//   node scripts/make-images.mjs [url=http://127.0.0.1:8123/]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = process.argv[2] || "http://127.0.0.1:8123/";
fs.mkdirSync(path.join(ROOT, "docs/images"), { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function shot(file, { width, height, params, hideUI = false, mobile = false, before }) {
  const page = await browser.newPage(mobile
    ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${URL_}?test&${params}`);
  await page.waitForFunction(() => window.__view?.app?.viz && !window.__view.app.loading, null, { timeout: 90_000 });
  await page.evaluate(() => window.__view.whenIdle());
  if (hideUI) await page.addStyleTag({ content: "#header,#controls,#info,#legend,.hint{visibility:hidden!important}" });
  if (before) await before(page);
  await page.evaluate(() => window.__view.settle(200));
  const buf = await page.screenshot();
  await page.close();
  if (file) fs.writeFileSync(file, buf);
  return buf;
}

// ---- social preview: 1200×630 scene with a title band
const scene = await shot(null, { width: 1200, height: 630, params: "site=devils-dyke&dir=326&mph=14", hideUI: true });
const title = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0b1016" stop-opacity=".92"/><stop offset="1" stop-color="#0b1016" stop-opacity="0"/></linearGradient></defs>
  <rect width="1200" height="230" fill="url(#g)"/>
  <text x="60" y="100" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="700" fill="#e8edf2">Lifty</text>
  <text x="62" y="150" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#b9c6d3">3D ridge lift &amp; rotor for paragliding sites, for any wind</text>
</svg>`);
await sharp(scene).composite([{ input: title }]).png({ compressionLevel: 9, palette: true, quality: 92 }).toFile(path.join(ROOT, "public/og-image.png"));

// ---- README screenshots
await shot(path.join(ROOT, "docs/images/desktop.png"), { width: 1440, height: 900, params: "site=devils-dyke&dir=326&mph=14" });
await shot(path.join(ROOT, "docs/images/sites.png"), {
  width: 1440, height: 900, params: "site=beachy-head&dir=146&mph=14",
  before: (p) => p.locator("#siteButton").click(),
});
await shot(path.join(ROOT, "docs/images/phone.png"), { width: 390, height: 844, params: "site=beachy-head&dir=146&mph=14", mobile: true });
await shot(path.join(ROOT, "docs/images/rotor.png"), { width: 1440, height: 900, params: "site=devils-dyke&dir=146&mph=20", hideUI: true });

// shrink the PNGs a little for the repo
for (const f of ["desktop", "sites", "phone", "rotor"]) {
  const p = path.join(ROOT, `docs/images/${f}.png`);
  const img = sharp(fs.readFileSync(p));
  const { width } = await img.metadata();
  await img.resize(Math.min(width, 1200)).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(p + ".tmp");
  fs.renameSync(p + ".tmp", p);
}
await browser.close();
console.log("wrote public/og-image.png and docs/images/{desktop,sites,phone,rotor}.png");
