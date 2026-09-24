// Screenshot regression tests. The app runs in ?test mode (seeded randomness,
// frozen clock, no network imagery) and is advanced exactly N frames, so the
// same code renders the same pixels (software WebGL via SwiftShader).
// Re-baseline after an intended visual change:  npm run test:screenshots:update
import { test, expect } from "./fixtures.mjs";

const HIDE_UI = "#header, #controls, #info, #legend, .hint, #sitesPanel { visibility: hidden !important; }";

// camera presets relative to the wind (flow toward fe, fn) — same as scripts/snapshot.mjs
async function camera(page, preset) {
  await page.evaluate((preset) => {
    const v = window.__view, t = v.app.terrain, wm = t.windowM, b = (v.app.dirDeg * Math.PI) / 180;
    const ex = -Math.sin(b), en = -Math.cos(b), ty = (t.meanH - t.minH) * 1.4;
    if (preset === "profile") { v.camera.position.set(-en * 1500, ty + 120, -ex * 1500); v.controls.target.set(0, ty + 60, 0); }
    if (preset === "close") { v.camera.position.set(-ex * 380 + en * 260, ty + 260, en * 380 + ex * 260); v.controls.target.set(0, ty + 40, 0); }
    v.controls.update();
  }, preset);
}

async function scene(page, app, params, { preset, frames = 180 } = {}) {
  await app.open(params);
  await page.addStyleTag({ content: HIDE_UI });
  if (preset) await camera(page, preset);
  await app.settle(frames);
}

test.describe("scene", () => {
  test("Devil's Dyke, NW 14 mph: lift band on the face, rotor behind", async ({ page, app }) => {
    await scene(page, app, "site=devils-dyke&dir=326&mph=14");
    await expect(page).toHaveScreenshot("dyke-nw-14.png");
  });

  test("Devil's Dyke profile: the lift lens in cross-section", async ({ page, app }) => {
    await scene(page, app, "site=devils-dyke&dir=326&mph=14", { preset: "profile" });
    await expect(page).toHaveScreenshot("dyke-profile.png");
  });

  test("Devil's Dyke, wind reversed: lee rotor", async ({ page, app }) => {
    await scene(page, app, "site=devils-dyke&dir=146&mph=20");
    await expect(page).toHaveScreenshot("dyke-se-20-rotor.png");
  });

  test("Beachy Head: cliffs, sea and a coastal lift band", async ({ page, app }) => {
    await scene(page, app, "site=beachy-head&dir=146&mph=14");
    await expect(page).toHaveScreenshot("beachy-head.png");
  });

  test("Newhaven close-up: town buildings, trees, water", async ({ page, app }) => {
    await scene(page, app, "site=newhaven-cliffs&dir=180&mph=16", { preset: "close" });
    await expect(page).toHaveScreenshot("newhaven-close.png");
  });

  test("all layers off: terrain and trees only", async ({ page, app }) => {
    await app.open("site=high-and-over&dir=100&mph=14");
    for (const id of ["#tBand", "#tFlow", "#tRotor", "#tWind"]) await page.locator(id).uncheck();
    await page.addStyleTag({ content: HIDE_UI });
    await app.settle(5);
    await expect(page).toHaveScreenshot("high-and-over-terrain.png");
  });
});

test.describe("UI", () => {
  test("desktop sites panel", async ({ page, app }) => {
    await app.open("site=devils-dyke&dir=326&mph=14");
    await page.locator("#siteButton").click();
    await page.locator('.site-row[data-slug="firle"] .star').click();
    await page.locator("#siteSearch").blur();
    await app.settle(60);
    await expect(page).toHaveScreenshot("desktop-sites-panel.png");
  });

  test("desktop layout with all panels", async ({ page, app }) => {
    await app.open("site=devils-dyke&dir=326&mph=14");
    await app.settle(120);
    await expect(page).toHaveScreenshot("desktop-ui.png");
  });
});
