/**
 * K6 table `sight.sightings`: who could see whom, row by row, for every ordered pair of enemies (docs/coach/sight.md).
 *
 * For each round's live play (freeze end through round end) and each ordered enemy pair (observer o, target t) a state
 * byte per row (`SEE` bits):
 *
 * - `los`: some body point of t is visible from o's eye (`LosWorld` sight mesh) and not behind opaque smoke
 *   (`SmokeField` from the smoke detonations);
 * - `head`: t's head point is visible;
 * - `inView`: a visible body point lies inside o's view frustum (`inFov`'s frustum: the los tuning's fov at the
 *   screen aspect, o's view angles at that row);
 * - `seen`: `inView` and o is not blind (`sightings.blindRemainingSec`): **the sighting**;
 * - `smoked`: some point is clear of the mesh but every such point is behind smoke (and so `los` is off);
 * - `blind`: o is blind at that row;
 * - `eval`: the pair was live (both alive, in range): a row without it says nothing;
 * - `far`: both alive but farther apart than `sightings.maxDistance` (not tested).
 *
 * Method: every pair is evaluated every `stepTicks` rows and at anchor rows (the rows of each gun shot by either
 * player and of every hurt and kill between them, and the row before); where two consecutive evaluations differ the
 * change is found to the row by bisection, and rows between equal evaluations take their value. The body points are
 * tested head first, then the chest, then the other points inside the frustum, then those outside it, and the test
 * stops as soon as the answer is known (a point seen in view; or line of sight with no remaining point in view). Both
 * directions of a pair share the sample rows, the alive and distance checks and the smokes.
 *
 * Without a sight mesh (`ctx.los` null) the table is empty (`available` false).
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { BODY_POINTS, SmokeField, type LosWorld, type SmokeDetonation } from '../los';
import type { MatchRound } from '../../model/match';
import { FLAG, rowAtOrAfter } from '../../model/raw';
import { SIGHT_TUNING, type SightTuning } from './tuning';

export const SEE = {
  los: 1,
  head: 2,
  inView: 4,
  seen: 8,
  smoked: 16,
  blind: 32,
  eval: 64,
  far: 128,
} as const;

/** The bits that decide whether two evaluations agree (blindness alone changes nothing visible). */
const KEY = SEE.los | SEE.head | SEE.inView | SEE.seen | SEE.smoked | SEE.eval;

/** One sighting: o sees t (`SEE.seen`) on rows r0..r1 (inclusive) of one round. */
export interface Sighting {
  readonly obs: number;
  readonly tgt: number;
  readonly round: number;
  readonly r0: number;
  readonly r1: number;
  readonly tick0: number;
  readonly tick1: number;
  /** The head point was visible at the first row. */
  readonly headAtStart: boolean;
}

export interface SightStats {
  /** Ordered enemy pair-rows of live play (both present in the round's roster, freeze end to round end). */
  pairRows: number;
  /** … of which one or both were dead. */
  deadRows: number;
  /** … both alive but farther apart than maxDistance. */
  farRows: number;
  /** … both alive and in range (`SEE.eval`). */
  liveRows: number;
  /** Rows evaluated exactly (samples, anchors, bisection). */
  evaluated: number;
  /** Segment tests run. */
  segmentTests: number;
  /** Smokes flooded. */
  smokeFloods: number;
}

export interface SightTable {
  readonly available: boolean;
  readonly P: number;
  /** [rows × P × P] `SEE` bits, index (r · P + obs) · P + tgt. */
  readonly state: Uint8Array;
  /** [rows × P] 1 when the player is blind (rows of live play only). */
  readonly blind: Uint8Array;
  /** Every sighting, by tick0, then observer, then target. */
  readonly sightings: readonly Sighting[];
  readonly stats: SightStats;
  /** Exact evaluation of one pair at one row (the same test as the table), for checks that must not miss a glimpse between samples; null when unavailable. */
  readonly probe: SightProbe | null;
}

/** The table's per-row test, exposed for exact re-checks of a few rows (it does not change the table). */
export interface SightProbe {
  eval(r: number, o: number, t: number): number;
}

export interface SightOptions {
  /** Override `sightings.stepTicks` (1 = every row, the ground truth the doc compares with). */
  step?: number;
  /** Only pairs with one of these slots (observer or target); default every pair. */
  slots?: readonly number[];
  tuning?: SightTuning;
}

/** Smoke detonations of the demo with their expiry (`smoke` joined to the next `smoke_end` of the same entity). */
export function smokeDetonations(ctx: AnalysisContext): SmokeDetonation[] {
  const dets = ctx.raw.events.detonations;
  const out: SmokeDetonation[] = [];
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    if (d === undefined || d.kind !== 'smoke') continue;
    let end: number | null = null;
    for (let j = i + 1; j < dets.length; j++) {
      const e = dets[j];
      if (e !== undefined && e.kind === 'smoke_end' && e.entity === d.entity) {
        end = e.tick;
        break;
      }
    }
    out.push({ x: d.x, y: d.y, z: d.z, startTick: d.tick, endTick: end });
  }
  return out;
}

/** [rows × P]: 1 where the player is blind (the flash he is under has more than `remainingSec` left). */
export function blindRows(ctx: AnalysisContext, remainingSec: number): Uint8Array {
  const T = ctx.raw.ticks;
  const P = ctx.P;
  const rate = ctx.raw.header.tickRate || 64;
  const out = new Uint8Array(T.count * P);
  const blinds = ctx.raw.events.blinds;
  for (let p = 0; p < P; p++) {
    let prev = 0;
    let onset = 0;
    let bi = 0;
    for (let r = 0; r < T.count; r++) {
      const tick = T.tick[r] ?? 0;
      const f = T.flash[r * P + p] ?? 0;
      let fresh = false;
      while (bi < blinds.length && (blinds[bi]?.tick ?? Infinity) <= tick) {
        const b = blinds[bi] as (typeof blinds)[number];
        if (b.victim === p) {
          fresh = true;
          onset = b.tick;
        }
        bi++;
      }
      if (f > 0 && f !== prev && !fresh) onset = tick;
      prev = f;
      if (f > 0 && f - (tick - onset) / rate > remainingSec) out[r * P + p] = 1;
    }
  }
  return out;
}

const DEG = Math.PI / 180;

class Evaluator implements SightProbe {
  readonly pts = new Float64Array(BODY_POINTS.length * 3);
  readonly fov = new Uint8Array(BODY_POINTS.length);
  readonly order = new Uint8Array(BODY_POINTS.length);
  evaluated = 0;
  private readonly tanH: number;
  private readonly tanV: number;
  private readonly maxD2: number;

  constructor(
    private readonly ctx: AnalysisContext,
    private readonly los: LosWorld,
    private readonly smoke: SmokeField,
    private readonly blind: Uint8Array,
    maxDistance: number,
  ) {
    const lt = los.tuning;
    this.tanV = Math.tan((lt.fovDeg * DEG) / 2) / lt.fovAspect;
    this.tanH = this.tanV * lt.aspect;
    this.maxD2 = maxDistance * maxDistance;
  }

  /** The `SEE` state of o → t at row r. */
  eval(r: number, o: number, t: number): number {
    this.evaluated++;
    const T = this.ctx.raw.ticks;
    const P = this.ctx.P;
    const i = r * P + o;
    const j = r * P + t;
    if (T.present[i] !== 1 || T.present[j] !== 1 || ((T.flags[i] ?? 0) & FLAG.alive) === 0 || ((T.flags[j] ?? 0) & FLAG.alive) === 0) return 0;
    const los = this.los;
    const ex = T.x[i] as number;
    const ey = T.y[i] as number;
    const ez = (T.z[i] as number) + los.eyeHeight((T.duck[i] ?? 0) / 255);
    const tx = T.x[j] as number;
    const ty = T.y[j] as number;
    const tz = T.z[j] as number;
    const dx = tx - ex;
    const dy = ty - ey;
    const dz = tz + 48 - ez;
    if (dx * dx + dy * dy + dz * dz > this.maxD2) return SEE.far;
    const blind = this.blind[i] === 1;
    let st = SEE.eval | (blind ? SEE.blind : 0);
    los.bodyPointsInto({ x: tx, y: ty, z: tz, yaw: T.yaw[j] ?? 0, duck: (T.duck[j] ?? 0) / 255 }, this.pts);
    // The observer's frustum (as inFov): forward (cp·cy, cp·sy, −sp), right (sy, −cy, 0), up (sp·cy, sp·sy, cp).
    const yaw = (T.yaw[i] ?? 0) * DEG;
    const pitch = (T.pitch[i] ?? 0) * DEG;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const n = BODY_POINTS.length;
    let fovLeft = 0;
    for (let k = 0; k < n; k++) {
      const px = (this.pts[k * 3] as number) - ex;
      const py = (this.pts[k * 3 + 1] as number) - ey;
      const pz = (this.pts[k * 3 + 2] as number) - ez;
      const f = px * cp * cy + py * cp * sy - pz * sp;
      const rr = px * sy - py * cy;
      const u = px * sp * cy + py * sp * sy + pz * cp;
      const inside = f > 0 && Math.abs(rr) <= f * this.tanH && Math.abs(u) <= f * this.tanV;
      this.fov[k] = inside ? 1 : 0;
      if (inside) fovLeft++;
    }
    let seenLos = false;
    let inView = false;
    let smoked = false;
    const g = los.geometry;
    // Order: head, chest, then the other points in view, then those outside it.
    const order = this.order;
    let m = 0;
    order[m++] = 0;
    order[m++] = 1;
    for (let k = 2; k < n; k++) if (this.fov[k] === 1) order[m++] = k;
    for (let k = 2; k < n; k++) if (this.fov[k] !== 1) order[m++] = k;
    for (let q = 0; q < n; q++) {
      const k = order[q] as number;
      const inF = this.fov[k] === 1;
      if (seenLos && (inView || fovLeft === 0)) break;
      if (inF) fovLeft--;
      else if (seenLos) continue;
      const bx = this.pts[k * 3] as number;
      const by = this.pts[k * 3 + 1] as number;
      const bz = this.pts[k * 3 + 2] as number;
      los.segmentTests++;
      if (g.sightBlocked(ex, ey, ez, bx, by, bz)) continue;
      if (this.smoke.detonations.length > 0 && this.smoke.blocks({ x: ex, y: ey, z: ez }, { x: bx, y: by, z: bz }, T.tick[r] ?? 0)) {
        smoked = true;
        continue;
      }
      seenLos = true;
      if (k === 0) st |= SEE.head;
      if (inF) inView = true;
    }
    if (seenLos) st |= SEE.los;
    else if (smoked) st |= SEE.smoked;
    if (inView) {
      st |= SEE.inView;
      if (!blind) st |= SEE.seen;
    }
    return st;
  }
}

/** Live rows [r0, r1] (inclusive) of a played round, or null. */
function liveRows(ctx: AnalysisContext, round: MatchRound): [number, number] | null {
  if (!round.played || round.freezeEndTick === null) return null;
  const T = ctx.raw.ticks;
  const r0 = Math.max(round.rowStart, rowAtOrAfter(T, round.freezeEndTick));
  const r1 = Math.min(round.rowEnd - 1, T.count - 1);
  return r1 >= r0 ? [r0, r1] : null;
}

export function buildSightings(ctx: AnalysisContext, opts: SightOptions = {}): SightTable {
  const P = ctx.P;
  const T = ctx.raw.ticks;
  const stats: SightStats = { pairRows: 0, deadRows: 0, farRows: 0, liveRows: 0, evaluated: 0, segmentTests: 0, smokeFloods: 0 };
  const los = ctx.los;
  if (los === null) return { available: false, P, state: new Uint8Array(0), blind: new Uint8Array(0), sightings: [], stats, probe: null };
  const tun = opts.tuning ?? SIGHT_TUNING;
  const step = Math.max(1, Math.round(opts.step ?? tun.sightings.stepTicks));
  const only = opts.slots === undefined ? null : new Set(opts.slots);
  const state = new Uint8Array(T.count * P * P);
  const blind = blindRows(ctx, tun.sightings.blindRemainingSec);
  const smoke = new SmokeField(los, smokeDetonations(ctx));
  const ev = new Evaluator(ctx, los, smoke, blind, tun.sightings.maxDistance);
  const tests0 = los.segmentTests;
  const rowOf = (tick: number): number => Math.min(T.count - 1, rowAtOrAfter(T, tick));
  const idx = (r: number, o: number, t: number): number => (r * P + o) * P + t;

  // Event rows per player (gun shots) and per pair (hurts, kills): the anchors.
  const shotRows: number[][] = Array.from({ length: P }, () => []);
  for (const b of ctx.raw.events.bullets) if (b.p >= 0 && b.p < P) shotRows[b.p]?.push(rowOf(b.tick));
  const pairRowsOf = new Map<number, number[]>();
  const addPair = (a: number, b: number, tick: number): void => {
    if (a < 0 || b < 0 || a >= P || b >= P || a === b) return;
    const k = Math.min(a, b) * P + Math.max(a, b);
    const l = pairRowsOf.get(k);
    const r = rowOf(tick);
    if (l === undefined) pairRowsOf.set(k, [r]);
    else l.push(r);
  };
  for (const h of ctx.raw.events.hurts) addPair(h.attacker, h.victim, h.tick);
  for (const k of ctx.raw.events.kills) addPair(k.attacker, k.victim, k.tick);

  const fill = (r: number, o: number, t: number, s: number): void => {
    const b = blind[r * P + o] === 1;
    let v = s & ~(SEE.blind | SEE.seen);
    if ((v & SEE.eval) !== 0) {
      if (b) v |= SEE.blind;
      else if ((v & SEE.inView) !== 0) v |= SEE.seen;
    }
    state[idx(r, o, t)] = v;
  };
  const bisect = (lo: number, slo: number, hi: number, shi: number, o: number, t: number): void => {
    if (hi - lo <= 1) return;
    const mid = (lo + hi) >> 1;
    const sm = ev.eval(mid, o, t);
    state[idx(mid, o, t)] = sm;
    if ((sm & KEY) === (slo & KEY)) for (let r = lo + 1; r < mid; r++) fill(r, o, t, slo);
    else bisect(lo, slo, mid, sm, o, t);
    if ((sm & KEY) === (shi & KEY)) for (let r = mid + 1; r < hi; r++) fill(r, o, t, sm);
    else bisect(mid, sm, hi, shi, o, t);
  };

  for (const round of ctx.match.rounds) {
    const span = liveRows(ctx, round);
    if (span === null) continue;
    const [R0, R1] = span;
    const grid: number[] = [];
    for (let r = R0; r <= R1; r += step) grid.push(r);
    if (grid[grid.length - 1] !== R1) grid.push(R1);
    const A = round.roster[round.sides.T];
    const B = round.roster[round.sides.CT];
    for (const a of A) {
      for (const b of B) {
        if (only !== null && !only.has(a) && !only.has(b)) continue;
        const extra: number[] = [];
        for (const p of [a, b]) for (const r of shotRows[p] ?? []) if (r >= R0 && r <= R1) extra.push(r, r - 1);
        for (const r of pairRowsOf.get(Math.min(a, b) * P + Math.max(a, b)) ?? []) if (r >= R0 && r <= R1) extra.push(r, r - 1);
        let samples = grid;
        if (extra.length > 0) {
          const set = new Set(grid);
          for (const r of extra) if (r >= R0) set.add(r);
          samples = [...set].sort((x, y) => x - y);
        }
        for (const [o, t] of [[a, b], [b, a]] as const) {
          let prev = samples[0] as number;
          let sp = ev.eval(prev, o, t);
          state[idx(prev, o, t)] = sp;
          for (let k = 1; k < samples.length; k++) {
            const r = samples[k] as number;
            const s = ev.eval(r, o, t);
            state[idx(r, o, t)] = s;
            if ((s & KEY) === (sp & KEY)) for (let q = prev + 1; q < r; q++) fill(q, o, t, sp);
            else bisect(prev, sp, r, s, o, t);
            prev = r;
            sp = s;
          }
          for (let r = R0; r <= R1; r++) {
            stats.pairRows++;
            const s = state[idx(r, o, t)] ?? 0;
            if ((s & SEE.eval) !== 0) stats.liveRows++;
            else if ((s & SEE.far) !== 0) stats.farRows++;
            else stats.deadRows++;
          }
        }
      }
    }
  }
  stats.evaluated = ev.evaluated;
  stats.segmentTests = los.segmentTests - tests0;
  stats.smokeFloods = smoke.floods;
  return { available: true, P, state, blind, sightings: collectSightings(ctx, state), stats, probe: ev };
}

function collectSightings(ctx: AnalysisContext, state: Uint8Array): Sighting[] {
  const P = ctx.P;
  const T = ctx.raw.ticks;
  const out: Sighting[] = [];
  for (const round of ctx.match.rounds) {
    const span = liveRows(ctx, round);
    if (span === null) continue;
    const [R0, R1] = span;
    for (let o = 0; o < P; o++) {
      for (let t = 0; t < P; t++) {
        if (o === t) continue;
        let start = -1;
        for (let r = R0; r <= R1 + 1; r++) {
          const on = r <= R1 && ((state[(r * P + o) * P + t] ?? 0) & SEE.seen) !== 0;
          if (on && start < 0) start = r;
          if (!on && start >= 0) {
            out.push({
              obs: o, tgt: t, round: round.number, r0: start, r1: r - 1, tick0: T.tick[start] ?? 0, tick1: T.tick[r - 1] ?? 0,
              headAtStart: ((state[(start * P + o) * P + t] ?? 0) & SEE.head) !== 0,
            });
            start = -1;
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.tick0 - b.tick0 || a.obs - b.obs || a.tgt - b.tgt);
}

/** The `SEE` state of o → t at row r (0 outside live play or for teammates). */
export function seeAt(tab: SightTable, r: number, o: number, t: number): number {
  if (!tab.available) return 0;
  return tab.state[(r * tab.P + o) * tab.P + t] ?? 0;
}

export const SIGHTINGS: TableDef<SightTable> = { id: 'sight.sightings', build: (ctx) => buildSightings(ctx) };
