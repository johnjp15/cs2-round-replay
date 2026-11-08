/**
 * G3: snap every recorded track sample onto CS2 Mirage (docs/geometry.md "Track snapping"), offline and
 * deterministically, and find where a puppet has to jump.
 *
 *   npx tsx tools/snap-tracks.ts            # data/geometry/mirage-tracks.json (+ the report on stdout)
 *   npx tsx tools/snap-tracks.ts --check    # rebuild in memory; exit 1 if the committed file is stale
 *   npm run tracks:snap                     # the first line
 *   npx tsx tools/snap-tracks.ts --map mirage-2020 [--check]   # X1: onto the 2020 package (data/maps/mirage-2020/tracks.json)
 *
 * The recording (data/round.json) has 2D positions from a 2020 POV video and z from the 2020 nav: 21 % of samples
 * are 16–64 units inside walls, props or the Truck, and stairs are off by up to 27 in z (G2's validation). The 3D
 * movement needs positions a hull can stand at. For each 10 Hz sample:
 *
 * 1. Stand levels (`standLevels`: walkable tops where the standing or crouched hull fits) on the movement mesh (world +
 *    player clips), allowed by the clips' nav rule (`Pieces.allowsLevel`: the hull isn't inside a clip prism).
 * 2. The nearest such spot to the recorded (x, y), searching a 2-unit grid out to SEARCH_RADIUS in order of distance,
 *    with a level within Z_WINDOW of the recorded z; the smallest |Δz| wins at a spot. z becomes that level (the floor
 *    the feet rest on). A track stays on its floor between samples (`continuity`, `follow`) unless the recording
 *    changes floor and a hull can walk to the recording's (`levelChange`); a track left on another floor than the
 *    recording's for a second (`floorRun`) restarts on the recording's (the puppet snaps there unless pass 3 finds a
 *    way). Samples with no spot within the radius keep their (x, y) and take the nearest level there
 *    within FAR_Z_WINDOW, or keep the recording (`impossible`).
 * 3. Jumps: wherever consecutive snapped samples climb more than a step (sv_stepsize), the 3D movement is run from
 *    the lower one toward the upper one, walking and then jumping (and crouch jumping): if only a jump gets there, the
 *    lower sample is marked as a take-off (`jump: true` in round data once applied).
 *
 * The output keeps one [x, y, z] per sample, parallel to `round.tracks[id].samples`, rounded to 1/32 unit, and the
 * jump take-offs. The app applies it to the round (`applyTracks3d`, src/contracts/tracks3d.ts) before the Core sees it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAYER_IDS, parseRound, parseTuning, type MovementTuning, type PlayerId, type RoundData } from '../src/contracts/index';
import { TRACKS3D_FORMAT, type Tracks3d, type Tracks3dJump } from '../src/contracts/tracks3d';
import { EventSchedule, RoundModel, recordedWeapons, runSpeedOf, weaponAt } from '../src/core/index';
import { MapGeometry, TRACE_SKIN, combineMeshes, decodeGeometry } from '../src/sim2d/geometry';
import { restingState, settle, stepMove3d, type MoveState } from '../src/sim2d/movement';
import { MeshSight, meshSightOptionsFromTuning } from '../src/sim2d/mesh-sight';
import { hullLineClear } from '../src/sim2d/walk-query';
import { ALLOW_ALL, NavCover, Pieces } from './extract-clips';
import { sightPass } from './sight-snap';
import { DEFAULT_MAP, mapPackagePaths, parseMapId, type MapId } from '../src/contracts/maps';
import { CS2_NAV_PATH, readCs2Nav, standLevels } from './extract-geometry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TRACKS3D_PATH = 'data/geometry/mirage-tracks.json';

export const SNAP_PARAMS = {
  /** Search spacing and radius (units). */
  grid: 2,
  searchRadius: 64,
  /** A level counts within this of the recorded z (the 2020 nav's stairs are off by up to 27). */
  zWindow: 32,
  /** First choice: a level within this of the previous sample's snapped level (a track doesn't change floors between samples except by a drop or a jump). */
  continuity: 24,
  /** Then: the same search out to this radius. */
  wideRadius: 128,
  /** `follow`: how far from the previous sample's spot a sample can go (a little more than 0.1 s at run speed)... */
  followRadius: 40,
  /** ... and how far from the recording the followed spot may be before the track jumps to the recording instead (as far as a puppet may lag before it snaps). */
  followMaxMiss: 96,
  /** Pass 2 (`repairWindow`): candidate spots within this of the recorded position, on this grid. */
  repairRadius: 48,
  repairGrid: 8,
  /** A recorded z this far from the previous sample's floor is a change of floor (stairs between samples): snap to the recording's floor when a hull can walk there. */
  levelChange: 48,
  /** ... and when pass 1 stays off the recording's floor for this many samples, even without such a way near by. */
  floorRun: 10,
  /** Samples with no spot within the radius: the nearest level at the recorded (x, y) within this. */
  farZWindow: 96,
  /** Consecutive samples that climb more than sv_stepsize + this are tested for a jump. */
  climbSlack: 2,
  /** The movement test: how long a pawn gets to get there (seconds), and how close counts as there (units). */
  reachSec: 0.6,
  reachUnits: 12,
  reachZ: 4,
} as const;

/** repairWindow: samples before and after the unconnected transition, and the cost of a transition that isn't clear (units of distance from the recording). */
const REPAIR_BEFORE = 3;
const REPAIR_AFTER = 3;
const UNCONNECTED_COST = 1000;
/** detour: grid (units), how far it may stray from the gap, its length limits, the samples re-spread on each side, and the search budget. */
const DETOUR_GRID = 8;
const DETOUR_REACH = 160;
const DETOUR_MAX_RATIO = 2.5;
const DETOUR_SLACK = 256;
const DETOUR_SPREAD: readonly number[] = [4, 6, 8, 12, 16, 20, 25, 30];
/** detour: the longest step between samples (units per 0.1 s) a spread may have: a little under the AK's 215 u/s. */
const DETOUR_MAX_STEP = 21;
/** frozenTick: margin around a plant or defuse, the plant's duration (tuning.bomb.plantSec), and the round's defuser (round.json's bomb has no defuser field; docs/round-data.md: sp4rtan). */
const FROZEN_MARGIN_SEC = 0.5;
const PLANT_SEC = 3.2;
const DEFUSER: PlayerId = 'sp4rtan';
const DETOUR_MAX_NODES = 6000;
/**
 * retime: a snapped track may cover this × the run speed of the recorded weapon per sample step, or as much as the
 * recording itself covered there (its own spikes and gaps stay as they are: the puppets snap there as before).
 */
const RETIME_SPEED_FACTOR = 1;
/** retime: a recorded step faster than this × run speed is a gap in the recording (tuning.replay.spikeSpeedFactor). */
const RETIME_GAP_FACTOR = 1.6;
/**
 * lead (K1): an inferred stretch (a reconstructed route, never seen) is walked at no more than this × the recorded
 * weapon's run speed per step on its way to the next sample that isn't inferred (puppets accelerate and turn corners,
 * so they hold a little under the run speed).
 */
const LEAD_SPEED_FACTOR = 0.9;
/** reroute: the lag that makes `reroute` look for a shorter way (units), how far back before the lag it starts (samples), the least it must save (units), and its A* budget. */
const REROUTE_MIN_LAG = 48;
const REROUTE_BACK = 5;
const REROUTE_MIN_GAIN = 16;
const REROUTE_MAX_NODES = 40000;
/** reroute: the most samples (8 s) one new way replaces, and how many times a track is looked at again. */
const REROUTE_MAX_SPAN = 80;
const REROUTE_ROUNDS = 8;
/** reroute's A*: the highest climb it jumps (a crouch jump reaches about 54 + 9; plain about 57 at the apex but lands lower) and the extra cost of a jump (units). */
const JUMP_UP = 48;
const JUMP_COST = 16;
/** reroute's A*: the room a jump's landing needs above it: the standing hull plus a jump's rise (sv_jump_impulse²/2g ≈ 57). */
const JUMP_HEADROOM = 72 + 57;
/** reroute: how far ahead along the new way (× a run-speed step) and how finely (units) a sample looks for its recorded position. */
const REROUTE_AHEAD = 2;
const REROUTE_PROBE = 2;
/**
 * levelFlips: the longest stretch (samples, 20 s) a recording may spend on the wrong one of two overlapping floors,
 * how far from a sample the floor it left may be (units: radar positions are off by up to ~60 in places), and the
 * grid that search uses.
 */
const FLIP_MAX_SAMPLES = 200;
const FLIP_RADIUS = 128;
const FLIP_GRID = 8;
/** detour: the highest drop it walks off (below sv_falldamage's 222). */
const DETOUR_DROP = 216;
const DETOUR_STEPS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Samples a detour must not move: the planter from FROZEN_MARGIN_SEC before his plant starts (plant time before the
 * recorded plant) to after it, the defuser from before his defuse to its end. Their positions are the bomb's.
 */
function frozenTick(round: RoundData, id: PlayerId, tick: number): boolean {
  const b = round.bomb;
  const margin = Math.round(FROZEN_MARGIN_SEC * 64);
  if (id === b.carrier && b.plantTick !== null && tick >= b.plantTick - Math.round(PLANT_SEC * 64) - margin && tick <= b.plantTick + margin) return true;
  if (b.defuseStartTick !== null && b.defuseTick !== null && id === DEFUSER && tick >= b.defuseStartTick - margin && tick <= b.defuseTick) return true;
  return false;
}

/** Consecutive snapped samples that aren't in a clear hull line. */
function countUnconnected(g: MapGeometry, s: readonly SnappedSample[], step: number): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) if (!stepOk(g, s[i - 1] as SnappedSample, s[i] as SnappedSample, step)) n++;
  return n;
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(ROOT, path)));
}

/** Offsets within `r` on the grid, nearest first (ties: dx, then dy). */
function searchOffsets(r: number): [number, number][] {
  const out: [number, number][] = [];
  const d = SNAP_PARAMS.grid;
  for (let dy = -r; dy <= r; dy += d) for (let dx = -r; dx <= r; dx += d) if (dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[0] - b[0] || a[1] - b[1]);
}

export type SnapKind = 'ok' | 'moved' | 'far' | 'impossible';

export interface SnappedSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: SnapKind;
  /** Horizontal and vertical move from the recording. */
  readonly dxy: number;
  readonly dz: number;
  /** In a clear hull line from the previous snapped sample (or the first). */
  readonly connected: boolean;
  /** A jump takes off here to the next sample (`reroute` over a path with a jump in it): 'plain' or 'crouch'. */
  readonly jump?: 'plain' | 'crouch';
}

/** A path point; `jump` = the edge into it is a jump of that kind. */
interface PathPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly jump?: 'plain' | 'crouch';
}

/** The sample without its take-off mark. */
function withoutJump(q: SnappedSample): SnappedSample {
  return { x: q.x, y: q.y, z: q.z, kind: q.kind, dxy: q.dxy, dz: q.dz, connected: q.connected };
}

/** Consecutive samples a puppet gets between: a clear hull line, or a jump the first one takes off for. */
function stepOk(g: MapGeometry, a: SnappedSample, b: SnappedSample, step: number): boolean {
  return a.jump !== undefined || hullLineClear(g, a, b, step);
}

/** 1/32 unit (exact in binary, so JSON round-trips it). */
function q32(v: number): number {
  return Math.round(v * 32) / 32;
}

/** A binary min-heap under `before` (deterministic: equal elements never reorder by insertion luck, `before` decides). */
class Heap<T> {
  private readonly items: T[] = [];

  constructor(private readonly before: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  push(v: T): void {
    const it = this.items;
    it.push(v);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(it[i] as T, it[p] as T)) break;
      [it[i], it[p]] = [it[p] as T, it[i] as T];
      i = p;
    }
  }

  pop(): T | undefined {
    const it = this.items;
    const top = it[0];
    const last = it.pop();
    if (it.length > 0 && last !== undefined) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < it.length && this.before(it[l] as T, it[m] as T)) m = l;
        if (r < it.length && this.before(it[r] as T, it[m] as T)) m = r;
        if (m === i) break;
        [it[i], it[m]] = [it[m] as T, it[i] as T];
        i = m;
      }
    }
    return top;
  }
}

export class Snapper {
  private readonly near = searchOffsets(SNAP_PARAMS.searchRadius);
  private readonly wide = searchOffsets(SNAP_PARAMS.wideRadius);
  private readonly repair = searchOffsets(SNAP_PARAMS.repairRadius).filter(([dx, dy]) => dx % SNAP_PARAMS.repairGrid === 0 && dy % SNAP_PARAMS.repairGrid === 0);
  private readonly followOffsets = searchOffsets(SNAP_PARAMS.followRadius);
  private readonly flipOffsets = searchOffsets(FLIP_RADIUS).filter(([dx, dy]) => dx % FLIP_GRID === 0 && dy % FLIP_GRID === 0);

  constructor(
    private readonly g: MapGeometry,
    private readonly pieces: Pieces,
    private readonly step: number,
    /** For jump edges in `astar` (`reroute`); null = no jumps. */
    private readonly m: MovementTuning | null = null,
  ) {}

  /**
   * The nearest allowed standing spot to (x, y) within `radius` (on a FLIP_GRID grid, nearest first) with a level
   * within zWindow of z; null if none.
   */
  nearestStand(x: number, y: number, z: number, radius: number): { x: number; y: number; z: number } | null {
    for (const [dx, dy] of this.flipOffsets) {
      if (dx * dx + dy * dy > radius * radius) break;
      const lv = this.levels(x + dx, y + dy, z, SNAP_PARAMS.zWindow)[0];
      if (lv !== undefined) return { x: x + dx, y: y + dy, z: lv };
    }
    return null;
  }

  /** Allowed stand levels at (x, y) within `window` of z where the standing hull fits, nearest first. */
  levels(x: number, y: number, z: number, window: number): number[] {
    return standLevels(this.g, x, y, z + window, z - window)
      .filter((l) => l.standing)
      .map((l) => l.z)
      .filter((lz) => this.pieces.allowsLevel(x, y, lz))
      .sort((a, b) => Math.abs(a - z) - Math.abs(b - z) || b - a);
  }

  /**
   * The nearest spot (offsets in order) with an allowed level within zWindow of z and, if `prev` is given, within
   * `continuity` of its level and in a clear hull line from it (`hullLineClear`, as the puppets' WalkQuery): a track
   * shouldn't jump through a wall between two samples. Returns the first such spot, else (with `connect`) null.
   */
  private search(offsets: readonly [number, number][], x: number, y: number, z: number, prev: { x: number; y: number; z: number } | null, connect: boolean): SnappedSample | null {
    for (const [dx, dy] of offsets) {
      const lv = this.levels(x + dx, y + dy, z, SNAP_PARAMS.zWindow).filter((l) => prev === null || Math.abs(l - prev.z) <= SNAP_PARAMS.continuity);
      for (const best of lv) {
        if (connect && prev !== null && !hullLineClear(this.g, prev, { x: x + dx, y: y + dy, z: best }, this.step)) continue;
        const dxy = Math.sqrt(dx * dx + dy * dy);
        return { x: q32(x + dx), y: q32(y + dy), z: q32(best), kind: dxy === 0 ? 'ok' : dxy <= 16 ? 'moved' : dxy <= SNAP_PARAMS.searchRadius ? 'far' : 'impossible', dxy, dz: best - z, connected: prev === null || connect };
      }
    }
    return null;
  }

  /**
   * Re-place the samples around an unconnected transition (between `i − 1` and `i`) together: a Viterbi search over
   * the samples i − REPAIR_BEFORE .. i + REPAIR_AFTER − 1, each choosing its pass-1 spot or any allowed spot within
   * REPAIR_RADIUS of its recorded (x, y) on a REPAIR_GRID grid, minimising the distance from the recording plus
   * UNCONNECTED_COST per transition (into, inside and out of the window) that isn't a clear hull line. Returns the
   * track with the window replaced if that has fewer unconnected transitions, else unchanged.
   */
  repairWindow(snapped: readonly SnappedSample[], raw: readonly { x: number; y: number; z: number }[], i: number): SnappedSample[] {
    const lo = Math.max(0, i - REPAIR_BEFORE);
    const hi = Math.min(snapped.length - 1, i + REPAIR_AFTER - 1);
    const left = lo > 0 ? (snapped[lo - 1] as SnappedSample) : null;
    const right = hi + 1 < snapped.length ? (snapped[hi + 1] as SnappedSample) : null;
    const cands: SnappedSample[][] = [];
    for (let j = lo; j <= hi; j++) {
      const r = raw[j] as { x: number; y: number; z: number };
      const list: SnappedSample[] = [snapped[j] as SnappedSample];
      for (const [dx, dy] of this.repair) {
        const lv = this.levels(r.x + dx, r.y + dy, r.z, SNAP_PARAMS.zWindow)[0];
        if (lv === undefined) continue;
        const dxy = Math.sqrt(dx * dx + dy * dy);
        list.push({ x: q32(r.x + dx), y: q32(r.y + dy), z: q32(lv), kind: dxy === 0 ? 'ok' : dxy <= 16 ? 'moved' : 'far', dxy, dz: lv - r.z, connected: true });
      }
      cands.push(list);
    }
    const clear = (a: SnappedSample | null, b: SnappedSample | null): boolean => a === null || b === null || hullLineClear(this.g, a, b, this.step);
    const cost = (c: SnappedSample): number => c.dxy + Math.abs(c.dz) / 2;
    // Viterbi.
    let best: number[] = (cands[0] as SnappedSample[]).map((c) => cost(c) + (clear(left, c) ? 0 : UNCONNECTED_COST));
    const back: number[][] = [];
    for (let j = 1; j < cands.length; j++) {
      const prev = cands[j - 1] as SnappedSample[];
      const cur = cands[j] as SnappedSample[];
      const next: number[] = [];
      const from: number[] = [];
      for (const c of cur) {
        let b = Infinity;
        let bk = 0;
        prev.forEach((p, k) => {
          const v = (best[k] as number) + (clear(p, c) ? 0 : UNCONNECTED_COST);
          if (v < b) {
            b = v;
            bk = k;
          }
        });
        next.push(b + cost(c));
        from.push(bk);
      }
      best = next;
      back.push(from);
    }
    const lastC = cands[cands.length - 1] as SnappedSample[];
    let end = 0;
    let endCost = Infinity;
    lastC.forEach((c, k) => {
      const v = (best[k] as number) + (clear(c, right) ? 0 : UNCONNECTED_COST);
      if (v < endCost) {
        endCost = v;
        end = k;
      }
    });
    const pick: SnappedSample[] = [];
    for (let j = cands.length - 1, k = end; j >= 0; j--) {
      pick.unshift((cands[j] as SnappedSample[])[k] as SnappedSample);
      if (j > 0) k = (back[j - 1] as number[])[k] as number;
    }
    const seq = (xs: readonly SnappedSample[]): number => {
      let n = clear(left, xs[0] ?? null) ? 0 : 1;
      for (let j = 1; j < xs.length; j++) if (!clear(xs[j - 1] as SnappedSample, xs[j] as SnappedSample)) n++;
      return n + (clear(xs[xs.length - 1] ?? null, right) ? 0 : 1);
    };
    const old = snapped.slice(lo, hi + 1);
    if (seq(pick) >= seq(old)) return [...snapped];
    return [...snapped.slice(0, lo), ...pick, ...snapped.slice(hi + 1)];
  }

  /**
   * The spot in a clear hull line from `prev` (within `follow` of it, on its level ± continuity) that is nearest to
   * (x, y): where a player who can't get to the recorded position from the previous one gets closest to it.
   */
  private follow(x: number, y: number, prev: SnappedSample): SnappedSample | null {
    let best: SnappedSample | null = null;
    let bestD = Infinity;
    for (const [dx, dy] of this.followOffsets) {
      const cx = prev.x + dx;
      const cy = prev.y + dy;
      const d = Math.hypot(cx - x, cy - y);
      if (d >= bestD) continue;
      const lv = this.levels(cx, cy, prev.z, SNAP_PARAMS.continuity)[0];
      if (lv === undefined || !hullLineClear(this.g, prev, { x: cx, y: cy, z: lv }, this.step)) continue;
      bestD = d;
      best = { x: q32(cx), y: q32(cy), z: q32(lv), kind: d === 0 ? 'ok' : d <= 16 ? 'moved' : d <= SNAP_PARAMS.searchRadius ? 'far' : 'impossible', dxy: d, dz: 0, connected: true };
    }
    return best;
  }

  /**
   * Pass 3: the way round an obstacle between samples i − 1 and i: an A* search on a DETOUR_GRID-unit grid of allowed
   * standing spots (each step a clear hull line, up at most a step or down a ledge up to DETOUR_DROP), out to
   * DETOUR_REACH from the gap. If one is
   * found and is at most DETOUR_MAX_RATIO times as long as the gap (or the gap plus DETOUR_SLACK units), the samples
   * i − n .. i + n − 1 are spread evenly by length along the polyline through them and the detour (each still 0.1 s
   * apart, so the puppet runs it a little faster), for the first n of DETOUR_SPREAD that leaves every two consecutive
   * samples in a clear hull line and no step longer than DETOUR_MAX_STEP (else the valid n with the shortest longest
   * step). Returns the new track, or null.
   */
  detour(snapped: readonly SnappedSample[], i: number, frozen: (j: number) => boolean = () => false): SnappedSample[] | null {
    const a = snapped[i - 1] as SnappedSample;
    const b = snapped[i] as SnappedSample;
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    const maxLen = Math.max(gap * DETOUR_MAX_RATIO, gap + DETOUR_SLACK);
    const path = this.astar(a, b, maxLen);
    if (path === null) return null;
    // Spread over enough samples on each side that the samples are in clear lines (closer samples cut corners less) and
    // no step is faster than a player runs (else the puppet falls behind and snaps); the slowest valid spread if none is.
    let best: SnappedSample[] | null = null;
    let bestStep = Infinity;
    for (const spread of DETOUR_SPREAD) {
      // Never into a frozen sample (a planter's plant, a defuser's defuse): the spread stops short of it on that side.
      // Nor across another gap (its own detour, or the snap there, is that gap's business).
      const clear = (j: number): boolean => j <= 0 || j >= snapped.length || stepOk(this.g, snapped[j - 1] as SnappedSample, snapped[j] as SnappedSample, this.step);
      let before = 0;
      while (before < spread && i - before - 1 >= 0 && !frozen(i - before - 1) && clear(i - before - 1)) before++;
      let after = 0;
      while (after < spread && i + after < snapped.length && !frozen(i + after) && clear(i + after + 1)) after++;
      if (before === 0 || after === 0) continue;
      const out = this.spread(snapped, i, path, before, after);
      if (out === null) continue;
      let step = 0;
      const lo = Math.max(1, i - before);
      const hi = Math.min(out.length - 1, i + after);
      for (let j = lo; j <= hi; j++) step = Math.max(step, Math.hypot((out[j] as SnappedSample).x - (out[j - 1] as SnappedSample).x, (out[j] as SnappedSample).y - (out[j - 1] as SnappedSample).y));
      if (step <= DETOUR_MAX_STEP) return out;
      if (step < bestStep) {
        bestStep = step;
        best = out;
      }
    }
    return best;
  }

  /** `detour`'s spreading of samples i − spread .. i + spread − 1 along the polyline through them and `path`; null if not in clear lines. */
  private spread(snapped: readonly SnappedSample[], i: number, path: readonly { x: number; y: number; z: number }[], before: number, after: number): SnappedSample[] | null {
    const lo = Math.max(0, i - before);
    const hi = Math.min(snapped.length - 1, i + after - 1);
    const pts: { x: number; y: number; z: number }[] = [];
    for (let j = lo; j < i; j++) pts.push(snapped[j] as SnappedSample);
    for (const q of path.slice(1, -1)) pts.push(q);
    for (let j = i; j <= hi; j++) pts.push(snapped[j] as SnappedSample);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k] as { x: number; y: number };
      const q = pts[k - 1] as { x: number; y: number };
      cum.push((cum[k - 1] as number) + Math.hypot(p.x - q.x, p.y - q.y));
    }
    const total = cum[cum.length - 1] as number;
    const at = (arc: number): { x: number; y: number; z: number; k: number } => {
      let k = 1;
      while (k < pts.length - 1 && (cum[k] as number) < arc) k++;
      const p0 = pts[k - 1] as { x: number; y: number; z: number };
      const p1 = pts[k] as { x: number; y: number; z: number };
      const seg = (cum[k] as number) - (cum[k - 1] as number);
      const f = seg > 0 ? Math.min(1, Math.max(0, (arc - (cum[k - 1] as number)) / seg)) : 0;
      return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f, z: f < 0.5 ? p0.z : p1.z, k };
    };
    const out = [...snapped];
    let prevArc = 0;
    let prevPos: { x: number; y: number; z: number } = lo > 0 ? (snapped[lo - 1] as SnappedSample) : (pts[0] as { x: number; y: number; z: number });
    for (let j = lo; j <= hi; j++) {
      // The sample's share of the way (equal steps), or the last polyline corner before it that is in a clear line
      // from the previous sample (so samples don't cut the detour's corners).
      const target = (total * (j - lo)) / (hi - lo);
      const t = at(target);
      const cands: { x: number; y: number; z: number; arc: number }[] = [{ ...t, arc: target }];
      for (let k = t.k - 1; k >= 1 && (cum[k] as number) > prevArc; k--) cands.push({ ...(pts[k] as { x: number; y: number; z: number }), arc: cum[k] as number });
      let chosen: { x: number; y: number; z: number; arc: number } | null = null;
      for (const c of cands) {
        const lv = this.levels(c.x, c.y, c.z, this.step)[0];
        if (lv === undefined) continue;
        const q = { x: q32(c.x), y: q32(c.y), z: q32(lv) };
        if (j === lo && lo === 0) {
          chosen = { ...q, arc: c.arc };
          break;
        }
        if (hullLineClear(this.g, prevPos, q, this.step)) {
          chosen = { ...q, arc: c.arc };
          break;
        }
      }
      if (chosen === null) return null;
      const old = snapped[j] as SnappedSample;
      out[j] = { ...old, x: chosen.x, y: chosen.y, z: chosen.z, dxy: old.dxy + Math.hypot(chosen.x - old.x, chosen.y - old.y), kind: 'far', connected: true };
      prevArc = chosen.arc;
      prevPos = out[j] as SnappedSample;
    }
    // Keep it only if it is connected all the way through.
    for (let j = Math.max(1, lo); j <= Math.min(out.length - 1, hi + 1); j++) if (!hullLineClear(this.g, out[j - 1] as SnappedSample, out[j] as SnappedSample, this.step)) return null;
    return out;
  }

  /** A* from a to b over grid spots (see `detour`); the path (a first, b last) or null. */
  astar(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, maxLen: number, maxNodes = DETOUR_MAX_NODES, jumps = false): PathPoint[] | null {
    const G = DETOUR_GRID;
    const key = (ix: number, iy: number): number => (ix + 32768) * 65536 + (iy + 32768);
    const sx = Math.round(a.x / G);
    const sy = Math.round(a.y / G);
    const tx = Math.round(b.x / G);
    const ty = Math.round(b.y / G);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const reach = Math.hypot(b.x - a.x, b.y - a.y) / 2 + DETOUR_REACH;
    interface Node {
      ix: number;
      iy: number;
      z: number;
      g: number;
      f: number;
      parent: Node | null;
      jump?: 'plain' | 'crouch';
    }
    const level = new Map<number, number | null>();
    // Where a hull walking in from height `near` comes to rest: the highest allowed standing level at most a step up
    // (walking, stairs) or any way down to DETOUR_DROP (walking off a ledge).
    const levelAt = (ix: number, iy: number, near: number): number | null => {
      const k = key(ix, iy) * 1024 + Math.floor(near / 8 + 512);
      if (!level.has(k)) {
        const lo = near - DETOUR_DROP;
        const hi = near + this.step;
        const lv = this.levels(ix * G, iy * G, (lo + hi) / 2, (hi - lo) / 2).filter((z) => z <= hi);
        level.set(k, lv.length === 0 ? null : Math.max(...lv));
      }
      return level.get(k) ?? null;
    };
    const best = new Map<number, number>();
    // Smallest f first (ties: smaller g, then grid order).
    const before = (n: Node, o: Node): boolean => n.f < o.f || (n.f === o.f && (n.g < o.g || (n.g === o.g && (n.ix < o.ix || (n.ix === o.ix && n.iy < o.iy)))));
    const open = new Heap<Node>(before);
    open.push({ ix: sx, iy: sy, z: a.z, g: 0, f: Math.hypot(b.x - a.x, b.y - a.y), parent: null });
    best.set(key(sx, sy), 0);
    let expanded = 0;
    while (open.size > 0 && expanded < maxNodes) {
      const n = open.pop() as Node;
      if (n.g > (best.get(key(n.ix, n.iy)) ?? Infinity)) continue;
      expanded++;
      const here = n.parent === null ? { x: a.x, y: a.y, z: a.z } : { x: n.ix * G, y: n.iy * G, z: n.z };
      if (Math.abs(n.ix - tx) <= 1 && Math.abs(n.iy - ty) <= 1 && hullLineClear(this.g, here, b, this.step)) {
        const out: PathPoint[] = [{ x: b.x, y: b.y, z: b.z }];
        for (let m: Node | null = n; m !== null; m = m.parent) out.unshift(m.parent === null ? { x: a.x, y: a.y, z: a.z } : { x: m.ix * G, y: m.iy * G, z: m.z, ...(m.jump === undefined ? {} : { jump: m.jump }) });
        return out;
      }
      for (const [dx, dy] of DETOUR_STEPS) {
        const ix = n.ix + dx;
        const iy = n.iy + dy;
        if (Math.hypot(ix * G - cx, iy * G - cy) > reach) continue;
        const z = levelAt(ix, iy, n.z);
        const k = key(ix, iy);
        if (z !== null) {
          const there = { x: ix * G, y: iy * G, z };
          const g = n.g + Math.hypot(there.x - here.x, there.y - here.y);
          if (g + Math.hypot(b.x - there.x, b.y - there.y) <= maxLen && (best.get(k) ?? Infinity) > g && hullLineClear(this.g, here, there, this.step)) {
            best.set(k, g);
            open.push({ ix, iy, z, g, f: g + Math.hypot(b.x - there.x, b.y - there.y), parent: n });
            continue;
          }
        }
        // A jump: up onto a level more than a step and at most JUMP_UP above, from standing ground (not mid-jump),
        // where the 3D movement gets there with a jump (or a crouch jump) from here.
        if (!jumps || this.m === null || n.jump !== undefined) continue;
        const up = this.levels(ix * G, iy * G, n.z + (this.step + JUMP_UP) / 2, (JUMP_UP - this.step) / 2).filter((lz) => lz > n.z + this.step && lz <= n.z + JUMP_UP);
        if (up.length === 0) continue;
        const zj = Math.max(...up);
        // Headroom for the whole jump over the landing (a jump into a window bumps the lintel and stalls there:
        // a puppet does better going round).
        if (this.g.ceilingAbove(ix * G, iy * G, zj + TRACE_SKIN) - zj < JUMP_HEADROOM) continue;
        const there = { x: ix * G, y: iy * G, z: zj };
        const g = n.g + Math.hypot(there.x - here.x, there.y - here.y) + JUMP_COST;
        if (g + Math.hypot(b.x - there.x, b.y - there.y) > maxLen || (best.get(k) ?? Infinity) <= g) continue;
        // The quicker of a plain and a crouch jump (a plain one can bump its head under a window's lintel).
        const plain = reachTicks(this.g, this.m, here, there, true, false);
        const crouch = reachTicks(this.g, this.m, here, there, true, true);
        const kind = crouch !== null && (plain === null || crouch < plain) ? 'crouch' : plain !== null ? 'plain' : null;
        if (kind === null) continue;
        best.set(k, g);
        open.push({ ix, iy, z: zj, g, f: g + Math.hypot(b.x - there.x, b.y - there.y), parent: n, jump: kind });
      }
    }
    if (process.env['DEBUG_ASTAR'] !== undefined) console.log('astar fail', expanded, open.size, best.size);
    return null;
  }

  /**
   * Snap (x, y, z); `prev` = the previous sample snapped (null for the first). In order: the nearest allowed spot to
   * (x, y) within searchRadius that is on prev's level (± continuity) and in a clear hull line from it; else the spot
   * reachable from prev (`follow`) nearest to (x, y), if within followMaxMiss of it; else the nearest spot at all (a
   * discontinuity: the puppet will snap there), out to wideRadius; else the follow spot however far; else the recording.
   */
  snap(x: number, y: number, z: number, prev: SnappedSample | null): SnappedSample {
    const near = prev === null ? null : this.search(this.near, x, y, z, prev, true);
    if (near !== null) return near;
    // The recording changes floors (it went down or up stairs between samples): take its floor if a hull can walk
    // there from prev (the detour pass then spreads the way over the samples around), not prev's floor near by.
    if (prev !== null && Math.abs(z - prev.z) > SNAP_PARAMS.levelChange) {
      const other = this.search(this.near, x, y, z, null, false);
      if (other !== null && Math.abs(other.z - prev.z) > SNAP_PARAMS.levelChange) {
        const d = Math.hypot(other.x - prev.x, other.y - prev.y);
        if (this.astar(prev, other, Math.max(d * DETOUR_MAX_RATIO, d + DETOUR_SLACK)) !== null) return { ...other, connected: hullLineClear(this.g, prev, other, this.step) };
      }
    }
    const fol = prev === null ? null : this.follow(x, y, prev);
    if (fol !== null && fol.dxy <= SNAP_PARAMS.followMaxMiss) return { ...fol, dz: fol.z - z };
    const any = this.search(this.near, x, y, z, null, false) ?? this.search(this.wide, x, y, z, null, false);
    if (any !== null) return prev === null ? any : { ...any, connected: hullLineClear(this.g, prev, any, this.step) };
    if (fol !== null) return { ...fol, dz: fol.z - z };
    const lv = this.levels(x, y, z, SNAP_PARAMS.farZWindow);
    const best = lv[0];
    return best === undefined ? { x, y, z, kind: 'impossible', dxy: 0, dz: 0, connected: false } : { x, y, z: q32(best), kind: 'impossible', dxy: 0, dz: best - z, connected: false };
  }
}

/**
 * Can a pawn get from `a` to `b` in the 3D movement: running at them (yaw toward b), with `jump` pressing JUMP on
 * the first tick (and with `crouch` holding DUCK from then on)? True when it comes within reachUnits in 2D and reachZ in
 * height of b within reachSec.
 */
export function reaches(g: MapGeometry, m: MovementTuning, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, jump: boolean, crouch: boolean): boolean {
  return reachTicks(g, m, a, b, jump, crouch) !== null;
}

/** `reaches`, as the ticks it takes (null: not within reachSec). */
export function reachTicks(g: MapGeometry, m: MovementTuning, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, jump: boolean, crouch: boolean): number | null {
  const yaw = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const st = settle(g, a, false, m);
  let s: MoveState = { ...restingState(st.pos, yaw), onGround: st.onGround };
  const ticks = Math.round(SNAP_PARAMS.reachSec * 64);
  for (let k = 0; k < ticks; k++) {
    const buttons: ('JUMP' | 'DUCK')[] = [];
    if (jump && k === 0) buttons.push('JUMP');
    if (crouch && jump) buttons.push('DUCK');
    s = stepMove3d(s, { forward: 1, side: 0, yaw, pitch: 0, buttons }, 'knife', g, m).state;
    if (Math.hypot(s.pos.x - b.x, s.pos.y - b.y) <= SNAP_PARAMS.reachUnits && Math.abs(s.pos.z - b.z) <= SNAP_PARAMS.reachZ && s.onGround) return k + 1;
  }
  return null;
}

/** A stretch of a recording on the wrong one of two overlapping floors (`levelFlips`): samples from..to − 1. */
export interface LevelFlip {
  readonly from: number;
  readonly to: number;
  /** The floor the recording left and comes back to (the sample before `from`). */
  readonly z: number;
  readonly dzIn: number;
  readonly dzOut: number;
}

/**
 * Pass 0 (`levelFlips`): the recording's z is the 2020 nav's floor under the radar dot's (x, y), so where two floors
 * overlap (Catwalk over the underpass, the Apartments over the Tunnel Stairs) a dot near the edge of one can pick up
 * the other: z jumps by more than levelChange in one sample step and jumps back later, while x/y goes on as before.
 * A stretch i .. j − 1 is such a flip when
 *
 * - the steps into i and into j each change z by more than levelChange, in opposite directions, j − i ≤
 *   FLIP_MAX_SAMPLES, and z[j] is back within levelChange of z[i − 1];
 * - the floor it left (within zWindow of z[i − 1]) is within FLIP_RADIUS of every sample of the stretch on CS2 Mirage
 *   (the dot never left the overlap);
 * - neither change of floor is a way a hull can go (`astar` with drops and jumps, as `detour` bounds it, finds no
 *   way from the nearest standing spot on one floor to the other's): a real flight of stairs, drop or jump between the
 *   samples is left alone.
 *
 * Such a stretch keeps its x/y and takes z[i − 1] (pass 1 then snaps it onto that floor).
 */
export function levelFlips(snapper: Snapper, rec: readonly { x: number; y: number; z: number }[]): LevelFlip[] {
  const out: LevelFlip[] = [];
  const lc = SNAP_PARAMS.levelChange;
  const way = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }): boolean => {
    const a = snapper.nearestStand(p.x, p.y, p.z, SNAP_PARAMS.searchRadius);
    const b = snapper.nearestStand(q.x, q.y, q.z, SNAP_PARAMS.searchRadius);
    if (a === null || b === null) return false;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return snapper.astar(a, b, Math.max(d * DETOUR_MAX_RATIO, d + DETOUR_SLACK), REROUTE_MAX_NODES, true) !== null;
  };
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1] as { x: number; y: number; z: number };
    const dzIn = (rec[i] as { z: number }).z - a.z;
    if (Math.abs(dzIn) <= lc) continue;
    let j = -1;
    for (let k = i + 1; k < rec.length && k - i <= FLIP_MAX_SAMPLES; k++) {
      if (Math.abs((rec[k] as { z: number }).z - (rec[k - 1] as { z: number }).z) > lc) {
        j = k;
        break;
      }
    }
    if (j < 0) continue;
    const dzOut = (rec[j] as { z: number }).z - (rec[j - 1] as { z: number }).z;
    if (Math.sign(dzOut) === Math.sign(dzIn) || Math.abs((rec[j] as { z: number }).z - a.z) > lc) continue;
    let under = true;
    for (let k = i; k < j && under; k++) under = snapper.nearestStand((rec[k] as { x: number }).x, (rec[k] as { y: number }).y, a.z, FLIP_RADIUS) !== null;
    if (!under) continue;
    if (way(a, rec[i] as { x: number; y: number; z: number }) || way(rec[j - 1] as { x: number; y: number; z: number }, rec[j] as { x: number; y: number; z: number })) continue;
    out.push({ from: i, to: j, z: a.z, dzIn, dzOut });
    i = j;
  }
  return out;
}

export interface SnapProducts {
  readonly text: string;
  readonly data: Tracks3d;
  readonly report: string;
}

/**
 * X1: `map` picks the package (docs/maps.md). The CS2 package's clips are rebuilt from the CS2 nav, so a stand level
 * must also be allowed by the nav (`Pieces`); the 2020 package has the map's own player clips, so every level a
 * hull fits at is allowed.
 */
export function buildTracks(map: MapId = DEFAULT_MAP): SnapProducts {
  const paths = mapPackagePaths(map);
  const roundBytes = read('data/round.json');
  const worldBytes = read(paths.geometry);
  const clipsBytes = read(paths.clips);
  const navBytes = map === DEFAULT_MAP ? read(CS2_NAV_PATH) : null;
  const round: RoundData = parseRound(new TextDecoder().decode(roundBytes));
  const tuning = parseTuning(JSON.parse(readFileSync(resolve(ROOT, 'data/tuning.json'), 'utf8')) as unknown);
  const m = tuning.movement;
  const worldMesh = decodeGeometry(worldBytes);
  const world = new MapGeometry(worldMesh);
  const g = new MapGeometry(combineMeshes(worldMesh, decodeGeometry(clipsBytes)));
  const pieces = new Pieces(world, world.triangleCount, navBytes === null ? ALLOW_ALL : new NavCover(readCs2Nav(navBytes).areas));
  const snapper = new Snapper(g, pieces, m.stepSize, m);
  const model = new RoundModel(round);
  const schedule = new EventSchedule(round);
  const weapons = (id: PlayerId) => recordedWeapons(model, schedule, id);
  const retimed: string[] = [];
  const led: string[] = [];
  const rerouted: string[] = [];
  const tracks: Partial<Record<PlayerId, number[][]>> = {};
  const jumps: Tracks3dJump[] = [];
  const counts: Record<SnapKind, number> = { ok: 0, moved: 0, far: 0, impossible: 0 };
  const moves: number[] = [];
  const zMoves: number[] = [];
  const rows: string[] = [];
  const climbs: string[] = [];
  let totalUnconnected = 0;
  let repaired = 0;
  let detoured = 0;
  const gaps: string[] = [];
  const flips: string[] = [];
  const snappedBy = new Map<PlayerId, SnappedSample[]>();
  const unconnectedBefore = new Map<PlayerId, number>();
  for (const id of PLAYER_IDS) {
    const tr0 = round.tracks[id];
    if (tr0 === undefined) continue;
    // Pass 0: stretches where the recording's z flipped to the other of two overlapping floors (`levelFlips`) go back
    // on the floor they left.
    const fl = levelFlips(snapper, tr0.samples);
    const onFlip = (k: number): LevelFlip | undefined => fl.find((f) => k >= f.from && k < f.to);
    const tr = fl.length === 0 ? tr0 : { ...tr0, samples: tr0.samples.map((q, k) => ({ ...q, z: onFlip(k)?.z ?? q.z })) };
    for (const f of fl) {
      const s0 = tr0.samples[f.from] as { t: number };
      const s1 = tr0.samples[f.to - 1] as { t: number };
      flips.push(`${id} ${s0.t.toFixed(1)}–${s1.t.toFixed(1)} s (${f.to - f.from} samples): dz ${f.dzIn.toFixed(0)} in, ${f.dzOut >= 0 ? '+' : ''}${f.dzOut.toFixed(0)} out; kept on z ${f.z}`);
    }
    // Pass 1: each sample on its own (nearest allowed spot, preferring one in a clear line from the previous).
    // A run of floorRun samples or more that pass 1 leaves on another floor than the recording's (it found no way to
    // the recording's floor near by) starts afresh on the recording's floor: a discontinuity unless pass 3 finds a way.
    const pass1 = (out: SnappedSample[], from: number): SnappedSample[] => {
      for (let i = from; i < tr.samples.length; i++) {
        const q = tr.samples[i] as { x: number; y: number; z: number };
        const prev = out.length === 0 || i === from ? null : (out[out.length - 1] as SnappedSample);
        const r = snapper.snap(q.x, q.y, q.z, prev);
        out.push(i === from && from > 0 ? { ...r, connected: hullLineClear(g, out[out.length - 1] as SnappedSample, r, m.stepSize) } : r);
      }
      return out;
    };
    let snapped: SnappedSample[] = pass1([], 0);
    const restarted = new Set<number>();
    for (;;) {
      let runFrom = -1;
      let start = -1;
      for (let i = 0; i <= snapped.length; i++) {
        const off = i < snapped.length && Math.abs((tr.samples[i] as { z: number }).z - (snapped[i] as SnappedSample).z) > SNAP_PARAMS.levelChange;
        if (off && start < 0) start = i;
        if (!off && start >= 0) {
          if (i - start >= SNAP_PARAMS.floorRun && !restarted.has(start)) {
            runFrom = start;
            break;
          }
          start = -1;
        }
      }
      if (runFrom < 0) break;
      restarted.add(runFrom);
      snapped = pass1(snapped.slice(0, runFrom), runFrom);
    }
    // Pass 2: where two consecutive samples still aren't in a clear line (a corner the greedy pass cut), re-place the
    // samples around it together (`repairWindow`).
    const before = countUnconnected(g, snapped, m.stepSize);
    for (let i = 1; i < snapped.length; i++) {
      if (stepOk(g, snapped[i - 1] as SnappedSample, snapped[i] as SnappedSample, m.stepSize)) continue;
      snapped = snapper.repairWindow(snapped, tr.samples, i);
    }
    // Pass 3: a gap that remains is a wall or obstacle the recording went through: walk round it (`detour`) and spread
    // the samples around the gap along the way, unless the way round is too long (then the gap stays: the puppet snaps).
    for (let i = 1; i < snapped.length; i++) {
      if (stepOk(g, snapped[i - 1] as SnappedSample, snapped[i] as SnappedSample, m.stepSize)) continue;
      const next = snapper.detour(snapped, i, (j) => frozenTick(round, id, (tr.samples[j] as { tick: number }).tick));
      if (next !== null) {
        snapped = next;
        detoured++;
      }
    }
    const speeds = tr.samples.map((q) => runSpeedOf(weaponAt(weapons(id), q.tick), m));
    const isFrozen = (j: number): boolean => frozenTick(round, id, (tr.samples[j] as { tick: number }).tick);
    // Pass 4 (K1, `lead`): an inferred route faster than a run before the next seen sample starts earlier instead.
    const ld = lead(g, snapper, tr.samples, snapped, speeds, m.stepSize, isFrozen);
    snapped = ld.out;
    led.push(...ld.notes.map((x) => `${id} ${x}`));
    // Pass 4a: where the snapped track is longer than the recording (detours, corners), a puppet running at full speed
    // can't keep up: let the track fall behind along its own path and catch up where the recording is slower (`retime`).
    // The first lag worth it not tried yet, from its start (at most REROUTE_MAX_SPAN samples at a time), then
    // retime again and look again: a long lag is rerouted piece by piece, each piece as short as it can be.
    let rt = retime(g, snapper, tr.samples, snapped, speeds, m.stepSize, isFrozen);
    const tried = new Set<number>();
    for (let round = 0; round < REROUTE_ROUNDS; round++) {
      const w = rt.windows.find((x) => (x.maxLag > REROUTE_MIN_LAG || x.forced) && !tried.has(x.from));
      if (w === undefined) break;
      tried.add(w.from);
      const rr = reroute(g, snapper, tr.samples, snapped, speeds, w, m.stepSize, isFrozen);
      if (rr === null) continue;
      snapped = rr.out;
      rerouted.push(`${id} ${rr.note}`);
      rt = retime(g, snapper, tr.samples, snapped, speeds, m.stepSize, isFrozen);
    }
    snapped = rt.out;
    retimed.push(...rt.notes.map((x) => `${id} ${x}`));
    snappedBy.set(id, snapped);
    unconnectedBefore.set(id, before);
  }
  // Pass 5 (G6, tools/sight-snap.ts): every recorded duel in sight on the CS2 mesh (docs/vision.md "Recorded duels").
  const sp = sightPass({
    round,
    tracks: snappedBy,
    g,
    sight: new MeshSight(world, meshSightOptionsFromTuning(tuning)),
    snapper,
    step: m.stepSize,
    runSpeed: (id, i) => runSpeedOf(weaponAt(weapons(id), (round.tracks[id]?.samples[i] as { tick: number }).tick), m),
    frozen: (id, i) => frozenTick(round, id, (round.tracks[id]?.samples[i] as { tick: number }).tick),
    raw: (id) => round.tracks[id]?.samples ?? [],
    standSpeed: tuning.replay.standSpeedThreshold,
  });
  for (const id of PLAYER_IDS) {
    const tr = round.tracks[id];
    const snapped = sp.tracks.get(id);
    if (tr === undefined || snapped === undefined) continue;
    const before = unconnectedBefore.get(id) ?? 0;
    const unconnected = countUnconnected(g, snapped, m.stepSize);
    repaired += before - unconnected;
    for (let i = 1; i < snapped.length; i++) {
      const a = snapped[i - 1] as SnappedSample;
      const b = snapped[i] as SnappedSample;
      if (!stepOk(g, a, b, m.stepSize)) gaps.push(`${id} ${(tr.samples[i - 1] as { t: number }).t.toFixed(1)} s: (${a.x}, ${a.y}, ${a.z}) → (${b.x}, ${b.y}, ${b.z}), ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)} u, dz ${(b.z - a.z).toFixed(0)}`);
    }
    const out: number[][] = [];
    let moved = 0;
    let maxMove = 0;
    let maxAt = 0;
    snapped.forEach((r, k) => {
      const s = tr.samples[k] as RoundData['tracks'][PlayerId]['samples'][number];
      counts[r.kind]++;
      if (r.dxy > 0) {
        moved++;
        moves.push(r.dxy);
      }
      if (Math.abs(r.dz) > 0) zMoves.push(Math.abs(r.dz));
      if (r.dxy > maxMove) {
        maxMove = r.dxy;
        maxAt = s.t;
      }
      out.push([r.x, r.y, r.z]);
    });
    // Jumps: the take-offs `reroute` placed, and a climb of more than a step between consecutive samples that only a
    // jump makes.
    for (let i = 0; i + 1 < snapped.length; i++) {
      const a = snapped[i] as SnappedSample;
      const b = snapped[i + 1] as SnappedSample;
      const sa0 = tr.samples[i] as RoundData['tracks'][PlayerId]['samples'][number];
      if (a.jump !== undefined) {
        climbs.push(`${id} ${sa0.t.toFixed(1)} s: (${a.x}, ${a.y}, ${a.z}) → (${b.x}, ${b.y}, ${b.z}), ${b.z - a.z >= 0 ? '+' : ''}${(b.z - a.z).toFixed(1)} in ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)} u: ${a.jump === 'crouch' ? 'crouch jump' : 'jump'} (rerouted)`);
        jumps.push({ id, t: sa0.t, tick: sa0.tick, crouch: a.jump === 'crouch' });
        continue;
      }
      if (!(b.z - a.z > m.stepSize + SNAP_PARAMS.climbSlack)) continue;
      const sa = tr.samples[i] as RoundData['tracks'][PlayerId]['samples'][number];
      const walk = reaches(g, m, a, b, false, false);
      const jump = !walk && reaches(g, m, a, b, true, false);
      const crouch = !walk && !jump && reaches(g, m, a, b, true, true);
      climbs.push(`${id} ${sa.t.toFixed(1)} s: (${a.x}, ${a.y}, ${a.z}) → (${b.x}, ${b.y}, ${b.z}), +${(b.z - a.z).toFixed(1)} in ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)} u: ${walk ? 'walk' : jump ? 'jump' : crouch ? 'crouch jump' : 'unreachable'}`);
      if (jump || crouch) jumps.push({ id, t: sa.t, tick: sa.tick, crouch });
    }
    tracks[id] = out;
    rows.push(`| ${id} | ${tr.samples.length} | ${moved} | ${maxMove.toFixed(0)} (${maxAt.toFixed(1)} s) | ${unconnected} |`);
    totalUnconnected += unconnected;
  }
  const hist = (v: number[], edges: number[]): string =>
    edges.map((e, k) => `${k === 0 ? '≤' : ''}${e}${k + 1 < edges.length ? '' : '+'}: ${v.filter((x) => x <= e && (k === 0 || x > (edges[k - 1] as number))).length}`).join(', ');
  const data: Tracks3d = {
    format: TRACKS3D_FORMAT,
    note: `Every recorded track sample of data/round.json snapped onto ${map === DEFAULT_MAP ? 'CS2 Mirage' : `the ${map} map package`} (world mesh + player clips): the nearest spot within 64 units where a hull stands, z = that floor; and the samples a jump takes off from. Built by tools/snap-tracks.ts (docs/geometry.md "Track snapping"); applied by applyTracks3d.`,
    sources: [
      { file: 'data/round.json', sha256: sha256(roundBytes) },
      { file: paths.geometry, sha256: sha256(worldBytes) },
      { file: paths.clips, sha256: sha256(clipsBytes) },
      ...(navBytes === null ? [] : [{ file: CS2_NAV_PATH, sha256: sha256(navBytes) }]),
    ],
    params: SNAP_PARAMS,
    stats: {
      samples: counts.ok + counts.moved + counts.far + counts.impossible,
      ok: counts.ok,
      moved: counts.moved,
      far: counts.far,
      impossible: counts.impossible,
      unconnected: totalUnconnected,
      jumps: jumps.length,
    },
    tracks,
    jumps,
  };
  const text = stableText(data);
  const report = [
    `snapped ${data.stats.samples} samples: ${counts.ok} ok (no move in x/y), ${counts.moved} moved ≤ 16, ${counts.far} moved 16–64, ${counts.impossible} moved further or not at all (no spot within 64)`,
    `horizontal moves: ${hist(moves, [4, 8, 16, 32, 48, 64])}`,
    `z changes: ${hist(zMoves, [1, 4, 8, 16, 32, 96])}`,
    '',
    `level flips (the recording on the other of two overlapping floors, put back on the floor it left; ${flips.length}):`,
    ...flips.map((x) => `  ${x}`),
    '',
    `consecutive samples not in a clear hull line: ${totalUnconnected} (${repaired} more repaired by re-placing the samples around them, ${detoured} of those by a detour):`,
    ...gaps.map((x) => `  ${x}`),
    '',
    `rerouted stretches (a shorter way than the snapped one, ${rerouted.length}):`,
    ...rerouted.map((x) => `  ${x}`),
    '',
    `led stretches (an inferred route faster than a run before a seen sample starts earlier along its own path; ${led.length}):`,
    ...led.map((x) => `  ${x}`),
    '',
    `retimed stretches (the track falls behind the recording along its own path, then catches up; ${retimed.length}):`,
    ...retimed.map((x) => `  ${x}`),
    '',
    '| player | samples | moved in x/y | largest move | not in a clear line from the previous |',
    '| --- | ---: | ---: | --- | ---: |',
    ...rows,
    '',
    `climbs of more than a step between samples (${climbs.length}):`,
    ...climbs.map((c) => `  ${c}`),
    '',
    `jumps: ${jumps.length === 0 ? 'none' : jumps.map((j) => `${j.id} @ ${j.t} s${j.crouch ? ' (crouch)' : ''}`).join(', ')}`,
    '',
    `recorded duels in sight on the CS2 mesh (pass 5, tools/sight-snap.ts):`,
    ...sp.notes.map((x) => `  ${x}`),
  ].join('\n');
  return { text, data, report };
}

/**
 * Pass 4 (`retime`): the snapped samples as a path (2D arc length S along the polyline through them, as the puppets
 * measure speed), walked at no more than A_i per step: the larger of RETIME_SPEED_FACTOR × the recorded weapon's run
 * speed × the step's time and the recording's own step. R_0 = S_0 and R_i = min(S_i, R_{i−1} + A_i): a sample whose
 * R_i < S_i sits on the path R_i along (behind where the snapping put it), z the allowed stand level there nearest the
 * path's; once R catches up, samples are as snapped. Every step is a clear hull line: where the spot at R_{i−1} + A_i
 * isn't (a corner the line would cut, or no stand level there: decimated stairs), the sample takes the last path
 * corner before it that is, or stays put. A frozen sample (plant, defuse), and a jump's take-off and landing, keep
 * their places: a lag still open there is closed in one step (the puppet snaps) and reported. So is a step both the recording and the snapped track make
 * faster than RETIME_GAP_FACTOR × run speed (a gap in the recording no detour spread: the puppet snaps there anyway).
 */
function retime(
  g: MapGeometry,
  snapper: Snapper,
  rec: readonly { t: number; x: number; y: number }[],
  snapped: readonly SnappedSample[],
  speeds: readonly number[],
  step: number,
  frozen: (i: number) => boolean,
): { out: SnappedSample[]; notes: string[]; windows: LagWindow[] } {
  const n = snapped.length;
  const windows: LagWindow[] = [];
  const S: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = snapped[i - 1] as SnappedSample;
    const b = snapped[i] as SnappedSample;
    S.push((S[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const out: SnappedSample[] = [snapped[0] as SnappedSample];
  const notes: string[] = [];
  let R = 0;
  let lagFrom = -1;
  let maxLag = 0;
  // The spot R = r along the path, on segment k (S[k − 1] ≤ r < S[k]), at an allowed stand level near the path's z; null if none.
  const at = (r: number, k: number): SnappedSample | null => {
    const a = snapped[k - 1] as SnappedSample;
    const b = snapped[k] as SnappedSample;
    const len = (S[k] as number) - (S[k - 1] as number);
    const f = len > 0 ? (r - (S[k - 1] as number)) / len : 1;
    const x = q32(a.x + (b.x - a.x) * f);
    const y = q32(a.y + (b.y - a.y) * f);
    const zl = a.z + (b.z - a.z) * f;
    const lv = snapper.levels(x, y, zl, Math.abs(b.z - a.z) + step)[0];
    if (lv === undefined) return null;
    return { ...withoutJump(b), x, y, z: q32(lv), kind: 'far', dxy: b.dxy + Math.hypot(b.x - x, b.y - y), connected: true };
  };
  for (let i = 1; i < n; i++) {
    const p0 = rec[i - 1] as { t: number; x: number; y: number };
    const p1 = rec[i] as { t: number; x: number; y: number };
    const allow = Math.max(RETIME_SPEED_FACTOR * Math.max(speeds[i - 1] as number, speeds[i] as number) * (p1.t - p0.t), Math.hypot(p1.x - p0.x, p1.y - p0.y));
    const prev = out[i - 1] as SnappedSample;
    // A jump's take-off and landing stay where the path put them (a fixed move), like a frozen sample.
    const fixed = frozen(i) || (snapped[i] as SnappedSample).jump !== undefined || (snapped[i - 1] as SnappedSample).jump !== undefined;
    const forced = fixed && (S[i] as number) - R > allow;
    // A step the recording itself makes faster than a spike allows (a gap in it) stays a jump: the puppet snaps there.
    const gapAt = RETIME_GAP_FACTOR * Math.max(speeds[i - 1] as number, speeds[i] as number) * (p1.t - p0.t);
    const gap = Math.hypot(p1.x - p0.x, p1.y - p0.y) > gapAt && (S[i] as number) - (S[i - 1] as number) > gapAt;
    if (fixed || gap || (S[i] as number) <= R + allow) {
      out.push(snapped[i] as SnappedSample);
      R = S[i] as number;
    } else {
      // The spot at R + allow, else the last path corner before it, else the one before that, ... (each ahead of
      // the previous sample and in a clear hull line from it); else stay put this step.
      const target = R + allow;
      let k = 1;
      while ((S[k] as number) <= target) k++;
      let placed = false;
      const here = at(target, k);
      if (here !== null && hullLineClear(g, prev, here, step)) {
        out.push(here);
        R = target;
        placed = true;
      }
      for (let v = k - 1; !placed && v >= 1 && (S[v] as number) > R; v--) {
        const c = snapped[v] as SnappedSample;
        if (!hullLineClear(g, prev, c, step)) continue;
        out.push({ ...withoutJump(snapped[i] as SnappedSample), x: c.x, y: c.y, z: c.z, kind: 'far', connected: true });
        R = S[v] as number;
        placed = true;
      }
      // Nothing in a clear line (the snapping left a gap here, or stairs the decimated mesh makes steps of): go on
      // along the path anyway rather than stall.
      if (!placed && here !== null) {
        out.push(here);
        R = target;
      } else if (!placed) {
        const v = (S[k - 1] as number) > R ? k - 1 : k;
        const c = snapped[v] as SnappedSample;
        out.push({ ...withoutJump(snapped[i] as SnappedSample), x: c.x, y: c.y, z: c.z, kind: 'far', connected: true });
        R = Math.min(S[v] as number, S[i] as number);
      }
    }
    const lag = (S[i] as number) - R;
    if (lag > 0 && lagFrom < 0) {
      lagFrom = i;
      maxLag = 0;
    }
    if (lag > maxLag) maxLag = lag;
    if (lag <= 0 && lagFrom >= 0) {
      windows.push({ from: lagFrom, to: i, maxLag, forced });
      notes.push(`${(rec[lagFrom] as { t: number }).t.toFixed(1)}–${p1.t.toFixed(1)} s: up to ${maxLag.toFixed(0)} u behind${forced ? ` (closed at the fixed sample at ${p1.t.toFixed(1)} s: the puppet snaps)` : ''}`);
      lagFrom = -1;
    }
  }
  if (lagFrom >= 0) windows.push({ from: lagFrom, to: n - 1, maxLag, forced: false });
  if (lagFrom >= 0) notes.push(`${(rec[lagFrom] as { t: number }).t.toFixed(1)} s–end: up to ${maxLag.toFixed(0)} u behind at the end`);
  return { out, notes, windows };
}

/**
 * Pass 4 (`lead`, K1): an inferred stretch (CT routes outside sightings: reconstructed, never seen) can't be faster
 * than its runner. Where the inferred samples before an anchor (the next sample that isn't inferred, or a frozen one,
 * or a jump's take-off or landing) cover more path than LEAD_SPEED_FACTOR × run speed allows, the stretch starts
 * earlier: with S the 2D arc length along the snapped samples, L_a = S_a at the anchor and L_i = max(S_i,
 * L_{i+1} − A_{i+1}) going back, A the allowed step; a sample whose L_i > S_i moves ahead along the path to L_i (at
 * the allowed stand level there nearest the path's z), and the lead ends where the inferred route was slow enough to
 * absorb it. A lead that would reach back past the inferred stretch's first sample is capped there (the puppet still
 * lags after it, as `retime` reports). Seen samples never move. Sp4rtaN 57.0–58.5 s (down the Apartments stairs to
 * B in 1.6 s, 330 u/s with an AK): without this his puppet was 190 u behind at barely's kill (docs/round-data.md).
 */
function lead(
  g: MapGeometry,
  snapper: Snapper,
  rec: readonly { t: number; confidence: string }[],
  snapped: readonly SnappedSample[],
  speeds: readonly number[],
  step: number,
  frozen: (i: number) => boolean,
): { out: SnappedSample[]; notes: string[] } {
  const n = snapped.length;
  const S: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = snapped[i - 1] as SnappedSample;
    const b = snapped[i] as SnappedSample;
    S.push((S[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const out = snapped.slice();
  const notes: string[] = [];
  const fixed = (i: number): boolean =>
    (rec[i] as { confidence: string }).confidence !== 'inferred' || frozen(i) || (snapped[i] as SnappedSample).jump !== undefined || (i > 0 && (snapped[i - 1] as SnappedSample).jump !== undefined);
  const allow = (i: number): number =>
    LEAD_SPEED_FACTOR * Math.max(speeds[i - 1] as number, speeds[i] as number) * ((rec[i] as { t: number }).t - (rec[i - 1] as { t: number }).t);
  // The spot at arc length r (S[k − 1] ≤ r ≤ S[k]) at an allowed stand level near the path's z; null if none.
  const at = (r: number, i: number): SnappedSample | null => {
    let k = 1;
    while (k < n - 1 && (S[k] as number) < r) k++;
    const a = snapped[k - 1] as SnappedSample;
    const b = snapped[k] as SnappedSample;
    const len = (S[k] as number) - (S[k - 1] as number);
    const f = len > 0 ? Math.min(1, Math.max(0, (r - (S[k - 1] as number)) / len)) : 1;
    const x = q32(a.x + (b.x - a.x) * f);
    const y = q32(a.y + (b.y - a.y) * f);
    const lv = snapper.levels(x, y, a.z + (b.z - a.z) * f, Math.abs(b.z - a.z) + step)[0];
    if (lv === undefined) return null;
    const own = snapped[i] as SnappedSample;
    return { ...withoutJump(own), x, y, z: q32(lv), kind: 'far', dxy: own.dxy + Math.hypot(own.x - x, own.y - y), connected: true };
  };
  for (let anchor = 1; anchor < n; anchor++) {
    if (!fixed(anchor) || fixed(anchor - 1)) continue;
    // anchor − 1 is inferred: walk back while the lead lasts.
    let L = S[anchor] as number;
    let first = anchor;
    let maxLead = 0;
    let capped = false;
    const L_: number[] = [];
    for (let i = anchor - 1; i >= 0; i--) {
      const want = L - allow(i + 1);
      if (want <= (S[i] as number)) break;
      if (fixed(i)) {
        capped = true;
        break;
      }
      L = want;
      L_[i] = L;
      first = i;
      maxLead = Math.max(maxLead, L - (S[i] as number));
    }
    if (first === anchor) continue;
    let moved = 0;
    for (let i = first; i < anchor; i++) {
      const spot = at(L_[i] as number, i);
      if (spot === null) continue;
      const prev = out[i - 1] as SnappedSample | undefined;
      if (prev !== undefined && !hullLineClear(g, prev, spot, step)) continue;
      out[i] = spot;
      moved++;
    }
    const t0 = (rec[first] as { t: number }).t;
    const t1 = (rec[anchor] as { t: number }).t;
    notes.push(`${t0.toFixed(1)}–${t1.toFixed(1)} s: up to ${maxLead.toFixed(0)} u ahead (${moved}/${anchor - first} samples moved)${capped ? `; capped at ${t0.toFixed(1)} s (a fixed sample before it): the rest lags` : ''}`);
  }
  return { out, notes };
}

/** A stretch where `retime` leaves the track behind: samples from..to − 1 lag, `to` is back on the snapped track. */
interface LagWindow {
  readonly from: number;
  readonly to: number;
  readonly maxLag: number;
  /** Closed at a frozen sample (the puppet snaps there). */
  readonly forced: boolean;
}

/**
 * Pass 4a (`reroute`): where retiming leaves a track more than REROUTE_MIN_LAG behind, the snapped way is longer than
 * the recording's (the recording went through something CS2 has there: a wall, a box). Try the shortest way instead:
 * A* (as `detour`, up to REROUTE_MAX_NODES) from the sample REROUTE_BACK before the lag starts to the one where it
 * ends (or the first frozen one), kept if it is shorter than the snapped way by at least REROUTE_MIN_GAIN. Each sample
 * in between goes as far along the new way as the recording's progress (the share of the window's 2D distance it had
 * covered by then), or further, to the point nearest its recorded position up to REROUTE_AHEAD run-speed steps ahead
 * of the previous sample (at the way's corner before that when it isn't in a clear hull line from the previous
 * sample); `retime` then runs on the result.
 */
function reroute(
  g: MapGeometry,
  snapper: Snapper,
  rec: readonly { t: number; x: number; y: number }[],
  snapped: readonly SnappedSample[],
  speeds: readonly number[],
  w: LagWindow,
  step: number,
  frozen: (i: number) => boolean,
): { out: SnappedSample[]; note: string } | null {
  let i0 = Math.max(0, w.from - 1 - REROUTE_BACK);
  while (i0 < w.from - 1 && frozen(i0)) i0++;
  let i1 = w.to;
  for (let j = i0 + 1; j < i1; j++) {
    if (frozen(j)) {
      i1 = j;
      break;
    }
  }
  // At most REROUTE_MAX_SPAN samples from where it starts: the less of the recording a new way replaces, the better.
  while (i1 > i0 + REROUTE_MAX_SPAN) i1--;
  if (i1 - i0 < 2) return null;
  let snappedLen = 0;
  for (let j = i0 + 1; j <= i1; j++) snappedLen += Math.hypot((snapped[j] as SnappedSample).x - (snapped[j - 1] as SnappedSample).x, (snapped[j] as SnappedSample).y - (snapped[j - 1] as SnappedSample).y);
  const a = snapped[i0] as SnappedSample;
  const b = snapped[i1] as SnappedSample;
  const path = snapper.astar(a, b, snappedLen - REROUTE_MIN_GAIN, REROUTE_MAX_NODES, true);
  if (path === null) return null;
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push((cum[k - 1] as number) + Math.hypot((path[k] as { x: number }).x - (path[k - 1] as { x: number }).x, (path[k] as { y: number }).y - (path[k - 1] as { y: number }).y));
  const total = cum[cum.length - 1] as number;
  const pointAt = (arc: number): { x: number; y: number } => {
    let k = 1;
    while (k < path.length - 1 && (cum[k] as number) < arc) k++;
    const p0 = path[k - 1] as { x: number; y: number };
    const p1 = path[k] as { x: number; y: number };
    const seg = (cum[k] as number) - (cum[k - 1] as number);
    const f = seg > 0 ? Math.min(1, Math.max(0, (arc - (cum[k - 1] as number)) / seg)) : 0;
    return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
  };
  const recCum = [0];
  for (let j = i0 + 1; j <= i1; j++) recCum.push((recCum[recCum.length - 1] as number) + Math.hypot((rec[j] as { x: number }).x - (rec[j - 1] as { x: number }).x, (rec[j] as { y: number }).y - (rec[j - 1] as { y: number }).y));
  const recTotal = recCum[recCum.length - 1] as number;
  const out = [...snapped];
  let prevArc = 0;
  for (let j = i0 + 1; j < i1; j++) {
    // At least the recording's progress (the 2D distance it had covered by then, as a share of the window's), so the
    // new way is done by the window's end ...
    const share = recTotal > 0 ? (total * (recCum[j - i0] as number)) / recTotal : (total * (j - i0)) / (i1 - i0);
    // ... and further where the recording is: the nearest point to it (2D) ahead of the previous sample's and at
    // most REROUTE_AHEAD × a run-speed step further (so a way that passes near itself isn't skipped), REROUTE_PROBE apart.
    const reach = REROUTE_AHEAD * Math.max(speeds[j - 1] as number, speeds[j] as number) * ((rec[j] as { t: number }).t - (rec[j - 1] as { t: number }).t);
    let target = Math.max(prevArc, share);
    let bestD = Infinity;
    let nearest = prevArc;
    for (let arc = prevArc; arc <= Math.min(total, prevArc + reach) + 1e-9; arc += REROUTE_PROBE) {
      const q = pointAt(Math.min(arc, total));
      const d = Math.hypot(q.x - (rec[j] as { x: number }).x, q.y - (rec[j] as { y: number }).y);
      if (d < bestD - 1e-9) {
        bestD = d;
        nearest = Math.min(arc, total);
      }
    }
    target = Math.max(target, nearest);
    const prev = out[j - 1] as SnappedSample;
    // A jump on the way: a sample takes off at its start (marked) and the next one lands at its end, whatever the
    // progress says (the jump is a fixed move; retime evens out the time around it).
    const jumpEdge = path.findIndex((q, k) => k > 0 && q.jump !== undefined && (cum[k] as number) > prevArc && (cum[k - 1] as number) < target + 1e-9);
    if (prev.jump !== undefined) {
      const k = path.findIndex((q, kk) => kk > 0 && q.jump !== undefined && Math.abs((cum[kk - 1] as number) - prevArc) < 1e-6);
      const land = path[k] as PathPoint;
      const old = withoutJump(snapped[j] as SnappedSample);
      out[j] = { ...old, x: q32(land.x), y: q32(land.y), z: q32(land.z), kind: 'far', dxy: Math.hypot(land.x - (rec[j] as { x: number }).x, land.y - (rec[j] as { y: number }).y), connected: true };
      prevArc = cum[k] as number;
      continue;
    }
    if (jumpEdge > 0) {
      const off = path[jumpEdge - 1] as PathPoint;
      const q = { x: q32(off.x), y: q32(off.y), z: q32(off.z) };
      if (!hullLineClear(g, prev, q, step)) return null;
      const old = snapped[j] as SnappedSample;
      out[j] = { ...old, ...q, kind: 'far', dxy: Math.hypot(q.x - (rec[j] as { x: number }).x, q.y - (rec[j] as { y: number }).y), connected: true, jump: (path[jumpEdge] as PathPoint).jump as 'plain' | 'crouch' };
      prevArc = cum[jumpEdge - 1] as number;
      continue;
    }
    let k = 1;
    while (k < path.length - 1 && (cum[k] as number) < target) k++;
    const p0 = path[k - 1] as { x: number; y: number; z: number };
    const p1 = path[k] as { x: number; y: number; z: number };
    const seg = (cum[k] as number) - (cum[k - 1] as number);
    const f = seg > 0 ? Math.min(1, Math.max(0, (target - (cum[k - 1] as number)) / seg)) : 0;
    const cands: { x: number; y: number; z: number; arc: number }[] = [{ x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f, z: f < 0.5 ? p0.z : p1.z, arc: target }];
    for (let c = k - 1; c >= 1 && (cum[c] as number) > prevArc; c--) cands.push({ ...(path[c] as { x: number; y: number; z: number }), arc: cum[c] as number });
    let chosen: SnappedSample | null = null;
    for (const c of cands) {
      const lv = snapper.levels(c.x, c.y, c.z, step)[0];
      if (lv === undefined) continue;
      const q = { x: q32(c.x), y: q32(c.y), z: q32(lv) };
      if (!hullLineClear(g, prev, q, step)) continue;
      const old = withoutJump(snapped[j] as SnappedSample);
      chosen = { ...old, ...q, kind: 'far', dxy: Math.hypot(q.x - (rec[j] as { x: number }).x, q.y - (rec[j] as { y: number }).y), connected: true };
      prevArc = c.arc;
      break;
    }
    if (chosen === null) return null;
    out[j] = chosen;
  }
  if (!stepOk(g, out[i1 - 1] as SnappedSample, b, step)) return null;
  const jumps = out.slice(i0, i1).filter((q) => q.jump !== undefined).length;
  return { out, note: `${(rec[i0] as { t: number }).t.toFixed(1)}–${(rec[i1] as { t: number }).t.toFixed(1)} s: rerouted, ${snappedLen.toFixed(0)} → ${total.toFixed(0)} u${jumps > 0 ? `, ${jumps} jump${jumps > 1 ? 's' : ''}` : ''}` };
}

/** JSON with one track per line (diffable, deterministic). */
function stableText(d: Tracks3d): string {
  const lines: string[] = ['{'];
  lines.push(`  "format": ${JSON.stringify(d.format)},`);
  lines.push(`  "note": ${JSON.stringify(d.note)},`);
  lines.push(`  "sources": ${JSON.stringify(d.sources)},`);
  lines.push(`  "params": ${JSON.stringify(d.params)},`);
  lines.push(`  "stats": ${JSON.stringify(d.stats)},`);
  lines.push('  "tracks": {');
  const ids = PLAYER_IDS.filter((id) => d.tracks[id] !== undefined);
  ids.forEach((id, k) => lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(d.tracks[id])}${k + 1 < ids.length ? ',' : ''}`));
  lines.push('  },');
  lines.push(`  "jumps": ${JSON.stringify(d.jumps)}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

function main(): void {
  const args = process.argv.slice(2);
  const mi = args.indexOf('--map');
  const map = parseMapId(mi >= 0 ? (args[mi + 1] ?? '') : null);
  const out = mapPackagePaths(map).tracks;
  const t0 = process.hrtime.bigint();
  const p = buildTracks(map);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (args.includes('--check')) {
    if (readFileSync(resolve(ROOT, out), 'utf8') !== p.text) {
      console.error(`stale: ${out}: run npx tsx tools/snap-tracks.ts${map === DEFAULT_MAP ? '' : ` --map ${map}`}`);
      process.exit(1);
    }
    console.log(`${out} is up to date (${ms.toFixed(0)} ms)`);
    return;
  }
  writeFileSync(resolve(ROOT, out), p.text, 'utf8');
  console.log(`wrote ${out} (${p.text.length} bytes) in ${ms.toFixed(0)} ms\n\n${p.report}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
