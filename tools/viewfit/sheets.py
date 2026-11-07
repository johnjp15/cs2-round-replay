"""Contact sheets for the view fit: video frame with the CS2 mesh's edges drawn at the fitted view | the mesh rendered
from the fitted eye (normal-shaded, darker with distance) | the same at the radar yaw and level pitch (before).

    python3 tools/viewfit/sheets.py <fit.json> <out.jpg> <player>:<t>[,<player>:<t>...] [--video <mp4>] [--width 640]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fit import default_video  # noqa: E402
from scene import EYE_STAND, Camera, Scene  # noqa: E402


def read_frame(video: str, n: int, w: int, h: int) -> np.ndarray:
    import subprocess

    ff = os.environ.get('FFMPEG', 'ffmpeg')
    out = subprocess.run([ff, '-v', 'error', '-i', video, '-vf', f'select=eq(n\\,{n}),scale={w}:{h}:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).reshape(h, w, 3).copy()


def render(scene: Scene, cam: Camera, eye: np.ndarray, yaw: float, pitch: float) -> tuple[np.ndarray, np.ndarray]:
    d, pr = cam.render(scene, eye, yaw, pitch)
    n = scene.normals[np.maximum(pr, 0)]
    img = ((n * 0.5 + 0.5) * 255).astype(np.uint8)[..., ::-1].copy()
    img[pr < 0] = 0
    sh = np.clip(1 - np.where(pr >= 0, d, 4000) / 4000, 0, 1)[..., None]
    img = (img * (0.3 + 0.7 * sh)).astype(np.uint8)
    dd = np.where(pr >= 0, d, 1e5)
    e = np.zeros(d.shape, bool)
    for ax in (0, 1):
        a = (slice(None, -1), slice(None)) if ax == 0 else (slice(None), slice(None, -1))
        b = (slice(1, None), slice(None)) if ax == 0 else (slice(None), slice(1, None))
        occl = np.abs(dd[a] - dd[b]) > 0.05 * np.minimum(dd[a], dd[b]) + 5
        crease = (pr[a] != pr[b]) & ((n[a] * n[b]).sum(-1) < 0.93)
        e[a] |= occl | crease
    return img, e


def label(img: np.ndarray, text: str) -> None:
    cv2.putText(img, text, (8, img.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, (8, img.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)


def sheet_row(scene: Scene, video: str, rec: dict, w: int, extra: list[tuple[np.ndarray, str]] | None = None) -> np.ndarray:
    h = w * 9 // 16
    hyp = rec['hyps'][rec.get('pick', 0)]
    cam = Camera(w, h, hyp['vfov'])
    base = np.array(rec['base'], float)
    eye = base + [hyp['dx'], hyp['dy'], EYE_STAND + hyp['dz']]
    frame = read_frame(video, rec['n'], w, h)
    rend, e = render(scene, cam, eye, hyp['yaw'], hyp['pitch'])
    over = frame.copy()
    over[e] = (0, 255, 0)
    label(over, f"{rec['player']} {rec['t']:.3f}s  video + CS2 mesh edges at the fit")
    label(rend, f"fit: yaw {hyp['yaw']:.1f}  pitch {hyp['pitch']:.1f}  score {hyp['score']:.2f}  {rec.get('confidence', '')}")
    panels = [over, rend]
    if rec.get('radarYaw') is not None:
        cam0 = Camera(w, h, hyp['vfov'])
        r0, e0 = render(scene, cam0, base + [0, 0, EYE_STAND], rec['radarYaw'], 0.0)
        f0 = frame.copy()
        f0[e0] = (0, 0, 255)
        label(f0, f"before: radar yaw {rec['radarYaw']:.1f}, pitch 0, track eye")
        panels.append(f0)
    for (img, txt) in extra or []:
        im = cv2.resize(img, (w, h))
        label(im, txt)
        panels.append(im)
    return np.hstack(panels)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('fit')
    ap.add_argument('out')
    ap.add_argument('which')
    ap.add_argument('--video', default=default_video())
    ap.add_argument('--width', type=int, default=640)
    ap.add_argument('--quality', type=int, default=80)
    a = ap.parse_args()
    data = json.load(open(a.fit))
    frames = data['frames']
    scene = Scene()
    rows = []
    for item in a.which.split(','):
        pid, t = item.split(':')
        cands = [r for r in frames if r['player'] == pid]
        rec = min(cands, key=lambda r: abs(r['t'] - float(t)))
        rows.append(sheet_row(scene, a.video, rec, a.width))
    wmax = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, wmax - r.shape[1]), (0, 0))) for r in rows]
    cv2.imwrite(a.out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, a.quality])
    print('wrote', a.out)


if __name__ == '__main__':
    main()
