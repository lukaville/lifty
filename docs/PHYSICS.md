# How the physics works

> Numbers quoted on this page come from `npm run analyse-lift` and `node scripts/section.mjs`; the
> tests in `tests/unit/physics.test.mjs` and `tests/golden/` pin the behaviour described here.

Everything is derived from the real elevation grid of each site, the LiDAR landcover, and the wind you set. All physics runs in the browser (`public/js/physics.js`) and uses true metres; the 3D view is vertically exaggerated 1.4× for clarity.

By default the app shows **precomputed large-eddy simulations** of every site (see
[Simulated airflow](#simulated-airflow)). The fast model below is used only with `?cfd=off`;
the two are never mixed.

Contents: ridge lift · terrain-following heights · wind gradient · local wind speed · sea surface · flow separation · net climb · rotor · vegetation · what is not modelled.

## Ridge lift — linear potential-flow theory
For streaming (neutral, non-separated) flow over terrain the vertical wind is governed by:

- **Surface boundary condition:** `w = U · ∇h`. The air is pushed up where the wind climbs
  a windward slope.
- **Vertical structure:** each terrain wavelength decays with height as `exp(-|k|·d)` (the
  irrotational/Laplace solution). Long features (the main ridge) reach high and small bumps
  decay fast. This puts the classic lift band **above and in front of the crest**.

The field is solved in the **spectral domain via FFT** (`public/js/fft.js`,
`public/js/physics.js`). The along-wind **speed-up** over the crest comes from the same
potential (`Ŝ = −i(k·f)/|k|·Ŵ`). Both fields are real, so they are packed into one complex
inverse FFT and cost nothing extra. A full recompute takes about 20 ms.

### Terrain-following heights (validated against exact potential flow)
The field is evaluated at **height above local ground**, the WAsP convention. Before, it was
evaluated on flat planes at the mean terrain height. To choose between them, the two
linearisations were compared against an **exact 2-D potential-flow solution**, computed by
conformal mapping, over Gaussian ridges with slopes of 22–30°:

| 2-D ridge, 150 m high, 23° max slope | exact | flat-plane (old) | terrain-following (new) |
|---|---:|---:|---:|
| `w/U`, 150 m upwind of crest, 30 m AGL | 0.37 | 0.18 | 0.32 |
| `w/U`, 250 m upwind, 100 m AGL (25 m above crest) | 0.27 | 0.19 | 0.24 |
| peak `w/U` | 0.45 | 0.37 | 0.43 |

The flat-plane version underestimated lift near the crest by 1.5–3×, which is exactly where
pilots soar. Terrain-following heights stay within about 10–25% of the exact answer, and even
then they slightly *under*-predict.

### Wind gradient (boundary layer)
The slider is the **forecast-style 10 m wind over open ground upwind**. The wind follows a
logarithmic profile (roughness `z0 = 5 cm`, downland/farmland), so it is weaker near the grass
and stronger aloft. As in Jackson–Hunt hill-flow theory, the hill's perturbation is driven by
the wind at the **middle-layer height** (~80 m). Below that height `w` follows the log profile
down to zero at the ground. Above it `w` does *not* keep growing, because in sheared flow it is
`w` itself that decays as `e^{-|k|d}`. The **horizontal** wind a glider has to penetrate keeps
growing with height. The app reports the resulting **wind on take-off** and the wind at 200 ft.
Take-off wind is quoted at **~2 m, the height of a hand-held anemometer**, because the sites'
strength bands come from readings like that. With simulated fields it's derived from the
wind at 30 m, brought down with the log law: the simulations' lowest cells sit inside their
wall models and don't resolve the bottom few metres.

**Penetration** ("too strong aloft") is judged against the median wind in the rising air, the
air that climbs faster than the wing's best sink, clear of the surface and of rotor. That's
where a pilot soars. The wind straight above the take-off crest is the most sped-up spot on
the hill, and judging by it flags good soaring days as too strong.

### Local wind speed, the compression zone and the dead air at the foot
Linear theory gives the streamline slope correctly, but it multiplies that slope by the
*undisturbed* wind speed. Real air moves along the streamline at the *local* speed:
`w = u_local × slope`. The air slows at the windward foot (adverse pressure) and speeds up
toward the crest (the venturi, or "compression zone"). Using the local speed therefore moves
lift off the lower slope and concentrates it just in front of the crest edge.

This was checked against the **exact 2-D potential-flow solution**. On the upper slope,
uncorrected linear theory was 20–35% low; the correction brings it to within about 10%. The
correction also slightly lowers the foot.

Near the ground the effect is stronger. In the Jackson–Hunt / Hunt–Leibovich–Richards **inner
layer**, the hill's pressure field acts on slow near-surface air. The potential-flow *surface*
speed change is therefore amplified by `(U(hm)/U(z))² = (ln(hm/z0)/ln(z/z0))²`, about 2× at 10 m.
That gives the classic ≈2H/L near-surface speed-up. It is capped at −70% / +80%, which brackets
the largest speed-ups measured on real hills (Askervein about +80–100% at 10 m).

Over the Devil's Dyke face at 10 m, the air slows to **0.56×** at the foot and speeds up
**1.56×** at the crest. Slow air at the bottom and fast air at the top, times the slope, is
what puts ridge lift in the upper part of the hill.

### Sea surface
The DEM contains **bathymetry**, which reaches −15 m off Beachy Head and Newhaven and covers
about half of those grids. Air flows over the sea surface, not the seabed, so the physics uses
`max(h, 0)` and the seabed is used only for rendering. Before this fix, seabed relief produced
spurious lift and sink over the water and exaggerated the cliff heights.

### Flow separation
Raw linear theory blows up on steep ground. A 61° DEM cell at Beachy Head produced an updraught
of 2.4× the wind speed, which cannot happen in attached flow.

- **Windward:** the surface gradient is **clamped to 35°**, keeping its direction. This bounds
  the updraught to `|U|·tan 35°`. The clamp is applied in physical space, before the forward
  FFT.
- **Lee:** where the flow has to descend a lee slope steeper than **~18°** (the separation
  threshold for rough ridges), it separates. The outer flow then rides over the separated shear
  layer, which descends at **~9°** and reattaches about 6 obstacle heights downstream. That
  envelope is filled into the surface the lift solver sees. The lee therefore shows a wake
  instead of potential-flow sink hugging a cliff face. The same envelope drives the rotor model.

## What "lift" means here — net climb, not raw updraught
A paraglider is always descending through the air, so air rising at 0.5 m/s is *not* lift.
Only air rising **faster than the wing sinks** is soarable. The app renders **net climb**, the
same thing a vario reads, and draws nothing below zero. The top of the violet band is the realistic
**ceiling in pure ridge lift**.

Two pilot realities are also included:

- **Turns cost height.** Ridge soaring is flown as beats with a turn at each end. A 30–40° turn
  sinks 25–50% faster and takes ~15–20% of the time, so the average sink is **+8%** on the polar.
- **Terrain clearance.** Air within **15 m** of the surface (ground, canopy or roof) isn't
  counted as usable band. A wing needs about a span plus margin to beat and turn safely. This
  removes the thin film of lift that hugs the lower slope.
- **Usable, not break-even.** `net = 0` means holding height in perfectly smooth air. Near a
  hill, gusts, corrections and gust-induced losses cost height, so air where you can merely
  hold 0–0.2 m/s is air you slowly sink out of. The band, the ceiling and the violet tracers
  require a **minimum usable climb**, set with the **"Show lift above"** slider (0–5 m/s,
  default 1 m/s in the app). That is what pilots call the lift band: where you can gain
  height. The analysis scripts and the tables below use 0.2 m/s, the physical break-even
  margin.

The result has the textbook shape. On an **ideal ridge** (`node scripts/ideal-ridge.mjs`: 150 m
high, 23° slopes, smooth concave foot, no vegetation) in 10 mph:

- the band hangs in front of the upper face and never touches the lower third;
- the strongest lift is just upwind of the crest edge;
- in stronger wind the envelope grows and reaches lower on the slope, as in the classic
  "low winds / high winds" soarable-envelope sketches.

The same holds at the Devil's Dyke NW face in 10 mph (`node scripts/section.mjs devils-dyke 326
10`). `#` is terrain; digits are usable climb in 0.5 m/s steps:

```
 304 ...............0000.......     ← top of the band ≈ 0.7 × hill height above the crest
 256 ..............0000000000..
 232 .............000001111100.     ← strongest lift just upwind of the crest edge
 208 ............000001111....████  ← take-off
 172 ...........000011..██████████  ← touches the slope about halfway up
 136 ...............██████████████  ← lower third: nothing usable
 100 ..........███████████████████
```

The sink rate comes from a **polar**, not a single number. To stay in the band a wing must fly
at least as fast as the local wind, or it gets blown back over the hill. In strong wind, and in
the stronger wind aloft, it therefore flies faster and sinks faster: `sink(V) = s_min + c(V − V_min)²`,
fitted through min sink and full speed. Where the wind exceeds the wing's full speed, nothing is
soarable. So for paragliders the band **collapses in over-strong wind** (the real "blown over
the back" limit), while hang gliders, with roughly 80 km/h top speed, keep working.

| Wing | min sink | trim | full speed |
|---|---:|---:|---:|
| Paraglider EN-A | 1.15 m/s | 36 km/h | 45 km/h |
| Paraglider EN-B | 1.10 m/s | 38 km/h | 51 km/h |
| Paraglider EN-C/D | 1.00 m/s | 40 km/h | 57 km/h |
| Hang glider | 0.85 m/s | 40 km/h | 79 km/h |

Resulting ceilings above take-off, EN-B, with the wind in the middle of each site's arc
(`node scripts/analyse-lift.mjs`):

| Site | 10 mph | 14 mph | 20 mph | 26 mph |
|------|------:|------:|------:|------:|
| Devil's Dyke | 333 ft | 568 ft | 412 ft | 16 ft |
| Firle | 393 ft | 549 ft | 413 ft | 29 ft |
| Bo Peep | 322 ft | 516 ft | 419 ft | 15 ft |
| Ditchling Beacon | 347 ft | 564 ft | 447 ft | 65 ft |
| Beachy Head | 353 ft | 535 ft | 452 ft | — |
| High & Over | 292 ft | 450 ft | 416 ft | 62 ft |
| Mount Caburn | 182 ft | 354 ft | 292 ft | — |
| Newhaven Cliffs | 117 ft | 199 ft | 221 ft | 71 ft |

The ranking is sane. Newhaven, a low coastal cliff, and Mount Caburn, which the SHGC guide
describes as having a *"small lift band"*, come out smallest. In 10 mph the ceiling is about
0.6–0.7 hill heights above the crest; in 26 mph a paraglider is barely soarable anywhere.

**Penetration:** the status flags "too strong aloft" once the wind at soaring height reaches
the wing's trim speed, and "cannot penetrate" near full speed.

## Rotor / turbulence — lee-wake diagnostic
**This part is an empirical parameterisation, not a solved flow.** The lift field comes from
an airflow solution validated against exact potential flow. Separated, recirculating flow
can't be represented by potential flow; it needs turbulence-resolving CFD (RANS/LES), which is
far too heavy to run live. The rotor is therefore built from published measurements:

1. **Where it separates.** From every column we march upwind looking for a crest whose lee
   slope is steep enough to separate (≳18°). Steepness is measured on the 1 m-derived LiDAR
   ground at 12.5 m. The 25 m physics grid smooths the Dyke's 28° scarp to 23°, which would
   halve the rotor.
2. **How far the bubble reaches**, in obstacle heights H (crest above the lowest lee ground),
   depends on lee steepness θ. It is anchored to published cases:

   | lee slope | reattachment |
   |---|---:|
   | < 18° | no separation |
   | ~26° (2-D ridges) | ~3 H |
   | 35–45° | ~5–6 H |
   | vertical cliff / backward-facing step | ~6.5 H |

   The fit is `xr/H = 6.5·(1 − e^{−(θ−18°)/12°})`. The separated shear layer runs from the crest
   down to reattachment.
3. **Recovering wake.** Beyond reattachment, a weaker turbulent layer (~0.35 H deep) lasts
   ~4 H more.
4. **Lee-face turbulence** only on steep lee faces: none below ~15°, full at ~30°. Gentle lee
   slopes keep attached flow.
5. **Intensity** scales with wind speed and with the drop; 50 m or more gives full strength.

Devil's Dyke with the wind reversed (SE, 20 mph; the 170 m NW scarp, 28°, in the lee): the
bubble reattaches ~500 m out (≈3 H), and weaker wake turbulence reaches ~1 km (≈6 H). That sits
within the pilots' rule of thumb that turbulence extends "5–10× the height of the obstacle".
That rule is really about **sharp** obstacles.

Trees, hedges and buildings (8 m grid) are sharp obstacles, so they follow it directly: a
cavity and near wake at full strength to ~3 H, fading out by ~10 H.

Rotor air doesn't count as usable lift, whatever its mean updraught: the band, the ceiling and
the best climb exclude it.

## Vegetation and buildings in the airflow
Trees, hedges and buildings come from the LiDAR landcover (see [DATA.md](DATA.md)) and act on the
air at two scales:

- **Hill scale.** Woods and built-up areas raise the effective surface by their zero-plane
  **displacement height**, `0.7 × canopy height × cover`, averaged over each 25 m cell. A wood on
  a crest makes the ridge effectively taller; a wood in a valley fills it in.
- **Obstacle scale (8 m grid).** Every tree line, wood edge, hedge and building sheds a turbulent
  wake, following windbreak and building-wake studies:
  - a cavity and near wake at full strength to about 3 obstacle heights (H);
  - then a recovering wake that thickens from H to about 2 H;
  - gone by about 10 H downwind (the pilots' "turbulence to 5–10× the obstacle height").

  Solid buildings shed more than porous tree lines, and tree lines more than low hedges. Canopy
  tops add mild roughness turbulence. A column is only sheltered where it sits below the
  obstacle's top, so a tree at the foot of a slope doesn't shelter the crest.
- The status panel warns when tree or building turbulence reaches the launch area. It looks at
  take-off and the air flowing onto it, not the lee behind it.

## Simulated airflow
The fast model above is linear theory plus empirical rotor rules. By default the app instead
shows a **large-eddy simulation** (FluidX3D lattice Boltzmann on the GPU, 10 m cells, neutral
atmospheric boundary layer), solved offline for 16 wind directions per site. It is checked
against steady RANS runs of the same cases (OpenFOAM, k-ω SST, 25 m cells). Set-up, validation
and costs are in [cfd/README.md](../cfd/README.md).

- **One model at a time.** The app uses the simulations for every site and direction, or,
  with `?cfd=off`, the fast model everywhere. If simulation data is missing or fails to load,
  it says so and shows no airflow; it never quietly substitutes the fast model.
- **Directions.** The two stored directions either side of the wind you set are blended linearly
  (`public/js/cfd.js`). The solutions are wind-speed independent, so velocities are stored as
  fractions of the 10 m reference wind and multiplied by the wind you set.
- **Wind speed calibration.** At 10 m cells the LES terrain is a staircase whose steps act as
  extra roughness. Its boundary layer comes out too slow near the ground and 10–16% too fast
  at soaring height for a given 10 m wind. Each case's velocities are therefore scaled by one
  factor so its approach wind at 50–180 m matches the OpenFOAM case, whose terrain-following
  mesh follows the log law. The factors are 0.76–0.92, median 0.855, about the same at every
  site. The flow pattern (lift, separation, gusts) is the LES's own.
- **Lift** is the simulated mean vertical wind, sampled on the same terrain-following layers as
  the fast model; net climb, the band and the ceiling are computed the same way.
- **Rotor** comes straight from the resolved flow:
  - the **core**: air reversed more than 20–50% of the time;
  - the **turbulent wake**: gusts clearly above what the local wind and ground roughness produce
    (turbulence beyond 20% of the local wind). It counts from σ = 0.8 m/s, when peak gusts of
    about 3σ reach a fifth of a paraglider's trim speed. Gusts scale with the wind, so the rotor
    reaches further, and is stronger, in stronger wind; below 9 mph it weakens and shrinks
    toward nothing in calm air.

  Rotor is smoothed over about 80 m across the wind, and only downstream along it, never
  across a change in ground height. That keeps it off the attached air approaching a cliff edge.
- **Take-off wind** comes from the simulated wind at 30 m, brought down to 2 m with the log law
  (the lowest cells sit inside the wall model). **Penetration** is judged against the median wind
  in the rising air (see above).
- **Trees and buildings** enter the simulation as raised ground (displacement) and surface
  roughness only. Wakes behind individual tree lines and buildings still come from the
  obstacle-wake rule, drawn on top in both modes.
- **Known limits.** The atmosphere is neutral, so rotor in light wind, when stability and
  thermals dominate, is indicative only. 10 m cells round off features smaller than about
  30 m.

The steady RANS (OpenFOAM) results can be viewed locally with `?flow=rans` after packing them
into `public/data/cfd/`; they aren't deployed. When they are shown, rotor uses a wake rule
(σ = U · 0.2 · e^(−x / 4H) past the recirculation core, from the Perdigão measurements,
[Menke et al. 2019](https://acp.copernicus.org/articles/19/2713/2019/)), because steady RANS
doesn't resolve gusts.

### Not modelled
Thermals, stability (inversions, lee waves), sea-breeze fronts, gusts and convergence are not
modelled. Thermals routinely take pilots far above the ridge-lift ceiling shown here. Linear
theory is also only approximate on slopes above ~25°.
