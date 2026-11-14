# Terrain data layer: frames, units, data and why

Scope: take NASA's south-pole elevation data, process it, align it with the coordinate system
the Sun/Earth data will use, and project it to 3D on demand around any point.
Anyone producing or consuming coordinates that touch the terrain should use `lunascout.terrain.frames`
instead of re-deriving them.

## The short version

| Topic | Standard we use | Why |
|---|---|---|
| Moon shape | Sphere, radius **1,737,400 m** | Used by LOLA, the IAU and JPL Horizons for the Moon. All DEM heights are measured from it. |
| Height | `h` = metres above that sphere. Radius of a point = 1,737,400 + h | That is literally what the DEM stores (not a geoid / "sea level"). |
| Moon-fixed frame | **`MOON_ME`** (SPICE alias of `MOON_ME_DE440_ME421`) | The DEM is in the DE421 mean-Earth frame. This frame reproduces it within ~0.5 m (2000–2040) while using the newest (DE440) lunar orientation. |
| Latitude / longitude | Planetocentric degrees, south negative, longitude **east-positive** | IAU / LOLA / Horizons convention. |
| 3D coordinates (XYZ) | Metres, origin at Moon's centre, +Z north pole, +X toward 0°E (Earth side), +Y toward 90°E | Same axes as `MOON_ME`. |
| Map coordinates (x, y) | South polar stereographic on the sphere, metres, +y toward 0°E, +x toward 90°E | The DEM's native grid. Never resampled into lat/lon (lat/lon grids break down at the pole). |
| Local directions | East / North / Up at a site; azimuth from north toward east; elevation above the sphere's horizontal plane | Same convention as JPL Horizons' observer tables, so values compare directly. |
| Time | Users see **UTC**. Frame rotations use **TDB** (SPICE "ET", seconds past J2000) via leap-second kernel `naif0012.tls` | SPICE and JPL ephemerides run on TDB. Every function accepts UTC strings or ET numbers. |
| Lunar orientation | NAIF kernels `moon_pa_de440_200625.bpc` + `moon_de440_250416.tf` | Official DE440 lunar orientation (libration included); defines `MOON_ME`. |
| Inertial frame | SPICE `J2000` (= ICRF to ~0.02 arcsec), Moon-centred, m and m/s | What JPL Horizons and SPICE deliver Sun/Earth/orbit vectors in. Converted to `MOON_ME` by `to_moon_me`. |
| Units | Metres, seconds, degrees in APIs; radians inside maths | One unit set; no km/m mixing at module boundaries. |

## Why `MOON_ME` and not the alternatives

The Moon wobbles (libration), and there are several ways to define "Moon-fixed" axes.
NAIF's frame kernel `moon_de440_250416.tf` documents how far apart they are:

| Frame | Offset from the DEM's frame | Verdict |
|---|---|---|
| `MOON_ME` = `MOON_ME_DE440_ME421` | ≤ 0.53 m (2000–2040), ≤ ~1 m (1900–2050) | **Use this.** |
| `MOON_PA` / `MOON_PA_DE440` (principal axes) | ~875 m | Wrong for map data. |
| `IAU_MOON` (IAU rotation formula) | up to ~155 m, time-varying | Wrong; truncated libration series. |
| Horizons `REF_PLANE=BODY EQUATOR` | not Moon-fixed in longitude | Only for equator orientation. |

A few hundred metres is enough to put a ridge on the wrong side of a landing site, so the frame
name is defined once in code (`backend/lunascout/terrain/constants.py: MOON_FRAME`) and used everywhere from there.

## The DEM and what "project-ready" means

Source: NASA GSFC PGDA product 90 (Barker et al. 2023, PSJ 4:183), file `LDEM_80S_20MPP_ADJ.TIF`.
Details and checksum: `backend/manifests/terrain.json`.

- 30,400 × 30,400 heights, 20 m squares, 608 × 608 km centred on the pole, no gaps.
- **No values are changed.** The file is used as delivered. Lat/lon/3D are computed on demand.
- "No gaps" ≠ "all measured": most squares near the pole are interpolated between laser tracks.
  The companion count map `LDEC_80S_20MPP_ADJ.TIF` (optional in the manifest) shows which were measured.
- **Only this 20 m product is used for terrain.** The separate 5 m site maps are deliberately not
  merged in: one product means one consistent surface, no seams and no offsets between datasets.
- Coarser spacings are made by **averaging** (anti-aliasing) and then bilinear interpolation.
  Averaging slightly lowers sharp peaks in far rings (open item below).

## Terrain mesh around a point ("render distance")

`build_terrain(lat, lon)` makes nested square rings around the point (a geometry clipmap):

| Ring | Spacing | Reach (n = 256) |
|---|---|---|
| 0 | 20 m (native) | ±2.56 km |
| 1 | 40 m | ±5.12 km |
| 2 | 80 m | ±10.24 km |
| … | doubles | doubles |
| 7 | 2,560 m | ±327.68 km |

- Every vertex is converted to true 3D `MOON_ME` metres, so the Moon's curvature is built in
  (at 150 km the surface is ~6.5 km below the site's horizontal plane; at 300 km ~26 km).
- Ring borders are stitched so the surface is watertight (tested). Vertices on a fine ring's
  outer edge are moved onto the coarser ring's edge (up to ~0.5 m height change there).
- Areas beyond the DEM (outer corners of the last ring) are left out, not filled.
- ~400k vertices / 800k triangles for the default; builds in under a second from the local file.

Outputs (`scripts/build_terrain.py`): `terrain.glb` (viewers: X = east, Y = up, Z = south,
metres from the site; the exact 4×4 transform back to `MOON_ME` is in the file's `extras`),
`terrain.npz` (float64 `MOON_ME`, full precision), `preview.png`, `info.json`.

## Interface for Sun/Earth/orbit data (computed by others)

The Sun/Earth positions are produced by a separate pipeline (e.g. JPL Horizons or SPICE).
For them to line up with the terrain, hand over data like this:

| Item | Required |
|---|---|
| Frame | **J2000 / ICRF** (Horizons: `REF_SYSTEM=ICRF`, `REF_PLANE=FRAME`) or already **`MOON_ME`**. Never `IAU_MOON`, `MOON_PA` or Horizons `REF_PLANE=BODY EQUATOR`: `to_moon_me` refuses them. |
| Origin | Moon's centre (Horizons `CENTER=500@301`). To get the view from a site, subtract the site position (`DEM.surface_xyz`). For the highest accuracy, vectors computed from the site itself are also fine. |
| Time tags | UTC strings (ISO 8601) or TDB seconds past J2000. Say which. |
| Units | Any length unit; `to_moon_me` returns the same unit. Our terrain is in metres. |
| Corrections | State whether vectors are geometric or apparent (`LT+S`). Visibility work normally wants apparent. |

Bringing them into the terrain's frame is one call:

```python
from lunascout.terrain.frames import to_moon_me, az_el
sun_me = to_moon_me(sun_icrf_m, "ICRF", times_utc)      # (T, 3) MOON_ME metres
az, el = az_el(sun_me - site_xyz, lat, lon)               # as seen from the site
```

Other conversions available in `lunascout.terrain.frames`: `inertial_to_me` / `me_to_inertial` (positions),
`state_inertial_to_me` / `state_me_to_inertial` (position + velocity, Moon's rotation included),
`site_state_inertial` (a surface point in the inertial frame), `look_angles` (azimuth, elevation,
range from a site to any `MOON_ME` point), `xyz_to_latlon_h` (sub-point and altitude).

## Using the terrain output

- `terrain.npz`: `vertices_me` (float64, `MOON_ME` metres), `triangles` (int32, counter-clockwise
  seen from outside, so normals point away from the Moon), `level` (ring of each vertex),
  `origin_me` (the requested point on the surface), `enu` (east/north/up rows at that point), `meta`.
- Same frame and units as anything passed through `to_moon_me`, so terrain and Sun/Earth vectors
  can be combined directly.
- For float32 / GPU work use `mesh.local_enu()` (coordinates relative to the point); absolute
  coordinates near 1.7 million metres lose ~10 cm in float32.
- `DEM` gives single-point access without building a mesh: `height_at_latlon`, `surface_xyz`
  (optionally raised by a mast height), `surface_normal`, `in_coverage`.

## Verification (re-run with `python -m pytest`)

| Check | Test | Result (2026-11-14) |
|---|---|---|
| Map ↔ lat/lon formulas | `test_frames.py` vs pyproj | agree to 1e-10° |
| DEM reads | heights at pixel centres vs raw file | identical (0.0 m) |
| Mesh heights, normals, seams, curvature, export | `test_terrain.py` | pass; seam test confirmed to fail if stitching is disabled |
| Frame conversion | `test_inertial.py`: `MOON_ME` is the DEM-aligned frame, rotations proper, Moon's rotation rate, site velocity 4.62 m/s at the equator | pass |
| **Compatibility with JPL data** | `test_alignment.py`: real Horizons ICRF Sun/Earth vectors converted with `to_moon_me` reproduce Horizons' own azimuth/elevation at a site | Sun 0.0002″, Earth 0.05″ (a frame mix-up would be ≥ 18″; no rotation ~94°) |
| Streaming vs local DEM | same mesh from NASA URL and local file | identical |

The JPL fixture is `backend/tests/terrain/fixtures/horizons_alignment.json` (regenerate with
`python tests/terrain/fixtures/make_horizons_fixture.py` from `backend/`).

## Open items

- Peak-preserving (max) sampling for far rings, if consumers need conservative horizons.
- Terrain beyond the DEM's ±304 km square (a 60°S 240 m product exists).
- Alignment of this terrain with the viewer's streamed Moon tiles (test once the viewer exists).
