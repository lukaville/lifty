# Architecture

A static web app: no build step, no server code. `public/` is served as-is (locally by `scripts/serve.mjs`, in production by a static-assets-only Cloudflare Worker).

## Rendering
[Three.js](https://threejs.org) r160, vendored under `public/vendor`. The scene has:
- **Satellite-draped LiDAR terrain**, streamed from Esri at z16. It falls back to elevation
  colours offline.
- ACES tone mapping, a sky dome, soft sun shadows and a diorama skirt.
- **Instanced 3-D models** for every detected object, each sized and tinted from its own
  measurements:
  - trees: lumpy crowns and trunks;
  - bushes;
  - buildings: walls with gabled or flat roofs.
- A **windsock** on take-off. It droops in light air and streams out from ~15 kt.

The air is drawn from the physics fields, not on a grid:
- **Wind tracers.** 2,600 air parcels are advected through the 3-D velocity field: along-wind,
  cross-wind (deflection around hills) and vertical, in terrain-following coordinates. They are
  drawn as fading streak trails. Colour shows what your wing would feel:
  - violet = usable climb;
  - white = no usable lift for your wing;
  - orange/red = rotor. In rotor, an Ornstein–Uhlenbeck eddy velocity scaled to the local
    turbulence visibly kicks the tracers around.
- **Lift band.** A translucent **violet** lens enclosing the usable air, with top and bottom
  surfaces. Soft contours every 25 ft and a bold one every 100 ft show its 3-D shape. Violet
  (as in pilots' lift-band diagrams) appears nowhere in grass, woods, chalk or sea, so the band
  reads over every site.
- **Rotor.** Translucent volumes over the turbulent air, with gently drifting stripes:
  orange-red for terrain rotor, amber for significant tree and building wakes. Swirling smoke
  sprites inside them add motion.
- **Sea.** A wave shader:
  - 12 wind-driven wave trains with deep-water dispersion, plus multi-scale chop, faded below
    pixel size to avoid aliasing;
  - Fresnel sky reflection, sun glint and glitter;
  - colour matched to a photo off Newhaven and graded by the real bathymetry, from turquoise
    shallows to deep blue;
  - shoreline surf, and whitecaps above ~12 kt.

  Over the sea the LiDAR "ground" is the water surface, so the seabed depth comes from the
  terrarium bathymetry.

**On phones** (≤ 760 px) the layout changes:
- a top bar with the sites as scrollable chips;
- a compact status card, which you tap for site details, hazards and credits;
- a bottom wind sheet: collapsed to a summary line and the wind slider, and expanded to the
  dial, lift threshold, wing and toggles;
  - swipe up to open it and swipe down to close it, from the handle or anywhere on the sheet
    once it's scrolled to the top (drags that start on sliders, the dial or the wing selector
    still adjust them);
  - tapping the map closes whichever panel is open;
- the camera backs off for portrait screens and centres the site in the gap between the panels;
- a lighter GPU load (1.5× pixel ratio, 2048² shadows, 1,300 tracers).

`MOBILE=1 node scripts/snapshot.mjs …` renders it in an emulated phone.

Vertical exaggeration is 1.4×. It applies equally to terrain, trees and buildings, so the air
lines up with them; all physics uses true metres.

## Project layout

```
lifty/
├── public/                       # the whole app, deployed as-is
│   ├── index.html                # UI shell, styles, meta tags
│   ├── manifest.webmanifest, robots.txt, og-image.png, icons/
│   ├── js/
│   │   ├── main.js               # scene, terrain, lighting, UI, status, URL options, test hooks
│   │   ├── physics.js            # FFT lift solver, polars, rotor + obstacle-wake models
│   │   ├── airviz.js             # tracers, lift-band lens, rotor volumes
│   │   ├── vegetation.js         # instanced trees, bushes, buildings, windsock
│   │   ├── sitebrowser.js        # sites panel: search, favourites, map
│   │   ├── imagery.js            # satellite texture (Esri tiles -> canvas -> UVs)
│   │   ├── landcover.js          # landcover raster decoder
│   │   ├── rng.js                # seeded randomness for test mode
│   │   └── fft.js                # radix-2 FFT
│   ├── data/
│   │   ├── sites.json            # site metadata (schema: CONTRIBUTING.md)
│   │   ├── terrain/<slug>.json   # terrain grids (physics 128², render 512²)
│   │   └── landcover/<slug>.*    # obstacle raster (.png) + 3D instances (.json)
│   └── vendor/                   # three.js + OrbitControls, Leaflet
├── scripts/
│   ├── fetch-terrain.mjs         # terrarium DEM (sea floor, fallback)
│   ├── fetch-surface.mjs         # LiDAR + imagery -> terrain, landcover, 3D instances
│   ├── lib/osgb.mjs, lib/png.mjs # WGS84 -> British National Grid; PNG codec
│   ├── serve.mjs                 # static server (no deps; mirrors production 404s)
│   ├── section.mjs, ideal-ridge.mjs, analyse-lift.mjs   # physics inspection tools
│   ├── snapshot.mjs, make-images.mjs                    # screenshots, README/social images
│   └── docker-e2e.sh             # browser tests in the Linux Playwright image
├── tests/
│   ├── unit/                     # node:test: unit, physics, data, golden, cross-sections
│   ├── e2e/                      # Playwright: functional, sites, mobile, screenshots, smoke
│   ├── helpers/                  # synthetic terrain, cross-section renderer
│   └── golden/                   # physics.json + simulation cross-section PNGs
├── docs/                         # PHYSICS.md, DATA.md, ARCHITECTURE.md, images/
├── README.md, CONTRIBUTING.md, AGENTS.md, LICENSE
├── playwright.config.mjs, wrangler.jsonc, package.json
└── .github/                      # CI workflow, issue and PR templates
```

## URL options and test hooks

| Option | Effect |
|---|---|
| `?site=<slug>&dir=<deg>&mph=<n>&lift=<m/s>&wing=<key>` | open at that state (values are clamped; unknown ones are ignored) |
| `?imagery=off` | elevation colours instead of satellite imagery |
| `?test[&seed=n]` | deterministic mode for tests: seeded randomness, no imagery, render loop stopped |

`window.__view` exposes the app for tests and debugging:
- `app`: all state;
- `recompute()` and `loadSite(slug)`;
- `whenIdle()`: resolves when no load or recompute is pending;
- `settle(frames)`: advances the animation and renders, in test mode.

## Deploying

The app is static: `public/` is uploaded as-is.

| Where | How | When |
|---|---|---|
| **https://liftyapp.pages.dev** (main site) | Cloudflare Pages: `npm run deploy:pages` | by hand, for releases |
| **https://liftyautopush.pages.dev** (head of `main`) | Cloudflare Pages via `.github/workflows/deploy-autopush.yml` | automatically on every push to `main`, after the unit tests pass |

To check a deployment:

```bash
npm run verify:live        # smoke tests against liftyapp.pages.dev
npm run verify:autopush    # … against liftyautopush.pages.dev
```

The auto-deploy needs a `CLOUDFLARE_API_TOKEN` secret (a token with *Account · Cloudflare
Pages · Edit*) and a `CLOUDFLARE_ACCOUNT_ID` variable in the repository's Actions settings.
Without them it skips deployment with a warning.

`public/404.html` matters. Without a top-level 404 page, Pages treats the site as a single-page
app and answers every missing URL with `index.html` and a `200`. A missing terrain file would
then fail silently instead of loudly. The smoke tests check that missing files are real 404s.

`wrangler.jsonc` still describes the earlier Workers deployment (`npm run deploy`), which serves
the same `public/` directory.
