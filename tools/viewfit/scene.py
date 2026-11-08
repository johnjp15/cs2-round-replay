"""CS2 Mirage world mesh (data/geometry/mirage-geometry.bin, G2GM v1) as an Embree ray-cast scene, and the
CS:GO first-person camera used by the view-angle fit (docs/viewfit.md).

Angles follow the repo (docs/conventions.md): yaw degrees counter-clockwise from +x (east), pitch Source's
(positive = looking down). World: x east, y north, z up.
"""
from __future__ import annotations

import math
import os

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GEOMETRY_BIN = os.path.join(ROOT, 'data', 'geometry', 'mirage-geometry.bin')

# CS:GO default_fov 90 at 4:3, hor+ (ScaleFOVByWidthRatio): vertical 73.74 deg fixed.
FOV_43_DEG = 90.0
VFOV_DEG = math.degrees(2 * math.atan(math.tan(math.radians(FOV_43_DEG / 2)) * 3 / 4))
EYE_STAND = 64.0
EYE_CROUCH = 46.0


def _unzigzag(n: np.ndarray) -> np.ndarray:
    return (n >> 1) ^ -(n & 1)


def load_mesh(path: str = GEOMETRY_BIN) -> tuple[np.ndarray, np.ndarray]:
    """(verts float32 N x 3 in world units, tris int32 M x 3), decoded like src/sim2d/geometry.ts decodeGeometry."""
    b = np.frombuffer(open(path, 'rb').read(), dtype=np.uint8)
    assert bytes(b[:4]) == b'G2GM' and b[4] == 1, 'not G2GM v1'
    quant = int(b[6]) + 256 * int(b[7])
    nv = int.from_bytes(bytes(b[8:12]), 'little')
    nt = int.from_bytes(bytes(b[12:16]), 'little')
    body = b[16:].astype(np.int64)
    # LEB128: a varint ends at every byte < 128.
    ends = np.nonzero(body < 128)[0]
    starts = np.concatenate([[0], ends[:-1] + 1])
    vals = np.zeros(len(ends), dtype=np.int64)
    low = body & 127
    maxlen = int((ends - starts).max()) + 1
    for k in range(maxlen):
        idx = starts + k
        ok = idx <= ends
        vals[ok] += low[idx[ok]] << (7 * k)
    assert len(vals) == nv * 3 + nt * 3, 'varint count'
    v = _unzigzag(vals[: nv * 3]).reshape(nv, 3).cumsum(axis=0)
    t = vals[nv * 3:].reshape(nt, 3)
    a = t[:, 0].cumsum()
    tris = np.stack([a, a + 1 + t[:, 1], a + 1 + t[:, 2]], axis=1).astype(np.int32)
    return (v / quant).astype(np.float32), tris


class Scene:
    """Ray casts against the mesh. `cast(origins, dirs)` -> (distance (inf on a miss), triangle id (-1))."""

    def __init__(self, verts: np.ndarray | None = None, tris: np.ndarray | None = None):
        from embreex import rtcore_scene as rtcs
        from embreex.mesh_construction import TriangleMesh

        if verts is None or tris is None:
            verts, tris = load_mesh()
        self.verts = verts
        self.tris = tris
        self.scene = rtcs.EmbreeScene()
        TriangleMesh(self.scene, verts[tris])  # one vertex triple per triangle
        e1 = verts[tris[:, 1]] - verts[tris[:, 0]]
        e2 = verts[tris[:, 2]] - verts[tris[:, 0]]
        n = np.cross(e1, e2)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        self.normals = n.astype(np.float32)

    def cast(self, origins: np.ndarray, dirs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        o = np.ascontiguousarray(origins, dtype=np.float32)
        d = np.ascontiguousarray(dirs, dtype=np.float32)
        res = self.scene.run(o, d, output=1)
        prim = res['primID'].astype(np.int64)
        geom = res['geomID']
        dist = res['tfar'].astype(np.float32)
        miss = geom < 0
        prim[miss] = -1
        dist[miss] = np.inf
        return dist, prim


def rotation(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """Camera axes as rows (forward, left, up) in world coordinates for a Source view angle (roll 0)."""
    y = math.radians(yaw_deg)
    p = math.radians(pitch_deg)
    fwd = np.array([math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), -math.sin(p)])
    left = np.array([-math.sin(y), math.cos(y), 0.0])
    up = np.cross(fwd, left)
    return np.stack([fwd, left, up])


def rotations(yaws: np.ndarray, pitches: np.ndarray) -> np.ndarray:
    """Vectorised `rotation`: (K, 3, 3) for K (yaw, pitch) pairs."""
    y = np.radians(yaws)
    p = np.radians(pitches)
    fwd = np.stack([np.cos(p) * np.cos(y), np.cos(p) * np.sin(y), -np.sin(p)], axis=-1)
    left = np.stack([-np.sin(y), np.cos(y), np.zeros_like(y)], axis=-1)
    up = np.cross(fwd, left)
    return np.stack([fwd, left, up], axis=1)


class Camera:
    """Pinhole camera of a W x H frame with the CS:GO hor+ FOV (square pixels): focal = (H / 2) / tan(vfov / 2)."""

    def __init__(self, width: int, height: int, vfov_deg: float = VFOV_DEG):
        self.w = width
        self.h = height
        self.f = (height / 2) / math.tan(math.radians(vfov_deg / 2))
        self.cx = width / 2
        self.cy = height / 2

    def pixel_dirs_cam(self, u: np.ndarray, v: np.ndarray) -> np.ndarray:
        """Unit camera-frame directions (forward, left, up) through pixel centres u, v."""
        d = np.stack([np.full_like(u, self.f, dtype=np.float64), -(u - self.cx), -(v - self.cy)], axis=-1)
        return d / np.linalg.norm(d, axis=-1, keepdims=True)

    def project_cam(self, d: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Camera-frame directions (..., 3) -> pixel u, v and a mask of those in front."""
        fw = d[..., 0]
        ok = fw > 1e-3
        fs = np.where(ok, fw, 1.0)
        u = self.cx - self.f * d[..., 1] / fs
        v = self.cy - self.f * d[..., 2] / fs
        return u, v, ok

    def render(self, scene: Scene, eye: np.ndarray, yaw: float, pitch: float) -> tuple[np.ndarray, np.ndarray]:
        """Depth (H x W, along the ray) and triangle id for a view."""
        vv, uu = np.mgrid[0:self.h, 0:self.w]
        dc = self.pixel_dirs_cam(uu.astype(np.float64) + 0.5, vv.astype(np.float64) + 0.5)
        dw = dc @ rotation(yaw, pitch)
        o = np.broadcast_to(eye, dw.shape)
        dist, prim = scene.cast(o.reshape(-1, 3), dw.reshape(-1, 3))
        return dist.reshape(self.h, self.w), prim.reshape(self.h, self.w)
