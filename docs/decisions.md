# Decisions and why

The choices that shape LunaScout, with the reason for each and what was given up. Newer decisions that replaced older ones say so.

## Science

| Decision | Why | What it costs |
|---|---|---|
| **Sun and Earth from SPICE with JPL DE440, computed locally** (replaced live JPL Horizons requests) | Microseconds per position, any date 1849–2150, no network or rate limit. Agrees with Horizons to 35 m (Sun) and 5 m (Earth) over 2026–2028, which changed no result. | Needs four NASA kernel files (about 30 MB). Horizons is kept for a monthly safety check. |
| **The Sun is a disk of 37 rays**, not a point | Near the pole a ridge hides *part* of the Sun. A centre ray said Shackleton was 86% lit; the full disk says 96%. | 37× the rays per point. Horizon maps pay for it. |
| **Horizon maps instead of tracing every ray** | Terrain is fixed, so each point's skyline is built once and every later ray is a lookup. Identical results (0 differences in 378,473 checks) and 15–35× faster. | A one-off build of about a minute per site. Rays within 0.05° of the skyline are still traced exactly. |
| **Curved, triangulated terrain from three NASA resolutions** | A flat map hides ridges the Moon's curvature tucks away; one resolution is either too coarse near the site or too large to load. | 5 m detail only within 60 km of a site, and only around ten sites. Each site reports how much of its area came from each resolution. |
| **Missing terrain is "unresolved", never "clear"** | Assuming empty sky would overstate sunlight and Earth contact. | Results carry a lower and an upper bound. |
| **Default receiver: a vertical panel that turns toward the Sun, 2 m up** | It is what polar landers use. At Shackleton it collects about 24 kWh/m² a day, against 0.7 for a horizontal plate. | Other receivers are a Settings choice. |
| **Earth coverage is geometric line of sight** | It is what the terrain decides, and can be computed exactly. | Not a link budget: no antenna patterns or ground-station schedules. |
| **Events found by scanning the site centre every minute, then bisecting** | Gives sunrise, sunset and contact times to about one second without simulating every second. | An event shorter than a minute can fall between two scans. |
| **All data from NASA** | One trusted source, with citations a mission planner recognises. | Nothing from other agencies is used, even where it might add detail. |

## Computing and sharing

| Decision | Why | What it costs |
|---|---|---|
| **API and worker are separate programs** | The API answers in milliseconds however busy the worker is, and a restart loses nothing. | Two services to run. |
| **A SQLite file as the queue** | Nothing extra to install, back up or lose. One server is enough for this load. | Would not scale to many servers. |
| **Runs are named by a fingerprint of their inputs** | The same request always finds the same results, from any browser. Changed data or physics changes the name, so stale results are never reused. | Changing the physics means bumping the model revision, which recomputes. |
| **Samples are shared between runs with the same "physics key"** | Overlapping date ranges, extended timelines and repeated requests compute each time once. | Slightly more complex submission: copy first, compute the gaps. |
| **Horizon maps are kept per site centre, not per run** | A smaller radius with the same grid points, other dates or another visitor reuse the same skyline. | The maps are large. They are removed only when a custom site is deleted. |
| **Pause and cancel act on a browser's own request** | A run is shared. One visitor must not stop it for another. It stops only when nobody wants it. | The server tracks who wants each run. |
| **Cancel deletes nothing** | The work is reusable by anyone asking for the same dates. Unwanted runs expire after 14 days. | Disk use grows until cleanup. |
| **Visitors come first; precompute yields** | The 15 reference sites are computed ahead so the first visitor sees results at once, but they must never slow a real visitor. | Precompute takes hours on a small server. |
| **Grid spacing follows the site's size** (about 10 cells across the radius, 5 to 20 m) | A fixed 20 m grid gave a 50 m site only about 5 cells across. A big site at 5 m would be 16 times the points, so the spacing grows with the radius and stops at 20 m. | Small sites cost more points, and a small site's grid is not the precomputed one. Outside the ten 5 m sites the terrain is 80 m, so a finer grid sharpens the picture, not the underlying detail. |
| **Reference sites precomputed at 500 m, defaults, to the end of next month** | Covers the common first look. A smaller radius at the same centre reuses the 500 m skyline for the grid points they share. | Other settings or later dates still need computing. |

## The website

| Decision | Why | What it costs |
|---|---|---|
| **Ask before computing new dates** (replaced starting automatically) | A silent start made the progress window appear unexpectedly and burned computing time. Now the question lists the missing days and a time estimate. | One extra click when dates are not covered. |
| **The browser draws; it does not simulate** | The picture, the rays and the numbers come from the same saved snapshot, so they cannot disagree. | The 3D rays for a time the run has not reached need a slower on-demand call. |
| **The Moon stays fixed and the sky moves** | Playing the timeline never spins the terrain, so the user can follow which ridge shadows what. | None. |
| **Add site works in 3D by ray-marching the drawn terrain** | The marker lands exactly under the pointer, with no redirect to the 2D map. | Terrain must be loaded to pick. |
| **Time estimates are learned from this server, per CPU count** | A fixed guess is wrong on every machine. After a resize, the old machine's times must not be promised. | The first runs on a new size use scaled estimates. |
| **A stage never shows done before the server says so** | A bar that jumps to 100% and waits is worse than one that says "taking longer than expected". | A slow stage can look stalled near its end. |

## Running it

| Decision | Why | What it costs |
|---|---|---|
| **Public mode: limited ranges, queue and request rates; sites kept in the visitor's browser** | A server open to the internet must survive strangers. Browser-held sites cannot be changed by others. | A visitor's sites do not follow them to another browser. |
| **A small Google Cloud VM, resized up only for precomputing** | Cheap to run, and resizing is a stop-and-start. The model keeps timings per CPU count so estimates follow the size. (C2 machines were unavailable on a new account, so E2 types are used.) | Precompute on the small size is slow. |
| **The Horizons contact address lives only in a server environment variable** | JPL asks automated clients to identify themselves; the address does not belong in a public repository. | Must be set on any new server. |
| **Setup script is idempotent and pulls its own code** | The same command installs and updates. Saved results are kept. | None. |
