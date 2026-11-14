"""Save a TerrainMesh for other tools.

- .npz : full precision (float64 MOON_ME) for calculations.
- .glb : glTF 2.0 binary for viewers (CesiumJS, Blender, three.js, Windows 3D Viewer).
         Positions are local metres around the origin in glTF's Y-up convention:
             glTF X = east, glTF Y = up, glTF Z = south (= -north)
         The exact transform back to MOON_ME is stored in the file's "extras".
"""
import json
import struct

import numpy as np

from .mesh import TerrainMesh

# local ENU -> glTF axes
_ENU_TO_GLTF = np.array([[1.0, 0.0, 0.0],
                         [0.0, 0.0, 1.0],
                         [0.0, -1.0, 0.0]])


def save_npz(mesh: TerrainMesh, path):
    np.savez_compressed(path, vertices_me=mesh.vertices, triangles=mesh.triangles, level=mesh.level,
                        origin_me=mesh.origin, enu=mesh.enu, meta=json.dumps(mesh.meta))


def load_npz(path) -> TerrainMesh:
    z = np.load(path)
    return TerrainMesh(z["vertices_me"], z["triangles"], z["level"], z["origin_me"], z["enu"],
                       json.loads(str(z["meta"])))


def save_glb(mesh: TerrainMesh, path):
    pos = (mesh.local_enu() @ _ENU_TO_GLTF.T).astype(np.float32)
    nrm = ((mesh.vertex_normals() @ mesh.enu.T) @ _ENU_TO_GLTF.T).astype(np.float32)
    idx = mesh.triangles.astype(np.uint32).ravel()

    blobs, views, offset = [], [], 0
    for arr, target in ((pos, 34962), (nrm, 34962), (idx, 34963)):
        b = arr.tobytes()
        pad = (-len(b)) % 4
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(b), "target": target})
        blobs.append(b + b"\0" * pad)
        offset += len(b) + pad
    binary = b"".join(blobs)

    # glTF position -> MOON_ME:  me = origin + enu.T @ (G.T @ p)   (G = _ENU_TO_GLTF, orthonormal)
    to_me = np.eye(4)
    to_me[:3, :3] = mesh.enu.T @ _ENU_TO_GLTF.T
    to_me[:3, 3] = mesh.origin
    gltf = {
        "asset": {"version": "2.0", "generator": "lunascout"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "lunar_terrain"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "mode": 4}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ],
        "extras": {
            **mesh.meta,
            "gltf_axes": "X=east, Y=up, Z=south, metres, origin at the requested point",
            "gltf_to_moon_me_4x4_column_major": to_me.T.ravel().tolist(),
            "origin_moon_me_m": mesh.origin.tolist(),
        },
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(binary), b"BIN\0") + binary)
