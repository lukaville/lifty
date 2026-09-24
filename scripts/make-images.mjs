// Regenerate the social preview (public/og-image.png) and the README
// screenshots (docs/images/*.png).
//   · README screenshots use the real satellite imagery; the README carries
//     the imagery attribution.
//   · The social preview is rendered in ?test mode (elevation colours, no
//     imagery), because a link preview can't carry an attribution line.
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

async function shot(file, { width, height, params, hideUI = false, mobile = false, before, imagery = false }) {
  const page = await browser.newPage(mobile
    ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${URL_}?${imagery ? "" : "test&"}${params}`);
  await page.waitForFunction(() => window.__view?.app?.viz && !window.__view.app.loading, null, { timeout: 90_000 });
  await page.evaluate(() => window.__view.whenIdle());
  if (imagery) await page.waitForFunction(() => window.__view.app.satLoaded, null, { timeout: 60_000 });
  if (hideUI) await page.addStyleTag({ content: "#header,#controls,#info,#legend,.hint{visibility:hidden!important}" });
  if (before) await before(page);
  if (imagery) await page.waitForTimeout(4000);       // live render loop: let tracers fill in
  else await page.evaluate(() => window.__view.settle(200));
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
await shot(path.join(ROOT, "docs/images/desktop.png"), { width: 1440, height: 900, params: "site=devils-dyke&dir=326&mph=14", imagery: true });
await shot(path.join(ROOT, "docs/images/rotor.png"), { width: 1440, height: 900, params: "site=devils-dyke&dir=146&mph=20", hideUI: true, imagery: true });

// README screenshots contain satellite photography: JPEG, not a palette PNG
// (palette quantisation smears the panel text)
for (const f of ["desktop", "rotor"]) {
  const src = path.join(ROOT, `docs/images/${f}.png`);
  const img = sharp(fs.readFileSync(src));
  const { width } = await img.metadata();
  await img.resize(Math.min(width, 1400)).jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(ROOT, `docs/images/${f}.jpg`));
  fs.unlinkSync(src);
}
await browser.close();
console.log("wrote public/og-image.png and docs/images/{desktop,rotor}.jpg");
