# LunaScout

**Compare lunar south-pole landing sites and dates by sunlight, power and line of sight to Earth.**

LunaScout is a web application built for the 2026 NASA Space Apps Challenge, *Lunar Landing Site Navigator*. It answers the two questions that decide a south-pole mission: will the lander have power, and can it talk to Earth? It traces real NASA terrain against JPL ephemerides to show, for any site and date range, which ground is lit, when the Sun and Earth rise and set, and how two candidate sites compare.

**Try it:** [luna-scout.online](https://luna-scout.online) · **Watch:** [the video tutorial](#video-tutorial)

## Video tutorial

[![The LunaScout video tutorial, playing automatically. Click for the full-quality video.](docs/images/tutorial.gif)](docs/tutorial.mp4)

The animation above is the whole 84-second tutorial. **[Open it as a full-quality MP4](docs/tutorial.mp4)** for smoother motion and pause and seek controls. It is a screen recording of the real application, following the path a mission planner takes to choose a site:

1. **Choose the dates.** The Sun and Earth move, so every date gives different light and contact.
2. **Add sites.** Pick NASA's candidate sites from the reference list, or click the map to add your own.
3. **Run the simulation.** Sun and Earth positions come from JPL's DE440 ephemeris, and shadows are traced over every point of the site.
4. **Play through the day.** The ground is coloured by how much of the Sun each point sees.
5. **See why.** **Sun rays** and **Earth rays** show which points see the Sun and Earth and which ridge blocks them. **Stand at site** shows the horizon from the ground.
6. **Switch layers.** Earth radio coverage, the best spots over the dates, and NASA's long-term maps.
7. **Read the site's numbers.** The results panel holds the skyline, the terrain, and modelled ice and temperature, on the 3D view or the flat 2D map.
8. **Compare two sites.** Watch both on one timeline, then read the whole-period scorecard, where ▲ marks the better site on each measure.

The video studies 23 November 2026. On that date Shackleton Rim spends much of the day in shadow, and Connecting Ridge comes out ahead on every measure where the two differ. Most of the video plays at 1.5× speed, and the new site's simulation at 30×.

## Why it exists

Near the Moon's south pole the Sun never climbs far above the horizon. Ridges a few hundred metres away throw shadows that last for days, and a place that is lit today can be dark next week. Earth can disappear behind the same ridges. Small changes in site or launch date therefore change power and communication windows dramatically.

The tools that hold this data (NASA's Quickmap and Moon Trek, JPL Horizons) are built for specialists and answer one question at a time. LunaScout puts the terrain, the ephemerides and the physics behind one interface, so a mission planner can ask "what happens if the launch slips?" and see the answer, and a student can see why the Moon is hard.

## At a glance

| | |
|---|---|
| **Terrain** | NASA LOLA elevation models: 5 m around ten candidate sites, 80 m inside 80°S and 240 m out to 60°S |
| **Sun and Earth** | JPL DE440 ephemeris computed with NASA NAIF SPICE, checked monthly against JPL Horizons |
| **Physics** | Finite Sun disk, curved Moon, terrain shadows, Earth eclipses, no atmosphere |
| **Ice and temperature** | NASA Diviner model of temperatures and where ice would be stable, per site |
| **Imagery** | NASA Moon Trek LROC WAC and NAC mosaics |
| **Views** | Interactive 3D Moon and flat south-polar map, for one site or two side by side |

## What you can do

### Explore a site in 3D

The application opens on the Moon in 3D. The Sun and Earth sit where JPL's ephemeris puts them, and the terrain refines as you zoom from the whole globe down to individual rims and craters near the south pole. The Moon stays fixed and the sky moves around it, so playing the timeline never spins the scene.

Pick a site from NASA's candidate list or click anywhere between 60°S and 90°S to add your own, then press play. The map shows what each part of the site sees at the chosen time.

![LunaScout showing the Moon in 3D with three saved landing sites](docs/images/overview-3d.png)

### See why a spot is dark

Turn on **Sun rays** to draw the rays the simulation traces from many points across the site to the Sun's disk. A ray that reaches the Sun is yellow; a ray cut off by terrain is red and stops at the ridge that blocks it. Here the whole site of Malapert Massif is in shadow because a ridge between the site and the Sun hides it:

![Sun rays from across the Malapert Massif site, all blocked by the ridge](docs/images/sun-rays.png)

### Check the line of sight to Earth

**Earth rays** does the same for Earth's disk, from mast height. Blue rays reach Earth and purple rays are blocked. The legend counts the rays that get through, and the **Earth radio coverage** layer colours every point of the site by how much of Earth it sees. Coverage here is geometric line of sight through the terrain, not a signal-strength or link-budget estimate.

![Earth rays at Malapert Massif, where only a few rays reach Earth](docs/images/earth-rays.png)

### Stand on the surface

**Stand at site** puts the camera on the ground at the site centre, at mast height, and lets you look around. The Sun and Earth appear against the real horizon that the simulation uses, so you can see for yourself whether a ridge hides them. Click the **Sun** or **Earth** label to turn toward it.

![View from the surface of de Gerlache Rim 1, with the Sun just above a distant ridge](docs/images/stand-at-site.png)

### Compare two sites

**Compare** places two sites side by side, in 3D or 2D, on one shared timeline. Each pane shows four headline numbers, the Sun or Earth against the real horizon at true angular scale, and the same layers and rays. Layer settings are shared, so both sites always show the same thing.

![Malapert Massif and Nobile Rim 1 compared side by side, with Sun rays](docs/images/compare-live.png)

### Read the numbers

The **Whole period** view turns the comparison into a scorecard, with a marker on the better site for every row. It is grouped into power, communication, whole-site statistics and long-term context:

![Scorecard comparing two sites across power, communication, whole-site and long-term metrics](docs/images/compare-scorecard.png)

- **Power and communication** for the selected dates: solar energy on the receiver, sunlit time, longest day, longest darkness, Earth visibility, longest Earth contact and longest blackout, with sunrise, sunset, Earthrise and Earthset timed to about one second at the site centre.
- **Across the whole site**: the longest day and longest darkness of the typical point and of the best spot, and the share of the site's area that is good for Sun, good for Earth contact and good for both.
- **Long-term and terrain**: NASA's 18.6-year averages for sunlight and Earth visibility, permanent shadow, open sky, and slope. They separate a bad day from a bad place.
- **Ice and temperature, modelled**: for the site only, NASA Diviner's annual mean and maximum temperature, the share of the site where ice would be stable, how much is stable right at the surface, and how deep the shallowest ice lies. These are model results at about 500 m, not detected ice. Measured hydrogen (neutron instruments) is mapped too coarsely to give a number for one site, so it is left out.

Two charts follow the scorecard, one for the Sun and one for Earth, each with a menu for what to plot (lit area, lit and gentle ground, irradiance, Earth disk visibility and others):

![Lit and gentle ground over time for two sites](docs/images/compare-chart.png)

### Layers

One **Layer** menu, on the flat map and in 3D, chooses what is drawn on the ground:

| Layer | What it shows |
|---|---|
| Solar visibility | How much of the Sun each point sees at the timeline's time |
| Earth radio coverage | How much of Earth each point sees from mast height |
| Best spots for Sun, for Earth contact, for both | Points that are good over the whole selected period. Good for Sun means lit at least 70% of the time, good for Earth contact means Earth in view at least 30% |
| Average sunlight, average Earth visibility | NASA LOLA 18.6-year averages |
| Permanent shadow, open sky | Where the Sun never reaches, and how much sky the terrain leaves open |
| Slope | Steepness of the ground on the flat map |

## Quick start

**Requirements:** Python 3.12 or newer, [uv](https://docs.astral.sh/uv/), Node.js 22.12 or newer, and about 2 GB of disk space for NASA data (the 605 MB Diviner table is cut down to a 58 MB file during the download).

Open three terminals in the repository root.

```sh
# 1 · Worker: install, download NASA data (first time only), compute runs
cd backend
uv sync --locked
uv run --locked lunascout-science fetch-data
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

Open the URL Vite prints, usually <http://localhost:5173>. The API documentation is at <http://localhost:8000/docs>.

To keep NASA data somewhere else, set `LUNASCOUT_DATA_DIR` to the same absolute path in terminals 1 and 2. No network access is needed after `fetch-data`: the Sun and Earth are computed locally.

## Hosting

To run LunaScout on a server of your own, with HTTPS and protections for public use, follow [deploy/README.md](deploy/README.md).

## Good to know

The [video tutorial](#video-tutorial) shows the usual steps. A few details it does not:

**Dates are UTC.** The playhead's time is computed first after **Run simulation**, so there is something to look at immediately.

**One timeline for every site.** Changing the date range starts a simulation for all saved sites. Only the missing times are computed, because results stored for the same site and settings are reused, and narrowing the range deletes nothing. Long ranges are limited by computing time on the server: choose a coarser **Sample every** in Settings for ranges longer than a few months.

**Pause, resume and cancel.** A running simulation can be paused and resumed later from where it stopped. Cancel deletes what it computed. On a public server only the browser that started a simulation can pause or cancel it, while anyone can resume one.

**Results follow the request, not the browser.** When you open a site with the same dates and settings as an earlier simulation, from any browser, its results appear without pressing Run. When earlier simulations cover part of your dates, only the rest is computed, and that starts on its own.

**Reference sites are precomputed.** NASA's reference sites are computed ahead of time with the default settings and a 500 m radius, from the start of the month to the end of the next one. A label such as "Ready to 31 Dec" shows which ones are done, and adding one shows its results at once. A smaller radius at the same centre reuses the terrain horizons, so it is quick too.

**Site size.** New sites start with a 50 m radius. The largest allowed is 500 m.

**Activity menu.** It shows whether the worker and API are running, what the worker is doing, and every recent simulation with its progress.

**Deleting a site.** A site you created has its stored results removed to save space. A reference site keeps its results, hidden, for 14 days, and restores only the part inside the current timeline if you add it back.

The first run at a new site builds a terrain horizon map, which takes about a minute for a 500 m site. Later runs, date changes and smaller radii at that centre reuse it.

## How it works

```
JPL DE440 ──► SPICE (UTC→TDB, ICRF→lunar frame) ─────┐
                                                     ├──► ray tracing per grid point ──► snapshots ──► API ──► website
NASA LOLA DEMs ──► curved triangulated terrain ──────┘      (finite Sun disk,          (SQLite +       (REST + SSE)
                   └──► horizon map per point (cached)       Earth eclipse)             NumPy files)
```

- **Terrain** from several LOLA resolutions is combined into one curved, triangulated surface, with the grids stitched so no false cliff appears where they meet.
- **Horizon maps.** For every point of a site the exact terrain horizon is computed once and cached. Rays far from the skyline are classified by lookup, and rays near it are traced exactly, so results equal tracing every ray but run much faster.
- **Sun and Earth** are sampled as disks with equal-solid-angle rays (37 for the Sun), so partial shadow and partial Earth views are resolved. Earth can eclipse the Sun.
- **Time.** SPICE computes the Sun and Earth from JPL's DE440 ephemeris, with light time and aberration, and rotates them into the Moon's own frame, which accounts for the Moon's orbit and libration. The Moon has no atmosphere, so the horizon is the terrain.
- **Events.** Sunrise, sunset, Earthrise and Earthset at the site centre are refined by bisection to about one second.
- **Per-point statistics.** Each saved snapshot is combined into every point's longest day, longest darkness and share of time lit and with Earth in view. These drive the best-spot layers and the whole-site comparison.
- **Runs** are content-addressed and shared between date ranges, so a run is never computed twice.

The 3D view streams LOLA elevation as tiles on the same grid as the NASA photos, and each tile refines as the camera approaches. Its rays come from the same calculation as the results panel and are saved with each snapshot, so the picture can never disagree with the numbers.

## Project structure

| Folder | Responsibility |
|---|---|
| `backend/lunascout/ephemeris` | Sun and Earth positions with SPICE, and the monthly check against JPL Horizons |
| `backend/lunascout/terrain` | DEM loading, ray tracer, horizon maps, elevation tiles, NASA long-term maps |
| `backend/lunascout/simulation` | Site grid, irradiance, Earth visibility, event windows, per-point statistics |
| `backend/lunascout/jobs` | Run queue, worker, time integration |
| `backend/lunascout/api` | FastAPI routes and the site catalogue |
| `frontend/src/features` | 3D view, map, comparison, timeline, results, settings |
| `frontend/src/styles` | Shared styles; each feature keeps its own stylesheet beside its components |
| `DATA/` | NASA inputs, caches and run outputs. See [DATA/README.md](DATA/README.md) for the API and data layout |

## Command line

Compute a single snapshot without the web application:

```sh
cd backend
uv run --locked lunascout-science snapshot \
  --latitude -89.7668 --longitude -171.87 --radius-m 500 \
  --at 2026-11-14T12:00:00Z --receiver terrain --collector-height-m 0 \
  --output ../DATA/runs/my-snapshot
```

This writes `summary.json` and `grid.npz`. With these settings Shackleton Rim is 95.9% lit, which is the project's regression reference.

Other commands:

```sh
uv run --locked lunascout-science precompute                       # queue NASA's reference sites to the end of next month
uv run --locked lunascout-science precompute --from 2026-12-01 --through 2026-12-31
LUNASCOUT_HORIZONS_CONTACT='you@example.org' uv run --locked lunascout-science check-ephemeris
```

`precompute` only queues background work, which the worker computes whenever no visitor's simulation is waiting. `check-ephemeris` compares the Sun and Earth positions with JPL Horizons and appends the result to `DATA/logs/ephemeris-check.log`.

## Tests

```sh
cd backend
uv run --locked --with pytest python -m pytest tests
```

The suite covers the ray tracer, the horizon method against direct tracing, event timing, run queueing and reuse, elevation tiles, the rays and the per-point statistics. Tests that need the NASA data are skipped when it has not been downloaded. The frontend is checked with `npm run check` (TypeScript) and `npm run build`.

## Accuracy and limitations

- **Earth coverage is geometric.** It says whether terrain blocks the line to Earth, not whether a link would close. Antenna patterns, link budgets and Earth's atmosphere are not modelled.
- **Terrain detail.** About 90% of the 5 m cells are interpolated between LOLA laser tracks (Barker et al. 2021), so grid spacing is not the same as measured detail. Each site reports which resolution it was computed from.
- **Not modelled:** reflected light and Earthshine.
- **Short events.** Events lasting under a minute can be missed.
- **Coverage.** Terrain support is 60°S to 90°S. Sites can be saved elsewhere but are not simulated.
- **Per-point statistics** treat each hourly snapshot as holding for its whole hour. The exact event times come from the site-centre windows.
- **Good-spot standards.** The 70% and 30% thresholds are judgements, shown in the interface, not NASA requirements.

## Data sources

All data comes from NASA.

- [LOLA 5 m south-pole site DEMs](https://pgda.gsfc.nasa.gov/products/78) (Barker et al. 2021) and [LOLA regional DEMs](https://pgda.gsfc.nasa.gov/products/90)
- [Lunar polar illumination, Earth visibility and sky visibility maps](https://pgda.gsfc.nasa.gov/products/69) (NASA Goddard PGDA)
- [Diviner Polar Resource Product](https://ode.rsl.wustl.edu/moon/pagehelp/Content/Missions_Instruments/LRO/DIVINER/PRP.htm) (NASA PDS): modelled temperatures and ice-stability depth for the south pole. Its mesh is built on Kaguya (JAXA) topography.
- [NAIF SPICE kernels](https://naif.jpl.nasa.gov/naif/data.html), including JPL's DE440 planetary ephemeris, and [JPL Horizons](https://ssd-api.jpl.nasa.gov/doc/horizons.html) for the monthly cross-check
- [NASA Moon Trek](https://trek.nasa.gov/moon/), LROC WAC and NAC imagery
- Reference sites: [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20230007818), Table A2-2

Open-source software: React, Three.js, OpenLayers, Vite, FastAPI, NumPy, Numba, Rasterio and SpiceyPy.
