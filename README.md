# LunaScout

LunaScout compares sunlight and line of sight to Earth for landing sites near the lunar south pole. The dashboard combines NASA photography, local 3D terrain from LOLA, and time-indexed simulations from the Python backend.

## Run locally

Requires Python 3.12 or later, [uv](https://docs.astral.sh/uv/), and Node.js 22.12 or later. Use three terminals from the project root. The first data download is about 480 MiB. Use a real project email or URL in the Horizons request header.

In the worker terminal, install the backend, download the data, and start the simulation worker.

```sh
cd backend
uv sync --locked
uv run --locked lunascout-science fetch-data
export LUNASCOUT_HORIZONS_CONTACT='contact@example.org'
uv run --locked lunascout-worker
```

Run the API in a second terminal.

```sh
cd backend
uv run --locked uvicorn lunascout.api.main:app --port 8000
```

Run the frontend in a third terminal and open the URL Vite prints.

```sh
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to port 8000. The API and worker share the `DATA/` directory. Set `LUNASCOUT_DATA_DIR` to the same absolute path in both terminals to use a different directory. The API documentation is at [localhost:8000/docs](http://localhost:8000/docs).

## Dashboard

1. Choose **Shackleton Rim** or **Connecting Ridge** in the reference sites, or add a site by clicking the map. **Go to** centers the map on a saved site.
2. Select **3D terrain** to inspect real elevation around the selected site. Drag to orbit, right-drag or Shift-drag to pan, and scroll to zoom toward the pointer. **Regional view** widens the terrain window to 32 km. **Reset view** restores the initial camera. The preview uses metre-for-metre scaling and requires WebGL 2.
3. Select the UTC date range, choose the time on the timeline, and click **Run simulation**. The selected hour gets priority. The timeline marks available snapshots.
4. Use **Solar visibility** to toggle the result on the map or terrain. The same colors identify full and partial disk visibility, shadow, and unresolved samples. The 3D colors interpolate between mesh vertices. The map displays the sampled cells.
5. Choose a second saved site under **Compare with** and click **Run comparison**. Both sites use the same UTC range and simulation settings. The comparison shows matched snapshot values and period totals as they become available.

Use **Simulation settings** to change grid spacing, disk ray count, Earth mast height, or time integration cadence. Hourly map snapshots and the default 15-minute integration cadence serve different purposes. Change the integration cadence for finer timing. A completed run is reused for identical physical inputs and source files.

Sites are saved in your browser by default. To use the API catalog, set `VITE_SITE_STORAGE=api` in `frontend/.env.local` and restart Vite. Both catalog modes can submit scientific runs.

## Map imagery and terrain

The 2D map opens at the south pole. **Whole Moon** switches to a global longitude/latitude map with NASA Moon Trek LROC WAC photographs (approximately 100 m source pixels), where sites can be placed and saved at any latitude or longitude. **South pole** restores the stereographic map with the existing WAC and detailed NAC photographs. The Shackleton-only orthophoto square is no longer displayed. Photographed shadows are preserved. Terrain previews and scientific simulations still use the supplied south-polar DEMs and support site centers from 90°S to 60°S. [NASA Moon Trek tile services](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon) · [Shackleton Rim LROC orthophoto](https://data.lroc.im-ldi.com/lroc/view_rdr_product/NAC_DTM_ESALL_SR12_NACORT04_1M)

The **3D terrain** view draws a bounded patch of the same LOLA height model used for the ray tracing. It uses neutral lighting to show relief. Solar colors come from the simulation at the selected time. The map's amber 87.5°S line marks the published PDS LOLA 5 m dataset extent. The solver's datasets and effective coverage are recorded separately. [NASA local LOLA grids](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) · [NASA regional LOLA grids](https://pgda.gsfc.nasa.gov/products/90)

## Run a stand-alone snapshot

From `backend/`, after downloading the data and setting the Horizons contact, run one timestamp without starting the web app.

```sh
uv run --locked lunascout-science snapshot \
  --latitude -89.7668 --longitude -171.87 --radius-m 500 \
  --at 2026-11-14T12:00:00Z \
  --grid-spacing-m 20 --solar-disk-samples 37 --mast-height-m 2 \
  --output ../DATA/runs/shackleton-20261114T1200
```

The command writes `summary.json` and `grid.npz`. See the [data guide](DATA/README.md) for exact dataset names, output fields, and physical assumptions.

## Architecture

| Location | Responsibility |
|---|---|
| `frontend/src/features/{globe,terrain,results,timeline}` | Photography map, orbitable elevation mesh, overlays, comparison, and shared UTC playback. |
| `backend/lunascout/api/` | Site catalog, typed run and terrain endpoints, and a single progress stream per dashboard. |
| `backend/lunascout/jobs/` | Persistent run queue, playhead priority, fair batches, and time integration. |
| `backend/lunascout/ephemeris/` | JPL Horizons queries and NAIF lunar frame transformations. |
| `backend/lunascout/terrain/` | LOLA elevation grids, ray intersections, and local preview sampling. |
| `backend/lunascout/simulation/` | Site grid, finite Sun irradiance, eclipse masking, and Earth center visibility. |
| `DATA/` | Downloaded science sources, archived Horizons responses, and run outputs. |

Reference-site coordinates come from Table A2-2 of the [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20230007818).
