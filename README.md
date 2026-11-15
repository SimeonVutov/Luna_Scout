# LunaScout

LunaScout explores lunar landing sites near the south pole. The frontend prototype lets you create and inspect one site at a time with synthetic sunlight and Earth visibility on a shared UTC timeline.

## Run locally

Requires Node.js 22.12 or later.

```sh
cd frontend
npm ci
npm run dev
```

Open the URL Vite prints. The dashboard saves sites in the current browser by default.

### South-polar map

LunaScout opens directly in the OpenLayers map in a lunar south-polar stereographic projection. It streams the WAC overview and loads finer NAC tiles as you zoom into the inner polar region. The finest published NAC tile matrix is about 4.18 projected metres per pixel. The underlying mosaic has 1 m sampling. [NASA Moon Trek tile services](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon)

The map displays optical imagery and preserves the dark pixels in the source tiles, including photographed shadows.

The 2D map compass shows the direction at the top of the map and its center coordinates. At the exact south pole, every outward direction is north. The amber 87.5°S line marks coverage of the regional PDS LOLA 5 m elevation grid. The teal 85.5°S line marks the nominal NAC photo mosaic limit, and the small outlined rectangle marks the Shackleton orthophoto. The terrain line marks dataset availability. The current simulation still uses demo results. The optical close-ups fade in gradually as you zoom.

### Native 1 m imagery at Shackleton Rim

The 2D map requests the Shackleton tiles as you zoom into the mapped area. Choose **Shackleton Rim**, click **Go to**, and zoom in. The locally served tiles come from NASA LRO's 5 × 5 km LROC orthophoto, `NAC_DTM_ESALL_SR12_NACORT04_1M`. Its finest tiles preserve the original 1 m pixel grid. Outside this footprint, the app uses the broader streamed imagery. [LROC source and GeoTIFF download](https://data.lroc.im-ldi.com/lroc/view_rdr_product/NAC_DTM_ESALL_SR12_NACORT04_1M)

### Use the dashboard

1. Drag the polar map or use the zoom controls. **South pole** resets the view.
2. Choose **Add site**, click the Moon to set its center, enter a name and radius, and save. Coordinates can also be entered directly. The outline shows the footprint.
3. Select a saved site to see its details. Use **Go to**, **Edit**, or **Delete** to manage it.
4. Use the bottom timeline to step, scrub, or play through hourly samples. The date selector changes the UTC range for the dashboard. The right panel shows the selected time and period.
5. **Demo data** labels the synthetic values. The tint on the selected circle illustrates lit fraction. The polar map uses NASA LROC tiles.

### Optional server-side site catalog

To save sites through the existing backend, set `VITE_SITE_STORAGE=api` in `frontend/.env.local` and run the API in a second terminal. It requires Python 3.12 or later and [uv](https://docs.astral.sh/uv/).

```sh
cd backend
uv sync
uv run uvicorn lunascout.api.main:app --reload
```

Restart Vite after changing the setting. Vite proxies `/api` to port 8000 and the API documentation is at [localhost:8000/docs](http://localhost:8000/docs). The browser and server catalogs are separate.

## Architecture

| Location | Responsibility |
|---|---|
| `frontend/src/features/{sites,globe,timeline,results}` | Saved-site controls, the OpenLayers viewport, the shared UTC playhead and the selected site's results. |
| `frontend/src/api/` | Request client and TypeScript types for the site catalog. |
| `frontend/src/features/results/demoResults.ts` | Synthetic timeline values, isolated from the map and results components. |
| `backend/lunascout/api/` | FastAPI endpoints, validated site/run inputs and the SQLite site catalog. |
| `backend/lunascout/jobs/` | Run submission and future worker dispatch, fairness and batch progress. |
| `backend/lunascout/terrain/` | NASA LOLA ingest, local/regional terrain, height lookup, coverage and spatial indexing. |
| `backend/lunascout/ephemeris/` | Cached Horizons Sun/Earth ephemerides and SPICE transforms. |
| `backend/lunascout/simulation/` | Per-timestamp illumination and Earth visibility, then time integration and event windows. |
| `DATA/` | Raw sources, processed terrain, reusable results and versioned runs. |

### Future simulation integration

- A site record holds its name, Moon-fixed latitude and longitude, and radius. The dashboard owns one UTC range for all sites. The date picker includes the last day and sends an exclusive end time at the following midnight.
- Run identity should include the geometry, date range, mast height, snapshot cadence and source/model revisions. A label edit has no effect on that identity.
- Start with one worker process. First compute the shared playhead timestamp for each queued site, then rotate through short batches. Keep science cadence independent of the published hourly snapshots so the solver can resolve events between frames.
- Persist the snapshot and its scientific coverage before publishing a notification. Use one dashboard-wide Server-Sent Events connection for state changes and ready timestamps. Fetch the actual map arrays on demand and reload the ready index on reconnect.
- The 2D map will display the backend's computed results. The tile stream and camera can vary independently of scientific terrain.

### Starter behavior and next integration

The backend simulation endpoints remain scaffolded. Replace the synthetic results provider when the worker can publish its first real snapshot. The prototype currently displays one selected site.

The next integration is one real timestamp at each reference site. Read the relevant fine and regional LOLA DEMs, resolve the ground coordinates, supply Horizons-derived Sun/Earth directions in the same lunar frame, and expose an immutable result with its validity mask. Then connect batch scheduling, progress events and side-by-side summaries.

## Data credits

- Reference-site coordinates come from Table A2-2. [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20230007818)
- Candidate scientific terrain and ephemerides. [NASA south-pole LOLA](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) · [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) · [NAIF SPICE](https://naif.jpl.nasa.gov/naif/)
