#!/usr/bin/env python3
"""V0 video parity: ground truth read off eradicate's POV recording (docs/parity.md).

Called by tools/video-parity.ts; usable on its own:

    python3 -I tools/parity/video_truth.py --video <mp4> --round data/round.json --times <times.json> --out <dir>

Writes into <dir> (a cache: frames and scans are reused when present):
  frames/f_<n>.jpg    the full 1080p frame n = round(t * 60) for each requested t (JPEG q 92)
  scan.npz            the top HUD strip of every frame at 60 fps, downscaled (kill feed, clock, bomb icon, score)
  truth.json          per requested time: radar dots (world x/y, colour, identity), HUD numbers, and the 60 fps
                      events (kill-feed entries, bomb icon, score change)

Everything here is deterministic: ffmpeg decodes the same frames, OpenCV's ECC and connected components are
deterministic for the same input, and the digit templates are cut from fixed, hand-labelled frames.

Needs: python3, numpy, opencv-python(-headless), ffmpeg on PATH (or $FFMPEG).
"""
import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np

FPS = 60.0
W, H = 1920, 1080

# --------------------------------------------------------------------------------------------------------------------
# Frame access
# --------------------------------------------------------------------------------------------------------------------


def ffmpeg_bin():
    return os.environ.get('FFMPEG', 'ffmpeg')


def frame_index(t):
    return int(round(t * FPS))


def extract_frames(video, indices, outdir):
    """Decode the requested frame numbers (one ffmpeg pass with a select filter) into outdir/f_<n>.jpg."""
    os.makedirs(outdir, exist_ok=True)
    todo = sorted({n for n in indices if not os.path.exists(os.path.join(outdir, f'f_{n:05d}.jpg'))})
    if not todo:
        return
    # Decode in chunks: the select expression gets long.
    for k in range(0, len(todo), 400):
        chunk = todo[k:k + 400]
        expr = '+'.join(f'eq(n\\,{n})' for n in chunk)
        tmp = os.path.join(outdir, '_tmp_%05d.png')
        cmd = [ffmpeg_bin(), '-loglevel', 'error', '-y', '-i', video, '-vf', f'select={expr}', '-vsync', '0', tmp]
        subprocess.run(cmd, check=True)
        for i, n in enumerate(chunk):
            src = os.path.join(outdir, f'_tmp_{i + 1:05d}.png')
            img = cv2.imread(src)
            cv2.imwrite(os.path.join(outdir, f'f_{n:05d}.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            os.remove(src)


def load_frame(outdir, n):
    img = cv2.imread(os.path.join(outdir, f'f_{n:05d}.jpg'))
    if img is None:
        raise RuntimeError(f'frame {n} missing in {outdir}')
    return img


# The top strip scanned at 60 fps: y 0..180, x 800..1920 (clock, score, bomb icon, kill feed).
STRIP = (0, 180, 800, 1920)


def scan_strip(video, out):
    """Per-frame features of the top strip, streamed (the frames are not kept): kill-feed name pixels per row, red C4
    icon pixels in the clock box, and the CT score box (downscaled grey) for change detection. Cached as scan.npz."""
    if os.path.exists(out):
        z = np.load(out)
        return {k: z[k] for k in z.files}
    y0, y1, x0, x1 = STRIP
    w, h = x1 - x0, y1 - y0
    cmd = [ffmpeg_bin(), '-loglevel', 'error', '-i', video, '-vf', f'crop={w}:{h}:{x0}:{y0}', '-f', 'rawvideo',
           '-pix_fmt', 'bgr24', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    rows, icon, score = [], [], []
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        f = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        rows.append(kill_feed_pixels(f))
        icon.append(bomb_icon_pixels(f))
        score.append(score_box(f))
    proc.wait()
    feats = {'rows': np.array(rows, np.int32), 'icon': np.array(icon, np.int32), 'score': np.array(score, np.float32)}
    np.savez_compressed(out, **feats)
    return feats


# --------------------------------------------------------------------------------------------------------------------
# Digits: template matching against glyphs cut from hand-labelled frames
# --------------------------------------------------------------------------------------------------------------------

# Regions (frame pixels: y0, y1, x0, x1).
REG = {
    'hp': (1030, 1076, 52, 124),
    'armor': (1030, 1076, 258, 330),
    'clip': (1026, 1076, 1722, 1786),
    'reserve': (1042, 1070, 1792, 1830),
    'clock_spec': (8, 46, 915, 1005),
    'clock_pov': (3, 28, 928, 994),
}
# Glyph height ranges per font.
GLYPH_H = {'big': (24, 44), 'small': (12, 22), 'clock_spec': (20, 36), 'clock_pov': (12, 22)}
FONT_OF = {'hp': 'big', 'armor': 'big', 'clip': 'big', 'reserve': 'small', 'clock_spec': 'clock_spec',
           'clock_pov': 'clock_pov'}

# Hand-labelled frames: (field, t, the value the HUD shows there). Read by eye from the video and cross-checked
# against the shots CSV (clip), the damage table (HP/armor) and clock = ceil(98.25 - t) (the clock frames are in the
# middle of their second). Every digit 0-9 of every font is covered.
LABELS = [
    ('clip', 18.55, '29'), ('clip', 18.75, '27'), ('clip', 18.85, '26'), ('clip', 18.95, '25'), ('clip', 20.0, '24'),
    ('clip', 18.62, '28'), ('clip', 66.15, '21'), ('clip', 5.0, '30'), ('clip', 48.9, '23'),
    ('hp', 5.0, '100'), ('hp', 20.0, '27'), ('armor', 5.0, '89'), ('armor', 20.0, '93'),
    ('reserve', 5.0, '90'), ('reserve', 20.0, '90'),
    ('clock_spec', 14.75, '1:24'), ('clock_spec', 15.75, '1:23'), ('clock_spec', 18.75, '1:20'),
    ('clock_spec', 22.75, '1:16'), ('clock_spec', 21.75, '1:17'), ('clock_spec', 20.75, '1:18'),
    ('clock_spec', 19.75, '1:19'), ('clock_spec', 16.75, '1:22'), ('clock_spec', 13.75, '1:25'),
    ('clock_pov', 0.75, '1:38'), ('clock_pov', 1.75, '1:37'), ('clock_pov', 2.75, '1:36'), ('clock_pov', 3.75, '1:35'),
    ('clock_pov', 4.75, '1:34'), ('clock_pov', 8.75, '1:30'), ('clock_pov', 9.75, '1:29'),
]


def glyphs(img, field):
    """Connected components of the bright, low-chroma HUD text in a region: [(x, 16x24 float glyph)], left to right."""
    y0, y1, x0, x1 = REG[field]
    r = img[y0:y1, x0:x1].astype(np.int32)
    lo, hi = GLYPH_H[FONT_OF[field]]
    mn, mx = r.min(axis=2), r.max(axis=2)
    # White text; the HUD draws low HP in a reddish white, so allow chroma up to 70 when the red channel is high.
    m = ((mn > 165) & ((mx - mn) < 55)) | ((r[:, :, 2] > 190) & (mn > 120))
    m = m.astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for k in range(1, n):
        x, y, w, h, area = st[k]
        if lo <= h <= hi and 3 <= w <= h and area >= h:
            g = (lab[y:y + h, x:x + w] == k).astype(np.float32)
            # A '1' is narrow: pad it to keep its aspect.
            pad = max(0, (h * 2 // 3 - w) // 2)
            g = cv2.copyMakeBorder(g, 0, 0, pad, pad, cv2.BORDER_CONSTANT, value=0)
            out.append((x, cv2.resize(g, (16, 24), interpolation=cv2.INTER_AREA)))
    out.sort(key=lambda c: c[0])
    return out


def ncc(a, b):
    a = a - a.mean()
    b = b - b.mean()
    return float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum() + 1e-9))


class DigitReader:
    def __init__(self, frame_of):
        self.t = {}
        for field, t, value in LABELS:
            font = FONT_OF[field]
            digits = value.replace(':', '')
            gs = glyphs(frame_of(t), field)
            if len(gs) != len(digits):
                raise RuntimeError(f'label {field}@{t}: {len(gs)} glyphs for "{value}"')
            for (_, g), d in zip(gs, digits):
                self.t.setdefault(font, {}).setdefault(d, []).append(g)
        for font, ds in self.t.items():
            for d in ds:
                ds[d] = np.mean(ds[d], axis=0)
            missing = sorted(set('0123456789') - set(ds))
            if missing and font != 'small':
                raise RuntimeError(f'font {font}: no template for digits {missing}')

    def read(self, img, field):
        """(value string or None, min match score)."""
        font = FONT_OF[field]
        gs = glyphs(img, field)
        if not gs or len(gs) > 4:
            return None, 0.0
        s, worst = '', 1.0
        for _, g in gs:
            best = max(((ncc(g, tp), d) for d, tp in self.t[font].items()))
            if font == 'small' and best[0] < 0.75:
                return None, best[0]  # the reserve font has templates for a few digits only
            worst = min(worst, best[0])
            s += best[1]
        if worst < 0.55:
            return None, worst
        if field.startswith('clock'):
            if len(s) != 3:
                return None, worst
            s = s[0] + ':' + s[1:]
        return s, worst

    def montage(self, path):
        rows = []
        blank = np.zeros((24, 16), np.float32)
        for font in sorted(self.t):
            rows.append(np.hstack([self.t[font].get(d, blank) for d in '0123456789']))
        cv2.imwrite(path, cv2.resize((np.vstack(rows) * 255).astype(np.uint8), None, fx=3, fy=3,
                                     interpolation=cv2.INTER_NEAREST))


# --------------------------------------------------------------------------------------------------------------------
# Radar
# --------------------------------------------------------------------------------------------------------------------

POSX, POSY, SCALE = -3230.0, 1713.0, 5.0  # overview transform (docs/round-data.md meta.map)


def ov_to_world(px, py):
    return px * SCALE + POSX, POSY - py * SCALE


def world_to_ov(x, y):
    return (x - POSX) / SCALE, (POSY - y) / SCALE


# Spectator full-map radar: fixed crop (frame px), registered once to the overview.
SPEC = (66, 346, 10, 290)
# eradicate's own rotating radar (0-12.75 s): circle in frame px.
POV_C = (150.0, 205.0)
POV_R = 118.0
POV_BOX = (80, 330, 25, 275)  # y0, y1, x0, x1 around the circle

TEAM_HUE = {  # OpenCV hue (0-180) bands of the radar dot colours: T teammates by colour, CTs red when spotted
    'yellow': (22, 34), 'orange': (9, 20), 'green': (55, 85), 'blue': (95, 112), 'purple': (125, 160), 'red': (-8, 6),
}
T_BY_COLOUR = {'yellow': 'barely', 'orange': 'cart', 'purple': 'donk', 'blue': 'eradicate', 'green': 'snarlbot'}


def overview_mask(radar_jpg):
    ov = cv2.imread(radar_jpg, 0)
    m = (ov > 55).astype(np.float32)
    return ov, cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))


def ecc(template, image, warp, motion, iters=300, eps=1e-6, mask=None, gauss=5):
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, iters, eps)
    return cv2.findTransformECC(template, image, warp.astype(np.float32), motion, crit, mask, gauss)


def register_spec(frames, ovm):
    """Median affine (crop px -> overview px) over several spectator frames."""
    ws, ccs = [], []
    for img in frames:
        y0, y1, x0, x1 = SPEC
        c = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        a = cv2.GaussianBlur((c > 75).astype(np.float32), (0, 0), 2)
        w = np.array([[3.77, 0, -20], [0, 3.6, 17]], np.float32)
        try:
            _, w = ecc(a, cv2.GaussianBlur(ovm, (0, 0), 6), w, cv2.MOTION_AFFINE)
            cc, w = ecc(a, cv2.GaussianBlur(ovm, (0, 0), 3), w, cv2.MOTION_AFFINE, eps=1e-7, gauss=3)
        except cv2.error:
            continue
        if cc > 0.85:
            ws.append(w)
            ccs.append(cc)
    if not ws:
        raise RuntimeError('spectator radar registration failed')
    return np.median(np.array(ws), axis=0), float(np.median(ccs)), len(ws)


def blobs(bgr, mask=None):
    """Round, saturated blobs: [(cx, cy, colour, area)] in the image's pixels."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hh, s, v = hsv[:, :, 0].astype(np.int32), hsv[:, :, 1], hsv[:, :, 2]
    sat = (s > 120) & (v > 140)
    if mask is not None:
        sat &= mask
    out = []
    for colour, (a, b) in TEAM_HUE.items():
        min_area = 50 if colour == 'red' else 25  # small red blobs: the flashing site marker, the C4 icon's print
        if a < 0:
            sel = sat & ((hh <= b) | (hh >= 180 + a))
        else:
            sel = sat & (hh >= a) & (hh <= b)
        m = sel.astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        for k in range(1, n):
            x, y, w, h, area = st[k]
            if area < min_area or area > 220 or w > 22 or h > 22:
                continue
            fill = area / float(w * h)
            if fill < 0.5 or max(w, h) > 1.8 * min(w, h):  # death X's, letters and arrows are not filled discs
                continue
            cs, _ = cv2.findContours((lab[y:y + h, x:x + w] == k).astype(np.uint8), cv2.RETR_EXTERNAL,
                                     cv2.CHAIN_APPROX_NONE)
            per = sum(cv2.arcLength(c, True) for c in cs)
            hull = cv2.contourArea(cv2.convexHull(max(cs, key=cv2.contourArea)))
            circ = 4 * math.pi * area / (per * per + 1e-9)
            solid = area / (hull + 1e-9)
            if solid < 0.8 or circ < 0.55:
                continue
            out.append((float(cen[k][0]), float(cen[k][1]), colour, int(area)))
    return out


def bomb_on_radar(crop):
    """The C4 icon on the full-map radar: a bright red box with white print (centre in crop px), or None."""
    r = crop.astype(np.int32)
    red = ((r[:, :, 2] > 165) & (r[:, :, 1] < 80) & (r[:, :, 0] < 80)).astype(np.uint8)
    white = (r.min(axis=2) > 170).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(cv2.dilate(red, np.ones((3, 3), np.uint8)), 8)
    best = None
    for k in range(1, n):
        x, y, w, h, area = st[k]
        if area < 25 or w > 30 or h > 30:
            continue
        wh = int(white[y:y + h, x:x + w].sum())
        if wh >= 4 and (best is None or area > best[2]):
            best = (float(cen[k][0]), float(cen[k][1]), int(area))
    return best


class Radar:
    def __init__(self, ov_jpg, spec_frames):
        self.ov, self.ovm = overview_mask(ov_jpg)
        self.spec_w, self.spec_cc, self.spec_n = register_spec(spec_frames, self.ovm)
        self.bg = None

    def set_background(self, frames):
        y0, y1, x0, x1 = SPEC
        self.bg = np.median(np.array([f[y0:y1, x0:x1] for f in frames]), axis=0).astype(np.uint8)

    def spec_dots(self, img):
        y0, y1, x0, x1 = SPEC
        crop = img[y0:y1, x0:x1]
        mask = None
        if self.bg is not None:
            d = np.abs(crop.astype(np.int32) - self.bg.astype(np.int32)).max(axis=2)
            mask = cv2.dilate((d > 40).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        out = []
        for cx, cy, colour, area in blobs(crop, mask):
            p = self.spec_w @ np.array([cx, cy, 1.0])
            wx, wy = ov_to_world(p[0], p[1])
            out.append({'colour': colour, 'x': round(wx, 1), 'y': round(wy, 1), 'area': area,
                        'px': [round(cx + x0, 1), round(cy + y0, 1)]})
        info = {'kind': 'spectator', 'cc': round(self.spec_cc, 4)}
        b = bomb_on_radar(crop)
        if b is not None:
            p = self.spec_w @ np.array([b[0], b[1], 1.0])
            wx, wy = ov_to_world(p[0], p[1])
            info['bomb'] = {'x': round(wx, 1), 'y': round(wy, 1), 'px': [round(b[0] + x0, 1), round(b[1] + y0, 1)]}
        return out, info

    def pov_raw(self, img):
        """Round dots on eradicate's rotating radar, as screen offsets from its centre (crop px, y down)."""
        y0, y1, x0, x1 = POV_BOX
        crop = img[y0:y1, x0:x1]
        cx, cy = POV_C[0] - x0, POV_C[1] - y0
        yy, xx = np.mgrid[0:crop.shape[0], 0:crop.shape[1]]
        circ = ((xx - cx) ** 2 + (yy - cy) ** 2) < (POV_R - 4) ** 2
        out = []
        for bx, by, colour, area in blobs(crop, circ):
            if math.hypot(bx - cx, by - cy) > POV_R - 12:
                continue  # off-radar arrows sit on the rim
            out.append((bx - cx, by - cy, colour, area, bx + x0, by + y0))
        return out

    @staticmethod
    def pov_to_world(dx, dy, centre, yaw, z):
        """Screen offset -> world. The radar turns with the view (facing = up); z = k e^{i delta} is the calibrated
        zoom (world units per crop px) and rotation offset. Screen (dx, dy down) -> forward = -dy, right = dx."""
        fwd, right = -dy, dx
        th = math.radians(yaw)
        # world = forward * (cos th, sin th) + right * (sin th, -cos th), then the calibration z.
        wx = fwd * math.cos(th) + right * math.sin(th)
        wy = fwd * math.sin(th) - right * math.cos(th)
        w = complex(wx, wy) * z
        return centre[0] + w.real, centre[1] + w.imag

    def pov_dots(self, img, centre, yaw, z):
        out = []
        for dx, dy, colour, area, fx, fy in self.pov_raw(img):
            if math.hypot(dx, dy) < 4:
                continue  # the centre is the watched player himself
            wx, wy = self.pov_to_world(dx, dy, centre, yaw, z)
            out.append({'colour': colour, 'x': round(wx, 1), 'y': round(wy, 1), 'area': area,
                        'px': [round(fx, 1), round(fy, 1)]})
        return out, {'kind': 'pov', 'centre': [round(centre[0], 1), round(centre[1], 1)], 'yaw': yaw,
                     'zoom': round(abs(z), 3), 'rotOffset': round(math.degrees(math.atan2(z.imag, z.real)), 2)}


def calibrate_pov(radar, frames, rd):
    """Least-squares zoom and rotation offset (one complex scalar) of eradicate's radar: the screen offsets of his
    teammates' dots against their recorded offsets from him (both from the same frames)."""
    num, den, n = 0j, 0.0, 0
    for t, img in frames:
        c = track_at(rd, 'eradicate', t)
        yaw = yaw_at(rd, 'eradicate', t)
        for dx, dy, colour, area, _, _ in radar.pov_raw(img):
            pid = T_BY_COLOUR.get(colour)
            if pid is None or pid == 'eradicate' or math.hypot(dx, dy) < 4:
                continue
            a = complex(*radar.pov_to_world(dx, dy, (0.0, 0.0), yaw, 1 + 0j))
            b = complex(*(lambda p: (p[0] - c[0], p[1] - c[1]))(track_at(rd, pid, t)))
            num += a.conjugate() * b
            den += abs(a) ** 2
            n += 1
    if n == 0:
        raise RuntimeError('POV radar calibration: no teammate dots')
    return num / den, n


# --------------------------------------------------------------------------------------------------------------------
# 60 fps strip events: kill feed, bomb icon, score
# --------------------------------------------------------------------------------------------------------------------

KF_X = (1560 - STRIP[2], 1905 - STRIP[2])
KF_ROWS = [90, 124, 158]  # entry centres (frame y); a fourth entry would be off the strip and is not needed here


def kill_feed_pixels(f):
    """Saturated T-yellow or CT-blue name-text pixels in each kill-feed row of one strip frame."""
    hsv = cv2.cvtColor(f[:, KF_X[0]:KF_X[1]], cv2.COLOR_BGR2HSV)
    hh, s, v = hsv[..., 0].astype(np.int32), hsv[..., 1], hsv[..., 2]
    name = (s > 110) & (v > 150) & (((hh >= 18) & (hh <= 34)) | ((hh >= 100) & (hh <= 118)))
    r = f[:, KF_X[0]:KF_X[1]].astype(np.int32)
    redbg = (r[..., 2] > 120) & (r[..., 1] < 60) & (r[..., 0] < 60)  # the watched player's own death: red box
    return [int(name[y - 9:y + 9].sum()) for y in KF_ROWS] + [int(redbg[y - 9:y + 9].sum()) // 20 for y in KF_ROWS]


def kill_feed_onsets(rows, windows):
    """Per (f0, f1, ft) window: the first visible frame of a new kill-feed entry nearest to ft, or None. An onset is a
    frame where a row's name (or red-box) pixels rise by more than 12 over their minimum of the previous 9 frames and
    stay up for 3 frames (an entry fades in over ~3 frames). Each onset is used once, in window order."""
    cand = []
    for f in range(9, len(rows) - 3):
        base = rows[f - 9:f].min(axis=0)
        up = rows[f] - base > 12
        if up.any():
            r = int(np.argmax(up))
            if (rows[f:f + 3, r] - base[r] > 12).all() and not (cand and cand[-1] >= f - 3):
                cand.append(f)
    used, out = set(), []
    for f0, f1, ft in windows:
        c = [f for f in cand if f0 <= f <= f1 and f not in used]
        hit = min(c, key=lambda f: abs(f - ft)) if c else None
        if hit is not None:
            used.add(hit)
        out.append(hit)
    return out


def kill_feed_count(rows):
    """Per frame: how many kill-feed rows hold an entry; entries stack from the top."""
    rows = rows[:, :len(KF_ROWS)]
    present = rows > 60
    count = np.zeros(len(rows), np.int32)
    for i in range(rows.shape[1]):
        count += np.all(present[:, :i + 1], axis=1)
    return count


def bomb_icon_pixels(f):
    """Red C4 icon pixels in the clock box (the HUD swaps the clock for it once the bomb is down)."""
    r = f[4:50, 925 - STRIP[2]:1000 - STRIP[2]].astype(np.int32)
    return int(((r[..., 2] > 150) & (r[..., 1] < 90) & (r[..., 0] < 90)).sum())


def score_box(f):
    """The CT score digits (x 828..886), grey, 4x downscaled, for change detection."""
    g = f[10:66, 828 - STRIP[2]:886 - STRIP[2]].astype(np.float32).mean(axis=2)
    return cv2.resize(g, (g.shape[1] // 4, g.shape[0] // 4), interpolation=cv2.INTER_AREA)


def first_run(mask, start, length=3):
    for i in range(max(0, start), len(mask) - length):
        if mask[i:i + length].all():
            return i
    return None


# --------------------------------------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------------------------------------


def sample_at(round_data, pid, t):
    s = round_data['tracks'][pid]['samples']
    return s[min(range(len(s)), key=lambda k: abs(s[k]['t'] - t))]


def track_at(round_data, pid, t):
    s = round_data['tracks'][pid]['samples']
    i = min(range(len(s)), key=lambda k: abs(s[k]['t'] - t))
    return s[i]['x'], s[i]['y']


def yaw_at(round_data, pid, t):
    ys = round_data['tracks'][pid]['yaw']
    if not ys:
        return None
    i = min(range(len(ys)), key=lambda k: abs(ys[k]['t'] - t))
    return ys[i]['deg']


def identify(dots, t, rd):
    """Who each dot is. T dots by colour (one per colour: the largest; a dead T's colour is his death marker). Red
    dots are spotted CTs: the nearest living CT on the recording within 600 u (identity from round.json, position
    from the video); red blobs by a dead CT's death spot are markers."""
    death = {p['id']: p['deathT'] for p in rd['players']}
    team = {p['id']: p['team'] for p in rd['players']}
    by = {}
    for d in dots:
        d['id'] = None
        d['role'] = 'extra'
        pid = T_BY_COLOUR.get(d['colour'])
        if pid is not None:
            if death[pid] is not None and t > death[pid] + 0.05:
                d['role'] = 'marker'
                continue
            if pid not in by or d['area'] > by[pid]['area']:
                by[pid] = d
    for pid, d in by.items():
        d['id'], d['role'] = pid, 'dot'
    reds = sorted([d for d in dots if d['colour'] == 'red'], key=lambda d: -d['area'])
    # A T's radar shows a CT's dot only while some T sees him (the breakdown's sightings); a red blob outside every
    # sighting window is a last-known "?" or the flashing site marker.
    seen = {s['who'] for s in rd['sightings'] if s['t0'] - 0.3 <= t <= s['t1'] + 0.3}
    taken = set()
    for d in reds:
        best = None
        for pid in team:
            if team[pid] != 'CT' or pid in taken or pid not in seen:
                continue
            dead = death[pid] is not None and t > death[pid] + 0.05
            smp = sample_at(rd, pid, min(t, death[pid]) if dead else t)
            dist = math.hypot(smp['x'] - d['x'], smp['y'] - d['y'])
            reach = max(150.0, float(smp.get('uncertainty') or 0) + 100.0)
            if best is None or dist / reach < best[0] / best[3]:
                best = (dist, pid, dead, reach)
        if best is None:
            continue
        if best[2] and best[0] < 150:
            d['role'] = 'marker'
        elif not best[2] and best[0] < best[3]:
            d['id'], d['role'] = best[1], 'dot'
            taken.add(best[1])
    return dots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--round', required=True)
    ap.add_argument('--radar', required=True)
    ap.add_argument('--times', required=True, help='JSON array of video seconds')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    rd = json.load(open(a.round))
    times = json.load(open(a.times))
    fdir = os.path.join(a.out, 'frames')
    labels_t = [t for _, t, _ in LABELS]
    spec_cal_t = [14.0, 20.0, 26.0, 33.0, 40.0, 45.0, 52.0, 58.0, 64.0, 68.0]
    bg_t = [13.5 + 1.5 * i for i in range(38)]  # spectator frames for the static radar background (median)
    pov_cal_t = [2.0, 4.0, 6.0, 8.0, 10.0]
    need = {frame_index(t) for t in list(times) + labels_t + spec_cal_t + bg_t + pov_cal_t}
    print(f'video_truth: extracting {len(need)} frames', file=sys.stderr)
    extract_frames(a.video, need, fdir)

    def frame_at(t):
        return load_frame(fdir, frame_index(t))

    reader = DigitReader(frame_at)
    reader.montage(os.path.join(a.out, 'digit-templates.png'))
    radar = Radar(a.radar, [frame_at(t) for t in spec_cal_t])
    radar.set_background([frame_at(t) for t in bg_t])

    pov_z, pov_n = calibrate_pov(radar, [(t, frame_at(t)) for t in pov_cal_t], rd)

    print('video_truth: scanning the HUD strip at 60 fps', file=sys.stderr)
    feats = scan_strip(a.video, os.path.join(a.out, 'scan.npz'))
    kf = kill_feed_count(feats['rows'])
    icon = feats['icon']
    sc = feats['score']
    # Kill-feed entries: frames where the count goes up and stays up for 3 frames.
    if feats['rows'].shape[1] < 2 * len(KF_ROWS):
        raise RuntimeError('scan.npz is from an older version: delete it')
    kills = rd['kills']
    onsets = kill_feed_onsets(feats['rows'], [(frame_index(k['t'] - 0.3), frame_index(k['t'] + 0.4), frame_index(k['t'])) for k in kills])
    entries = [{'frame': f, 't': round(f / FPS, 4), 'victim': k['victim']} for k, f in zip(kills, onsets) if f is not None]
    planted = first_run(icon > 120, frame_index(20.0))
    # The icon pulses: "shown" at a frame = seen in the last 0.75 s.
    shown = np.array([icon[max(0, i - 45):i + 1].max() > 120 for i in range(len(icon))])
    ref = sc[frame_index(60.0)]
    diff = np.abs(sc - ref).mean(axis=(1, 2))
    score_change = first_run(diff > 20, frame_index(60.0))

    out_times = []
    for t in times:
        n = frame_index(t)
        img = load_frame(fdir, n)
        rec = {'t': t, 'frame': n, 'frameT': round(n / FPS, 4)}
        if t < 12.75:
            # Centre and rotation: eradicate's recorded position and yaw (round.json); the dots' offsets: the video.
            yaw = yaw_at(rd, 'eradicate', t)
            dots, info = radar.pov_dots(img, track_at(rd, 'eradicate', t), yaw if yaw is not None else 180.0, pov_z)
            layout = 'pov'
        elif t < 13.2:
            dots, info, layout = [], {'kind': 'deathcam'}, 'deathcam'
        else:
            dots, info = radar.spec_dots(img)
            layout = 'spectator'
        rec['radar'] = {'dots': identify(dots, t, rd), **{k: v for k, v in info.items() if k != 'warp'}}
        if 'warp' in info:
            rec['radar']['warp'] = info['warp']
        rec['layout'] = layout
        hud = {}
        for field in ('hp', 'armor', 'clip', 'reserve'):
            v, score = reader.read(img, field)
            hud[field] = {'value': v, 'score': round(score, 3)}
        ck = 'clock_pov' if t < 12.75 else 'clock_spec'
        v, score = reader.read(img, ck)
        hud['clock'] = {'value': v, 'score': round(score, 3), 'bombIcon': bool(shown[n])}
        rec['hud'] = hud
        out_times.append(rec)

    truth = {
        'video': os.path.basename(a.video),
        'fps': FPS,
        'specWarp': radar.spec_w.tolist(),
        'specCc': round(radar.spec_cc, 4),
        'specFrames': radar.spec_n,
        'povZoom': round(abs(pov_z), 4),
        'povRotOffsetDeg': round(math.degrees(math.atan2(pov_z.imag, pov_z.real)), 3),
        'povCalDots': pov_n,
        'events': {
            'killFeed': entries,
            'bombIconFrame': planted,
            'bombIconT': None if planted is None else round(planted / FPS, 4),
            'scoreChangeFrame': score_change,
            'scoreChangeT': None if score_change is None else round(score_change / FPS, 4),
        },
        'killFeedCount': kf.tolist(),
        'times': out_times,
    }
    with open(os.path.join(a.out, 'truth.json'), 'w') as f:
        json.dump(truth, f, indent=1, sort_keys=True)
    print(f'video_truth: wrote {os.path.join(a.out, "truth.json")}', file=sys.stderr)


if __name__ == '__main__':
    main()
