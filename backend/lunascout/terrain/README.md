# Terrain data layer (`lunascout.terrain`)

Takes NASA's lunar south-pole elevation data (LOLA, 20 m), processes it, aligns it with the
coordinate system that Sun/Earth data from JPL uses, and projects it to 3D on demand around
any point. Frames, units and data choices: [CONVENTIONS.md](CONVENTIONS.md).

## Setup (once, from `backend/`)

```bash
pip install -r requirements-terrain.txt
python scripts/fetch_data.py          # ~2.6 GB from NASA into ../DATA/, checksums verified
python -m pytest tests/terrain        # 21 passed
```

No data is stored in git. `backend/manifests/*.json` lists every input file with its NASA source
and checksum. Short on disk? Skip the 2.6 GB DEM: the code then streams just the needed parts
from NASA (slower).

## Project terrain to 3D around a point

```bash
python scripts/build_terrain.py --lat -89.9 --lon 0 --name pole_demo
```

Writes `DATA/processed/terrain/<name>/`: `terrain.glb` (3D viewers), `terrain.npz` (full precision),
`preview.png`, `info.json`. Detail is 20 m at the point and halves with each ring out to ~330 km
(`--n` and `--max-distance-km` change this).

```python
from lunascout.terrain import DEM, build_terrain

mesh = build_terrain(-89.9, 0.0)         # vertices in Moon-fixed metres (MOON_ME), triangles, rings
with DEM() as dem:
    h = dem.height_at_latlon(-89.9, 0.0)             # terrain height at a point
    p = dem.surface_xyz(-89.9, 0.0, above_m=2.0)     # 3D point 2 m above the ground
```

## Bringing Sun/Earth/orbit data into the terrain's frame

Sun/Earth positions are computed elsewhere (`lunascout.ephemeris`). If they arrive in
J2000/ICRF (JPL's standard), one call puts them in the same coordinates as the terrain:

```python
from lunascout.terrain.frames import to_moon_me, az_el
sun_me = to_moon_me(sun_icrf_m, "ICRF", times_utc)
az, el = az_el(sun_me - p, -89.9, 0.0)
```

The handover format is in [CONVENTIONS.md](CONVENTIONS.md#interface-for-sunearthorbit-data-computed-by-others).
`tests/terrain/test_alignment.py` proves real JPL Horizons vectors line up this way
(Sun 0.0002″, Earth 0.05″).

## Files

| Path (under `backend/`) | What |
|---|---|
| `lunascout/terrain/dem.py` | Height lookups, surface points, normals, coverage |
| `lunascout/terrain/mesh.py` | 3D rings around a point |
| `lunascout/terrain/export.py` | glb / npz output |
| `lunascout/terrain/frames/` | `projection` (map ↔ lat/lon), `bodyfixed` (lat/lon ↔ 3D, local east/north/up), `inertial` (Moon-fixed ↔ J2000/ICRF, `to_moon_me`), `spice_kernels` (time, kernel loading) |
| `lunascout/terrain/constants.py` | Radius, frame name, data locations: defined once |
| `scripts/fetch_data.py`, `scripts/build_terrain.py` | Download + verify; 3D around a point |
| `manifests/` | Data sources and checksums |
| `tests/terrain/` | Automated checks, including the JPL compatibility fixture |
| `requirements-terrain.txt` | Python packages this module needs |
