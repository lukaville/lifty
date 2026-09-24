# Contributing to Lifty

Thanks for helping! Useful contributions include:

- **New sites.** This is the most valuable one. See [Adding a site](#adding-a-site).
- **Bug reports**, especially "the lift band / rotor looks wrong at X in Y wind". Pilots' local
  knowledge is exactly what the model needs to be checked against. Please say where, the wind,
  and what you actually see when flying there.
- **Physics review.** The model and its assumptions are written up in
  [docs/PHYSICS.md](docs/PHYSICS.md). Corrections with references are very welcome.
- **Code:** UI, rendering, performance, accessibility, and support for other countries' LiDAR.

Please keep the tone of issues and reviews friendly and constructive.

## Contents

- [Setup](#setup)
- [How the project fits together](#how-the-project-fits-together)
- [Adding a site](#adding-a-site)
- [Making changes](#making-changes)
- [Tests](#tests)
- [Updating baselines](#updating-baselines)
- [Pull request checklist](#pull-request-checklist)

## Setup

Requires **Node 22 or newer**. There's no build step and no framework. The app is plain ES
modules served straight from `public/`.

```bash
npm install                  # dev tools only: Playwright, sharp, wrangler
npx playwright install chromium
npm run serve                # http://127.0.0.1:8123
npm test                     # everything except the live smoke test (~2 min)
```

The data scripts download to `.cache/` (git-ignored), so re-runs are fast and work offline.

## How the project fits together

```
public/                  the whole app (deployed as-is)
  js/physics.js          wind and lift physics (pure maths, runs in the browser and in Node)
  js/airviz.js           tracers, lift-band lens, rotor volumes
  js/vegetation.js       instanced trees, bushes, buildings, windsock
  js/sitebrowser.js      sites panel: search, favourites, map
  js/main.js             scene, UI wiring, status logic, URL options
  data/sites.json        site metadata (one entry per site)
  data/terrain/<slug>.json   terrain grids (generated)
  data/landcover/<slug>.*    tree/building raster + 3-D instances (generated)
scripts/                 data pipeline and dev tools
tests/unit/              node:test: unit, physics, data, golden, simulation cross-sections
tests/e2e/               Playwright: functional, sites, mobile, screenshots, smoke
docs/                    PHYSICS.md, DATA.md, ARCHITECTURE.md
```

The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `physics.js` has no browser
dependencies, so everything physical is tested in Node, and fast.

## Adding a site

A site is one entry in `public/data/sites.json` plus two generated data files. Plan on about 15
minutes, most of it checking that the result makes sense.

### 1. Gather the information

You need, ideally from the club's site guide:

- the **take-off** position: lat/lon in decimal degrees, WGS84, e.g. from a map app;
- the take-off height above sea level, and roughly how high the hill is above its foot;
- the **working-wind arc**: the wind directions (*from*) in which the site works;
- the **wind-strength band** the club recommends;
- a short description of the site, its **hazards**, and the club or guide it comes from.

Please only use information you're allowed to share. Credit the source, and link to the club's
guide rather than copying it wholesale.

### 2. Add the entry

Add an object to the `sites` array in `public/data/sites.json`:

```json
{
  "slug": "rhossili",
  "name": "Rhossili Down",
  "region": "Gower, Wales",
  "country": "GB",
  "club": "South Wales Hang Gliding & Paragliding Club",
  "clubShort": "SWHGC",
  "source": "https://example.org/sites/rhossili",
  "lat": 51.5736,
  "lon": -4.2863,
  "takeoffAmsl_ft": 600,
  "relief_ft": 550,
  "windFrom": [225, 315],
  "aspect": 270,
  "workingWind": "SW – NW",
  "strengthBand_mph": [10, 22],
  "character": "Long west-facing ridge above the beach…",
  "hazards": "Rotor behind the ridge in strong wind…"
}
```

(The club name and URL here are placeholders; use the real ones.)

| Field | Required | Meaning |
|---|---|---|
| `slug` | ✓ | unique id: lowercase letters and hyphens. Names the data files and appears in URLs (`?site=`). Don't change it later |
| `name` | ✓ | display name |
| `region` | ✓ | e.g. "South Downs, East Sussex". Shown and searchable |
| `country` | ✓ | ISO 3166-1 alpha-2 code, e.g. `GB`, `FR` |
| `lat`, `lon` | ✓ | take-off, WGS84 decimal degrees. The 3.2 km model window is centred here |
| `takeoffAmsl_ft` | ✓ | take-off height above sea level, feet. The tests check it against the terrain |
| `relief_ft` | ✓ | height of the hill above its foot, feet |
| `windFrom` | ✓ | `[from°, to°]`: the arc of directions the wind blows **from**, **clockwise** from the first to the second. `[315, 22.5]` means NW through N to NNE. Drives the "off wind" status, the wind roses and search |
| `workingWind` | ✓ | the same arc in words, e.g. `"NW – NNE"` |
| `strengthBand_mph` | ✓ | `[min, max]` recommended wind on take-off |
| `character` | ✓ | one or two sentences about the site |
| `hazards` | ✓ | the main hazards. Plain text: markup is shown literally, never rendered |
| `club`, `clubShort`, `source` | recommended | whose guide the information comes from. `source` must be an `https://` URL; it is linked from the site card |
| `aspect` | optional | the direction the main face looks toward, in degrees |
| `gridRef` | optional | local grid reference (e.g. OS grid in the UK), shown on the site card |

### 3. Build the site's data

```bash
node scripts/fetch-terrain.mjs <slug>    # global elevation tiles (sea floor, fallback terrain)
node scripts/fetch-surface.mjs <slug>    # LiDAR + satellite imagery -> terrain, trees, buildings
```

This writes `public/data/terrain/<slug>.json` and `public/data/landcover/<slug>.{png,json}`.

- **In England** the terrain is the Environment Agency's 1 m LiDAR, with trees, hedges and
  buildings detected from it. The script prints how many of each it found. Expect thousands of
  trees at a typical downland site.
- **Outside England** the script says so and falls back to the ~30 m global elevation model,
  with no trees or buildings. The app still works, with coarser terrain. Plugging in another
  country's open LiDAR is a welcome contribution: see [docs/DATA.md](docs/DATA.md).

### 4. Check that it makes sense

This is the important step. The model is only as good as its data.

```bash
npm run serve
open "http://127.0.0.1:8123/?site=<slug>"             # the new site, default wind
node scripts/section.mjs <slug> <windFromDeg> 14      # ASCII cross-section of the lift band
npm run analyse-lift                                  # ceilings and climbs for every site
```

Things to look for:

- **Take-off position.** The yellow windsock should stand on the take-off. If it's off, fix
  `lat`/`lon`.
- **Default wind.** It is the middle of your `windFrom` arc, and the status should say "Good
  soaring window" or "Light". If it says "Off wind", the arc is probably reversed: it's the
  direction the wind comes *from*, clockwise.
- **Lift band.** It should sit over the windward face, mostly in its upper half, with rotor
  behind the crest. Compare with what pilots actually experience there.
- **Trees and buildings (England).** Toggle **Trees**. Woods and villages should match the
  satellite imagery, with no tall "trees" on bare cliffs or over water.

### 5. Run the tests and add golden values

```bash
npm run test:unit            # data tests check the new files; the golden test asks you to:
npm run test:golden:update   # pin the new site's physics numbers
npm run test:e2e             # the browser tests cover every site automatically
```

The data tests check:
- the site entry is complete and well-formed;
- its terrain and landcover decode;
- the take-off height matches the terrain: within 15 m with LiDAR, 40 m without;
- there are no phantom trees on cliff faces.

### 6. Open a pull request

Include:
- the site and where its information comes from;
- a screenshot of the site in a working wind;
- anything that looked surprising in step 4.

Commit the generated data files. Don't commit anything from `.cache/`.

## Making changes

- **Style.** Match the surrounding code: plain ES modules, no frameworks, no build step, and
  comments that explain *why*. There is no formatter configured; keep lines under ~130
  characters and follow `.editorconfig`.
- **Physics changes** need a reason: a reference, a validation, or a pilot report. Describe the
  effect in the PR. The golden numbers and the simulation cross-sections will change: include
  the before/after images or numbers.
- **Site data is untrusted input.** Put it in the page with `textContent`, never `innerHTML`.
  There's a test for this.
- **Dependencies.** The app has no runtime npm dependencies; libraries are vendored under
  `public/vendor/`. Please keep it that way. Adding a dev dependency is fine if it earns its
  place.
- **Licensing.** Don't commit satellite imagery or anything derived from it, except the landcover
  classification and the README screenshots (`scripts/make-images.mjs`, credited in the README).
  Test baselines use `?test` mode, which has no imagery.

## Tests

| Command | Runs | Time |
|---|---|---|
| `npm run test:unit` | unit, physics, data, golden, simulation cross-sections (Node) | ~5 s |
| `npm run test:e2e` | Playwright: functional, sites, mobile, screenshots (desktop + phone) | ~2 min |
| `npm test` | both | |
| `npm run verify:live` | smoke tests against the deployed site | ~1 min |

What each layer guards:

- **Unit:** FFT, coordinate conversion, PNG codec, landcover decoding, wing polars, wind
  profile, site search and favourites, the static server.
- **Physics on synthetic hills with known answers:**
  - still air over flat ground;
  - lift upwind of the crest, and crest speed-up in the Askervein range;
  - mirror symmetry and linearity;
  - the band confined to the upper slope;
  - paragliders blown back in strong wind;
  - rotor length versus lee steepness;
  - tree wakes within 5–10 H;
  - a performance budget.
- **Data:** every site's files are complete, consistent and plausible.
- **Golden physics:** per-site ceilings, climbs, winds and rotor coverage pinned in
  `tests/golden/physics.json`.
- **Simulation cross-sections:** 14 images of the wind solution itself, for different hill
  shapes with the wind onto and off the hill, pixel-compared with `tests/golden/sections/`.
  Each also asserts basic physics, so a baseline can't silently lock in nonsense.
- **Browser:**
  - every control and site, and races between site loads;
  - failure modes: no landcover, no imagery;
  - the phone layout and its gestures;
  - markup injection from site data.

  Any console error fails a test.
- **Screenshots:** the 3D scene and the UI on desktop and phone.

The browser tests run the app in `?test` mode, which makes rendering deterministic:
- seeded randomness;
- no network imagery;
- time advances only through `window.__view.settle(n)`;
- software WebGL (SwiftShader).

## Updating baselines

Baselines are the point of the tests. **Update them only for an intended change, and look at
what changed before committing.**

```bash
npm run test:golden:update          # physics numbers only
UPDATE_GOLDEN=1 npm run test:unit   # physics numbers + simulation cross-sections
npm run test:screenshots:update     # viewer screenshots, for your platform
```

On a mismatch:
- the simulation test writes `test-results/sections/<name>.{actual,diff}.png`;
- Playwright writes `test-results/<test>/…-{actual,expected,diff}.png`, and `npx playwright
  show-report` shows them side by side.

Viewer screenshots are per platform (`tests/e2e/__screenshots__/<project>/<platform>/`),
because font and edge rendering differ between operating systems. CI runs on Linux. To generate
or refresh its baselines, run the **tests** workflow manually with **update_screenshots**, then
commit the images it uploads. `scripts/docker-e2e.sh` runs the browser tests in the same Linux
image locally.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] If physics or data changed, the goldens are updated and the diffs explained.
- [ ] If visuals changed, the screenshots are updated and reviewed.
- [ ] New sites: data files committed, sources credited, and a screenshot in the PR.
- [ ] Docs updated if behaviour changed (README, `docs/`, AGENTS.md).
