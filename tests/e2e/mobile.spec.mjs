// Phone layout and touch gestures (390×844, touch).
import { test, expect } from "./fixtures.mjs";

// real touch events through the DevTools protocol (swipes, not just taps)
async function swipe(page, x, y1, y2, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await send("touchStart", y1);
  for (let i = 1; i <= steps; i++) await send("touchMove", y1 + ((y2 - y1) * i) / steps);
  await send("touchEnd", y2);
  await cdp.detach();
  await page.waitForTimeout(350);
}
const sheetOpen = (page) => page.locator("#controls").evaluate((el) => el.classList.contains("open"));
const sheetTop = async (page) => (await page.locator("#controls").boundingBox()).y;

test.beforeEach(async ({ app }) => app.open());

test("phone layout: site button, compact card, collapsed wind sheet, no legend", async ({ page }) => {
  await expect(page.locator("#legend")).toBeHidden();
  await expect(page.locator(".hint")).toBeHidden();
  await expect(page.locator("#sheetHandle")).toBeVisible();
  await expect(page.locator("#sheetSummary")).toHaveText(/Wind \d+° [NSEW]+ · \d+ mph/);
  await expect(page.locator("#dial")).toBeHidden();                 // collapsed: only summary + speed
  await expect(page.locator("#speed")).toBeVisible();
  await expect(page.locator("#info .details")).toBeHidden();
  await expect(page.locator("#siteButtonName")).toHaveText("Devil's Dyke");
  // nothing overflows the viewport horizontally
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("tap the handle to open and close the sheet", async ({ page }) => {
  await page.locator("#sheetHandle").tap();
  expect(await sheetOpen(page)).toBe(true);
  await expect(page.locator("#dial")).toBeVisible();
  await expect(page.locator("#sheetHandle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#sheetHandle").tap();
  expect(await sheetOpen(page)).toBe(false);
});

test("swipe up opens the sheet, swipe down closes it", async ({ page }) => {
  let top = await sheetTop(page);
  await swipe(page, 195, top + 20, top - 160);
  expect(await sheetOpen(page)).toBe(true);
  top = await sheetTop(page);
  await swipe(page, 195, top + 20, top + 260);                       // on the handle
  expect(await sheetOpen(page)).toBe(false);
});

test("swipe down on the sheet body closes it; dragging a slider does not", async ({ page }) => {
  await page.locator("#sheetHandle").tap();
  const top = await sheetTop(page);
  const slider = await page.locator("#minLift").boundingBox();
  await swipe(page, slider.x + slider.width * 0.5, slider.y + slider.height / 2, slider.y + 200);
  expect(await sheetOpen(page), "slider drag keeps the sheet open").toBe(true);
  const readout = await page.locator("#dirDeg").boundingBox();
  await swipe(page, readout.x + 10, readout.y + 5, readout.y + 260);
  expect(await sheetOpen(page), "swipe on the body closes").toBe(false);
  expect(top).toBeGreaterThan(0);
});

test("a short swipe snaps back open", async ({ page }) => {
  await page.locator("#sheetHandle").tap();
  const top = await sheetTop(page);
  await swipe(page, 195, top + 20, top + 40, 3);
  expect(await sheetOpen(page)).toBe(true);
});

test("tapping the map closes the open panel", async ({ page }) => {
  await page.locator("#sheetHandle").tap();
  await page.touchscreen.tap(195, 430);
  await page.waitForTimeout(300);
  expect(await sheetOpen(page)).toBe(false);
});

test("site card and wind sheet are mutually exclusive", async ({ page }) => {
  await page.locator("#info").tap();
  await expect(page.locator("#info .details")).toBeVisible();
  await expect(page.locator("#info .mobile-credit a")).toHaveAttribute("href", "https://github.com/lukaville/lifty");
  await page.locator("#sheetHandle").tap();
  await expect(page.locator("#info .details")).toBeHidden();
  await page.locator("#info").tap();
  expect(await sheetOpen(page)).toBe(false);
});

test("the sheet summary follows the wind", async ({ page, app }) => {
  await app.setSpeed(18);
  await expect(page.locator("#sheetSummary")).toHaveText(/· 18 mph/);
});

test("the sites panel is full-screen and picks a site", async ({ page, app }) => {
  await page.locator("#siteButton").tap();
  const box = await page.locator("#sitesPanel").boundingBox();
  expect(box.width).toBe(390); expect(box.height).toBe(844);
  await app.pickSite("firle", { touch: true });
  await expect(page.locator("#sitesPanel")).toBeHidden();
  await expect(page.locator("#siteName")).toHaveText("Firle");
});

test("opening the sites panel closes the wind sheet", async ({ page }) => {
  await page.locator("#sheetHandle").tap();
  await page.locator("#siteButton").tap();
  expect(await sheetOpen(page)).toBe(false);
});

test.describe("screenshots", () => {
  test("phone: collapsed sheet", async ({ page, app }) => {
    await app.settle(120);
    await expect(page).toHaveScreenshot("phone-collapsed.png");
  });
  test("phone: expanded wind sheet", async ({ page, app }) => {
    await page.locator("#sheetHandle").tap();
    await page.waitForTimeout(400);
    await app.settle(120);
    await expect(page).toHaveScreenshot("phone-sheet-open.png");
  });
  test("phone: sites panel", async ({ page, app }) => {
    await page.locator("#siteButton").tap();
    await page.locator(".site-row .star").nth(2).tap();
    await app.settle(60);
    await expect(page).toHaveScreenshot("phone-sites.png");
  });
  test("phone: site details open", async ({ page, app }) => {
    await page.locator("#info").tap();
    await app.settle(120);
    await expect(page).toHaveScreenshot("phone-details.png");
  });
});
