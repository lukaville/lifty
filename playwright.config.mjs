// Browser tests: functional (desktop + mobile), screenshot regression, and a
// smoke suite for the deployed site.
//   npm run test:e2e                     functional + screenshots, local server
//   npm run test:screenshots:update      re-baseline screenshots after an intended change
//   BASE_URL=https://… npm run test:smoke
import { defineConfig } from "@playwright/test";

const PORT = 8124;
const LOCAL = `http://127.0.0.1:${PORT}`;
// Software WebGL (SwiftShader): identical pixels on any machine / CI runner
const webgl = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
    // SwiftShader renders bit-identically run to run, so tolerances can be tight
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.05, animations: "disabled", timeout: 60_000 },
  },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{platform}/{arg}{ext}",
  use: {
    baseURL: LOCAL,
    trace: "retain-on-failure",
    launchOptions: { args: webgl },
  },
  webServer: process.env.BASE_URL ? undefined : {
    command: `node scripts/serve.mjs ${PORT}`,
    url: LOCAL,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "desktop",
      testMatch: /(functional|sites|screenshots)\.spec\.mjs/,
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.mjs/,
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
    },
    {
      name: "smoke",
      testMatch: /smoke\.spec\.mjs/,
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, baseURL: process.env.BASE_URL || LOCAL },
    },
  ],
});
