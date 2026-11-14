"""Needs the DEM (local file, or network access to stream it from NASA)."""
import numpy as np
import pytest

from lunascout.terrain.constants import MOON_RADIUS_M as R
from lunascout.terrain import DEM, build_terrain
from lunascout.terrain.frames import latlon_to_map, xyz_to_latlon_h
from lunascout.terrain.mesh import _grid_triangles


@pytest.fixture(scope="module")
def mesh():
    with DEM() as d:
        return build_terrain(-89.45, 222.7, n=64, levels=5, dem=d)


def _border_edges(T):
    e = np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1)
    uniq, cnt = np.unique(e, axis=0, return_counts=True)
    return uniq[cnt == 1]


def _map_xy(V):
    lat, lon, _ = xyz_to_latlon_h(V)
    return np.stack(latlon_to_map(lat, lon), axis=-1)


def test_heights_match_dem(mesh):
    """Level-0 vertices sit on the native grid, so their height equals the DEM there.
    Ring-edge vertices are excluded: stitching moves them onto the coarser ring's edge."""
    edge_verts = np.unique(_border_edges(mesh.triangles))
    sel = np.setdiff1d(np.flatnonzero(mesh.level == 0), edge_verts)[::97]
    lat, lon, h = xyz_to_latlon_h(mesh.vertices[sel])
    x, y = latlon_to_map(lat, lon)
    with DEM() as d:
        hd = np.array([d.height_at(a, b) for a, b in zip(x, y)])
    assert np.max(np.abs(h - hd)) < 0.01


def test_normals_point_up(mesh):
    n = mesh.vertex_normals()
    up = mesh.vertices / np.linalg.norm(mesh.vertices, axis=1, keepdims=True)
    assert (np.einsum("ij,ij->i", n, up) > 0).mean() > 0.999


def _point_segment_dist(P, A, B):
    """Distance from each point in P (p,3) to each segment A-B (s,3) -> (p, s)."""
    AB = B - A
    t = np.einsum("psk,sk->ps", P[:, None, :] - A[None], AB) / np.einsum("sk,sk->s", AB, AB)
    t = np.clip(t, 0, 1)
    C = A[None] + t[..., None] * AB[None]
    return np.linalg.norm(P[:, None, :] - C, axis=-1)


def test_rings_are_watertight(mesh):
    """Every open edge between rings must be exactly covered by the neighbouring ring's edges."""
    V, L = mesh.vertices, mesh.level
    border = _border_edges(mesh.triangles)
    # drop the outer rim of the outermost ring
    xy = _map_xy(V)
    top = L == L.max()
    c = 0.5 * (xy[top].min(0) + xy[top].max(0))
    halfw = 0.5 * (xy[top].max(0) - xy[top].min(0)).max()
    cheb = np.abs(xy - c).max(axis=1)
    rim = (cheb[border] > halfw - 1.0).all(axis=1)
    inner = border[~rim]
    assert len(inner) > 0
    A, B = V[inner[:, 0]], V[inner[:, 1]]
    lev = L[inner[:, 0]]
    for t in (0.25, 0.5, 0.75):
        P = A + t * (B - A)
        D = _point_segment_dist(P, A, B)
        D[lev[:, None] == lev[None, :]] = np.inf  # must be covered by a DIFFERENT ring
        assert D.min(axis=1).max() < 1e-6


def test_glb_roundtrip(mesh, tmp_path):
    """Positions in the .glb, transformed by the matrix stored in its extras, give back MOON_ME XYZ."""
    import json
    import struct
    from lunascout.terrain import load_npz, save_glb, save_npz
    p = tmp_path / "t.glb"
    save_glb(mesh, p)
    b = p.read_bytes()
    jl = struct.unpack("<I", b[12:16])[0]
    g = json.loads(b[20:20 + jl])
    bin0 = 20 + jl + 8
    v = g["bufferViews"][0]
    pos = np.frombuffer(b[bin0 + v["byteOffset"]: bin0 + v["byteOffset"] + v["byteLength"]], np.float32).reshape(-1, 3)
    M = np.array(g["extras"]["gltf_to_moon_me_4x4_column_major"]).reshape(4, 4).T
    me = pos.astype(float) @ M[:3, :3].T + M[:3, 3]
    assert np.abs(me - mesh.vertices).max() < 0.01  # float32 local coordinates: cm-level
    save_npz(mesh, tmp_path / "t.npz")
    m2 = load_npz(tmp_path / "t.npz")
    assert np.array_equal(m2.vertices, mesh.vertices) and m2.meta == mesh.meta


def test_ring_extents_and_spacing(mesh):
    m = mesh.meta
    assert m["spacing_m"] == [20.0, 40.0, 80.0, 160.0, 320.0]
    assert m["half_width_m"][-1] == 32 * 320.0


def test_grid_triangles_hole():
    t = _grid_triangles(8, hole=(2, 2, 4))
    assert len(t) == 2 * (64 - 16)


def test_curvature_far_field():
    """Local 'up' of far vertices must follow the sphere: up = (R+h)cos(theta) - (R+h0),
    i.e. ~ (h - h0) - d^2/2R. On a flat map this drop (kilometres at 150+ km) would be lost."""
    with DEM() as d:
        m = build_terrain(-90, 0, n=16, levels=12, dem=d)
    loc = m.local_enu()
    _, _, h = xyz_to_latlon_h(m.vertices)
    h0 = m.meta["center_height_m"]
    up_unit = m.vertices / np.linalg.norm(m.vertices, axis=1, keepdims=True)
    cos_theta = up_unit @ m.enu[2]
    expected_up = (R + h) * cos_theta - (R + h0)
    assert np.abs(loc[:, 2] - expected_up).max() < 1e-3
    d = np.hypot(loc[:, 0], loc[:, 1])
    far = d > 150_000
    drop = (h[far] - h0) - loc[far, 2]
    assert drop.min() > 6_000  # 150 km -> ~6.5 km of curvature drop
