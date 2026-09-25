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
node cfd/extract.mjs cfd/runs/<slug>/dNNN                                        # -> public/data/cfd/<slug>/dNNN.bin
node cfd/compare.mjs <slug> <windFromDeg> [mph] [--at e,n]                        # CFD vs the app's model, as ASCII
```

`run.sh` uses a native OpenFOAM if `simpleFoam` is on the `PATH`. Otherwise it uses the
official `opencfd/openfoam-default:2512` Docker image, which is multi-arch and runs natively on
Apple Silicon.

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

## Output (`dNNN.bin`)

A JSON header line, then:
- the CFD ground (terrain + displacement), Float32 on the app's 128² grid;
- for each of the app's terrain-following layers, Int16 × 1/1000:
  - `w`: vertical wind;
  - `s`: along-wind speed (negative means reversed flow, i.e. rotor);
  - `c`: cross-wind speed;
  - `t`: turbulent velocity √(2k/3).

About 2.6 MB per direction per site.

## Cost

| Mesh | Cells | Time |
|---|---:|---:|
| 73 m cells | 86k | 1 min |
| 40 m cells | 340k | 7 min |
| 25 m cells over the site | 520k | 13 min |

Times are for 1,000–1,200 iterations on 5 cores (Docker on an M-series Mac). A full set, 16
directions × 8 sites at 25 m, is about 28 hours on this setup: roughly half that natively on
10 cores, or a few hours on a rented many-core machine.

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
