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
//      segment's first clear view held back across the spectator's camera switch (`inferred`, up to 0.6 s).
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
export const HOLD_BACK_SEC = 0.6;

export function angDist(y1: number, p1: number, y2: number, p2: number): number {
  const r = Math.PI / 180;
  const c = Math.cos(p1 * r) * Math.cos(p2 * r) * Math.cos((y1 - y2) * r) + Math.sin(p1 * r) * Math.sin(p2 * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

export function classify(f: RawFrame): FitFrame {
  const view = f.hyps[f.pick] as RawHyp;
  let alt = -Infinity;
  for (const h of f.hyps) if (h !== view && angDist(h.yaw, h.pitch, view.yaw, view.pitch) > ALT_DEG) alt = Math.max(alt, h.score);
  const margin = alt === -Infinity ? view.score : view.score - alt;
  let confidence: Confidence | 'failed' = 'failed';
  if (view.score >= OBSERVED_MIN_SCORE && margin >= OBSERVED_MIN_MARGIN) confidence = 'observed';
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
    if (first.length < 3 || first.some((v) => v.source !== 'video' || v.confidence !== 'observed')) continue;
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

function loadSnapped(): Snapped {
  return JSON.parse(readFileSync(resolve(ROOT, 'data/geometry/mirage-tracks.json'), 'utf8')) as Snapped;
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
  readonly note: string;
}

export const ENGAGEMENTS: readonly Engagement[] = [
  {
    name: 'cart-lokier',
    watched: 'cart',
    other: 'lokier',
    window: [17.4, 18.8],
    aim: [18.75, 18.767, 18.783, 18.8],
    note: "cart's Apartments window over B site; his headshot on Lokier at 18.8 s (shots 18.52-19.0 s)",
  },
  {
    name: 'donk-sp4rtan',
    watched: 'donk',
    other: 'sp4rtan',
    window: [49.5, 50.3],
    aim: [49.85, 49.867],
    note: "donk's AWP shot at Sp4rtaN at 49.85 s; Sp4rtaN's hits on donk 49.9-50.3 s",
  },
  {
    name: 'barely-sp4rtan',
    watched: 'barely',
    other: 'sp4rtan',
    window: [58.3, 58.8],
    aim: [],
    note: "barely's last frames before Sp4rtaN's headshot at 58.85 s",
  },
  {
    name: 'cart-sp4rtan',
    watched: 'cart',
    other: 'sp4rtan',
    window: [65.8, 69.4],
    aim: [],
    note: "cart's shots at the defusing Sp4rtaN 65.9-66.9 and 68.67-69.27 s; Sp4rtaN kills cart at 69.4 s",
  },
];

/** Refinements are tapered over this long outside each window. */
const TAPER_SEC = 0.3;
/** A refinement never moves a sample further than this (the radar's accuracy is 20-40 u; CTs carry their radius). */
const MAX_MOVE_T = 60;

export interface Move {
  readonly player: PlayerId;
  readonly offset: { dx: number; dy: number };
  readonly window: readonly [number, number];
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

export function engagementMoves(round: RoundData, frames: readonly FitFrame[], sn: Snapped): Move[] {
  const moves: Move[] = [];
  for (const e of ENGAGEMENTS) {
    const fr = frames.filter((f) => f.player === e.watched && f.t >= e.window[0] - 1e-9 && f.t <= e.window[1] + 1e-9 && f.confidence === 'observed');
    if (fr.length === 0) continue;
    const dx = median(fr.map((f) => f.view.dx));
    const dy = median(fr.map((f) => f.view.dy));
    const off = clampLen(dx, dy, MAX_MOVE_T);
    const ts = fr.map((f) => f.t);
    moves.push({
      player: e.watched,
      offset: off,
      window: e.window,
      frames: `${fr.length} observed frames ${Math.min(...ts).toFixed(2)}-${Math.max(...ts).toFixed(2)} s`,
      reason: `${e.name}: the fitted eye (median offset of the frames)`,
    });
    // The other player onto the line of sight at the aim frames.
    const aimFr = e.aim.map((t) => frames.find((f) => f.player === e.watched && Math.abs(f.t - t) < 0.009)).filter((f): f is FitFrame => f !== undefined && f.confidence !== 'failed');
    if (aimFr.length === 0) continue;
    const cx: number[] = [];
    const cy: number[] = [];
    for (const f of aimFr) {
      const eye = { x: f.base.x + off.dx, y: f.base.y + off.dy, z: f.base.z + EYE + f.view.dz };
      const d = viewDir(f.view.yaw, f.view.pitch);
      const p = snappedAt(sn, e.other, f.t);
      const h = { x: p.x, y: p.y, z: p.z + HEAD };
      // Closest point of the view ray to the head, in 2D (the target keeps his floor).
      const hl = Math.hypot(d.x, d.y);
      const ux = d.x / hl;
      const uy = d.y / hl;
      const s = Math.max(0, (h.x - eye.x) * ux + (h.y - eye.y) * uy);
      cx.push(eye.x + ux * s - h.x);
      cy.push(eye.y + uy * s - h.y);
    }
    const unc = Math.max(MAX_MOVE_T, ...(round.tracks[e.other]?.samples ?? []).filter((s) => s.t >= e.window[0] - 1e-9 && s.t <= e.window[1] + 1e-9).map((s) => s.uncertainty ?? 0));
    const toff = clampLen(median(cx), median(cy), unc);
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
export function positionEdits(round: RoundData, original: (id: PlayerId, t: number) => Vec3, moves: readonly Move[]): ViewFitFile['positions'] {
  const out: { player: string; t: number; from: Vec3; to: Vec3; frames: string; reason: string }[] = [];
  for (const m of moves) {
    const tr = round.tracks[m.player];
    for (const s of tr?.samples ?? []) {
      const [a, b] = m.window;
      const w = s.t < a ? 1 - (a - s.t) / TAPER_SEC : s.t > b ? 1 - (s.t - b) / TAPER_SEC : 1;
      if (w <= 0) continue;
      const from = original(m.player, s.t);
      const to = { x: Math.round(from.x + m.offset.dx * w), y: Math.round(from.y + m.offset.dy * w), z: from.z };
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
  const sn = loadSnapped();
  const g = loadWorld();
  const prev = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, 'utf8')) as ViewFitFile) : null;

  if (check) {
    // round.json and the snapped tracks already carry the refinement: "before" = undo it on the snapped positions.
    const moved = prev?.positions ?? [];
    const after = (id: PlayerId, t: number): Vec3 => snappedAt(sn, id, t);
    const before = (id: PlayerId, t: number): Vec3 => {
      const p = snappedAt(sn, id, t);
      const q = (k0: number): { dx: number; dy: number } => {
        const m = moved.find((e) => e.player === id && Math.abs(e.t - k0 / 10) < 1e-9);
        return m === undefined ? { dx: 0, dy: 0 } : { dx: m.to.x - m.from.x, dy: m.to.y - m.from.y };
      };
      const f = t * 10 - Math.floor(t * 10);
      const a = q(Math.floor(t * 10));
      const b = q(Math.floor(t * 10) + 1);
      return { x: p.x - (a.dx + (b.dx - a.dx) * f), y: p.y - (a.dy + (b.dy - a.dy) * f), z: p.z };
    };
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
  // Snapped positions without the earlier refinement (the snapping moves refined samples too).
  const undoPrev = (id: PlayerId, t: number): Vec3 => {
    const p = snappedAt(sn, id, t);
    const mv = (k: number): { dx: number; dy: number } => {
      const m = prev?.positions.find((e) => e.player === id && Math.abs(e.t - k / 10) < 1e-9);
      return m === undefined ? { dx: 0, dy: 0 } : { dx: m.to.x - m.from.x, dy: m.to.y - m.from.y };
    };
    const f = t * 10 - Math.floor(t * 10);
    const a = mv(Math.floor(t * 10));
    const b = mv(Math.floor(t * 10) + 1);
    return { x: p.x - (a.dx + (b.dx - a.dx) * f), y: p.y - (a.dy + (b.dy - a.dy) * f), z: p.z };
  };
  const snUndone: Snapped = { tracks: {} };
  for (const id of Object.keys(sn.tracks)) {
    snUndone.tracks[id] = (sn.tracks[id] as [number, number, number][]).map((_, k) => {
      const p = undoPrev(id as PlayerId, k / 10);
      return [p.x, p.y, p.z];
    });
  }
  const views = buildViews(round, frames);
  const moves = engagementMoves(round, frames, snUndone);
  const positions = positionEdits(round, original, moves);
  const after = (id: PlayerId, t: number): Vec3 => {
    const p = snappedAt(snUndone, id, t);
    const mv = (k: number): { dx: number; dy: number } => {
      const m = positions.find((e) => e.player === id && Math.abs(e.t - k / 10) < 1e-9);
      return m === undefined ? { dx: 0, dy: 0 } : { dx: m.to.x - m.from.x, dy: m.to.y - m.from.y };
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
    moves: moves.map((m) => ({ player: m.player, dx: r2(m.offset.dx), dy: r2(m.offset.dy), window: m.window, frames: m.frames, reason: m.reason })),
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
