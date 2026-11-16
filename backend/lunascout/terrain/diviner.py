"""Diviner's modelled temperatures and ice-stability depth for a landing site.

NASA's Diviner Polar Resource Product (PDS data set LRO-L-DLRE-5-PRP-V2.0) models the first
year of Diviner observations on a triangular mesh over the south pole (about 500 m between
triangle corners, from the pole out past 80°S). Each triangle has:

- the annual average temperature at 2 cm depth, in kelvin;
- the annual maximum surface temperature, in kelvin;
- the depth in metres at which water ice would lose less than 1 kg per square metre per billion
  years. Zero means ice is stable at the surface; the product writes -999 (its specification
  says -32768) when that depth is below 2.8738 m, meaning no ice is stable within the model's
  reach.

The table also holds -1 in about 100,000 triangles that the documents do not define. They are
the coldest ones (median annual maximum 77 K, against 106 K for the triangles marked 0), so
they are read as ice stable at the surface and counted with the zeros.

These are model results, not detected ice. The mesh is built on Kaguya (JAXA) laser-altimeter
topography.

The 605 MB text table is cut down once to a compact file of triangle centres and the three
values, and that file is what the server reads.
"""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from ..simulation.frames import FloatArray
from .context_maps import polar_xy_m

PRP_URL = (
    "https://pds-geosciences.wustl.edu/lro/lro-l-dlre-4-rdr-v1/lrodlr_1001/data/prp/dlre_prp_south.tab"
)
TABLE_NAME = "dlre_prp_south.tab"
COMPACT_NAME = "diviner_prp_south.npz"

# Fixed-width layout of the table: every record is 210 bytes, the first holds the column names.
RECORD_BYTES = 210
_COLUMNS = {
    "longitude": (126, 141),
    "latitude": (143, 158),
    "mean_temperature": (177, 185),
    "max_temperature": (187, 195),
    "ice_depth": (197, 208),
}
# Any depth at or below this is the "no ice within reach" marker (-999 in the data).
_NO_ICE_AT_OR_BELOW = -900.0
_RECORDS_PER_CHUNK = 200_000

# About the spacing of the mesh, in metres, the finest detail the numbers can give.
RESOLUTION_M = 500.0
# A site is outside the table when no triangle centre lies this close to its centre. The
# centres of neighbouring triangles are at most about 350 m apart.
MAX_CENTRE_GAP_M = 700.0


@dataclass(frozen=True)
class PolarTable:
    """Triangle centres in south-polar stereographic metres, with their three values.

    Temperatures are NaN where the table has none. `ice_depth_m` is infinite where no ice is
    stable within the model's depth, and zero where ice is stable at the surface.
    """

    x_m: FloatArray
    y_m: FloatArray
    mean_temperature_k: FloatArray
    max_temperature_k: FloatArray
    ice_depth_m: FloatArray


@dataclass(frozen=True)
class IceSummary:
    """What the table says about one site. Shares are of the triangles that fall in the site."""

    triangle_count: int
    resolution_m: float
    # True when the site was smaller than a triangle, so the nearest triangle stands for it.
    nearest_triangle_only: bool
    mean_temperature_k: float | None
    max_temperature_k: float | None
    coldest_max_temperature_k: float | None
    stable_ice_share: float
    surface_ice_share: float
    shallowest_ice_depth_m: float | None
    # Mean over the triangles whose ice is buried below the surface; None when there are none.
    mean_buried_ice_depth_m: float | None


def build_compact_table(table_path: Path, compact_path: Path) -> None:
    """Cut the 605 MB text table down to the compact file the server reads."""
    columns: dict[str, list[FloatArray]] = {name: [] for name in _COLUMNS}

    with table_path.open("rb") as table:
        table.seek(RECORD_BYTES)
        while chunk := table.read(RECORD_BYTES * _RECORDS_PER_CHUNK):
            records = np.frombuffer(chunk, dtype=np.uint8).reshape(-1, RECORD_BYTES)
            for name, (start, end) in _COLUMNS.items():
                text = np.ascontiguousarray(records[:, start:end]).view(f"S{end - start}").ravel()
                columns[name].append(text.astype(np.float64))

    values = {name: np.concatenate(parts) for name, parts in columns.items()}
    longitude = np.radians(values["longitude"])
    latitude = np.radians(values["latitude"])
    # Unit direction of each triangle centre: u = (cos φ cos λ, cos φ sin λ, sin φ)
    #   φ, λ - Planetocentric latitude and east longitude of the triangle's centre.
    directions = np.stack(
        [np.cos(latitude) * np.cos(longitude), np.cos(latitude) * np.sin(longitude), np.sin(latitude)], axis=-1
    )
    x_m, y_m = polar_xy_m(directions)

    raw_depth = values["ice_depth"]
    # Depth in metres: infinite for "no ice within reach", zero for ice stable at the surface
    # (the table's 0, and its undocumented -1 in the coldest triangles).
    depth = np.where(raw_depth <= _NO_ICE_AT_OR_BELOW, np.inf, np.maximum(raw_depth, 0.0))
    # A temperature at or below zero kelvin is a missing value, not a measurement.
    mean_temperature = np.where(values["mean_temperature"] > 0, values["mean_temperature"], np.nan)
    max_temperature = np.where(values["max_temperature"] > 0, values["max_temperature"], np.nan)

    compact_path.parent.mkdir(parents=True, exist_ok=True)
    staged = compact_path.with_suffix(".partial.npz")
    np.savez(
        staged,
        x_m=x_m.astype(np.float32),
        y_m=y_m.astype(np.float32),
        mean_temperature_k=mean_temperature.astype(np.float32),
        max_temperature_k=max_temperature.astype(np.float32),
        ice_depth_m=depth.astype(np.float32),
    )
    staged.replace(compact_path)


@lru_cache(maxsize=1)
def load_table(compact_path: Path) -> PolarTable | None:
    """The compact table, or None when it has not been downloaded."""
    if not compact_path.is_file():
        return None

    with np.load(compact_path) as file:
        return PolarTable(
            x_m=file["x_m"].astype(np.float64),
            y_m=file["y_m"].astype(np.float64),
            mean_temperature_k=file["mean_temperature_k"],
            max_temperature_k=file["max_temperature_k"],
            ice_depth_m=file["ice_depth_m"],
        )


def summarize_site_ice(table: PolarTable, x_m: float, y_m: float, radius_m: float) -> IceSummary | None:
    """Numbers for the triangles inside a site, or None when the site is outside the table.

    Triangles are equal in size on the projected plane, so every triangle counts the same.
    """
    nearby = (np.abs(table.x_m - x_m) <= radius_m) & (np.abs(table.y_m - y_m) <= radius_m)
    indices = np.flatnonzero(nearby)
    inside = indices[np.hypot(table.x_m[indices] - x_m, table.y_m[indices] - y_m) <= radius_m]

    nearest_only = inside.size == 0
    if nearest_only:
        distance = np.hypot(table.x_m - x_m, table.y_m - y_m)
        closest = int(np.argmin(distance))
        if distance[closest] > MAX_CENTRE_GAP_M:
            return None
        inside = np.array([closest])

    depth = table.ice_depth_m[inside]
    stable = np.isfinite(depth)
    stable_depth = depth[stable]
    buried_depth = depth[stable & (depth > 0)]

    return IceSummary(
        triangle_count=int(inside.size),
        resolution_m=RESOLUTION_M,
        nearest_triangle_only=nearest_only,
        mean_temperature_k=_mean(table.mean_temperature_k[inside]),
        max_temperature_k=_mean(table.max_temperature_k[inside]),
        coldest_max_temperature_k=_minimum(table.max_temperature_k[inside]),
        # Share of triangles with ice stable somewhere in the model's reach: s = n_stable / n
        #   A triangle with no stable ice has an infinite depth and is left out of the depths,
        #   so the sentinel never enters an average.
        stable_ice_share=float(stable.mean()),
        surface_ice_share=float((depth == 0).mean()),
        shallowest_ice_depth_m=float(stable_depth.min()) if stable_depth.size else None,
        mean_buried_ice_depth_m=float(buried_depth.mean()) if buried_depth.size else None,
    )


def _mean(values: np.ndarray) -> float | None:
    known = values[np.isfinite(values)]
    return float(known.mean()) if known.size else None


def _minimum(values: np.ndarray) -> float | None:
    known = values[np.isfinite(values)]
    return float(known.min()) if known.size else None
