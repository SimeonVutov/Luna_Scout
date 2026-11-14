"""Build a 3D terrain mesh around a point on the lunar south pole.

    python scripts/build_terrain.py --lat -89.45 --lon 222.7
    python scripts/build_terrain.py --lat -89.9 --lon 0 --n 128 --max-distance-km 150 --name pole

Outputs in DATA/processed/terrain/<name>/:
    terrain.glb   for 3D viewers (CesiumJS, Blender, three.js)
    terrain.npz   full-precision MOON_ME coordinates for science code
    preview.png   quick look (hillshade, light from the north-west)
    info.json     what was built, from what, in which frame
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lunascout.terrain.constants import DATA  # noqa: E402
from lunascout.terrain import DEM, build_terrain, save_glb, save_npz  # noqa: E402


def preview(mesh, path, title=""):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.tri import Triangulation

    loc = mesh.local_enu()
    n = mesh.vertex_normals() @ mesh.enu.T
    a, e = np.radians(315), np.radians(35)  # hillshade light: from the north-west, 35 deg up
    light = np.array([np.cos(e) * np.sin(a), np.cos(e) * np.cos(a), np.sin(e)])
    shade = np.clip(n @ light, 0, None)
    fig, axes = plt.subplots(1, 3, figsize=(18, 6.2), dpi=110)
    T = mesh.triangles
    tri_lev = mesh.level[T].max(axis=1)
    hw = mesh.meta["half_width_m"]
    for ax, (k, label) in zip(axes, [(0, "finest ring"), (min(2, len(hw) - 1), "inner rings"), (len(hw) - 1, "all rings")]):
        sel = tri_lev <= k
        tr = Triangulation(loc[:, 0] / 1e3, loc[:, 1] / 1e3, T[sel])
        c = ax.tripcolor(tr, shade, shading="gouraud", cmap="gray", vmin=0, vmax=max(shade.max(), 1e-6))
        lim = hw[k] / 1e3
        ax.set_xlim(-lim, lim); ax.set_ylim(-lim, lim); ax.set_aspect("equal")
        ax.set_title(f"{label}: ±{lim:g} km, spacing {mesh.meta['spacing_m'][0]:g}-{mesh.meta['spacing_m'][k]:g} m")
        ax.set_xlabel("east (km)"); ax.set_ylabel("north (km)")
        ax.plot(0, 0, "r+", ms=10)
    fig.colorbar(c, ax=axes, shrink=0.8, label="hillshade (light from NW, 35° up)")
    fig.suptitle(title)
    fig.savefig(path)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True, help="degrees, south negative")
    ap.add_argument("--lon", type=float, required=True, help="degrees east")
    ap.add_argument("--n", type=int, default=256, help="squares per ring side (multiple of 4)")
    ap.add_argument("--max-distance-km", type=float, default=300.0, help="how far the outermost ring reaches")
    ap.add_argument("--name", default=None, help="output folder name")
    ap.add_argument("--dem", default=None, help="DEM path or URL (default: local file, else stream from NASA)")
    ap.add_argument("--no-glb", action="store_true")
    a = ap.parse_args()

    t0 = time.time()
    with DEM(a.dem) as dem:
        mesh = build_terrain(a.lat, a.lon, n=a.n, max_distance_m=a.max_distance_km * 1e3, dem=dem)
    dt = time.time() - t0
    name = a.name or f"lat{a.lat:+.4f}_lon{a.lon % 360:.4f}"
    out = DATA / "processed" / "terrain" / name
    out.mkdir(parents=True, exist_ok=True)
    save_npz(mesh, out / "terrain.npz")
    if not a.no_glb:
        save_glb(mesh, out / "terrain.glb")

    preview(mesh, out / "preview.png", f"Terrain around {a.lat:.4f}, {a.lon:.4f} E (top-down, local east/north)")

    info = {**mesh.meta, "request": vars(a), "vertices": int(len(mesh.vertices)),
            "triangles": int(len(mesh.triangles)), "build_seconds": round(dt, 2),
            "origin_moon_me_m": mesh.origin.tolist(), "enu_rows_east_north_up": mesh.enu.tolist()}
    (out / "info.json").write_text(json.dumps(info, indent=2))
    sizes = {p.name: f"{p.stat().st_size / 1e6:.1f} MB" for p in out.iterdir()}
    print(f"built {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} triangles in {dt:.1f}s")
    print(f"rings: {mesh.meta['levels']}, spacing {mesh.meta['spacing_m'][0]:g}..{mesh.meta['spacing_m'][-1]:g} m, "
          f"reach +-{mesh.meta['half_width_m'][-1] / 1e3:g} km, coverage per ring {[round(c, 3) for c in mesh.meta['coverage_fraction']]}")
    print(f"centre height {mesh.meta['center_height_m']:.1f} m  ->  {out}")
    print(sizes)


if __name__ == "__main__":
    main()
