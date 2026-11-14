"""Lunar south-pole terrain: LOLA ingest, height lookup, coverage, frames and 3D projection.

    dem.py        DEM: heights anywhere, surface points and normals, coverage
    mesh.py       build_terrain: nested-ring 3D mesh around a point (detail falls with distance)
    export.py     save/load .npz (full precision) and .glb (3D viewers)
    frames/       every coordinate transformation, incl. to_moon_me() for Sun/Earth/orbit vectors
    constants.py  reference radius, frame name, data locations

See CONVENTIONS.md (next to this file) for frames, units, data sources and the handover format.
"""
from .dem import DEM
from .export import load_npz, save_glb, save_npz
from .mesh import TerrainMesh, build_terrain

__all__ = ["DEM", "load_npz", "save_glb", "save_npz", "TerrainMesh", "build_terrain"]
