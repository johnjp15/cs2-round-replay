// V2: the watched player's view (yaw, pitch) fitted to the original video, and the engagement positions it implies.
//
//   python3 tools/viewfit/fit.py                       # the fit itself: logs/viewfit/fit.json (about an hour, 2 cores)
//   npx tsx tools/fit-view-angles.ts                   # -> data/source/view-fit.json + logs/viewfit/report.md
//   npx tsx tools/extract-round.ts ../web-apps/cs2/mirage-round-replay/index.html   # merges it into data/round.json
//   npx tsx tools/snap-tracks.ts                       # re-snap the refined samples onto CS2 Mirage
//   npx tsx tools/fit-view-angles.ts --check           # LOS and aim checks on the merged, snapped data (no writes)
//
// Options: --fit <logs/viewfit/fit.json>  --out <data/source/view-fit.json>  --report <logs/viewfit/report.md>
//
// What it does with the raw fit (docs/viewfit.md):
//   1. Per frame, the Viterbi pick; its margin over the best alternative view more than 8 deg away; a confidence.
//   2. Views: `video` (observed / estimated) where the fit holds, else the radar yaw (`radar`, no pitch); each camera
//      segment's first clear view held back across the spectator's camera switch (`inferred`, up to 0.8 s).
//   3. Engagements the camera watches: the shooter's eye offset (the fit's median) and the target moved onto the
//      shooter's line of sight at the frames where the crosshair is on him; both within the radar's accuracy.
//   4. Checks: the view against the target at every watched shot, and the eye-to-band line of every scripted hit of
//      those engagements on the CS2 mesh, before and after.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MapGeometry, decodeGeometry } from '../src/sim2d/geometry';
import { type Confidence, type PlayerId, type RoundData, type Vec3, type ViewSource } from '../src/contracts/index';
import { VIEW_FIT_FORMAT, VIEW_FIT_PATH, type ViewFitFile } from './extract-round';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EYE = 64;
const HEAD = 64;
const CHEST = 48;

// ------------------------------------------------------------------------------------------------ raw fit

interface RawHyp {
  score: number;
  mesh: number;
  eta: number;
  edge: number;
  manhattan: number;
  dx: number;
  dy: number;
  dz: number;
  yaw: number;
  pitch: number;
  vfov: number;
}

interface RawFrame {
  player: PlayerId;
  t: number;
  n: number;
  on10Hz: boolean;
  radarYaw: number | null;
  scoped: boolean;
  contrast: number;
  samples: number;
  base: [number, number, number];
  hyps: RawHyp[];
  pick: number;
}

/** A fitted frame after post-processing. */
export interface FitFrame {
  readonly player: PlayerId;
  readonly t: number;
  readonly n: number;
  readonly on10Hz: boolean;
  readonly radarYaw: number | null;
  readonly scoped: boolean;
  readonly base: Vec3;
  readonly view: RawHyp;
  /** Score of the pick minus the best alternative more than ALT_DEG away (the pick's own score if none). */
  readonly margin: number;
  readonly confidence: Confidence | 'failed';
}

/** Alternatives closer than this to the pick are the same view. */
const ALT_DEG = 8;
/**
 * Confidence thresholds on the total score (mesh + 0.5 manhattan - prior) and the margin. Calibrated on the round:
 * see docs/viewfit.md "Confidence" (scores of the visually checked frames).
 */
export const OBSERVED_MIN_SCORE = 0.62;
export const OBSERVED_MIN_MARGIN = 0.02;
export const ESTIMATED_MIN_SCORE = 0.45;
/** A camera segment's first clear view is held back this long across the spectator's camera switch. */
export const HOLD_BACK_SEC = 0.8;

export function angDist(y1: number, p1: number, y2: number, p2: number): number {
  const r = Math.PI / 180;
  const c = Math.cos(p1 * r) * Math.cos(p2 * r) * Math.cos((y1 - y2) * r) + Math.sin(p1 * r) * Math.sin(p2 * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

export function classify(f: RawFrame): FitFrame {
  // pick -1: the Viterbi pass left the frame out as an outlier.
  const view = (f.pick >= 0 ? f.hyps[f.pick] : f.hyps[0]) as RawHyp;
  let alt = -Infinity;
  for (const h of f.hyps) if (h !== view && angDist(h.yaw, h.pitch, view.yaw, view.pitch) > ALT_DEG) alt = Math.max(alt, h.score);
  const margin = alt === -Infinity ? view.score : view.score - alt;
  let confidence: Confidence | 'failed' = 'failed';
  if (f.pick < 0) confidence = 'failed';
  else if (view.score >= OBSERVED_MIN_SCORE && margin >= OBSERVED_MIN_MARGIN) confidence = 'observed';
  else if (view.score >= ESTIMATED_MIN_SCORE) confidence = 'estimated';
  return {
    player: f.player,
    t: f.t,
    n: f.n,
    on10Hz: f.on10Hz,
    radarYaw: f.radarYaw,
    scoped: f.scoped,
    base: { x: f.base[0], y: f.base[1], z: f.base[2] },
    view,
    margin,
    confidence,
  };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const wrapYaw = (d: number): number => {
  const r = (((d % 360) + 540) % 360) - 180;
  return r <= -180 ? r + 360 : r;
};

// ------------------------------------------------------------------------------------------------ views

interface OutView {
  t: number;
  yaw: number;
  pitch: number | null;
  source: ViewSource;
  confidence: Confidence;
  score: number | null;
  margin: number | null;
  radarYaw: number | null;
  eye: { dx: number; dy: number; dz: number } | null;
  vfov: number | null;
}

export function buildViews(round: RoundData, frames: readonly FitFrame[]): Record<string, OutView[]> {
  const out: Record<string, OutView[]> = {};
  for (const f of frames) {
    const list = out[f.player] ?? (out[f.player] = []);
    if (f.confidence === 'failed') {
      if (f.radarYaw === null) continue;
      list.push({ t: r3(f.t), yaw: r3(wrapYaw(f.radarYaw)), pitch: null, source: 'radar', confidence: 'estimated', score: r3(f.view.score), margin: r3(f.margin), radarYaw: f.radarYaw, eye: null, vfov: null });
      continue;
    }
    list.push({
      t: r3(f.t),
      yaw: r3(wrapYaw(f.view.yaw)),
      pitch: r3(f.view.pitch),
      source: 'video',
      confidence: f.confidence,
      score: r3(f.view.score),
      margin: r3(f.margin),
      radarYaw: f.radarYaw,
      eye: { dx: r2(f.view.dx), dy: r2(f.view.dy), dz: r2(f.view.dz) },
      vfov: r3(f.view.vfov),
    });
  }
  // Hold each segment's first clear view back across the camera switch (inferred), on the 10 Hz grid, while it is
  // inside the track and after this player's previous segment.
  for (const seg of round.pov) {
    const id = seg.target;
    const list = out[id];
    const tr = round.tracks[id];
    if (list === undefined || tr === undefined) continue;
    const inSeg = list.filter((v) => v.t >= seg.t0 - 1e-9 && v.t <= seg.t1 + 1e-9);
    const first = inSeg.slice(0, 3);
    if (first.length < 3 || first.some((v) => v.source !== 'video') || (first[0] as OutView).confidence !== 'observed') continue;
    const a = first[0] as OutView;
    if (first.some((v) => angDist(v.yaw, v.pitch as number, a.yaw, a.pitch as number) > 6)) continue;
    const prevEnd = Math.max(0, ...round.pov.filter((p) => p.target === id && p.t1 <= seg.t0 + 1e-9 && p !== seg).map((p) => p.t1));
    for (let k = Math.ceil((a.t - HOLD_BACK_SEC) * 10 - 1e-9); k / 10 < a.t - 1e-9; k++) {
      const t = k / 10;
      if (t < 0 || t <= prevEnd + 1e-9 || t > tr.endT + 1e-9 || list.some((v) => Math.abs(v.t - t) < 1e-9)) continue;
      list.push({ ...a, t, confidence: 'inferred', score: null, margin: null, radarYaw: null });
    }
  }
  for (const id of Object.keys(out)) (out[id] as OutView[]).sort((p, q) => p.t - q.t);
  return out;
}

// ------------------------------------------------------------------------------------------------ geometry

function loadWorld(): MapGeometry {
  return new MapGeometry(decodeGeometry(new Uint8Array(readFileSync(resolve(ROOT, 'data/geometry/mirage-geometry.bin')))));
}

interface Snapped {
  tracks: Record<string, [number, number, number][]>;
}

/**
 * The snapped tracks the fit's eye bases come from (each frame's `base`): data/geometry/mirage-tracks.json as it was
 * when the fit ran, i.e. before G6's sight pass (pass 5) moved samples to make duels visible. The refinement is relative
 * to these; snap-tracks then re-snaps round.json with the refined samples, and pass 5 only moves what is still
 * out of sight. `--snapped` overrides; default logs/viewfit/tracks-base.json if present, else the committed file.
 */
function loadSnapped(path: string | null): Snapped {
  const p = path ?? (existsSync(resolve(ROOT, 'logs/viewfit/tracks-base.json')) ? resolve(ROOT, 'logs/viewfit/tracks-base.json') : resolve(ROOT, 'data/geometry/mirage-tracks.json'));
  return JSON.parse(readFileSync(p, 'utf8')) as Snapped;
}

/** Snapped (CS2 floor) position at t, linear between the 10 Hz samples, clamped. */
function snappedAt(sn: Snapped, id: string, t: number): Vec3 {
  const s = sn.tracks[id] as [number, number, number][];
  const f = Math.max(0, Math.min(t * 10, s.length - 1));
  const i = Math.floor(f);
  const j = Math.min(i + 1, s.length - 1);
  const a = f - i;
  const p = s[i] as [number, number, number];
  const q = s[j] as [number, number, number];
  return { x: p[0] + (q[0] - p[0]) * a, y: p[1] + (q[1] - p[1]) * a, z: p[2] + (q[2] - p[2]) * a };
}

function viewDir(yaw: number, pitch: number): Vec3 {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

/** Angle (deg) between the view and the direction from `eye` to `pt`. */
function aimError(eye: Vec3, yaw: number, pitch: number, pt: Vec3): number {
  const d = viewDir(yaw, pitch);
  const vx = pt.x - eye.x;
  const vy = pt.y - eye.y;
  const vz = pt.z - eye.z;
  const n = Math.hypot(vx, vy, vz);
  const c = (d.x * vx + d.y * vy + d.z * vz) / n;
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

// ------------------------------------------------------------------------------------------------ engagements

/**
 * The engagements the camera watches from one side. `aim`: times (s) of frames where the watched player's crosshair is
 * on the other player (checked on the contact sheets, docs/viewfit.md); `window`: the samples to refine (the shooter's
 * eye offset over the whole window, the target's offset tapered in and out over TAPER_SEC).
 */
export interface Engagement {
  readonly name: string;
  readonly watched: PlayerId;
  readonly other: PlayerId;
  readonly window: readonly [number, number];
  readonly aim: readonly number[];
  /** Refine positions (false: the views only, no frame shows the other player at the crosshair). */
  readonly refine: boolean;
  /** Before the window, the watched player follows the fit frame by frame over this span (the approach). */
  readonly approach?: readonly [number, number];
  readonly note: string;
}

export const ENGAGEMENTS: readonly Engagement[] = [
  {
    name: 'cart-lokier',
    watched: 'cart',
    other: 'lokier',
    window: [18.2, 18.8],
    aim: [18.75, 18.767, 18.783, 18.8],
    refine: true,
    approach: [17.4, 17.9],
    note: "cart's Apartments window over B site; his headshot on Lokier at 18.8 s (shots 18.52-19.0 s)",
  },
  {
    name: 'donk-sp4rtan',
    watched: 'donk',
    other: 'sp4rtan',
    window: [49.5, 50.3],
    aim: [49.85, 49.867],
    refine: false,
    note: "donk's AWP shot at Sp4rtaN at 49.85 s; Sp4rtaN's hits on donk 49.9-50.3 s",
  },
  {
    name: 'barely-sp4rtan',
    watched: 'barely',
    other: 'sp4rtan',
    window: [58.3, 58.8],
    aim: [],
    refine: false,
    note: "barely's last frames before Sp4rtaN's headshot at 58.85 s",
  },
  {
    name: 'cart-sp4rtan',
    watched: 'cart',
    other: 'sp4rtan',
    window: [65.8, 69.4],
    aim: [],
    refine: false,
    note: "cart's shots at the defusing Sp4rtaN 65.9-66.9 and 68.67-69.27 s; Sp4rtaN kills cart at 69.4 s",
  },
];

/** Refinements are tapered over this long outside each window. */
const TAPER_SEC = 0.8;
/** A refinement never moves a sample further than this (the radar's accuracy is 20-40 u; CTs carry their radius). */
const MAX_MOVE_T = 60;

export interface Move {
  readonly player: PlayerId;
  readonly offset: { dx: number; dy: number };
  readonly window: readonly [number, number];
  /**
   * Optional offset profile before the window: the fitted per-frame offsets of an approach (median of 3), joined
   * linearly to `offset` at `window[0]`; the taper then starts before the first point.
   */
  readonly points?: readonly { t: number; dx: number; dy: number }[];
  readonly frames: string;
  readonly reason: string;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

function clampLen(dx: number, dy: number, max: number): { dx: number; dy: number } {
  const l = Math.hypot(dx, dy);
  return l <= max ? { dx, dy } : { dx: (dx * max) / l, dy: (dy * max) / l };
}

/**
 * The fitted eye is well placed across the view but not along it: moving the camera forward along the view changes
 * the frame little (the score of cart's 18.5-18.8 s frames drops 0.02-0.08 over the first 80-100 u forward, then
 * collapses when the eye reaches the window; docs/viewfit.md "Depth"). So after the fitted offset, the watched player
 * moves forward along his median view yaw by the least amount (DEPTH_STEP steps, at most MAX_DEPTH) that opens the
 * eye-to-band line of every scripted hit of the pair in the window, with the other player re-placed on the line of
 * sight each step.
 */
const DEPTH_STEP = 4;
const MAX_DEPTH = 128;
/** Sideways the fit is tighter: at most this far (units). */
const MAX_SIDE = 64;
/** The other player counts as at the crosshair within this angle of the fitted view. */
const AIM_TOL_DEG = 3;

export function engagementMoves(round: RoundData, frames: readonly FitFrame[], sn: Snapped, g: MapGeometry): Move[] {
  const moves: Move[] = [];
  const hits = engagementHits(round);
  for (const e of ENGAGEMENTS) {
    if (!e.refine) continue;
    const fr = frames.filter((f) => f.player === e.watched && f.t >= e.window[0] - 1e-9 && f.t <= e.window[1] + 1e-9 && f.confidence === 'observed');
    if (fr.length === 0) continue;
    const base = clampLen(median(fr.map((f) => f.view.dx)), median(fr.map((f) => f.view.dy)), MAX_MOVE_T);
    const aimFr = e.aim.map((t) => frames.find((f) => f.player === e.watched && Math.abs(f.t - t) < 0.009)).filter((f): f is FitFrame => f !== undefined && f.confidence !== 'failed');
    const yawRef = median((aimFr.length > 0 ? aimFr : fr).map((f) => f.view.yaw));
    const ux = Math.cos((yawRef * Math.PI) / 180);
    const uy = Math.sin((yawRef * Math.PI) / 180);
    // The other player's cap: 60 u where the radar saw him in the window, else his uncertainty radius.
    const otherSamples = (round.tracks[e.other]?.samples ?? []).filter((s) => s.t >= Math.min(...e.aim, e.window[1]) - 0.5 - 1e-9 && s.t <= e.window[1] + 1e-9);
    const cap = Math.min(...otherSamples.map((s) => (s.confidence === 'observed' ? MAX_MOVE_T : Math.max(MAX_MOVE_T, s.uncertainty ?? MAX_MOVE_T))));
    const pairHits = hits.filter((h) => [h.attacker, h.victim].sort().join('-') === [e.watched, e.other].sort().join('-') && h.t >= e.window[0] - 1e-9 && h.t <= e.window[1] + 0.06);
    const place = (off: { dx: number; dy: number }): { dx: number; dy: number } | null => {
      if (aimFr.length === 0) return null;
      const cx: number[] = [];
      const cy: number[] = [];
      const ds: number[] = [];
      for (const f of aimFr) {
        const eye = { x: f.base.x + off.dx, y: f.base.y + off.dy, z: f.base.z + EYE + f.view.dz };
        const d = viewDir(f.view.yaw, f.view.pitch);
        const p = snappedAt(sn, e.other, f.t);
        const hl = Math.hypot(d.x, d.y);
        const s = Math.max(0, (p.x - eye.x) * (d.x / hl) + (p.y - eye.y) * (d.y / hl));
        cx.push(eye.x + (d.x / hl) * s - p.x);
        cy.push(eye.y + (d.y / hl) * s - p.y);
        ds.push(s);
      }
      // Within AIM_TOL_DEG of the crosshair is on it (the fit's accuracy, spread and recoil): move only the rest.
      const mx = median(cx);
      const my = median(cy);
      const len = Math.hypot(mx, my);
      const tol = median(ds) * Math.tan((AIM_TOL_DEG * Math.PI) / 180);
      const k = len <= tol ? 0 : (len - tol) / len;
      return clampLen(mx * k, my * k, Number.isFinite(cap) ? cap : MAX_MOVE_T);
    };
    const open = (off: { dx: number; dy: number }, toff: { dx: number; dy: number } | null): boolean =>
      pairHits.every((h) => {
        const mv = (id: PlayerId): { dx: number; dy: number } => (id === e.watched ? off : id === e.other && toff !== null ? toff : { dx: 0, dy: 0 });
        const a = snappedAt(sn, h.attacker, Math.min(h.t, e.window[1]));
        const b = snappedAt(sn, h.victim, Math.min(h.t, e.window[1]));
        const ma = mv(h.attacker);
        const mb = mv(h.victim);
        const band = h.band === 'head' ? HEAD : CHEST;
        // With a margin: the band 4 u lower and both ends 2 u off either way stay open too (integer positions,
        // the snapping's floor z).
        const pa = { x: a.x + ma.dx, y: a.y + ma.dy, z: a.z };
        const pb = { x: b.x + mb.dx, y: b.y + mb.dy, z: b.z };
        // ... and with the victim crouched (the puppet's button plan crouches slow stretches: band × 46 / 64).
        return [0, 2, -2].every(
          (q) =>
            lineOpen(g, { ...pa, x: pa.x + q, y: pa.y + q }, { ...pb, x: pb.x - q, y: pb.y - q }, band) &&
            lineOpen(g, { ...pa, x: pa.x + q, y: pa.y - q }, { ...pb, x: pb.x + q, y: pb.y - q }, band - 4) &&
            lineOpen(g, { ...pa, x: pa.x - q, y: pa.y + q }, { ...pb, x: pb.x - q, y: pb.y + q }, (band * 46) / 64),
        );
      });
    // Candidates: forward along the view (weakly constrained by the frame) costs half as much as sideways (well
    // constrained); the cheapest one that opens every shot line wins.
    const cands: { s: number; l: number; cost: number }[] = [];
    for (let fs = 0; fs <= MAX_DEPTH; fs += DEPTH_STEP) for (let l = -MAX_SIDE; l <= MAX_SIDE; l += DEPTH_STEP) cands.push({ s: fs, l, cost: Math.hypot(fs / 2, l) });
    cands.sort((a, b) => a.cost - b.cost || a.s - b.s || a.l - b.l);
    let off = base;
    let toff = place(off);
    let depth = 0;
    let side = 0;
    for (const c of cands) {
      const o = { dx: base.dx + ux * c.s - uy * c.l, dy: base.dy + uy * c.s + ux * c.l };
      const to = place(o);
      if (open(o, to)) {
        off = o;
        toff = to;
        depth = c.s;
        side = c.l;
        break;
      }
    }
    const ts = fr.map((f) => f.t);
    // The approach: the fitted offset of each observed 10 Hz frame, median of 3.
    const ap = e.approach;
    const apFr = ap === undefined ? [] : frames.filter((f) => f.player === e.watched && f.on10Hz && f.t >= ap[0] - 1e-9 && f.t <= ap[1] + 1e-9 && f.confidence === 'observed');
    const med3 = (k: number, key: 'dx' | 'dy'): number => median(apFr.slice(Math.max(0, k - 1), k + 2).map((f) => f.view[key]));
    // Each approach frame then gets the least move (forward along its own view at half cost, or sideways) that
    // opens the eye-to-head line both ways to the other player (with his planned offset at that time), as in the
    // window; the frames of the approach are where the recording has the other player in sight.
    const otherWin: readonly [number, number] = [Math.min(...e.aim, e.window[1]) - 0.5, Math.max(...e.aim, e.window[1])];
    const otherOff = (t: number): { dx: number; dy: number } => {
      if (toff === null) return { dx: 0, dy: 0 };
      const w = t < otherWin[0] ? 1 - (otherWin[0] - t) / TAPER_SEC : t > otherWin[1] ? 1 - (t - otherWin[1]) / TAPER_SEC : 1;
      return w <= 0 ? { dx: 0, dy: 0 } : { dx: toff.dx * w, dy: toff.dy * w };
    };
    const points = apFr.map((f, k) => {
      const o0 = clampLen(med3(k, 'dx'), med3(k, 'dy'), MAX_MOVE_T);
      const fx = Math.cos((f.view.yaw * Math.PI) / 180);
      const fy = Math.sin((f.view.yaw * Math.PI) / 180);
      const a = snappedAt(sn, e.watched, f.t);
      const bo = otherOff(f.t);
      const b0 = snappedAt(sn, e.other, f.t);
      const b = { x: b0.x + bo.dx, y: b0.y + bo.dy, z: b0.z };
      for (const c of cands) {
        const o = { dx: o0.dx + fx * c.s - fy * c.l, dy: o0.dy + fy * c.s + fx * c.l };
        const pa = { x: a.x + o.dx, y: a.y + o.dy, z: a.z };
        if (lineOpen(g, pa, b, HEAD) && lineOpen(g, b, pa, HEAD)) return { t: f.t, ...o };
      }
      return { t: f.t, ...o0 };
    });
    moves.push({
      player: e.watched,
      offset: off,
      window: e.window,
      ...(points.length > 0 ? { points } : {}),
      frames: `${fr.length} observed frames ${Math.min(...ts).toFixed(2)}-${Math.max(...ts).toFixed(2)} s${points.length > 0 ? `; approach: ${points.length} frames ${(points[0] as { t: number }).t}-${(points[points.length - 1] as { t: number }).t} s, each its own fit` : ''}`,
      reason: `${e.name}: the fitted eye (median offset of the frames)${depth !== 0 || side !== 0 ? `, then ${depth} u forward and ${side} u to the left of the view (yaw ${yawRef.toFixed(1)}°) to open the shot lines` : ''}`,
    });
    if (toff === null) continue;
    moves.push({
      player: e.other,
      offset: toff,
      window: [Math.min(...e.aim) - 0.5, Math.max(...e.aim)],
      frames: `${e.watched}'s crosshair at ${e.aim.map((t) => t.toFixed(3)).join(', ')} s`,
      reason: `${e.name}: onto ${e.watched}'s line of sight at his radar distance`,
    });
  }
  return moves;
}

/** Per-sample position edits for the moves (10 Hz grid), tapered at the window ends. */
export function positionEdits(round: RoundData, original: (id: PlayerId, t: number) => Vec3, snapped: (id: PlayerId, t: number) => Vec3, moves: readonly Move[]): ViewFitFile['positions'] {
  const out: { player: string; t: number; from: Vec3; to: Vec3; frames: string; reason: string }[] = [];
  for (const m of moves) {
    const tr = round.tracks[m.player];
    for (const s of tr?.samples ?? []) {
      const pts = [...(m.points ?? []), { t: m.window[0], ...m.offset }];
      const a = (pts[0] as { t: number }).t;
      const b = m.window[1];
      const w = s.t < a ? 1 - (a - s.t) / TAPER_SEC : s.t > b ? 1 - (s.t - b) / TAPER_SEC : 1;
      if (w <= 0) continue;
      // The offset at t: the profile (linear between points), the window's offset from window[0] on.
      let off = s.t <= a ? (pts[0] as { dx: number; dy: number }) : m.offset;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i] as { t: number; dx: number; dy: number };
        const q = pts[i + 1] as { t: number; dx: number; dy: number };
        if (s.t >= p.t - 1e-9 && s.t <= q.t + 1e-9) {
          const f = q.t > p.t ? (s.t - p.t) / (q.t - p.t) : 0;
          off = { dx: p.dx + (q.dx - p.dx) * f, dy: p.dy + (q.dy - p.dy) * f };
        }
      }
      const from = original(m.player, s.t);
      // The offset is relative to the snapped (CS2 floor) spot the fit used as the eye base, so the edit puts the
      // sample there (snap-tracks keeps a spot where a hull stands); z stays the recording's.
      const sp = snapped(m.player, s.t);
      const to = { x: Math.round(sp.x + off.dx * w), y: Math.round(sp.y + off.dy * w), z: from.z };
      if (to.x === from.x && to.y === from.y) continue;
      const prev = out.find((q) => q.player === m.player && Math.abs(q.t - s.t) < 1e-9);
      if (prev !== undefined) continue; // the first move of a sample wins
      out.push({ player: m.player, t: s.t, from, to, frames: m.frames, reason: m.reason });
    }
  }
  out.sort((p, q) => (p.player < q.player ? -1 : p.player > q.player ? 1 : p.t - q.t));
  return out;
}

// ------------------------------------------------------------------------------------------------ checks

interface Hit {
  t: number;
  attacker: PlayerId;
  victim: PlayerId;
  band: 'head' | 'chest';
  what: string;
}

function engagementHits(round: RoundData): Hit[] {
  const pairs = ENGAGEMENTS.map((e) => [e.watched, e.other].sort().join('-'));
  const hits: Hit[] = [];
  for (const d of round.damage) {
    if (!pairs.includes([d.attacker, d.victim].sort().join('-'))) continue;
    hits.push({ t: d.t, attacker: d.attacker as PlayerId, victim: d.victim, band: 'chest', what: `damage ${d.amount}` });
  }
  for (const k of round.kills) {
    if (!pairs.includes([k.killer, k.victim].sort().join('-'))) continue;
    hits.push({ t: k.t, attacker: k.killer as PlayerId, victim: k.victim, band: k.hs ? 'head' : 'chest', what: k.hs ? 'kill (headshot)' : 'kill' });
  }
  return hits.sort((a, b) => a.t - b.t);
}

function lineOpen(g: MapGeometry, a: Vec3, b: Vec3, band: number): boolean {
  return !g.lineBlocked({ x: a.x, y: a.y, z: a.z + EYE }, { x: b.x, y: b.y, z: b.z + band });
}

/** For each engagement window: share of 10 Hz samples (and every 1/64 s tick) whose eye-to-head line is open. */
function openShare(g: MapGeometry, at: (id: PlayerId, t: number) => Vec3, e: Engagement): { share: number; ticks: string } {
  let open = 0;
  let n = 0;
  const runs: string[] = [];
  let runStart: number | null = null;
  const k0 = Math.ceil(e.window[0] * 64);
  const k1 = Math.floor(e.window[1] * 64);
  for (let k = k0; k <= k1; k++) {
    const t = k / 64;
    const ok = lineOpen(g, at(e.watched, t), at(e.other, t), HEAD) || lineOpen(g, at(e.other, t), at(e.watched, t), HEAD);
    n++;
    if (ok) {
      open++;
      if (runStart === null) runStart = t;
    } else if (runStart !== null) {
      runs.push(`${runStart.toFixed(2)}-${(t - 1 / 64).toFixed(2)}`);
      runStart = null;
    }
  }
  if (runStart !== null) runs.push(`${runStart.toFixed(2)}-${(k1 / 64).toFixed(2)}`);
  return { share: n === 0 ? 0 : open / n, ticks: runs.length === 0 ? 'never' : runs.join(', ') };
}

function report(round: RoundData, frames: readonly FitFrame[], views: Record<string, OutView[]>, before: (id: PlayerId, t: number) => Vec3, after: (id: PlayerId, t: number) => Vec3, g: MapGeometry): string {
  const L: string[] = [];
  // Coverage.
  L.push('### Coverage', '', '| player | fitted frames | observed | estimated | radar fallback | held (inferred) |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  const ids = [...new Set(frames.map((f) => f.player))].sort();
  for (const id of ids) {
    const fr = frames.filter((f) => f.player === id);
    const v = views[id] ?? [];
    L.push(`| ${id} | ${fr.length} | ${fr.filter((f) => f.confidence === 'observed').length} | ${fr.filter((f) => f.confidence === 'estimated').length} | ${fr.filter((f) => f.confidence === 'failed').length} | ${v.filter((q) => q.confidence === 'inferred').length} |`);
  }
  const all = frames.length;
  const obs = frames.filter((f) => f.confidence === 'observed').length;
  const est = frames.filter((f) => f.confidence === 'estimated').length;
  L.push(`| **all** | ${all} | ${obs} (${((100 * obs) / all).toFixed(0)} %) | ${est} (${((100 * est) / all).toFixed(0)} %) | ${all - obs - est} | |`, '');
  // Radar yaw vs fit.
  L.push('### Fitted yaw against the radar yaw (observed frames)', '', '| player | frames | median abs. difference | p90 | mean pitch | pitch range |', '| --- | ---: | ---: | ---: | ---: | --- |');
  for (const id of ids) {
    const fr = frames.filter((f) => f.player === id && f.confidence === 'observed' && f.radarYaw !== null);
    const d = fr.map((f) => Math.abs(wrapYaw(f.view.yaw - (f.radarYaw as number)))).sort((a, b) => a - b);
    const p = fr.map((f) => f.view.pitch);
    if (fr.length === 0) continue;
    L.push(`| ${id} | ${fr.length} | ${median(d).toFixed(1)}° | ${(d[Math.floor(0.9 * (d.length - 1))] as number).toFixed(1)}° | ${(p.reduce((a, b) => a + b, 0) / p.length).toFixed(1)}° | ${Math.min(...p).toFixed(0)}° to ${Math.max(...p).toFixed(0)}° |`);
  }
  L.push('');
  // Shots.
  L.push('### The view at the watched shots', '', 'Angle between the fitted view and the line from the fitted eye to the target\'s head (track position + 64; before: the recorded position, after: the refined one).', '');
  L.push('| t (s) | shooter → target | weapon | frame | confidence | yaw / pitch | error before | error after |', '| ---: | --- | --- | ---: | --- | --- | ---: | ---: |');
  for (const sh of round.shots) {
    if (sh.t === null || sh.target === null || sh.kind === 'kill' || sh.kind === 'switch') continue;
    const f = frames.filter((q) => q.player === sh.shooter).sort((a, b) => Math.abs(a.t - (sh.t as number)) - Math.abs(b.t - (sh.t as number)))[0];
    if (f === undefined || Math.abs(f.t - sh.t) > 0.02) continue;
    const eyeB = { x: f.base.x + f.view.dx, y: f.base.y + f.view.dy, z: f.base.z + EYE + f.view.dz };
    const tb = before(sh.target, f.t);
    const ta = after(sh.target, f.t);
    const sa = after(sh.shooter, f.t);
    const sb = before(sh.shooter, f.t);
    const eyeA = { x: eyeB.x + (sa.x - sb.x), y: eyeB.y + (sa.y - sb.y), z: eyeB.z };
    const eb = aimError(eyeB, f.view.yaw, f.view.pitch, { x: tb.x, y: tb.y, z: tb.z + HEAD });
    const ea = aimError(eyeA, f.view.yaw, f.view.pitch, { x: ta.x, y: ta.y, z: ta.z + HEAD });
    L.push(`| ${sh.t.toFixed(3)} | ${sh.shooter} → ${sh.target} | ${sh.weapon} | ${f.t.toFixed(3)} | ${f.confidence} | ${f.view.yaw.toFixed(1)}° / ${f.view.pitch.toFixed(1)}° | ${eb.toFixed(1)}° | ${ea.toFixed(1)}° |`);
  }
  L.push('');
  // LOS.
  L.push('### Eye-to-band lines of the engagements on the CS2 mesh', '', 'Snapped (CS2 floor) positions; eye at +64, the band at +64 (head) or +48 (chest). `open ticks`: the ticks of the window where the eye-to-head line is open either way.', '');
  L.push('| engagement | window (s) | open ticks before | open ticks after |', '| --- | --- | --- | --- |');
  for (const e of ENGAGEMENTS) {
    const b = openShare(g, before, e);
    const a = openShare(g, after, e);
    L.push(`| ${e.name} | ${e.window[0]}–${e.window[1]} | ${(100 * b.share).toFixed(0)} % (${b.ticks}) | ${(100 * a.share).toFixed(0)} % (${a.ticks}) |`);
  }
  L.push('', '| scripted hit | t (s) | band | before | after |', '| --- | ---: | --- | --- | --- |');
  for (const h of engagementHits(round)) {
    const bh = h.band === 'head' ? HEAD : CHEST;
    const ob = lineOpen(g, before(h.attacker, h.t), before(h.victim, h.t), bh);
    const oa = lineOpen(g, after(h.attacker, h.t), after(h.victim, h.t), bh);
    L.push(`| ${h.attacker} → ${h.victim} ${h.what} | ${h.t.toFixed(2)} | ${h.band} | ${ob ? 'open' : '**blocked**'} | ${oa ? 'open' : '**blocked**'} |`);
  }
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------ main

function arg(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : dflt;
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const fitPath = resolve(arg(args, '--fit', resolve(ROOT, 'logs/viewfit/fit.json')));
  const outPath = resolve(arg(args, '--out', resolve(ROOT, VIEW_FIT_PATH)));
  const reportPath = resolve(arg(args, '--report', resolve(ROOT, 'logs/viewfit/report.md')));
  const check = args.includes('--check');
  const round = JSON.parse(readFileSync(resolve(ROOT, 'data/round.json'), 'utf8')) as RoundData;
  const raw = JSON.parse(readFileSync(fitPath, 'utf8')) as { frames: RawFrame[] };
  const frames = raw.frames.map(classify);
  const sn = check ? loadSnapped(resolve(ROOT, 'data/geometry/mirage-tracks.json')) : loadSnapped(args.includes('--snapped') ? resolve(arg(args, '--snapped', '')) : null);
  const g = loadWorld();
  const prev = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, 'utf8')) as ViewFitFile) : null;

  if (check) {
    // After: the committed (re-snapped) tracks; before: the tracks the fit ran on.
    const base = loadSnapped(null);
    const after = (id: PlayerId, t: number): Vec3 => snappedAt(sn, id, t);
    const before = (id: PlayerId, t: number): Vec3 => snappedAt(base, id, t);
    const views = buildViews(round, frames);
    const text = report(round, frames, views, before, after, g);
    console.log(text);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath.replace(/\.md$/, '-check.md'), text + '\n');
    return;
  }

  // Original (source) positions: round.json's, with any earlier refinement undone.
  const original = (id: PlayerId, t: number): Vec3 => {
    const m = prev?.positions.find((e) => e.player === id && Math.abs(e.t - t) < 1e-9);
    if (m !== undefined) return m.from;
    const s = round.tracks[id]?.samples[Math.round(t * 10)];
    if (s === undefined) throw new Error(`no sample of ${id} at ${t}`);
    return { x: s.x, y: s.y, z: s.z };
  };
  // The base tracks predate any refinement (loadSnapped).
  const snUndone = sn;
  const views = buildViews(round, frames);
  const moves = engagementMoves(round, frames, snUndone, g);
  const positions = positionEdits(round, original, (id, t) => snappedAt(snUndone, id, t), moves);
  const after = (id: PlayerId, t: number): Vec3 => {
    const p = snappedAt(snUndone, id, t);
    const mv = (k: number): { dx: number; dy: number } => {
      const m = positions.find((e) => e.player === id && Math.abs(e.t - k / 10) < 1e-9);
      const b = snappedAt(snUndone, id, k / 10);
      return m === undefined ? { dx: 0, dy: 0 } : { dx: m.to.x - b.x, dy: m.to.y - b.y };
    };
    const f = t * 10 - Math.floor(t * 10);
    const a = mv(Math.floor(t * 10));
    const b = mv(Math.floor(t * 10) + 1);
    return { x: p.x + a.dx + (b.dx - a.dx) * f, y: p.y + a.dy + (b.dy - a.dy) * f, z: p.z };
  };
  const before = (id: PlayerId, t: number): Vec3 => snappedAt(snUndone, id, t);
  const file = {
    format: VIEW_FIT_FORMAT,
    note: 'V2: the watched player\'s view fitted to the original video (tools/viewfit/fit.py + tools/fit-view-angles.ts, docs/viewfit.md) and the engagement positions it implies. Merged into data/round.json by tools/extract-round.ts.',
    params: { observedMinScore: OBSERVED_MIN_SCORE, observedMinMargin: OBSERVED_MIN_MARGIN, estimatedMinScore: ESTIMATED_MIN_SCORE, holdBackSec: HOLD_BACK_SEC, altDeg: ALT_DEG, taperSec: TAPER_SEC },
    moves: moves.map((m) => ({ player: m.player, dx: r2(m.offset.dx), dy: r2(m.offset.dy), window: m.window, ...(m.points ? { points: m.points.map((p) => ({ t: p.t, dx: r2(p.dx), dy: r2(p.dy) })) } : {}), frames: m.frames, reason: m.reason })),
    views,
    positions,
  };
  writeFileSync(outPath, stringify(file));
  const text = report(round, frames, views, before, after, g);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, text + '\n');
  console.log(text);
  console.log(`wrote ${outPath} (${Object.values(views).reduce((n, v) => n + v.length, 0)} views, ${positions.length} position edits) and ${reportPath}`);
}

/** 2-space JSON, except that every element of `views.<id>`, `moves` and `positions` is one line (diffable). */
function stringify(file: Record<string, unknown>): string {
  const one = (x: unknown): string => JSON.stringify(x);
  const list = (xs: readonly unknown[], ind: string): string => (xs.length === 0 ? '[]' : `[\n${xs.map((x) => ind + '  ' + one(x)).join(',\n')}\n${ind}]`);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(file)) {
    if (k === 'views') {
      const vs = v as Record<string, unknown[]>;
      const inner = Object.keys(vs)
        .sort()
        .map((id) => `    ${one(id)}: ${list(vs[id] as unknown[], '    ')}`);
      parts.push(`  "views": {\n${inner.join(',\n')}\n  }`);
    } else if (Array.isArray(v)) parts.push(`  ${one(k)}: ${list(v, '  ')}`);
    else parts.push(`  ${one(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`);
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
