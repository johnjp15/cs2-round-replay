"""Fit the watched player's view (yaw, pitch) and eye position to every first-person frame of the recording.

    python3 tools/viewfit/fit.py [--video <mp4>] [--out logs/viewfit] [--only cart:18.3-19.0] [--workers 2]

Writes <out>/fit.json (every fitted frame: the chosen view, its score parts, the alternatives, the Viterbi pick) that
tools/fit-view-angles.ts turns into data/source/view-fit.json. Method and accuracy: docs/viewfit.md.

Per frame (480 x 270, a grid sample every 8 px, HUD and viewmodel masked):
  * candidates: around each of the previous frame's best views (+-15 deg yaw, +-12.5 deg pitch), and a coarse sweep
    around the radar yaw (+-35 deg, pitch -84..84; +-45 deg and a 3 x 3 position grid at a segment's first frame);
  * the best few are refined jointly in (dx, dy, dz, yaw, pitch) by a shrinking random search;
  * score = eta^2 of the frame colours given the mesh's plane regions + 0.15 x the frame gradient across the mesh's
    region boundaries (features.GridScorer), minus a prior on the eye offset from the track (radar +-20-40 u).
Per segment: a Viterbi pass over each frame's distinct hypotheses with a turn penalty picks a consistent sequence.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import GridFrame, GridScorer, LabelCube, LineSet, hud_mask, is_scoped, plane_ids  # noqa: E402
from scene import EYE_STAND, ROOT, VFOV_DEG, Camera, Scene  # noqa: E402

W, H = 480, 270
STEP = 8
FPS = 60
# AWP zoom levels (CS:GO weapon data zoom_fov_1 / zoom_fov_2: 40 and 10 at 4:3), as vertical FOVs.
SCOPE_VFOVS = [math.degrees(2 * math.atan(math.tan(math.radians(f / 2)) * 3 / 4)) for f in (40.0, 10.0)]

# Prior on the eye offset from the (snapped) track: radar accuracy +-20-40 u.
POS_SIGMA = 45.0
POS_WEIGHT = 0.03
DZ_MIN, DZ_MAX = -24.0, 12.0  # crouched eye is 18 below the standing eye
DZ_WEIGHT = 0.004
# Viterbi: per hypothesis switch, cost per degree of view change beyond what a player turns in 0.1 s anyway.
TURN_FREE_DEG = 12.0
TURN_COST = 0.006
SKIP_COST = 0.15
MAX_SKIP = 3
DISTINCT_DEG = 5.0
# Weight of the Manhattan vanishing-point cue (features.LineSet) against the mesh score.
MANHATTAN_WEIGHT = 0.5

DEFAULT_VIDEO = os.path.join(ROOT, '..', 'web-apps', 'cs2', 'mirage-round-replay', 'source', 'video_1080p60_h264.mp4')


def default_video() -> str:
    if os.environ.get('VIEWFIT_VIDEO'):
        return os.environ['VIEWFIT_VIDEO']
    for base in (os.path.join(ROOT, '..'), os.path.join(ROOT, '..', '..')):
        p = os.path.join(base, 'web-apps', 'cs2', 'mirage-round-replay', 'source', 'video_1080p60_h264.mp4')
        if os.path.exists(p):
            return os.path.abspath(p)
    return os.path.abspath(DEFAULT_VIDEO)


# ---------------------------------------------------------------------------------------------- round data


class Round:
    def __init__(self) -> None:
        self.data = json.load(open(os.path.join(ROOT, 'data', 'round.json')))
        snapped = json.load(open(os.path.join(ROOT, 'data', 'geometry', 'mirage-tracks.json')))
        self.snapped = snapped['tracks']
        self.tracks = self.data['tracks']

    def segments(self) -> list[dict]:
        """First-person camera segments of players with a track (the death cam and next round excluded)."""
        out = []
        for p in self.data['pov']:
            pid = p['target']
            if 'death cam' in p['note'] or 'next round' in p['note']:
                continue
            tr = self.tracks[pid]
            t1 = min(p['t1'], tr['endT'])
            if t1 <= p['t0']:
                continue
            out.append({'player': pid, 't0': p['t0'], 't1': t1, 'cut1': p['t1']})
        return out

    def base(self, pid: str, t: float) -> np.ndarray:
        """The snapped (CS2 floor) track position at t, linear between the 10 Hz samples."""
        s = self.snapped[pid]
        f = t * 10
        i = int(math.floor(f))
        i = max(0, min(i, len(s) - 1))
        j = min(i + 1, len(s) - 1)
        a = f - math.floor(f)
        return np.array([s[i][k] * (1 - a) + s[j][k] * a for k in range(3)], float)

    def radar_yaw(self, pid: str, t: float) -> float | None:
        y = self.tracks[pid]['yaw']
        if not y:
            return None
        best = min(y, key=lambda r: abs(r['t'] - t))
        if abs(best['t'] - t) > 0.15:
            return None
        return float(best['deg'])


def wrap(a: np.ndarray | float) -> np.ndarray | float:
    return (np.asarray(a) + 180.0) % 360.0 - 180.0


# ---------------------------------------------------------------------------------------------- frames


def frame_numbers(rnd: Round, only: list[tuple[str, float, float]] | None) -> list[dict]:
    """The frames to fit: the 10 Hz grid of every segment, plus 60 fps windows around the key moments."""
    jobs = []
    # (player, t0, t1, every n-th 60 fps frame)
    keys: list[tuple[str, float, float, int]] = [
        ('cart', 18.3, 19.0, 2),  # cart -> Lokier at the Apartments window
        ('cart', 59.4, 60.2, 2),  # cart staring at the Market ceiling after barely's death
        ('donk', 49.85, 50.35, 2),  # donk <-> sp4rtan
        ('cart', 65.8, 69.4, 3),  # cart -> sp4rtan during the defuse
    ]
    for sh in rnd.data['shots']:
        if sh['t'] is None:
            continue
        keys.append((sh['shooter'], sh['t'] - 0.1, sh['t'] + 0.1, 1))
    for seg in rnd.segments():
        pid = seg['player']
        ns = set()
        k0 = math.ceil(seg['t0'] * 10 - 1e-9)
        k1 = math.floor(seg['t1'] * 10 + 1e-9)
        for k in range(k0, k1 + 1):
            t = k / 10
            if t < seg['t0'] + 0.02 or t > seg['cut1'] - 0.02 or t > seg['t1']:
                continue
            ns.add(round(t * FPS))
        for (kp, a, b, every) in keys:
            if kp != pid:
                continue
            for n in range(math.ceil(max(a, seg['t0'] + 0.02) * FPS), math.floor(min(b, seg['t1'], seg['cut1'] - 0.02) * FPS) + 1):
                if n % every == 0:
                    ns.add(n)
        for n in sorted(ns):
            t = n / FPS
            if only and not any(pid == op and a - 1e-9 <= t <= b + 1e-9 for (op, a, b) in only):
                continue
            jobs.append({'player': pid, 'n': n, 't': round(t, 4), 'seg': seg['t0'], 'on10Hz': abs(t * 10 - round(t * 10)) < 1e-6})
    return jobs


def decode_frames(video: str, numbers: list[int], cache: str) -> dict[int, np.ndarray]:
    """Decode the wanted frames at W x H (one sequential pass; cached as <cache>.npy + .json)."""
    meta_p = cache + '.json'
    if os.path.exists(meta_p) and os.path.exists(cache + '.npy'):
        meta = json.load(open(meta_p))
        if set(numbers) <= set(meta['numbers']):
            arr = np.load(cache + '.npy', mmap_mode='r')
            idx = {n: i for i, n in enumerate(meta['numbers'])}
            return {n: np.array(arr[idx[n]]) for n in numbers}
    want = sorted(set(numbers))
    last = want[-1]
    ff = os.environ.get('FFMPEG', 'ffmpeg')
    cmd = [ff, '-v', 'error', '-i', video, '-frames:v', str(last + 1), '-vf', f'scale={W}:{H}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = W * H * 3
    out = np.zeros((len(want), H, W, 3), np.uint8)
    wi = 0
    assert proc.stdout is not None
    for n in range(last + 1):
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        if wi < len(want) and n == want[wi]:
            out[wi] = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
            wi += 1
    proc.stdout.close()
    proc.wait()
    np.save(cache + '.npy', out)
    json.dump({'numbers': want, 'width': W, 'height': H, 'video': os.path.basename(video)}, open(meta_p, 'w'))
    return {n: out[i] for i, n in enumerate(want)}


# ---------------------------------------------------------------------------------------------- fitting


class FrameFit:
    """All scoring of one frame: one GridScorer per FOV hypothesis (normal; scoped: the two zoom levels)."""

    def __init__(self, scene: Scene, region: np.ndarray, bgr: np.ndarray, base: np.ndarray):
        self.scoped = is_scoped(bgr)
        self.base = base
        mask = hud_mask(W, H, scoped=self.scoped)
        vfovs = SCOPE_VFOVS if self.scoped else [VFOV_DEG]
        self.scorers = [(v, GridScorer(scene, region, GridFrame(bgr, mask, Camera(W, H, v), step=STEP))) for v in vfovs]
        self.lines = [LineSet(bgr, mask, Camera(W, H, v)) for v in vfovs]
        self.scene = scene
        self.region = region
        self.cubes: dict[tuple[int, int, int], LabelCube] = {}
        self.contrast = self.scorers[0][1].gf.contrast
        self.samples = int(self.scorers[0][1].gf.keep.sum())

    def score(self, X: np.ndarray, fi: int = 0) -> np.ndarray:
        """X rows (dx, dy, dz, yaw, pitch) -> penalised score."""
        X = np.atleast_2d(X)
        eyes = self.base[None, :] + np.c_[X[:, 0], X[:, 1], EYE_STAND + X[:, 2]]
        p = np.clip(X[:, 4], -89, 89)
        s = self.scorers[fi][1].score(eyes, X[:, 3], p)
        return s + MANHATTAN_WEIGHT * self.lines[fi].score(X[:, 3], p) - prior(X)

    def score_rot(self, X: np.ndarray, fi: int = 0) -> np.ndarray:
        """Like `score`, for rows that share one eye offset (X[0, :3]): one cube map and lookups."""
        X = np.atleast_2d(X)
        key = (int(round(X[0, 0])), int(round(X[0, 1])), int(round(X[0, 2])))
        cube = self.cubes.get(key)
        if cube is None:
            cube = LabelCube(self.scene, self.region, self.base + [key[0], key[1], EYE_STAND + key[2]])
            self.cubes[key] = cube
        Xr = X.copy()
        Xr[:, 0], Xr[:, 1], Xr[:, 2] = key
        p = np.clip(Xr[:, 4], -89, 89)
        sc = self.scorers[fi][1]
        s = sc.score_labels(sc.cube_labels(cube, Xr[:, 3], p))
        return s + MANHATTAN_WEIGHT * self.lines[fi].score(Xr[:, 3], p) - prior(Xr)

    def parts(self, x: np.ndarray, fi: int = 0) -> tuple[float, float, float, float]:
        """(mesh score, eta, edge, manhattan) of one view."""
        eyes = (self.base + [x[0], x[1], EYE_STAND + x[2]])[None]
        p = np.clip(x[4:5], -89, 89)
        s, e, g = self.scorers[fi][1].score(eyes, x[3:4], p, parts=True)
        m = self.lines[fi].score(x[3:4], p)
        return float(s[0]), float(e[0]), float(g[0]), float(m[0])


def prior(X: np.ndarray) -> np.ndarray:
    r2 = (X[:, 0] ** 2 + X[:, 1] ** 2) / POS_SIGMA ** 2
    dz = X[:, 2]
    out = POS_WEIGHT * r2 + DZ_WEIGHT * (np.minimum(dz, 0) / 18.0) ** 2 + 0.02 * (np.maximum(dz, 0) / 12.0) ** 2
    return out


def clamp(X: np.ndarray) -> np.ndarray:
    X = X.copy()
    r = np.hypot(X[:, 0], X[:, 1])
    f = np.where(r > 90, 90 / np.maximum(r, 1e-9), 1.0)
    X[:, 0] *= f
    X[:, 1] *= f
    X[:, 2] = np.clip(X[:, 2], DZ_MIN, DZ_MAX)
    X[:, 3] = wrap(X[:, 3])
    X[:, 4] = np.clip(X[:, 4], -89, 89)
    return X


def grid(off: np.ndarray, yaw0: float, yaw_half: float, yaw_step: float, p0: float, p1: float, p_step: float) -> np.ndarray:
    ys = np.arange(-yaw_half, yaw_half + 1e-9, yaw_step) + yaw0
    ps = np.arange(p0, p1 + 1e-9, p_step)
    Y, P = np.meshgrid(ys, ps)
    n = Y.size
    return np.c_[np.tile(off[:3], (n, 1)), Y.ravel(), P.ravel()]


def refine(ff: FrameFit, x0: np.ndarray, s0: float, fi: int, rng: np.random.Generator, iters: int = 7, batch: int = 36) -> tuple[np.ndarray, float]:
    x = x0.copy()
    best = s0
    step = np.array([10.0, 10.0, 5.0, 1.6, 1.6])
    for _ in range(iters):
        X = clamp(x + rng.normal(size=(batch, 5)) * step)
        s = ff.score(X, fi)
        k = int(np.argmax(s))
        if s[k] > best:
            best = float(s[k])
            x = X[k]
        step *= 0.8
    return x, best


def angdist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """View-direction angle (deg) between (yaw, pitch) rows."""
    ya, pa = np.radians(a[..., 0]), np.radians(a[..., 1])
    yb, pb = np.radians(b[..., 0]), np.radians(b[..., 1])
    c = np.cos(pa) * np.cos(pb) * np.cos(ya - yb) + np.sin(pa) * np.sin(pb)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def distinct(hyps: list[tuple[float, np.ndarray, int]], k: int) -> list[tuple[float, np.ndarray, int]]:
    out: list[tuple[float, np.ndarray, int]] = []
    for h in sorted(hyps, key=lambda q: -q[0]):
        if all(angdist(h[1][3:5], o[1][3:5]) > DISTINCT_DEG for o in out):
            out.append(h)
        if len(out) >= k:
            break
    return out


def fit_frame(ff: FrameFit, prev: list[tuple[float, np.ndarray, int]], radar: float | None, first: bool, rng: np.random.Generator) -> list[tuple[float, np.ndarray, int]]:
    """Distinct refined hypotheses (score, x, fov index), best first."""
    seeds: list[tuple[float, np.ndarray, int]] = []
    off = prev[0][1] if prev else np.zeros(5)
    for fi in range(len(ff.scorers)):
        cands = []
        for (_, px, _) in prev[:3]:
            cands.append(grid(px, px[3], 15, 2.5, px[4] - 12.5, px[4] + 12.5, 2.5))
        anchor = radar if radar is not None else (prev[0][1][3] if prev else 0.0)
        if first:
            for dx in (-40, 0, 40):
                for dy in (-40, 0, 40):
                    o = np.array([dx, dy, 0.0, 0, 0])
                    cands.append(grid(o, anchor, 45, 3.0, -84, 84, 6))
        else:
            cands.append(grid(off, anchor, 35, 3.5, -84, 84, 6))
            # The mirror pitch of the best previous view (looking up and looking down are alike for both cues).
            if prev:
                px = prev[0][1].copy()
                px[4] = -px[4]
                cands.append(grid(px, px[3], 10, 2.5, px[4] - 7.5, px[4] + 7.5, 2.5))
        X = clamp(np.concatenate(cands))
        s = np.concatenate([ff.score_rot(c, fi) for c in (clamp(c) for c in cands)])
        order = np.argsort(-s)
        picked: list[tuple[float, np.ndarray, int]] = []
        for k in order:
            h = (float(s[k]), X[k], fi)
            if all(angdist(h[1][3:5], o[1][3:5]) > DISTINCT_DEG for o in picked):
                picked.append(h)
            if len(picked) >= (6 if first else 3):
                break
        seeds.extend(picked)
    out = []
    for (s0, x0, fi) in seeds:
        s0 = float(ff.score(x0[None], fi)[0])  # the exact score (the cube is a lookup)
        x, s = refine(ff, x0, s0, fi, rng, iters=10 if first else 6)
        out.append((s, x, fi))
    return distinct(out, 5)


def viterbi(frames: list[dict]) -> list[int]:
    """Index of the chosen hypothesis per frame, or -1 for a frame left out as an outlier.

    Minimises, along the segment: per visited frame its score deficit against that frame's best hypothesis, per
    transition TURN_COST x the view change beyond what a player turns anyway in that time, and SKIP_COST per frame
    left out (at most MAX_SKIP in a row). Leaving frames out lets one motion-blurred or smoke-filled frame not drag the
    sequence onto a wrong view (e.g. looking down instead of up at the Market ceiling, 59.73-59.8 s)."""
    n = len(frames)
    if n == 0:
        return []
    views = [np.array([[h['yaw'], h['pitch']] for h in f['hyps']]) for f in frames]
    deficit = [np.array([f['hyps'][0]['score'] - h['score'] for h in f['hyps']]) for f in frames]
    cost: list[np.ndarray] = []
    back: list[tuple[np.ndarray, np.ndarray]] = []
    for jdx in range(n):
        cj = deficit[jdx] + SKIP_COST * jdx  # start here: every frame before is left out
        bi = np.full(len(cj), -1)
        bk = np.full(len(cj), -1)
        for idx in range(max(0, jdx - 1 - MAX_SKIP), jdx):
            dt = max(frames[jdx]['t'] - frames[idx]['t'], 1 / FPS)
            d = angdist(views[idx][:, None, :], views[jdx][None, :, :])
            trans = TURN_COST * np.maximum(d - TURN_FREE_DEG * dt / 0.1, 0)
            tot = cost[idx][:, None] + trans + SKIP_COST * (jdx - idx - 1)
            a = np.argmin(tot, axis=0)
            c = tot[a, np.arange(len(cj))] + deficit[jdx]
            better = c < cj
            cj = np.where(better, c, cj)
            bi = np.where(better, idx, bi)
            bk = np.where(better, a, bk)
        cost.append(cj)
        back.append((bi, bk))
    # End: the last frames may be left out too.
    best = None
    for idx in range(max(0, n - 1 - MAX_SKIP), n):
        k = int(np.argmin(cost[idx]))
        c = float(cost[idx][k]) + SKIP_COST * (n - 1 - idx)
        if best is None or c < best[0]:
            best = (c, idx, k)
    assert best is not None
    path = [-1] * n
    _, idx, k = best
    while idx >= 0:
        path[idx] = int(k)
        pi, pk = back[idx]
        idx, k = int(pi[k]), int(pk[k])
    return path


def seg_path(seg_dir: str, seg: dict, jobs: list[dict]) -> str:
    return os.path.join(seg_dir, f"{seg['player']}-{seg['t0']:.2f}-{len(jobs)}.json")


def fit_segment(args: tuple[dict, list[dict], dict[int, np.ndarray], str | None]) -> list[dict]:
    seg, jobs, frames, cache = args
    scene = Scene()
    region = plane_ids(scene)
    rnd = Round()
    rng = np.random.default_rng(int(seg['t0'] * 1000) + len(jobs))
    out = []
    prev: list[tuple[float, np.ndarray, int]] = []
    last_t = None
    t_start = time.time()
    for j in jobs:
        t = j['t']
        pid = j['player']
        base = rnd.base(pid, t)
        ff = FrameFit(scene, region, frames[j['n']], base)
        radar = rnd.radar_yaw(pid, t)
        first = not prev or (last_t is not None and t - last_t > 0.35)
        hyps = fit_frame(ff, prev, radar, first, rng)
        prev = hyps
        last_t = t
        rec = {
            'player': pid, 't': t, 'n': j['n'], 'on10Hz': j['on10Hz'], 'radarYaw': radar, 'scoped': ff.scoped,
            'contrast': round(ff.contrast, 2), 'samples': ff.samples,
            'base': [round(float(v), 2) for v in base],
            'hyps': [],
        }
        for (s, x, fi) in hyps:
            tot, eta, edge, man = ff.parts(x, fi)
            rec['hyps'].append({
                'score': round(s, 5), 'mesh': round(tot, 5), 'eta': round(eta, 5), 'edge': round(edge, 5), 'manhattan': round(man, 5),
                'dx': round(float(x[0]), 2), 'dy': round(float(x[1]), 2), 'dz': round(float(x[2]), 2),
                'yaw': round(float(wrap(x[3])), 3), 'pitch': round(float(x[4]), 3), 'vfov': round(ff.scorers[fi][0], 3),
            })
        out.append(rec)
        print(f"{pid} {t:7.3f} {'S' if ff.scoped else ' '} best yaw {rec['hyps'][0]['yaw']:8.2f} pitch {rec['hyps'][0]['pitch']:6.2f} "
              f"score {rec['hyps'][0]['score']:.3f} radar {radar} ({time.time() - t_start:.0f}s)", flush=True)
    path = viterbi(out)
    for rec, k in zip(out, path):
        rec['pick'] = k
    if cache:
        json.dump(out, open(cache, 'w'))
    return out


def parse_only(s: str | None) -> list[tuple[str, float, float]] | None:
    if not s:
        return None
    res = []
    for part in s.split(','):
        pid, rng_ = part.split(':')
        a, b = rng_.split('-')
        res.append((pid, float(a), float(b)))
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', default=default_video())
    ap.add_argument('--out', default=os.path.join(ROOT, 'logs', 'viewfit'))
    ap.add_argument('--only', default=None)
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--repick', action='store_true', help='recompute the Viterbi picks of the cached segments and write fit.json')
    a = ap.parse_args()
    if a.repick:
        seg_dir = os.path.join(a.out, 'segments')
        results = []
        for name in sorted(os.listdir(seg_dir)):
            seg = json.load(open(os.path.join(seg_dir, name)))
            seg.sort(key=lambda r: r['t'])
            for rec, k in zip(seg, viterbi(seg)):
                rec['pick'] = k
            results.extend(seg)
        results.sort(key=lambda r: (r['t'], r['player']))
        json.dump({'format': 'cs2-round-replay/viewfit-raw@1', 'width': W, 'height': H, 'step': STEP, 'frames': results}, open(os.path.join(a.out, 'fit.json'), 'w'))
        print('repicked', len(results), 'frames')
        return
    os.makedirs(a.out, exist_ok=True)
    rnd = Round()
    only = parse_only(a.only)
    jobs = frame_numbers(rnd, only)
    print(f'{len(jobs)} frames', flush=True)
    frames = decode_frames(a.video, [j['n'] for j in jobs], os.path.join(a.out, 'frames'))
    # One task per segment; a long segment is split where the 10 Hz grid allows (each part restarts with a full search).
    tasks: list = []
    for seg in rnd.segments():
        sj = [j for j in jobs if j['player'] == seg['player'] and seg['t0'] <= j['t'] <= seg['t1']]
        if not sj:
            continue
        tasks.append((seg, sj, {j['n']: frames[j['n']] for j in sj}))
    tasks.sort(key=lambda q: -len(q[1]))
    # Each segment's result is cached in <out>/segments/ (a long run survives a restart); --only runs never cache.
    seg_dir = os.path.join(a.out, 'segments')
    os.makedirs(seg_dir, exist_ok=True)
    results: list[dict] = []
    todo = []
    for task in tasks:
        cp = seg_path(seg_dir, task[0], task[1])
        if not only and os.path.exists(cp):
            results.extend(json.load(open(cp)))
        else:
            todo.append(task)
    tasks = [(t[0], t[1], t[2], None if only else seg_path(seg_dir, t[0], t[1])) for t in todo]
    if a.workers > 1 and len(tasks) > 1:
        import multiprocessing as mp

        with mp.get_context('fork').Pool(a.workers) as pool:
            for r in pool.imap_unordered(fit_segment, tasks):
                results.extend(r)
    else:
        for task in tasks:
            results.extend(fit_segment(task))
    results.sort(key=lambda r: (r['t'], r['player']))
    name = 'fit.json' if not only else 'fit-only.json'
    json.dump({'format': 'cs2-round-replay/viewfit-raw@1', 'width': W, 'height': H, 'step': STEP, 'frames': results}, open(os.path.join(a.out, name), 'w'))
    print('wrote', os.path.join(a.out, name), len(results), 'frames')


if __name__ == '__main__':
    main()
