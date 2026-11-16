# Data and science notes

This folder holds the NASA inputs, the caches and the simulation outputs. `uv run lunascout-science fetch-data` (run from `backend/`) downloads everything that is missing.

## Contents

| Path | What | Source |
|---|---|---|
| `raw/spice/` | `naif0012.tls` (leap seconds), `moon_de440_250416.tf` + `moon_pa_de440_200625.bpc` (lunar orientation) | NASA NAIF |
| `raw/terrain/LDEM_60S_240MPP_ADJ.TIF` | 240 m LOLA, 60°S–90°S: far-field horizon | NASA Goddard PGDA |
| `raw/terrain/LDEM_80S_80MPP_ADJ.TIF` | 80 m LOLA, used within about 120 km of a site | NASA Goddard PGDA |
| `raw/terrain/*_final_adj_5mpp_surf.tif` | 5 m LOLA for 10 candidate sites (below) | NASA Goddard PGDA |
| `cache/horizons.sqlite3` | Validated JPL Horizons replies, reused instead of requested again | JPL Horizons |
| `cache/horizons/` | Terrain horizon maps, one per site, grid and receiver height | computed |
| `runs/` | Run queue (`queue.sqlite3`) and per-timestamp result grids | computed |

The 5 m sites are Connecting Ridge (`Site01`), Shackleton Rim (`Site04`), Nobile Rim 1 (`Site06`), Peak near Shackleton (`Site07`), de Gerlache Rim (`Site11`), Leibnitz Beta Plateau (`Site20`), Malapert Massif (`Site23`), Haworth, Shoemaker, and Nobile Rim 2 (`DM2`).

## Key decisions

### Sun and Earth positions: JPL Horizons and SPICE

- Horizons provides Moon-centred ICRF vectors for the Sun (10) and Earth (399), in batches of 32 epochs.
- SPICE converts UTC to TDB and rotates the vectors into `MOON_ME_DE440_ME421`. That frame is within about 0.5 m of the DE421 frame the DEMs use.
- Lunar libration comes from the time-varying orientation kernel, so no separate libration model is needed.
- Light-time and aberration are applied at the Moon's centre (`LT+S`). The error this introduces at a surface site is below 0.003″.
- **Why Horizons:** it is NASA's authoritative ephemeris service, and every reply is cached with its checksum for reproducibility.
- **Transient failures:** network errors and 5xx replies are retried after 15, 60 and 180 s. Samples that were already computed are kept, so a failed run resumes where it stopped.

### Terrain: curved, triangulated, multi-resolution

- All DEMs are reprojected into one south-polar gnomonic grid. Each grid cell is split into two planar triangles on the curved Moon (radius 1,737,400 m).
- Where grids overlap, the finest one is used. Edges are stitched so no false walls appear at seams.
- 5 m tiles are loaded only within 60 km of a site. Beyond that, an 80 m posting subtends less than 0.08°, compared with the 0.53° solar disk, while loading every tile would hold more than 1 GB in memory.
- Missing terrain is never assumed clear. Rays crossing it are reported as **unresolved**, and the results carry lower and upper bounds.

### Sunlight: finite Sun disk

- Each grid box casts 37 equal-solid-angle rays across the Sun's apparent disk. At the pole the Sun skims the horizon, so a ridge often hides only part of it. In our tests, a single centre ray reported 86% of Shackleton lit where the full disk gives 96%.
- Irradiance uses 1361 W/m² at 1 AU, scaled by inverse-square distance and by each ray's angle to the receiver. Earth eclipses are masked per ray.
- **Receivers.** The default is a vertical panel that turns toward the Sun, 2 m above the ground, as on real polar landers. At Shackleton it collects about 24 kWh/m² per day, compared with 13 on the ground and 0.7 on a horizontal plate.
- Two "lit" definitions are reported: any part of the Sun visible, and at least half of the disk visible.

### Terrain detail, slope and the skyline

- **Detail is reported, not assumed.** The solver runs anywhere from 60°S to 90°S, but the terrain under a site is 5 m only inside the ten grids, 80 m inside 80°S and 240 m beyond. Each site reports the share of its area from each source, and a site on coarse terrain is flagged as approximate.
- **Slope** is a central difference of terrain height between grid neighbours, over a baseline of twice the grid spacing (40 m at the default 20 m grid). It is a smoothed slope, gentler than the 5 m posting would give. At Shackleton the mean is 32.7°, close to the 31.5° read directly from NASA's 5 m grid at the centre.
- **Lit and gentle** counts a point when at least half the Sun is visible and its slope is at most 10°, the limit used in NASA-supported landing-site studies. Missing data widens the upper bound.
- **Skyline** is the exact terrain horizon from the site centre in 3,600 directions (0.1°), at the panel height and at the mast height, from the same triangulated terrain as the ray tracer. It does not depend on time, so the browser draws the Sun and Earth against it as the timeline moves. The visible share of a disk comes from the geometry, not from sampled rays.

### Sharing results between date ranges

- A run is identified by its site, settings, data checksums and dates. Its **physics key** is the same thing without the dates, so runs that differ only in range compute identical samples at identical times.
- Submitting a run first copies the matching samples from earlier runs, with their snapshot files hard-linked rather than duplicated. The worker then computes only the gaps. A 3-day run over a finished 1-day run reused 96 of its 289 samples, and the reused day's totals were identical to the original to the last digit.
- The old closing endpoint of a range is recomputed when it becomes an interior snapshot hour, since the shorter run never produced a snapshot file for it.
- **Deleting a site:** a custom site's runs, snapshot files and horizon map are removed. A reference site's runs are hidden and kept for 14 days. Submitting a run for it again restores what falls inside the new range and then discards the kept runs, so data outside the timeline does not accumulate.
- Horizon maps built before sites were labelled cannot be matched to a site and are never removed automatically.

### Earth visibility

- A ray from a mast at the site centre to Earth's centre decides whether Earth is visible. 37 rays across Earth's disk give the visible fraction.
- This is line-of-sight geometry only. It does not include a radio link budget or ground-station schedules.

### Speed: terrain horizon maps

Terrain does not move, so for each grid box we compute its skyline once: the highest terrain angle in 720 directions, measured exactly on the triangulated surface. At each timestamp, a ray is clear if it rises above the skyline and blocked if it passes below. Rays within 0.05° of the skyline are re-traced with the full ray tracer. This is the horizon method behind NASA's LOLA illumination maps (Mazarico et al. 2011).

| Site (1,961 boxes, 193 timestamps) | Build once | Per timestamp | Speed-up | Differences from direct tracing |
|---|---|---|---|---|
| Shackleton Rim | 44 s | 21 ms | 15.6× | 0 of 378,473 box-timestamps |
| Connecting Ridge | 66 s | 12 ms | 34.5× | 0 of 378,473 box-timestamps |

Maps are cached in `cache/horizons/`. The cache key covers the terrain checksums, the receiver positions and the method revision, so any change triggers a rebuild. Pure ray tracing remains available as `ray_method: "direct"`.

### Time

- Area metrics are sampled at the integration cadence (15 min by default) and integrated with trapezoids, split at UTC midnights.
- Sun and Earth windows at the site centre are scanned every minute between Horizons samples, then refined by bisection to about 1 s. Interpolating positions over a 15-minute step introduces an error below 0.0001°.

## Run API

| Endpoint | Returns |
|---|---|
| `POST /api/runs` | Queues or reuses a run. Identical inputs, including data checksums, share one result. |
| `GET /api/runs/{id}` | Progress, ready snapshots and the period summary |
| `GET /api/runs/events?run_id=…` | Live progress (server-sent events) |
| `GET /api/runs/{id}/snapshots/{index}` | One hour's metrics, sunlight grid and Earth line-of-sight grid (fraction of Earth's disk seen from mast height per point; absent before model revision 5) |
| `GET /api/runs/{id}/series` | Sun and Earth angles and metrics per published hour |
| `GET /api/runs/{id}/provenance` | Data checksums and Horizons reply digests |
| `GET /api/terrain/tiles/{level}/{row}/{column}` | LOLA heights of one tile (65×65 nodes plus a one-node border, little-endian float32, north to south) on the same south-polar tile grid as NASA Moon Trek imagery. Levels 0–13 reach 4 m spacing. Saved under `cache/terrain_tiles`. |
| `GET /api/sky?start_utc&end_utc&integration_minutes&index` | Sun and Earth positions (Moon-fixed metres) for the Horizons batch holding that sample. Uses the same batches as simulation runs, so replies are shared. |
| `POST /api/terrain/context?grid_spacing_m=` | NASA's long-term maps over a site on the simulation's grid, with area-weighted means: average sunlight and Earth visibility (18.6 years), permanent-shadow share and open sky. Read from `raw/context` (60 m inside 85°S, 240 m to 65°S). |
| `POST /api/terrain/ice` | Diviner's modelled temperatures and ice-stability depth for the cells inside a site (about 500 m cells, 80°S to the pole): annual mean and maximum temperature, share of the site with stable ice, share stable at the surface, shallowest and mean buried depth. `summary` is null outside the table. Read from `raw/context/diviner_prp_south.npz`. |
| `GET /api/runs/{id}/site-map` | For a finished run: every point's longest day and darkness, share of the period lit and with Earth in view, the good-spot standards, and whole-site summaries (typical, best and worst longest day and darkness; area good for Sun, Earth contact and both). Built from the saved snapshots (each taken to hold for its whole interval) and cached as `site_map.npz` in the run's folder. |
| `GET /api/runs/{id}/rays/{index}` | The 3D view's rays for one published snapshot: Sun-disk rays from about 40 evenly spaced grid points (the simulation's own rays) and Earth-disk rays from the same points at mast height (an illustration; the simulation reports Earth only at the centre mast). The worker saves origins, clear/blocked/unresolved and blocking distances with each frame, so this needs no terrain and is fast. Frames saved before this existed return 404. |
| `POST /api/terrain/rays` | The same rays traced on demand for a time that has no saved frame, plus the centre-mast fans. Loads the site's terrain, so the first call takes seconds. |

## Known limits

- Terrain support covers 60°S–90°S, and 5 m detail exists only around the 10 sites listed above.
- About 90% of the 5 m cells are interpolated between LOLA tracks (Barker et al. 2021). Grid spacing is not the same as measured detail.
- Events shorter than one minute can be missed. Reflected light and Earthshine are not modelled.

`raw/context` holds NASA Goddard's illumination products (`AVGVISIB_*`, `LPSR_*`, `SKYV_*`), about 150 MB, downloaded by `fetch-data` from `pgda.gsfc.nasa.gov`. It also holds `diviner_prp_south.npz` (58 MB): triangle centres with Diviner's annual mean temperature (2 cm depth), annual maximum surface temperature and ice depth. `fetch-data` downloads NASA's 605 MB `dlre_prp_south.tab` from the PDS Geosciences Node, cuts it down and deletes it. In the table `-999` means no ice is stable within 2.87 m; it also holds an undocumented `-1` in the coldest triangles, which LunaScout reads as ice stable at the surface.
