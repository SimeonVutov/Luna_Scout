# Scientific data

`uv run lunascout-science fetch-data` from `backend/` installs the inputs. `LUNASCOUT_DATA_DIR` sets the data directory for the CLI and the site catalog. The CLI also accepts `--data-dir` before the subcommand.

| Path | Exact inputs and use |
|---|---|
| `raw/spice/` | `naif0012.tls` for UTC to TDB, `moon_de440_250416.tf` and `moon_pa_de440_200625.bpc` for lunar orientation. |
| `raw/terrain/LDEM_60S_240MPP_ADJ.TIF` | NASA Goddard adjusted LOLA with 240 m posting for far-field terrain. |
| `raw/terrain/LDEM_80S_80MPP_ADJ.TIF` | NASA Goddard adjusted LOLA with 80 m posting, used for nearby regional terrain within the prepared site window. |
| `raw/terrain/Site01_final_adj_5mpp_surf.tif` | NASA Goddard 5 m LOLA for Connecting Ridge. |
| `raw/terrain/Site04_final_adj_5mpp_surf.tif` | NASA Goddard 5 m LOLA for Shackleton Rim. |
| `cache/horizons.sqlite3` | Validated Sun and Earth response batches, reused to follow the JPL fair-use policy. |
| `runs/` | Suggested location for snapshot outputs. |

The terrain filenames refer to [NASA's local LOLA elevation grids](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) and [regional adjusted LOLA elevation grids](https://pgda.gsfc.nasa.gov/products/90). Kernel versions come from [NAIF's generic kernel archive](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/). See the [JPL API policy](https://ssd-api.jpl.nasa.gov/) for request requirements.

## Calculation and coverage

- Horizons returns Moon-centered ICRF positions in kilometres for the Sun (10) and Earth (399) at the requested TDB epochs. SPICE rotates the vectors into `MOON_ME_DE440_ME421`, which closely matches the DE421 mean-Earth frame of the DEMs. The engine subtracts each instrument position to get local directions. The CLI uses reception light time and aberration at the lunar center by default. [Horizons settings](https://ssd-api.jpl.nasa.gov/doc/horizons.html) · [NAIF lunar frame](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf)
- The solver reprojects radial elevations above 1,737,400 m into aligned gnomonic grids and traces rays against curved lunar terrain with triangular facets. The outer two grids extend the horizon past the site circle. The 80 m grid is cropped around the site to roughly 120 km on each side, subject to coverage. Grid posting describes the sampling of the DEM. The underlying LOLA measurements and interpolated regions have different effective detail.
- The sunlight calculation samples a uniform apparent solar disk. It applies terrain and a spherical Earth occultation mask, inverse-square solar distance scaling, and incidence relative to the receiver normal. The default receiver is the terrain facet. Set `--collector-tilt-deg 0` for local horizontal or set a tilt from horizontal and an azimuth clockwise from north. The snapshot reports direct irradiance at that plane, measured in W/m². Solar limb darkening and secondary illumination are outside this model. [IAU nominal solar constants](https://arxiv.org/abs/1510.07674)
- A ray crossing incomplete terrain coverage is uncertain unless a known obstacle or Earth occultation determines its outcome. Output bounds represent that coverage uncertainty for the sampled disk. Terrain accuracy and sampling convergence are separate sources of error. Use finer grid spacing to refine a shadow edge across the circle and more solar rays to refine partial visibility at a point.
- Custom south-polar DEMs can replace both default local inputs with repeated `--local-dem` flags. Use a single-band, north-up GeoTIFF in the same lunar datum. Its square pixel spacing must divide 240 m. Clip large local DEMs to the area you need before loading them.

## Snapshot output

`summary.json` holds the ephemeris and terrain checksums, modeling settings, center sky angles and distances, and footprint statistics. The center's longitude defines grid orientation at the exact pole. The lit area estimate counts grid samples receiving positive direct irradiance. Site averages use sample-center quadrature within a geodesic circle. The irradiance mean uses the area with known ground elevations.

`grid.npz` contains a common one-dimensional `offsets_m` axis for east and north. Columns increase east and rows increase north. `inside_site` masks the reporting circle. Use `height_m` and `dem_spacing_m` to identify ground coverage. The four sunlight arrays give the lower and upper values of visible disk fraction and irradiance. NaN denotes entries outside the circle or on unknown ground.

## Dashboard runs

The API and one local worker share `runs/queue.sqlite3`. It stores normalized run inputs, data checksums, progress, sampled metrics, and source provenance. The worker writes `runs/<run_id>/snapshots/<sample_index>.npz` before marking each published hour ready. A restarted worker continues from the saved samples. Repeated submissions reuse completed results when the geometry, UTC interval, sampling, settings, and input checksums match.

| Endpoint | Data |
|---|---|
| `POST /api/runs` | Queue or reuse a simulation. Supply the saved site ID or inline site footprint, UTC interval, and settings. |
| `GET /api/runs/{run_id}` | Read the normalized plan, progress, ready hours, and completed period summary. |
| `PUT /api/runs/priority` | Request the current playhead for active simulations. |
| `GET /api/runs/events?run_id=…` | Receive run updates by server-sent events. A reconnect receives the current ready index. |
| `GET /api/runs/{run_id}/snapshots/{index}` | Get the selected published hour's metrics and row-major sunlight arrays. Index zero is the first hour. |
| `GET /api/runs/{run_id}/series` | Read sky angles and other small records for the published hours. |
| `GET /api/runs/{run_id}/provenance` | Read the model revision, raw source hashes, and Horizons response digests. |
| `POST /api/terrain/preview` | Get a 161 × 161 square of elevations around a site in the same local coordinate convention. Cells without ground are null. |

The worker samples the end of the UTC interval for integration, while the dashboard's published timeline is half-open. It integrates area-weighted lit fraction and direct irradiance with elapsed-time trapezoids, splitting daily totals at UTC midnight. Earth visibility changes between consecutive known samples are placed at the midpoint. Intervals with unresolved endpoints contribute uncertainty bounds. Timing estimates depend on the selected integration cadence. The displayed incidence and energy averages use ground with valid receiving heights.
