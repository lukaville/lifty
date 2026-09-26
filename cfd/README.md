# CFD: simulating the airflow with OpenFOAM

The app's built-in model is fast but approximate:
- **lift** comes from linear potential flow;
- **rotor** comes from empirical rules.

This directory runs a real flow solver instead: steady RANS (Reynolds-averaged Navier–Stokes)
with OpenFOAM. Separation, recirculating rotor and flow around hills then come out of the
equations rather than rules. The results can be baked into the app, and the fast model kept
to cross-check them.

## Pipeline

```bash
node cfd/make-case.mjs <slug> <windFromDeg> [--dx 25] [--nz 28] [--iter 1200]   # -> cfd/runs/<slug>/dNNN
cfd/run.sh cfd/runs/<slug>/dNNN [nprocs]                                         # simpleFoam (Docker or native)
node cfd/extract.mjs cfd/runs/<slug>/dNNN --out cfd/runs/_bins                  # full-precision fields
node cfd/pack.mjs cfd/runs/_bins                                                 # -> public/data/cfd/ (+ index.json)
node cfd/compare.mjs <slug> <windFromDeg> [mph] --bin cfd/runs/_bins/<slug>/dNNN.bin   # CFD vs the app's model, as ASCII
```

To solve every site × 16 directions, run `cfd/batch.sh [jobs] [procs-per-job] [sites…]`.
It is resumable: directions that already have a `.bin` are skipped. Environment variables:
- `RUNS` and `OUT` set where cases and results go;
- `NODE` and `DOCKER` wrap the commands, for example `NODE="docker run … node:22-slim node"`
  on a host with an old Node, or `DOCKER="sudo docker"`.

`run.sh` uses a native OpenFOAM if `simpleFoam` is on the `PATH`. Otherwise it uses the
official `opencfd/openfoam-default:2512` Docker image, which is multi-arch and runs natively on
Apple Silicon.

## Large-eddy simulation with FluidX3D (GPU)

Steady RANS gives only the mean flow. The gusts that make rotor dangerous come from unsteady
eddies, which it averages away. So the same sites are also run as a **large-eddy simulation**
with [FluidX3D](https://github.com/ProjectPhysX/FluidX3D), a lattice-Boltzmann solver for the
GPU:

```bash
cfd/fluidx3d/build.sh                                   # fetch FluidX3D (pinned), add our setup + kernel patch, build
node cfd/lbm-case.mjs <slug> <windFromDeg> [--dx 10]     # -> cfd/runs/lbm/<slug>/dNNN/case.bin
LIFTY_CASE=$PWD/cfd/runs/lbm/<slug>/dNNN/case.bin cfd/fluidx3d/FluidX3D/bin/FluidX3D
node cfd/lbm-extract.mjs cfd/runs/lbm/<slug>/dNNN       # -> cfd/runs/_lbm/<slug>/dNNN.bin (lifty-cfd-1)
node cfd/pack.mjs cfd/runs/_lbm --calibrate cfd/runs/_bins   # -> public/data/les/ (what the app loads)
cfd/lbm-batch.sh [jobs=2] [sites…]                       # all sites × 16 directions, resumable, 2 cases per GPU
```

- **Grid.** 10 m cells (D3Q19, FP16 storage), 8 × 4.4 km × ~1 km: about 38 M cells. The
  terrain and roughness are the same as the OpenFOAM cases' (`cfd/lib/site.mjs`).
- **Turbulence.** Smagorinsky subgrid model. The domain repeats along the wind, driven by a
  pressure gradient under a top held at the log-law wind, so the boundary layer produces its
  own turbulence over about 6 km of flat fetch. Random initial disturbances and a strip of
  roughness blocks speed that up.
- **Ground.** 10 m cells can't resolve the surface layer, so the ground is **free-slip** and
  a **log-law wall model** applies the surface drag, f = −ρ (κ / ln(d/z0))² |u| u, in the first
  cell. Without that, the no-slip wall plus the subgrid viscosity gives about 15× the right
  surface stress and the near-ground wind stalls. Both are a small patch to FluidX3D's kernel,
  applied by `build.sh`.
- **Output.** After 25 min of spin-up the solver averages 30 min of flow at the app's sample
  points. Beside the mean flow it records the **gust strengths** (velocity standard
  deviations: `t` overall, `g` vertical) and the **fraction of time the flow is reversed**
  (`r`). Results are scaled by the 10 m wind measured over the flat upwind ground.
- **Cost.** On an RTX 3090 two cases share the GPU at once, about 10 min per pair (5 min
  per case). One alone leaves the GPU idle while it copies the velocity field back and samples
  it on the CPU. Only the lattice layers that hold sample points are copied, every 1.5 s of
  flow: gusts stay correlated for 5–10 s, so the statistics don't change. 8 sites × 16
  directions take about 11 h.

**Checked on Beachy Head, wind from the north** (off the cliff):
- **Upwind profile:** 1.34 / 1.60 / 1.88 × the 10 m wind at 30 / 80 / 200 m, against a log law
  of 1.21 / 1.39 / 1.56. That's the usual 10–20% log-layer mismatch of wall-modelled LES.
- **Recirculation:** the same pattern as RANS, reaching about 225 m past the cliff foot where
  RANS gives about 150 m.
- **Gusts:** vertical gusts at 30 m are 3–4× the upwind level across the whole section, more
  than 5 cliff heights downstream, well past reattachment. That's the turbulent wake, now
  simulated.

**Resolution check (5 m against 10 m).** Devil's Dyke's working directions, 315° and 337.5°,
were rerun at 5 m cells (`--dx 5 --lx 7000 --ly 4000 --top 700`: 203 M cells, 13.4 GB of VRAM,
39 min each). At 14 mph the two resolutions agree:

| | Best climb | Band top | Take-off / in-band wind | Rotor |
|---|---|---|---|---|
| 315°, 5 m / 10 m | 3.3 / 3.6 m/s | 331 / 346 ft | 14 / 14, 22 / 22 mph | 110 / 101 ha |
| 337.5°, 5 m / 10 m | 3.4 / 3.4 m/s | 361 / 469 ft | 16 / 14, 23 / 22 mph | 118 / 116 ha |

The calibration factors barely move (0.93 / 0.90 and 0.83 / 0.86). The excess wind at soaring
height therefore comes mostly from the LES surface layer (the wall-model region), not the size
of the terrain steps. The 10 m set is effectively converged in resolution, so the rest of the
site wasn't rerun.

**Wind speed calibration.** At 10 m cells the terrain is a staircase whose steps act as extra
roughness, so the LES boundary layer is too slow near the ground and 10–16% too fast at
soaring height for a given 10 m wind. Over the approach to every site, before any hill,
`pack.mjs --calibrate` scales each LES case's velocities by one factor so that its along-wind
speed at 50–180 m matches the OpenFOAM case for the same site and direction. OpenFOAM's
terrain-following mesh follows the log law. The factors are 0.76–0.92 with a median of 0.855,
about the same at every site. Packing stops if a case has no OpenFOAM counterpart. After
calibration, the wind speed at which each model first says "too strong aloft" agrees within
1–2 mph across all sites. A 5 m LES would need less correction, at 8× the cost.

**Licence.** FluidX3D is free for non-commercial use under
[its own licence](https://github.com/ProjectPhysX/FluidX3D/blob/master/LICENSE.md) and isn't
part of this repository. `build.sh` downloads it. Our changes, `fluidx3d/setup.cpp` and the
kernel patch in `build.sh`, are published here as that licence requires. If you publish work
based on these simulations, cite FluidX3D as its licence asks.

## The case

- **Mesh.** A structured, terrain-following hex grid, written directly by `make-case.mjs`
  (no snappyHexMesh):
  - rotated so the wind blows along +x;
  - 25 m cells over the site window, growing ×1.15 toward the edges of a 4.4 km domain;
  - 28 layers, the first 4 m thick, to about 1.5 km above the highest ground.
- **Ground.** The LiDAR terrain; the sea surface offshore. Woods and buildings enter two ways:
  - raised by their displacement height (0.7 × height × cover);
  - a per-face roughness length z0: grass 0.03 m, scrub 0.1 m, woods 0.1 × height (0.5–2 m),
    buildings 0.5 m, sea 0.0002 m.
- **Far field.** Outside the window the terrain relaxes smoothly to a flat plane. The plane is
  at the upwind edge's mean ground level at the inlet and the downwind edge's at the outlet.
  A single mean level would create a fake ramp out at sea at coastal sites.
- **Physics:**
  - incompressible, neutral atmosphere, `simpleFoam`;
  - the **k-ω SST** turbulence model (better than k-ε at predicting separation);
  - a Richards–Hoxey log-law inlet (U, k, ω) at 10 m/s at 10 m, with z0 = 0.05 m;
  - atmospheric rough-wall functions (`atmNutkWallFunction`, `atmOmegaWallFunction`);
  - slip top, symmetry sides, zero-pressure outlet.
- **Scaling.** In neutral flow over rough terrain the pattern is independent of wind speed, so
  each direction is solved once. `extract.mjs` stores velocities as fractions of the 10 m/s
  reference; the app multiplies them by the wind you set.

## Output

`extract.mjs` writes full-precision fields (`lifty-cfd-1`, about 2.6 MB per direction): a JSON
header line, the CFD ground (terrain + displacement) as Float32 on the app's 128² grid, then for
each of the app's terrain-following layers Int16 × 1/1000 of the reference wind:
- `w`: vertical wind;
- `s`: along-wind speed (negative means reversed flow, i.e. rotor);
- `c`: cross-wind speed;
- `t`: turbulent velocity √(2k/3).

`pack.mjs` turns these into the files the app loads (`lifty-cfd-2`, about 350 KB each, 16
directions × 8 sites ≈ 50 MB): the same fields in steps of 0.004 × the reference wind
(0.025 m/s at 14 mph), stored as differences between layers and gzipped. The browser inflates
them with `DecompressionStream`. It also writes `index.json`, the directions available per site;
the app only uses sites listed there. `compare.mjs` reads the full-precision files.

## Cost

| Mesh | Cells | Time |
|---|---:|---:|
| 73 m cells | 86k | 1 min |
| 40 m cells | 340k | 7 min |
| 25 m cells over the site | 520k | 13 min |

Times are for 1,000–1,200 iterations on 5 cores (Docker on an M-series Mac). On a 20-core x86
machine running 4 cases × 5 cores, a case takes 18–45 min (many converge in ~500 iterations), so
the full set, 16 directions × 8 sites at 25 m, takes about a day.

**Convergence.** Solves stop at the residual targets (U, k, ω 2 × 10⁻⁵). Checked on Beachy Head
from the north: running on to 2,500 iterations changes the reversed-flow area by < 0.1 ha and
vertical wind by ≤ 0.006 × the reference wind.

## Validation so far

`compare.mjs` puts the simulation next to the app's model. `cfd/synthetic.mjs` provides the
idealised shapes, each 100–150 m high, at 25 m cells.

| Case | CFD (OpenFOAM, k-ω SST) | App model | Verdict |
|---|---|---|---|
| **Windward lift**, 23° ridge | 2.8 m/s at 30 m, 2.4 at 80 m (14 mph) | 3.3 / 2.6 | agree within 10–15% |
| **Windward lift**, Devil's Dyke NW | same band shape; peak 75–80% of the linear model at 73 m cells | | agree (coarse mesh) |
| **Lift in front of a cliff** (75°) | air starts rising 2–3 H out in front; about 2× the linear model at 80 m | capped at 35° slope | linear model **underestimates** |
| **Lee of a 45° escarpment** | reversed flow ≈ 5 H long, up to ≈ 0.6 H deep | empirical rotor ≈ 5.8 H | **agree** |
| **Lee of a 23° ridge** | separates; reversed flow ≥ 4 H | empirical ≈ 2.2 H; linear sink hugs the slope | empirical **too short** |
| **Cliff top, wind onto the cliff** (75°; Beachy Head) | thin reversed-flow layer ≈ 0.3 H deep, ≈ 5–6 H long | (not modelled in production) | real; CFD is probably long |
| **Sink under a lee rotor** | ≈ −0.2 m/s | linear ≈ −1.2 m/s | linear **overestimates** |

**Against published measurements:**
- forward-facing steps reattach 1.6–4.2 step heights behind the edge, depending on geometry,
  with some studies reporting 5–10 ([Science.gov topic summary](https://www.science.gov/topicpages/h/horizontal+forward-facing+step));
- steep 2-D hills (the RUSHIL wind-tunnel benchmark) separate in the lee, and roughness
  lengthens the bubble ([LES validation, Springer](https://link.springer.com/article/10.1007/s40314-017-0435-z)).

The simulated bubbles are at the long end of these ranges. That's consistent with k-ω SST's
known tendency to overpredict separation length.

**Grid dependence:** the Beachy Head cliff-top bubble is essentially the same at 40 m and 25 m
cells.

Limitations:
- steady RANS gives the *mean* flow; it doesn't resolve gusts inside rotor, which would need
  LES at 10–100× the cost;
- the atmosphere is neutral: no thermals, inversions or lee waves;
- 25 m cells can't resolve features smaller than about 75 m.
