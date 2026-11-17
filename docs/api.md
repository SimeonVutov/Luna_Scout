# API reference

The API is plain REST, with live progress over server-sent events. Interactive documentation of every route and field is served by the API itself at `/docs` (for example <http://localhost:8000/docs>). This page groups the routes by what they are for.

## Runs

| Endpoint | What it does |
|---|---|
| `POST /api/runs/lookup` | Read-only. Returns the run for a request if it exists, how many samples earlier runs already computed, and how long the rest should take (`estimated_seconds`). Starts nothing. |
| `POST /api/runs` | Queues or reuses a run. Identical inputs, including data checksums, share one run. An optional `session` (the browser's random ID) records that browser as wanting it. Matching samples from other runs are copied first. |
| `GET /api/runs/{id}` | Progress, ready snapshots and the period summary. While waiting, running or paused, `progress` lists the stages with their state, estimated seconds and share done, and the seconds left. |
| `GET /api/runs/events?run_id=…` | Live progress as server-sent events. A removed run is announced so pages can forget it. |
| `POST /api/runs/{id}/pause?session=` | Pauses this session's request. The run stops only when no session wants it. |
| `POST /api/runs/{id}/resume?session=` | Wants the run again and continues from where it stopped. |
| `DELETE /api/runs/{id}?session=` | Withdraws this session's request. Deletes nothing. |
| `GET /api/precomputed` | For each NASA reference site, the newest precomputed range with default settings, and whether it is complete. |

How the run endpoints fit together is explained in [Runs, reuse and the queue](runs.md).

## Results

| Endpoint | Returns |
|---|---|
| `GET /api/runs/{id}/snapshots/{index}` | One hour: metrics, the sunlight grid and the Earth line-of-sight grid |
| `GET /api/runs/{id}/series` | Sun and Earth angles and metrics for every published hour |
| `GET /api/runs/{id}/site-map` | For a finished run: each point's longest day and darkness, share of time lit and with Earth in view, and whole-site summaries. Cached with the run |
| `GET /api/runs/{id}/rays/{index}` | The 3D view's rays for one saved snapshot. Fast, needs no terrain |
| `GET /api/runs/{id}/provenance` | Data and kernel checksums and the ephemeris used |

## Terrain and the sky

| Endpoint | Returns |
|---|---|
| `GET /api/terrain/tiles/{level}/{row}/{column}` | LOLA heights of one tile (65×65 nodes plus a one-node border, float32, north to south) on the same grid as NASA Moon Trek imagery. Levels 0–13, down to 4 m spacing |
| `POST /api/terrain/rays` | The 3D view's rays traced on demand, for a time with no saved snapshot. Loads terrain, so the first call takes seconds |
| `POST /api/terrain/context` | NASA's long-term maps over a site: 18.6-year sunlight and Earth visibility, permanent shadow, open sky |
| `POST /api/terrain/ice` | Diviner's modelled temperatures and ice-stability depth for the cells inside a site. `summary` is null outside the table (80°S to the pole) |
| `GET /api/sky` | Sun and Earth positions (Moon-fixed metres) for one batch of 32 samples, the same batches runs use |

## Public servers

On a public server the site list and deleting saved results are disabled, pause and cancel need a `session`, and heavy routes are rate limited (for example `POST /api/runs` 30 per minute, lookups 120 per minute). Exceeding a limit returns HTTP 429. See [deploy/README.md](../deploy/README.md#what-the-public-setting-does).
