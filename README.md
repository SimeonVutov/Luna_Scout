# LunaScout

**Compare lunar south-pole landing sites by sunlight and line of sight to Earth.**

LunaScout is our project for the 2026 NASA Space Apps Challenge *Lunar Landing Site Navigator*. Pick a site and a date range, and LunaScout traces real NASA terrain against JPL Sun and Earth positions. It shows which parts of the site are lit, how much energy a panel would collect, and when Earth is in view for direct-to-Earth communication.

| | |
|---|---|
| **Terrain** | NASA LOLA elevation models: 5 m around 10 candidate sites, 80 m and 240 m regionally |
| **Sun & Earth** | NASA JPL Horizons vectors, rotated into the lunar frame with NAIF SPICE |
| **Physics** | Finite solar disk, curved Moon, terrain shadows, Earth eclipses |
| **Imagery** | NASA Moon Trek LROC WAC and NAC mosaics |

## Features

- **Site catalogue.** 15 NASA reference sites (Artemis III regions, Lunar Surface Data Book sites, IM-2), or click anywhere from 60°S to 90°S to add your own.
- **Time playback.** Scrub a shared UTC timeline. Snapshots appear as soon as they are computed.
- **Sunlight map.** Each grid box is classified as fully lit, partly lit, dark or unresolved, using 37 rays across the Sun's disk.
- **Power estimate.** Direct irradiance and energy (kWh/m²) on a vertical Sun-facing panel, on the ground, or on a horizontal plate.
- **Earth visibility.** Line of sight from a mast at the site centre, including how much of Earth's disk is visible.
- **Exact events.** Sunset, sunrise, Earthset and Earthrise at the site centre to about one second, plus the longest darkness.
- **Terrain insight.** For every site: how fine the elevation data is (5 m, 80 m or 240 m, with a warning when coarse), slope statistics, and the share of ground at or below 5°, 10° and 15°.
- **Lit and gentle.** The share of the site that is both in sunlight and on ground no steeper than 10°, updated with the timeline.
- **Skyline close-up.** The Sun and Earth drawn against the real terrain horizon from the site centre, at true angular scale, with the visible share of their disks.
- **Map layers.** Solar visibility, slope, and the footprints of NASA's 5 m terrain grids, so you can see where results are most trustworthy.
- **3D terrain.** A local relief view built from the same LOLA data the solver uses.
- **Comparison.** Run two sites with the same settings and the same playhead.

## Quick start

**Requirements:** Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 22.12+, and about 1.5 GB of disk space for NASA data.

Open three terminals in the repository root.

```sh
# 1 · Worker: install, download NASA data (first time only), compute runs
cd backend
uv sync --locked
uv run --locked lunascout-science fetch-data
export LUNASCOUT_HORIZONS_CONTACT='you@example.org'   # identifies you to JPL
uv run --locked lunascout-worker
```

```sh
# 2 · API
cd backend
uv run --locked uvicorn lunascout.api.main:app --port 8000
```

```sh
# 3 · Website
cd frontend
npm ci
npm run dev
```

Open the URL Vite prints (usually <http://localhost:5173>). The API documentation is at <http://localhost:8000/docs>.

> **Tip:** to keep NASA data elsewhere, set `LUNASCOUT_DATA_DIR` to the same absolute path in terminals 1 and 2.

## Using the dashboard

1. Choose a reference site, or press **Add site** and click the map.
2. Set the UTC date range and press **Run simulation**. The playhead time is computed first.
3. Scrub the timeline to explore snapshots. Toggle **Solar visibility** on the map or in **3D terrain**.
4. Pick a second site under **Compare with** to see the two side by side.

The first run at a new site builds a terrain horizon map, which takes about 40–70 s. Later runs and date changes at that site reuse it.

**One timeline for every site.** Changing the date range starts a simulation for all your saved sites at once. Only the missing times are computed, because results already stored for the same site and settings are reused. Narrowing the range is instant and deletes nothing. Long ranges are limited by how fast JPL Horizons answers (a year at 15 minute sampling needs about 2,200 requests, and they must be sent one at a time), so choose a coarser **Sample every** in Settings for ranges longer than a few months.

**Activity menu.** Next to Settings, it shows whether the worker and API are running, what the worker is doing, and every recent simulation with its progress. It fetches the current state when the page opens. Each site card also shows a live progress bar and "Simulation done".

**Deleting a site.** A site you created yourself has its stored results removed to save space. A reference site keeps its results hidden for 14 days. If you add it back and run a timeline, only the part inside that timeline is restored, and the rest is discarded.

## How it works

```
JPL Horizons ──► SPICE (UTC→TDB, ICRF→lunar frame) ──┐
                                                     ├──► ray tracing per grid box ──► snapshots ──► API ──► website
NASA LOLA DEMs ──► curved triangulated terrain ──────┘         (finite Sun disk,           (SQLite +
                   └──► horizon map per box (cached)            Earth eclipse)             NumPy files)
```

| Folder | Responsibility |
|---|---|
| `backend/lunascout/ephemeris` | Horizons requests, response cache, frame rotation |
| `backend/lunascout/terrain` | DEM loading, ray tracer, horizon maps, 3D preview |
| `backend/lunascout/simulation` | Site grid, irradiance, Earth visibility, event windows |
| `backend/lunascout/jobs` | Run queue, worker, time integration |
| `backend/lunascout/api` | FastAPI routes and the site catalogue |
| `frontend/src/features` | Map, 3D view, timeline, results |
| `DATA/` | NASA inputs, caches and run outputs. See [DATA/README.md](DATA/README.md). |

## Command line

Compute a single snapshot without the web app:

```sh
cd backend
uv run --locked lunascout-science snapshot \
  --latitude -89.7668 --longitude -171.87 --radius-m 500 \
  --at 2026-11-14T12:00:00Z --receiver terrain --collector-height-m 0 \
  --output ../DATA/runs/my-snapshot
```

This writes `summary.json` and `grid.npz`. With these settings, Shackleton Rim is 95.9% lit, which is the project's regression reference.

## Tests

```sh
cd backend
uv run --locked --with pytest python -m pytest tests
```

Tests that need the NASA data are skipped when it has not been downloaded.

## Data sources

- [NASA LOLA 5 m site DEMs](https://pgda.gsfc.nasa.gov/products/78) (Barker et al. 2021)
- [NASA LOLA regional DEMs](https://pgda.gsfc.nasa.gov/products/90)
- [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) · [NAIF SPICE kernels](https://naif.jpl.nasa.gov/naif/data.html)
- [NASA Moon Trek](https://trek.nasa.gov/moon/) (LROC imagery)
- Reference sites: [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20230007818), Table A2-2
