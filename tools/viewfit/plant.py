"""P3: where the C4 was planted, measured on the first-person frames of the recording against the 2020 BSP package.

    python3 tools/viewfit/plant.py render <eye x,y,z> <yaw> <pitch> <out.png> [--w 960 --h 540] [--package mirage-2020]
    python3 tools/viewfit/plant.py ray <eye x,y,z> <yaw> <pitch> <u> <v> [--w 960 --h 540] [--z -158]
        -> the world point the pixel's ray hits on the mesh, and where it crosses the plane z = --z (the bomb's light)

The renderer ray-casts the package's drawn mesh (`render.bin`, G2RM v1: src/app3d/render-package.ts) with the
CS:GO camera of `scene.Camera` (default_fov 90 at 4:3, hor+: 73.74 deg vertical). Colours are the baked vertex
colours of the hit triangle, so the image can be laid next to the video frame (docs/round-data.md "The plant spot").
The private video never enters the repo: frames are decoded to a temp dir by the caller (ffmpeg -ss <t> -i <video>).
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from scene import Camera, Scene, rotation  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def _varints(body: np.ndarray) -> np.ndarray:
    ends = np.nonzero(body < 128)[0]
    starts = np.concatenate([[0], ends[:-1] + 1])
    vals = np.zeros(len(ends), dtype=np.int64)
    low = body & 127
    for k in range(int((ends - starts).max()) + 1):
        idx = starts + k
        ok = idx <= ends
        vals[ok] += low[idx[ok]] << (7 * k)
    return vals


def _unzig(n: np.ndarray) -> np.ndarray:
    return (n >> 1) ^ -(n & 1)


def load_render(package: str = 'mirage-2020') -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(verts N x 3 float32, tris M x 3 int32, colours N x 3 uint8, material per triangle) of a package's render.bin
    (G2RM v1)."""
    b = np.frombuffer(open(os.path.join(ROOT, 'data', 'maps', package, 'render.bin'), 'rb').read(), dtype=np.uint8)
    assert bytes(b[:4]) == b'G2RM' and b[4] == 1, 'not G2RM v1'
    quant = int(b[6]) + 256 * int(b[7])
    nv = int.from_bytes(bytes(b[8:12]), 'little')
    nt = int.from_bytes(bytes(b[12:16]), 'little')
    vals = _varints(b[18:].astype(np.int64))
    assert len(vals) == nv * 6 + nt * 4, 'varint count'
    v = _unzig(vals[: nv * 6]).reshape(nv, 6).cumsum(axis=0)
    t = vals[nv * 6:].reshape(nt, 4)
    a = _unzig(t[:, 0]).cumsum()
    tris = np.stack([a, a + _unzig(t[:, 1]), a + _unzig(t[:, 2])], axis=1).astype(np.int32)
    return (v[:, :3] / quant).astype(np.float32), tris, v[:, 3:].astype(np.uint8), t[:, 3]


# The package draws each prop from a mesh clustered to <= 400 triangles (docs/maps.md "The 2020 package"); that fills
# the opening of the small B-site arch barely looks through at 55-59 s, so its triangles are left out of the image.
SKIP = ('models/props/de_dust/dust_arch_small',)


class RenderScene(Scene):
    def __init__(self, package: str = 'mirage-2020'):
        import json

        verts, tris, cols, mats = load_render(package)
        names = [m['name'] for m in json.load(open(os.path.join(ROOT, 'data', 'maps', package, 'manifest.json')))['render']['materials']]
        keep = ~np.isin(mats, [i for i, n in enumerate(names) if n in SKIP])
        tris = tris[keep]
        super().__init__(verts, tris)
        self.tri_rgb = cols[tris].astype(np.float32).mean(axis=1)


def render(sc: RenderScene, eye: np.ndarray, yaw: float, pitch: float, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """RGB image (H x W x 3 uint8, sky blue on a miss, light shading by the surface normal) and the depth."""
    cam = Camera(w, h)
    depth, prim = cam.render(sc, eye, yaw, pitch)
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    hit = prim >= 0
    rgb[~hit] = (150, 190, 230)
    col = sc.tri_rgb[prim[hit]]
    n = sc.normals[prim[hit]]
    shade = 0.75 + 0.25 * np.abs(n @ np.array([0.3, 0.5, 0.81], dtype=np.float32))
    rgb[hit] = col * shade[:, None]
    return np.clip(rgb, 0, 255).astype(np.uint8), depth


def pixel_ray(eye: np.ndarray, yaw: float, pitch: float, u: float, v: float, w: int, h: int) -> np.ndarray:
    cam = Camera(w, h)
    dc = cam.pixel_dirs_cam(np.array([u], dtype=np.float64), np.array([v], dtype=np.float64))
    return (dc @ rotation(yaw, pitch))[0]


def main(argv: list[str]) -> None:
    def opt(name: str, default: str) -> str:
        return argv[argv.index(name) + 1] if name in argv else default

    w = int(opt('--w', '960'))
    h = int(opt('--h', '540'))
    pkg = opt('--package', 'mirage-2020')
    cmd = argv[0]
    eye = np.array([float(s) for s in argv[1].split(',')], dtype=np.float64)
    yaw = float(argv[2])
    pitch = float(argv[3])
    if cmd == 'render':
        import cv2

        img, _ = render(RenderScene(pkg), eye, yaw, pitch, w, h)
        cv2.imwrite(argv[4], img[:, :, ::-1])
    elif cmd == 'ray':
        u, v = float(argv[4]), float(argv[5])
        d = pixel_ray(eye, yaw, pitch, u, v, w, h)
        sc = RenderScene(pkg)
        dist, prim = sc.cast(eye[None, :], d[None, :])
        hitp = eye + d * float(dist[0]) if math.isfinite(float(dist[0])) else None
        z = float(opt('--z', '-158'))
        s = (z - eye[2]) / d[2] if d[2] < 0 else math.inf
        plane = eye + d * s
        bearing = math.degrees(math.atan2(d[1], d[0]))
        print(f'bearing {bearing:.2f} deg, depression {math.degrees(-math.asin(d[2])):.2f} deg')
        print('mesh hit', None if hitp is None else np.round(hitp, 1), 'dist', round(float(dist[0]), 1))
        print(f'plane z={z}', np.round(plane, 1), 'dist', round(float(s), 1))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
