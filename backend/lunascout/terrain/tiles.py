"""Elevation tiles for the 3D view, cut from the NASA LOLA grids.

Tiles follow the south-polar tile grid of NASA Moon Trek's imagery, so a tile and its
photo cover the same ground. The LOLA grids already use that projection (south-polar
stereographic on the 1,737,400 m sphere), so a tile is a resampled window of them.

These tiles are for display only. The simulation traces rays against the full grids
through `terrain.model`, never against tiles.
"""

import hashlib
from pathlib import Path

import numpy as np
import rasterio
from numpy.typing import NDArray
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from .model import LOCAL_DEM_NAMES, REGIONAL_DEM_NAMES, TerrainError

# Half the width of the level-0 tile in projected metres (Moon Trek "default028mm" matrix set).
TILE_HALF_EXTENT_M = 1_095_930.0
# Cells along one side of a tile; a tile has one more node than cells per side.
TILE_CELLS = 64
# Extra ring of nodes on every side, so the viewer can shade tile edges without seams.
TILE_BORDER = 1
TILE_NODES = TILE_CELLS + 1 + 2 * TILE_BORDER
# At level 13 the nodes are 4.2 m apart, matching the finest (5 m) LOLA grids.
MAX_TILE_LEVEL = 13
# Change when the sampling changes, so tiles saved by an older version are ignored.
_TILE_REVISION = 1

Float32Array = NDArray[np.float32]


def node_spacing_m(level: int) -> float:
    """Projected distance between neighbouring nodes of a tile at `level`."""
    # Tile node spacing: s = 2E / (C · 2ᶻ)
    #   s - Projected node spacing, in metres.
    #   E (TILE_HALF_EXTENT_M) - Half-width of the level-0 tile, in metres.
    #   C (TILE_CELLS) - Cells per tile side; z (level) - tile level, dimensionless.
    return 2 * TILE_HALF_EXTENT_M / (TILE_CELLS * 2**level)


def sample_tile(data_dir: Path, level: int, row: int, column: int) -> Float32Array:
    """Heights in metres above the 1,737,400 m sphere at the nodes of one tile.

    The array has `TILE_NODES` rows (north to south) and columns (west to east), including
    the border ring. Nodes without elevation data are NaN. Finer grids replace coarser ones
    wherever they have data and the tile is detailed enough to show the difference.
    """
    if not 0 <= level <= MAX_TILE_LEVEL or not (0 <= row < 2**level and 0 <= column < 2**level):
        raise ValueError("The tile is outside the south-polar tile grid.")

    spacing = node_spacing_m(level)
    tile_width = spacing * TILE_CELLS
    west = -TILE_HALF_EXTENT_M + column * tile_width - TILE_BORDER * spacing
    north = TILE_HALF_EXTENT_M - row * tile_width + TILE_BORDER * spacing
    east = west + (TILE_NODES - 1) * spacing
    south = north - (TILE_NODES - 1) * spacing
    # Rasterio addresses pixel corners, so the grid is shifted by half a node to put
    # pixel centres on the nodes.
    node_grid = from_origin(west - spacing / 2, north + spacing / 2, spacing, spacing)

    terrain_dir = data_dir / "raw" / "terrain"
    heights = np.full((TILE_NODES, TILE_NODES), np.nan, dtype=np.float32)
    try:
        for path in _sources(terrain_dir):
            with rasterio.open(path) as raster:
                # A finer grid adds nothing when the tile's nodes are farther apart than
                # the next coarser grid's posting; the 240 m grid is always the base.
                if path.name != REGIONAL_DEM_NAMES[0] and spacing >= _coarser_posting_m(raster.res[0]):
                    continue
                bounds = raster.bounds
                if bounds.right <= west or bounds.left >= east or bounds.top <= south or bounds.bottom >= north:
                    continue

                layer = np.full_like(heights, np.nan)
                reproject(
                    source=rasterio.band(raster, 1),
                    destination=layer,
                    dst_crs=raster.crs,
                    dst_transform=node_grid,
                    dst_nodata=np.nan,
                    resampling=Resampling.bilinear,
                )
                known = np.isfinite(layer)
                heights[known] = layer[known]
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise TerrainError("Could not read the LOLA elevation grids.") from exc

    return heights


def load_tile(data_dir: Path, level: int, row: int, column: int) -> bytes:
    """One tile as little-endian float32 bytes, row by row, saved for the next request."""
    path = _cache_dir(data_dir) / str(level) / str(row) / f"{column}.f32"
    if path.is_file():
        return path.read_bytes()

    payload = sample_tile(data_dir, level, row, column).astype("<f4").tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(f".{hashlib.sha256(payload).hexdigest()[:12]}.part")
    staging.write_bytes(payload)
    staging.replace(path)
    return payload


def _sources(terrain_dir: Path) -> list[Path]:
    """Available LOLA grids, coarsest first, so finer data is written last."""
    regional = [terrain_dir / name for name in REGIONAL_DEM_NAMES]
    missing = [path.name for path in regional if not path.is_file()]
    if missing:
        raise TerrainError(f"Missing regional LOLA DEMs: {', '.join(missing)}")
    local = [path for name in LOCAL_DEM_NAMES if (path := terrain_dir / name).is_file()]
    return [*regional, *local]


def _coarser_posting_m(posting_m: float) -> float:
    """Posting of the next coarser LOLA product below a grid with `posting_m`."""
    return 240.0 if posting_m >= 80 else 80.0


def _cache_dir(data_dir: Path) -> Path:
    """Folder for saved tiles, named after the exact elevation files they were cut from."""
    terrain_dir = data_dir / "raw" / "terrain"
    digest = hashlib.sha256(f"rev={_TILE_REVISION};nodes={TILE_NODES};".encode())
    for path in _sources(terrain_dir):
        details = path.stat()
        digest.update(f"{path.name};{details.st_size};{details.st_mtime_ns};".encode())
    return data_dir / "cache" / "terrain_tiles" / digest.hexdigest()[:16]
