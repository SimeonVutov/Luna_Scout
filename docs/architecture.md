# Architecture

LunaScout is three programs that share one folder of files and one small database. The website asks questions, the API answers quickly, and a separate worker does the slow physics.

```mermaid
flowchart LR
    subgraph Browser
        UI["Website<br/>3D Moon · 2D map · charts"]
    end
    subgraph Server
        API["API<br/>answers requests,<br/>never computes simulations"]
        Q[("Run queue<br/>SQLite")]
        W["Worker<br/>computes simulations"]
        D[/"DATA folder<br/>NASA inputs · horizon maps<br/>snapshots"/]
    end
    UI -- "REST + live progress (SSE)" --> API
    API <--> Q
    W <--> Q
    W --> D
    API -- "reads results" --> D
    NASA(["NASA terrain,<br/>SPICE kernels"]) -. "downloaded once" .-> D
```

## Why the work is split in two

A simulation can take minutes or hours. If the API did it, every visitor would wait behind it, and a restart would lose it. So:

- **The API only reads and queues.** It answers in milliseconds and stays responsive however busy the server is.
- **The worker computes.** It takes the next piece of work from the queue, saves the result to disk, and records progress. If it is restarted, it continues from what is saved.
- **The queue is a SQLite file.** It is the only thing the two programs share besides result files, so there is no message broker to run or lose.

## One request, end to end

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API
    participant Q as Queue
    participant W as Worker
    B->>A: Lookup: what exists for this site and dates?
    A-->>B: Reusable samples, estimated time. Nothing starts
    B->>A: Run simulation
    A->>Q: Add a run, copy samples other runs already computed
    loop until every missing sample is done
        W->>Q: Next batch of samples, nearest the playhead first
        W->>W: Compute Sun and Earth positions, trace rays
        W->>Q: Save snapshots, record progress
        Q-->>A: Change noticed
        A-->>B: Progress and finished hours (server-sent events)
    end
    W->>Q: Mark complete, with sunrise and sunset times
    B->>A: Fetch an hour's grid, rays and charts
```

Two details make this feel fast:

- **The playhead goes first.** The worker computes the hour the user is looking at before the rest, so something appears within seconds. If the user moves the timeline, the order follows.
- **Nothing is computed twice.** A new request first copies any samples earlier runs of the same site and settings already hold. See [Runs, reuse and the queue](runs.md).

## What each part is responsible for

| Part | Responsibility | Lives in |
|---|---|---|
| Ephemeris | Where the Sun and Earth are, seen from the Moon, at any time | `backend/lunascout/ephemeris` |
| Terrain | One curved, multi-resolution surface from NASA elevation data, and each point's skyline | `backend/lunascout/terrain` |
| Simulation | Rays, sunlight, Earth visibility, sunrise and sunset, per-point statistics | `backend/lunascout/simulation` |
| Jobs | The queue, the worker, progress and time estimates | `backend/lunascout/jobs` |
| API | HTTP routes, public-server protections | `backend/lunascout/api` |
| Website | 3D and 2D views, timeline, comparison, progress window | `frontend/src/features` |

The physics is explained in [How the physics works](physics.md); the website's behaviour in [How the website behaves](app-flows.md).

## The website has no simulation code

Everything shown, the numbers, the rays in 3D, the skyline, comes from files the worker saved. The browser only draws them. This is deliberate: the picture and the numbers cannot disagree, because both are read from the same saved snapshot.

The one exception is the Sun and Earth positions drawn in the sky, which the API computes with the same SPICE code and sends as small batches.

## Where things are stored

```mermaid
flowchart TB
    DATA["DATA/"] --> raw["raw/<br/>NASA inputs, downloaded once"]
    DATA --> cache["cache/"]
    DATA --> runs["runs/"]
    DATA --> logs["logs/"]
    cache --> hz["horizons/<br/>one skyline file per site centre"]
    cache --> tiles["terrain_tiles/<br/>3D view's elevation tiles"]
    cache --> perf["performance.json<br/>learned timings"]
    runs --> db[("queue.sqlite3")]
    runs --> snaps["one folder per run:<br/>a grid file per snapshot hour"]
    logs --> eph["ephemeris-check.log"]
```

Everything under `raw/` can be downloaded again. Everything under `cache/` can be rebuilt, only slower. `runs/` holds the results people asked for. See [DATA/README.md](../DATA/README.md) for the file list and sizes.
