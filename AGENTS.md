# Guide for coding agents

This file is for AI coding agents (and humans in a hurry) working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PHYSICS.md](docs/PHYSICS.md) before
changing rendering or physics.

## What this is

Lifty: a static, build-free web app that models wind over real terrain and shows
the ridge lift and rotor at paragliding sites. `public/` is the whole app, plain ES modules and
three.js. Physics runs in the browser, and in Node for tests.

## Commands

```bash
npm run serve                  # http://127.0.0.1:8123 (scripts/serve.mjs, no deps)
npm run test:unit              # ~5 s: unit, physics, data, golden, simulation cross-sections
npm run test:e2e               # ~2 min: Playwright desktop + mobile (starts its own server on :8124)
npm test                       # both
npx playwright test -g "<name>"            # one browser test
node --test tests/unit/physics.test.mjs    # one unit file
node scripts/section.mjs <slug> <dirDeg> <mph>   # ASCII cross-section: a fast physics sanity check
node scripts/snapshot.mjs <slug> <dir> <mph> out.png   # screenshot (TEST=1 deterministic, MOBILE=1, CAM=profile|close|side)
```

Always run `npm run test:unit` after touching `public/js/physics.js`, `scripts/fetch-surface.mjs`
or `public/data/`. Run the browser tests after touching `public/js/main.js`, `airviz.js`,
`sitebrowser.js`, `vegetation.js` or `index.html`.

## Rules

1. **Don't update baselines to make a test pass.** Golden numbers
   (`tests/golden/physics.json`), simulation cross-sections (`tests/golden/sections/*.png`) and
   screenshots (`tests/e2e/__screenshots__/`) encode the expected behaviour. A failing baseline
   is either a regression, which you fix, or an intended change. For an intended change:
   - regenerate (`npm run test:golden:update`, `UPDATE_GOLDEN=1 npm run test:unit`,
     `npm run test:screenshots:update`);
   - **look at the new images/numbers**;
   - say in your summary what changed and why.
2. **Physics must stay physical.**
   - Any change needs a reason: a reference, a validation against exact potential flow, or a
     pilot report.
   - Keep the synthetic-hill tests in `tests/unit/physics.test.mjs` passing. They encode
     physics, not implementation.
   - Don't tune constants to make one site look nicer.
   - Quote numbers from `scripts/section.mjs` / `npm run analyse-lift`, not from memory.
3. **Site data is untrusted.** Anything from `sites.json` goes into the DOM through
   `textContent` or `esc()` in `sitebrowser.js`, never raw `innerHTML`. A test injects markup
   to check.
4. **No runtime dependencies and no build step.** Vendor browser libraries under
   `public/vendor/`. Dev-only npm packages are fine.
5. **Licensing.**
   - Don't commit satellite imagery itself. The only screenshots containing it are the README
     images from `scripts/make-images.mjs`, credited in the README. Test baselines and the
     social preview use `?test` mode, which has no imagery.
   - The LiDAR-derived data is OGL and fine to commit.
   - Keep the attribution strings in the app and the README.
6. **Keep docs in step.**
   - Behaviour changes go in the relevant `docs/*.md` and, if user-visible, the README.
   - New commands or rules go here.

## Where things are

| Area | Files |
|---|---|
| Lift, wind profile, polars, rotor, obstacle wakes | `public/js/physics.js`, `public/js/fft.js` |
| Tracers, lift-band lens, rotor volumes | `public/js/airviz.js` |
| Trees, buildings, windsock (instanced meshes) | `public/js/vegetation.js` |
| Scene, UI, status text, URL options, test hooks | `public/js/main.js`, `public/index.html` |
| Site list, search, favourites, map | `public/js/sitebrowser.js` |
| Satellite texture | `public/js/imagery.js` |
| Data pipeline | `scripts/fetch-terrain.mjs`, `scripts/fetch-surface.mjs`, `scripts/lib/` |
| Site metadata | `public/data/sites.json` (schema: CONTRIBUTING.md → Adding a site) |
| Test helpers (synthetic terrain, section renderer) | `tests/helpers/` |
| OpenFOAM (RANS) and FluidX3D (GPU LES) simulation pipelines | `cfd/` (see `cfd/README.md`) |
| Loading and blending the OpenFOAM results in the app | `public/js/cfd.js`, `public/data/cfd/` |

## Gotchas

- **Test mode.** `?test` seeds randomness (`public/js/rng.js`), disables network imagery, and
  **stops the render loop**. Nothing animates or redraws until `window.__view.settle(frames)`.
  - Tests wait with `window.__view.whenIdle()`.
  - A screenshot taken without `settle()` shows a stale frame.
- **Tracers and rotor sprites use separate seeded random streams** (`stream()` in `rng.js`), so a
  change in one doesn't move the other in screenshots. Keep new random consumers on their own
  stream too.
- **Software WebGL is slow**, several seconds per frame at 3× DPR. Keep test viewports at DPR 1–2
  and avoid per-frame waits.
- **Heights and arcs:**
  - `windFrom` arcs are directions the wind blows *from*, clockwise, and may wrap through north
    (`[315, 22.5]`).
  - Flow vectors in the code point where the wind *goes*: `fe = -sin(dir)`, `fn = -cos(dir)`.
  - World space: x = east, z = −north, y = up, with heights × `EXAG` (1.4). Physics uses metres,
    x = east, y = north.
- **Terrain-following layers.** Lift fields are sampled at heights above the *effective*
  surface: ground, raised by canopy displacement and filled over separation bubbles. That is
  `field.base`, not the DEM.
- **Two flow models.** Sites listed in `public/data/cfd/index.json` use precomputed OpenFOAM
  fields; everything else uses `physics.js`. Test mode uses `physics.js` unless `?cfd=on`, so
  screenshot baselines don't change when new simulation results land. Compare the two with
  `QUERY=cfd=on` / `QUERY=cfd=off` on `scripts/snapshot.mjs`.
- **Data pipeline caches.** Everything downloaded goes to `.cache/`. Outside England the
  Environment Agency service returns zeros, not nodata; `readTiff` treats exact 0 as missing.
- **Screenshot baselines are per platform.** macOS baselines are committed; Linux ones come
  from CI (see CONTRIBUTING.md). Don't hand-copy baselines between platforms.
- **Mobile layout.** Panels are mutually exclusive on phones (`setSheet`, the info card, the
  sites panel), and `fitViewToPanels()` shifts the camera centre into the visible gap. Call it
  after changing a panel's size.

## Before you finish

- [ ] `npm test` passes.
- [ ] If baselines changed, you looked at them and explained why.
- [ ] Docs updated (README / docs / this file).
- [ ] No imagery, secrets or `.cache/` files committed.
