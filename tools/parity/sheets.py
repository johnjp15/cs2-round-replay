#!/usr/bin/env python3
"""V0 video parity: contact sheets and image similarity (docs/parity.md). Called by tools/video-parity.ts.

    python3 -I tools/parity/sheets.py sheets <spec.json>      # one JPEG per entry: video | sim | radar overlay
    python3 -I tools/parity/sheets.py similarity <spec.json>  # edge F-score + blurred SSIM per image pair (3D views)

spec.json for `sheets`: {"radar": <overview jpg>, "entries": [{"out", "video", "sim" (image or null), "title",
"lines": [str], "dots": [{"id", "colour", "video": [x, y] | null, "sim": [x, y] | null, "ok": bool}],
"simRadar": bool}]}. Positions are world units; the overlay draws the video's dots as rings and the sim's as filled
dots with a line between them. `simRadar` true: the middle panel is drawn here from the sim dots (no app screenshot).
"""
import json
import sys

import cv2
import numpy as np

POSX, POSY, SCALE = -3230.0, 1713.0, 5.0
BGR = {
    'yellow': (61, 216, 255), 'orange': (48, 146, 255), 'green': (122, 210, 58), 'blue': (255, 166, 78),
    'purple': (242, 95, 182), 'red': (60, 60, 235), 'ct': (235, 160, 90),
}
PANEL_H = 360


def to_px(p, size):
    return int(round((p[0] - POSX) / SCALE * size / 1024.0)), int(round((POSY - p[1]) / SCALE * size / 1024.0))


def fit(img, h):
    return cv2.resize(img, (int(round(img.shape[1] * h / img.shape[0])), h), interpolation=cv2.INTER_AREA)


def label(img, text, org, scale=0.45, colour=(235, 235, 235)):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, colour, 1, cv2.LINE_AA)


def radar_panel(ov, dots, rings=True, fills=True, zoom=False, focus=None):
    """The overview with the dots; zoom: cropped to the video's dots, or to the `focus` player's pair (the worst
    failing one), at least 1,200 u across, so 40 u errors are visible."""
    x0, y0, side = 0.0, 0.0, 1024.0
    pick = [d for d in dots if d.get('id') == focus] if focus else [d for d in dots if d.get('video') is not None]
    pts = [q for d in pick for q in (d.get('video'), d.get('sim')) if q is not None]
    if zoom and pts:
        xs = [(q[0] - POSX) / SCALE for q in pts]
        ys = [(POSY - q[1]) / SCALE for q in pts]
        side = max(240.0, max(max(xs) - min(xs), max(ys) - min(ys)) + 60.0)
        x0 = (max(xs) + min(xs)) / 2 - side / 2
        y0 = (max(ys) + min(ys)) / 2 - side / 2
    m = np.array([[PANEL_H / side, 0, -x0 * PANEL_H / side], [0, PANEL_H / side, -y0 * PANEL_H / side]])
    p = cv2.warpAffine(ov, m, (PANEL_H, PANEL_H), flags=cv2.INTER_AREA, borderValue=(0, 0, 0))
    p = (p * 0.6).astype(np.uint8)

    def to_px(q, _size):
        return (int(round(((q[0] - POSX) / SCALE - x0) * PANEL_H / side)),
                int(round(((POSY - q[1]) / SCALE - y0) * PANEL_H / side)))
    if zoom:
        label(p, f'{side * SCALE:.0f} u across', (6, PANEL_H - 8), 0.38)
    for d in dots:
        c = BGR.get(d.get('colour'), (200, 200, 200))
        v, s = d.get('video'), d.get('sim')
        if rings and fills and v is not None and s is not None:
            cv2.line(p, to_px(v, PANEL_H), to_px(s, PANEL_H), (255, 255, 255) if d.get('ok') else (0, 0, 255), 1,
                     cv2.LINE_AA)
        if fills and s is not None:
            cv2.circle(p, to_px(s, PANEL_H), 4, c, -1, cv2.LINE_AA)
        if rings and v is not None:
            cv2.circle(p, to_px(v, PANEL_H), 7, c, 2, cv2.LINE_AA)
        anchor = s if s is not None else v
        if anchor is not None and d.get('id'):
            x, y = to_px(anchor, PANEL_H)
            label(p, d['id'][:4], (x + 6, y - 6), 0.33)
    return p


def sheets(spec):
    ov = cv2.imread(spec['radar'])
    for e in spec['entries']:
        video = cv2.imread(e['video'])
        vp = fit(video, PANEL_H)
        if e.get('simRadar') or not e.get('sim'):
            sp = radar_panel(ov, e['dots'], rings=False)
            label(sp, 'sim (radar, drawn from the log)', (6, 16))
        else:
            sp = fit(cv2.imread(e['sim']), PANEL_H)
            label(sp, 'sim (2D app)', (6, 16))
        op = radar_panel(ov, e['dots'], zoom=True, focus=e.get('focus'))
        label(op, 'ring = video (CT: recorded route), dot = sim', (6, 16))
        label(vp, 'video', (6, 16))
        row = np.hstack([vp, np.full((PANEL_H, 4, 3), 30, np.uint8), sp, np.full((PANEL_H, 4, 3), 30, np.uint8), op])
        lines = [e['title']] + list(e.get('lines', []))
        bar = np.full((18 * len(lines) + 8, row.shape[1], 3), 24, np.uint8)
        for i, ln in enumerate(lines):
            col = (120, 120, 255) if ln.startswith('FAIL') else (235, 235, 235)
            label(bar, ln, (8, 18 + 18 * i), 0.45, col)
        cv2.imwrite(e['out'], np.vstack([row, bar]), [cv2.IMWRITE_JPEG_QUALITY, 82])


def edge_f(a, b, tol=3):
    ea = cv2.Canny(a, 60, 160) > 0
    eb = cv2.Canny(b, 60, 160) > 0
    if ea.sum() == 0 or eb.sum() == 0:
        return 0.0
    da = cv2.distanceTransform((~ea).astype(np.uint8), cv2.DIST_L2, 3)
    db = cv2.distanceTransform((~eb).astype(np.uint8), cv2.DIST_L2, 3)
    precision = float((da[eb] <= tol).mean())
    recall = float((db[ea] <= tol).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def ssim(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = cv2.GaussianBlur(a, (11, 11), 1.5), cv2.GaussianBlur(b, (11, 11), 1.5)
    va = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a ** 2
    vb = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b ** 2
    cov = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2))
    return float(m.mean())


def similarity(spec):
    """Geometry similarity of a sim view and a video frame: both to 480x270 grey; the HUD bands are masked out."""
    out = []
    for e in spec['pairs']:
        a = cv2.cvtColor(cv2.resize(cv2.imread(e['video']), (480, 270), interpolation=cv2.INTER_AREA),
                         cv2.COLOR_BGR2GRAY)
        b = cv2.cvtColor(cv2.resize(cv2.imread(e['sim']), (480, 270), interpolation=cv2.INTER_AREA),
                         cv2.COLOR_BGR2GRAY)
        for img in (a, b):  # radar, kill feed, team panels, HUD bar, net graph
            img[:45, :] = 0
            img[230:, :] = 0
            img[:, :75] = 0
            img[120:230, 365:] = 0
        a = cv2.equalizeHist(a)
        b = cv2.equalizeHist(b)
        out.append({'t': e['t'], 'edgeF': round(edge_f(a, b), 4),
                    'ssim': round(ssim(cv2.GaussianBlur(a, (0, 0), 4), cv2.GaussianBlur(b, (0, 0), 4)), 4)})
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    cmd, path = sys.argv[1], sys.argv[2]
    spec = json.load(open(path))
    if cmd == 'sheets':
        sheets(spec)
    elif cmd == 'similarity':
        similarity(spec)
    else:
        raise SystemExit(f'unknown command {cmd}')
