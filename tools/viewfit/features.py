"""Edge features for the view-angle fit (docs/viewfit.md).

Model side: one ray per grid sample of the frame, cast from the candidate eye through the candidate view (yaw, pitch);
the hit triangle's plane region (coplanar triangles share one) and a depth bin label the ray, a miss is sky.
Frame side: the frame on the same grid (Lab colours, gradient magnitude), with the HUD and viewmodel masked.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from scene import Camera, Scene


def hud_mask(w: int, h: int, scoped: bool = False) -> np.ndarray:
    """Frame regions that show the world (1) or not (0): CS:GO spectator / POV HUD, kill feed, player panels, chat,
    net_graph and the weapon viewmodel (bottom right); scoped, everything outside the scope circle and its cross
    lines. Coordinates as fractions of a 1920 x 1080 frame."""
    m = np.ones((h, w), np.uint8)

    def box(x0: float, y0: float, x1: float, y1: float) -> None:
        m[int(y0 / 1080 * h):int(math.ceil(y1 / 1080 * h)), int(x0 / 1920 * w):int(math.ceil(x1 / 1920 * w))] = 0

    box(0, 0, 310, 400)  # radar + money
    box(560, 0, 1600, 75)  # scoreboard bar
    box(1380, 60, 1920, 160)  # kill feed
    box(0, 520, 130, 860)  # left team icons
    box(1450, 520, 1920, 860)  # right player panels
    box(0, 820, 760, 1080)  # chat
    box(640, 830, 1300, 960)  # spectated name panel
    box(0, 1000, 1920, 1080)  # bottom HUD strip
    box(1030, 930, 1920, 1080)  # net_graph + ammo
    if scoped:
        vv, uu = np.mgrid[0:h, 0:w]
        r = np.hypot(uu + 0.5 - w / 2, vv + 0.5 - h / 2)
        m[r > SCOPE_RADIUS * h * 0.92] = 0
        cl = max(1, int(round(3 / 1080 * h)))
        m[h // 2 - cl:h // 2 + cl + 1, :] = 0
        m[:, w // 2 - cl:w // 2 + cl + 1] = 0
    else:
        box(1000, 560, 1920, 1080)  # viewmodel (rifle / knife / hands, right handed)
        box(820, 700, 1200, 1080)
    return m


# Scope overlay: a circle of this radius (fraction of the frame height) around the centre; black outside.
SCOPE_RADIUS = 0.415


def is_scoped(bgr: np.ndarray) -> bool:
    """True when the AWP / SSG scope overlay is up: the band left and right of the scope circle is black."""
    h, w = bgr.shape[:2]
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    y0, y1 = int(0.35 * h), int(0.6 * h)
    xl = int(w / 2 - SCOPE_RADIUS * h * 1.12)
    xr = int(w / 2 + SCOPE_RADIUS * h * 1.12)
    d = max(2, int(0.03 * h))
    side = np.concatenate([g[y0:y1, xl - d:xl].ravel(), g[y0:y1, xr:xr + d].ravel()])
    inner = g[y0:y1, w // 2 - d:w // 2 + d]
    return float(np.median(side)) < 10 and float(np.percentile(side, 90)) < 25 and float(inner.mean()) > 20


def plane_ids(scene: Scene, max_bend_deg: float = 12.0) -> np.ndarray:
    """A region id (>= 1) per triangle: triangles joined through shared edges whose normals differ by less than
    `max_bend_deg` (the mesh is decimated on an 8-unit grid, so flat floors and walls come out slightly bent) form one
    region, so a room's floor or a whole wall is one region, and its tessellation can't be matched to frame texture."""
    tris = scene.tris.astype(np.int64)
    nt = len(tris)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e.sort(axis=1)
    owner = np.tile(np.arange(nt), 3)
    key = e[:, 0] * (int(e.max()) + 1) + e[:, 1]
    order = np.argsort(key, kind='stable')
    ks = key[order]
    os_ = owner[order]
    same = ks[1:] == ks[:-1]
    a = os_[:-1][same]
    b = os_[1:][same]
    n = scene.normals.astype(np.float64)
    ok = (n[a] * n[b]).sum(1) > math.cos(math.radians(max_bend_deg))
    a = a[ok]
    b = b[ok]
    parent = np.arange(nt)

    def find(x: np.ndarray) -> np.ndarray:
        while True:
            px = parent[x]
            if np.array_equal(px, x):
                return x
            parent[x] = parent[px]
            x = parent[x]

    # Vectorised union by repeated pointer jumping (min label propagation).
    for _ in range(200):
        ra = find(a.copy())
        rb = find(b.copy())
        lo = np.minimum(ra, rb)
        hi = np.maximum(ra, rb)
        diff = lo != hi
        if not diff.any():
            break
        np.minimum.at(parent, hi[diff], lo[diff])
    roots = find(np.arange(nt))
    _, inv = np.unique(roots, return_inverse=True)
    return inv.ravel().astype(np.int64) + 1


class GridFrame:
    """A frame sampled on a regular grid (every `step` px): Lab colours, gradient magnitude, mask, camera directions."""

    def __init__(self, bgr: np.ndarray, mask: np.ndarray, cam: Camera, step: int = 6, blur: float = 1.5):
        h, w = bgr.shape[:2]
        self.step = step
        lab = cv2.cvtColor(cv2.GaussianBlur(bgr, (0, 0), blur), cv2.COLOR_BGR2LAB).astype(np.float32)
        gray = cv2.GaussianBlur(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.0)
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        gm = np.sqrt(gx * gx + gy * gy)
        # Max-pool the gradient over each step x step cell boundary neighbourhood so an edge anywhere between two
        # samples counts.
        gmp = cv2.dilate(gm, np.ones((step + 1, step + 1), np.uint8))
        vs, us = np.mgrid[step // 2:h:step, step // 2:w:step]
        self.gh, self.gw = vs.shape
        self.u = us.ravel()
        self.v = vs.ravel()
        self.keep = (mask[vs, us] > 0).ravel()
        self.col = lab[self.v, self.u][self.keep]
        self.dirs_cam = cam.pixel_dirs_cam(self.u + 0.5, self.v + 0.5)
        c = self.col - self.col.mean(0) if len(self.col) else self.col
        self.total = float((c * c).sum()) if len(self.col) else 0.0
        # Gradient between horizontal / vertical neighbours (at the midpoint, max-pooled).
        g2 = gmp[vs, us]
        self.gH = ((g2[:, :-1] + g2[:, 1:]) / 2).ravel()
        self.gV = ((g2[:-1, :] + g2[1:, :]) / 2).ravel()
        k2 = self.keep.reshape(self.gh, self.gw)
        self.kH = (k2[:, :-1] & k2[:, 1:]).ravel()
        self.kV = (k2[:-1, :] & k2[1:, :]).ravel()
        allg = np.concatenate([self.gH[self.kH], self.gV[self.kV]])
        self.gmean = float(allg.mean()) if len(allg) else 1.0
        self.gstd = float(allg.std()) if len(allg) else 1.0
        self.contrast = float(np.sqrt(self.total / max(len(self.col), 1)))


class GridScorer:
    """Scores candidate views by casting one ray per grid sample.

    eta: correlation ratio of the frame's Lab colours given the model's region labels, minus chance.
    edge: mean standardised frame gradient across the grid neighbours where the model's label changes.
    score = eta + EDGE_WEIGHT * edge.
    """

    EDGE_WEIGHT = 0.15

    def __init__(self, scene: Scene, region: np.ndarray, gf: GridFrame):
        self.scene = scene
        self.region = region
        self.gf = gf

    def labels(self, eyes: np.ndarray, yaws: np.ndarray, pitches: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from scene import rotations

        Rs = rotations(np.asarray(yaws, float), np.asarray(pitches, float))
        dw = np.einsum('nj,kji->kni', self.gf.dirs_cam, Rs)
        K, n = dw.shape[:2]
        o = np.broadcast_to(np.asarray(eyes, float).reshape(-1, 1, 3), (K, n, 3))
        dist, prim = self.scene.cast(o.reshape(-1, 3), dw.reshape(-1, 3))
        dist = dist.reshape(K, n)
        prim = prim.reshape(K, n)
        db = np.searchsorted(np.array([300.0, 900.0, 2500.0]), dist)
        lab = np.where(prim >= 0, self.region[np.maximum(prim, 0)] * 4 + db, 0)
        return lab, dist, prim

    def score(self, eyes: np.ndarray, yaws: np.ndarray, pitches: np.ndarray, parts: bool = False):
        gf = self.gf
        lab_all, _, _ = self.labels(eyes, yaws, pitches)
        K = lab_all.shape[0]
        lab = lab_all[:, gf.keep]
        n = lab.shape[1]
        big = int(lab_all.max()) + 1
        key = lab + (np.arange(K)[:, None] * big)
        uk, inv = np.unique(key.ravel(), return_inverse=True)
        cnt = np.bincount(inv).astype(np.float64)
        col = gf.col
        mean = col.mean(0)
        between = np.zeros(len(uk))
        for ch in range(3):
            s = np.bincount(inv, weights=np.tile(col[:, ch], K))
            between += cnt * (s / cnt - mean[ch]) ** 2
        cand = uk // big
        b = np.bincount(cand, weights=between, minlength=K)
        nl = np.bincount(cand, minlength=K)
        eta = b / max(gf.total, 1e-9) - (nl - 1) / max(n, 1)
        L = lab_all.reshape(K, gf.gh, gf.gw)
        cH = (L[:, :, :-1] != L[:, :, 1:]).reshape(K, -1) & gf.kH[None, :]
        cV = (L[:, :-1, :] != L[:, 1:, :]).reshape(K, -1) & gf.kV[None, :]
        zH = (gf.gH - gf.gmean) / max(gf.gstd, 1e-6)
        zV = (gf.gV - gf.gmean) / max(gf.gstd, 1e-6)
        num = (cH * zH[None, :]).sum(1) + (cV * zV[None, :]).sum(1)
        den = cH.sum(1) + cV.sum(1)
        edge = num / (den + 20.0)
        sc = eta + self.EDGE_WEIGHT * edge
        if parts:
            return sc, eta, edge
        return sc


class LineSet:
    """Straight line segments of a frame (LSD, unmasked parts) for the Manhattan cue: Mirage's walls, floors, door
    frames, beams and roof lines mostly run along the world axes (docs/geometry.md: 85 % of the wall area is within 10
    deg of an axis), so in the right view most segments point at one of the three vanishing points of x, y and z."""

    MIN_LEN = 14.0
    SIGMA_DEG = 1.5

    def __init__(self, bgr: np.ndarray, mask: np.ndarray, cam: Camera):
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        lsd = cv2.createLineSegmentDetector()
        seg = lsd.detect(gray)[0]
        self.cam = cam
        if seg is None:
            seg = np.zeros((0, 1, 4), np.float32)
        s = seg.reshape(-1, 4).astype(np.float64)
        p1 = s[:, :2]
        p2 = s[:, 2:]
        ln = np.linalg.norm(p2 - p1, axis=1)
        mid = (p1 + p2) / 2
        h, w = mask.shape
        mi = np.clip(mid.astype(np.int64), 0, [w - 1, h - 1])
        # Both ends and the middle must be unmasked (the HUD has many straight lines).
        e1 = np.clip(p1.astype(np.int64), 0, [w - 1, h - 1])
        e2 = np.clip(p2.astype(np.int64), 0, [w - 1, h - 1])
        ok = (ln >= self.MIN_LEN) & (mask[mi[:, 1], mi[:, 0]] > 0) & (mask[e1[:, 1], e1[:, 0]] > 0) & (mask[e2[:, 1], e2[:, 0]] > 0)
        self.mid = mid[ok]
        self.dir = ((p2 - p1) / np.maximum(ln, 1e-9)[:, None])[ok]
        self.len = ln[ok]
        self.total = float(self.len.sum())

    def score(self, yaws: np.ndarray, pitches: np.ndarray) -> np.ndarray:
        """Length-weighted share of segments that point at a vanishing point of a world axis, minus the share a
        random view gets (about 3 x the angular window / 90 deg)."""
        from scene import rotations

        K = len(yaws)
        if self.total <= 0:
            return np.zeros(K)
        Rs = rotations(np.asarray(yaws, float), np.asarray(pitches, float))  # (K, 3, 3): rows fwd, left, up
        c = self.cam
        best = np.zeros((K, len(self.len)))
        for ax in range(3):
            d = Rs[:, :, ax]  # world axis in camera frame (fwd, left, up)
            qx = c.cx * d[:, 0] - c.f * d[:, 1]
            qy = c.cy * d[:, 0] - c.f * d[:, 2]
            qw = d[:, 0]
            vx = qx[:, None] - self.mid[None, :, 0] * qw[:, None]
            vy = qy[:, None] - self.mid[None, :, 1] * qw[:, None]
            nv = np.sqrt(vx * vx + vy * vy) + 1e-12
            cosang = np.abs(vx * self.dir[None, :, 0] + vy * self.dir[None, :, 1]) / nv
            ang = np.degrees(np.arccos(np.clip(cosang, 0, 1)))
            best = np.maximum(best, np.exp(-0.5 * (ang / self.SIGMA_DEG) ** 2))
        share = (best * self.len[None, :]).sum(1) / self.total
        chance = 3 * self.SIGMA_DEG * math.sqrt(2 * math.pi) / 180.0
        return (share - chance) * min(1.0, self.total / 600.0)
