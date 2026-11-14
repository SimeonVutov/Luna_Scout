# LunaScout

LunaScout compares landing sites near the lunar south pole using terrain-aware sunlight and geometric Earth visibility. This starter includes an interactive Cesium dashboard, a persistent site catalog, and the module boundaries for the simulation.

## Run locally

Requires Python 3.12 or later, [uv](https://docs.astral.sh/uv/), and Node.js 22.12 or later.

In one terminal, from the project root:

```sh
cd backend
uv sync
uv run uvicorn lunascout.api.main:app --reload
```

In a second terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open the URL Vite prints. It proxies `/api` to the backend on port 8000. The API also provides interactive documentation at [localhost:8000/docs](http://localhost:8000/docs).

To use the detailed Cesium Moon 3D Tiles, copy `frontend/.env.example` to `frontend/.env.local` and supply a read-only Cesium ion token with access to asset `2684829`. The app also ships with a NASA LRO basemap and a local LOLA hillshade on the lunar reference sphere. The hillshade depicts relief and uses a fixed visual light.

## Architecture

| Location | Responsibility |
|---|---|
| `frontend/src/features/{sites,globe,timeline,results}` | Saved-site controls, one Cesium viewport, the shared UTC playhead and the selected site's results. |
| `frontend/src/api/` | Request client and TypeScript types matching the API. |
| `backend/lunascout/api/` | FastAPI endpoints, validated site/run inputs and the SQLite site catalog. |
| `backend/lunascout/jobs/` | Run submission and future worker dispatch, fairness and batch progress. |
| `backend/lunascout/terrain/` | NASA LOLA ingest, local/regional terrain, height lookup, coverage and spatial indexing. |
| `backend/lunascout/ephemeris/` | Cached Horizons Sun/Earth ephemerides and SPICE transforms. |
| `backend/lunascout/simulation/` | Per-timestamp illumination and Earth visibility, then time integration and event windows. |
| `DATA/` | Raw sources, processed terrain, reusable results and versioned runs. |

### Request and playback

- A site record holds its name, Moon-fixed latitude and longitude, and radius. The dashboard owns one UTC range for all sites. The date picker includes the last day and sends an exclusive end time at the following midnight.
- Run identity should include the geometry, date range, mast height, snapshot cadence and source/model revisions. A label edit has no effect on that identity.
- Start with one worker process. First compute the shared playhead timestamp for each queued site, then rotate through short batches. Keep science cadence independent of the published hourly snapshots so the solver can resolve events between frames.
- Persist the snapshot and its scientific coverage before publishing a notification. Use one dashboard-wide Server-Sent Events connection for state changes and ready timestamps. Fetch the actual map arrays on demand and reload the ready index on reconnect.
- Cesium renders the backend's ephemerides and computed map. The tile stream and camera can vary independently of scientific terrain.

### Starter behavior and next integration

Site creation, editing, deletion, globe navigation and the UTC timeline work locally. Run submission returns a typed `not_configured` response until a worker is connected. The UI leaves the scientific outputs empty.

The next integration is one real timestamp at each reference site. Read the relevant fine and regional LOLA DEMs, resolve the ground coordinates, supply Horizons-derived Sun/Earth directions in the same lunar frame, and expose an immutable result with its validity mask. Then connect batch scheduling, progress events and side-by-side summaries.

## Data credits

- The local browse image is a resampled stitch of NASA JPL Moon Trek's level-2 LRO WAC Global Mosaic v2 tiles. [Moon Trek viewer](https://trek.nasa.gov/moon/) · [Tile service metadata](https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/WMTSCapabilities.xml)
- Local visual hillshade is derived from the NASA LOLA Site01 and Site04 elevation tiles. [Source datasets](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/)
- Reference-site coordinates come from Table A2-2. [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20230007818)
- Candidate scientific terrain and ephemerides. [NASA south-pole LOLA](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) · [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) · [NAIF SPICE](https://naif.jpl.nasa.gov/naif/)

