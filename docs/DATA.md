# Data pipeline

How each site's terrain, trees and buildings are built, and where the data comes from. For adding a site, see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-site).

## Terrain, trees and buildings
The data is built in two steps:

1. `scripts/fetch-terrain.mjs` fetches **terrarium DEM tiles** (Mapzen/Tilezen, AWS open data).
   These supply the sea-floor fallback and fill any LiDAR gaps.
2. `scripts/fetch-surface.mjs` builds the real surface for each site's 3.2 km window from two
   sources:
   - **Environment Agency LiDAR composite, 1 m** (Open Government Licence), fetched over WCS on
     the British National Grid. The bundled WGS84 → OSGB36 converter
     (`scripts/lib/osgb.mjs`) matches the SHGC grid refs for all eight sites.
     - The **DTM** (bare earth) replaces the ~30 m DEM. It gives a 128² physics grid (cell means)
       and a 512² render mesh. LiDAR take-off heights agree with the published figures to within
       1–12 m.
     - The **first-return DSM** is the top of the canopy. `nDSM = DSM − DTM` is the height of
       whatever stands on the ground. The last-return DSM would lose most of the trees, because it
       passes through foliage.
   - **Esri World Imagery "Clarity"** at z17 (~0.75 m/px). It is cloud-free over all eight
     sites; the default World Imagery has cumulus over Beachy Head.

   Every 1 m pixel is then classified:

   | Class | Rule |
   |---|---|
   | Building | nDSM ≥ 2.5 m, **planar** (low Laplacian of the DSM), not lush green, footprint ≥ 20 m², flat as a whole |
   | Tree | nDSM ≥ 2.5 m, anything else (crowns are lumpy) |
   | Bush / scrub / hedge | 0.6–2.5 m and green |
   | Water (rejected) | low-lying, blue-ish, no real height. The DSM sees waves and a different tide |
   | Crop (rejected) | huge, smooth, low "bush". A standing crop at survey time |
   | Cliff face (rejected) | on cliff-steep ground, "height" that doesn't stand above the highest ground within 3 m, or is bright bare chalk. On a near-vertical face the DSM and DTM sample the top and the foot, which would otherwise read as 50 m trees |

   Colour alone is unreliable: roofs can look green between imagery vintages. LiDAR flatness is
   the primary building test.

   From the classified raster the script extracts:
   - **trees and bushes**: crown tops (local maxima of the smoothed nDSM, with height-dependent
     crown spacing);
   - **buildings**: oriented footprints (PCA), eaves height and roof rise.

   It writes `public/data/landcover/<slug>.json` (3D instances) and `<slug>.png` (a 4 m obstacle
   raster the physics reads).

| Site | Trees | Bushes | Buildings |
|---|---:|---:|---:|
| Devil's Dyke | 13,246 | 4,512 | 90 |
| Firle | 8,992 | 2,904 | 34 |
| Mount Caburn | 8,653 | 4,593 | 63 |
| Beachy Head | 5,197 | 3,758 | 74 |
| Ditchling Beacon | 14,735 | 4,126 | 89 |
| Bo Peep | 7,552 | 5,202 | 35 |
| High & Over | 21,735 | 7,506 | 485 |
| Newhaven Cliffs | 10,593 | 8,870 | 808 |
