/**
 * CS2's volumetric smoke as a voxel flood (docs/grenades.md, Smoke). CS2 fills a 32³ grid of 20-unit voxels around
 * the detonation; here the cloud is a Dijkstra flood from the detonation voxel through the 26 neighbours, where a
 * step is allowed only if the segment between the two voxel centres is clear of the world (so it flows around
 * corners, through doors and down stairs but not through walls or floors). Climbing costs `smokeUpCost` × more.
 * The flood stops at `smokeMaxVoxels` voxels or `smokeMaxRadius` cost distance: in the open that is a dome of about
 * 140 units, in a corridor it runs further. Voxels appear by cost distance over `smokeGrowSec`.
 *
 * Holes: a bullet clears the voxels within `bulletHoleRadius` of its path for `bulletHoleSec`; an HE blast opens a
 * 200-unit core (feathered to 240) that regrows over 0.5–5 s (memorin's T3 transcription of the client shader).
 */
import type { GrenadeCs2Tuning, Team, Vec3 } from '../../contracts/index';
import { secToTicks, smoothstep, TICK_RATE } from './math';
import type { GrenadeState, GrenadeWorld, HeHole, Smoke, SmokeCell } from './types';

/** The client keeps this many recent HE blasts for smoke holes. */
const HE_HOLE_SLOTS = 5;
/** The detonation sits in this voxel layer (room below for the cloud to flow down stairs). */
const START_LAYER = 10;
/** Voxel centres start this far above the grenade (it rests 2 units over the floor). */
const START_LIFT = 10;

/** Binary min-heap on (cost, index), ties by index: a deterministic Dijkstra order. */
class CostHeap {
  readonly cost: number[] = [];
  readonly idx: number[] = [];
  get size(): number {
    return this.cost.length;
  }
  private less(a: number, b: number): boolean {
    const ca = this.cost[a] as number;
    const cb = this.cost[b] as number;
    return ca < cb || (ca === cb && (this.idx[a] as number) < (this.idx[b] as number));
  }
  private swap(a: number, b: number): void {
    const c = this.cost[a] as number;
    this.cost[a] = this.cost[b] as number;
    this.cost[b] = c;
    const i = this.idx[a] as number;
    this.idx[a] = this.idx[b] as number;
    this.idx[b] = i;
  }
  push(c: number, i: number): void {
    this.cost.push(c);
    this.idx.push(i);
    let k = this.cost.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }
  pop(): { c: number; i: number } {
    const c = this.cost[0] as number;
    const i = this.idx[0] as number;
    const lc = this.cost.pop() as number;
    const li = this.idx.pop() as number;
    if (this.cost.length > 0) {
      this.cost[0] = lc;
      this.idx[0] = li;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < this.cost.length && this.less(l, m)) m = l;
        if (r < this.cost.length && this.less(r, m)) m = r;
        if (m === k) break;
        this.swap(k, m);
        k = m;
      }
    }
    return { c, i };
  }
}

/** The 26 neighbour offsets, in a fixed order. */
const NEIGHBOURS: [number, number, number][] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0 || dz !== 0) NEIGHBOURS.push([dx, dy, dz]);

export function cellCenter(s: Pick<Smoke, 'originX' | 'originY' | 'originZ'>, index: number, t: Pick<GrenadeCs2Tuning, 'smokeGridCells' | 'smokeVoxel'>): Vec3 {
  const n = t.smokeGridCells;
  const i = index % n;
  const j = Math.floor(index / n) % n;
  const k = Math.floor(index / (n * n));
  const v = t.smokeVoxel;
  return { x: s.originX + (i + 0.5) * v, y: s.originY + (j + 0.5) * v, z: s.originZ + (k + 0.5) * v };
}

/** Flood-fill a smoke that detonated at `pos` on `tick`. */
export function createSmoke(seq: number, thrower: string, team: Team, pos: Vec3, tick: number, world: GrenadeWorld, t: GrenadeCs2Tuning): Smoke {
  const n = t.smokeGridCells;
  const v = t.smokeVoxel;
  const half = Math.floor(n / 2);
  const originX = pos.x - (half + 0.5) * v;
  const originY = pos.y - (half + 0.5) * v;
  const originZ = pos.z + START_LIFT - (START_LAYER + 0.5) * v;
  const geo = { originX, originY, originZ };
  const total = n * n * n;
  const best = new Float64Array(total).fill(Infinity);
  const done = new Uint8Array(total);
  const start = half + n * half + n * n * START_LAYER;
  best[start] = 0;
  const heap = new CostHeap();
  heap.push(0, start);
  const accepted: { index: number; cost: number }[] = [];
  while (heap.size > 0 && accepted.length < t.smokeMaxVoxels) {
    const { c, i } = heap.pop();
    if (done[i] === 1 || c > (best[i] as number)) continue;
    if (c > t.smokeMaxRadius) break;
    done[i] = 1;
    accepted.push({ index: i, cost: c });
    const ci = i % n;
    const cj = Math.floor(i / n) % n;
    const ck = Math.floor(i / (n * n));
    const a = cellCenter(geo, i, t);
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const ni = ci + dx;
      const nj = cj + dy;
      const nk = ck + dz;
      if (ni < 0 || nj < 0 || nk < 0 || ni >= n || nj >= n || nk >= n) continue;
      const q = ni + n * nj + n * n * nk;
      if (done[q] === 1) continue;
      const step = v * Math.sqrt(dx * dx + dy * dy + dz * dz) * (dz > 0 ? t.smokeUpCost : 1);
      const nc = c + step;
      if (nc >= (best[q] as number) || nc > t.smokeMaxRadius) continue;
      const b = cellCenter(geo, q, t);
      if (world.traceLine(a.x, a.y, a.z, b.x, b.y, b.z) < 1) continue;
      best[q] = nc;
      heap.push(nc, q);
    }
  }
  let maxCost = 0;
  for (const e of accepted) maxCost = Math.max(maxCost, e.cost);
  const grow = t.smokeGrowSec * TICK_RATE;
  const cells: SmokeCell[] = accepted.map((e) => ({
    index: e.index,
    appearTick: tick + (maxCost > 0 ? Math.round((grow * e.cost) / maxCost) : 0),
    holeUntilTick: 0,
  }));
  const order = cells.map((c, k) => ({ index: c.index, slot: k })).sort((p, q) => p.index - q.index);
  const fadeTick = tick + secToTicks(t.smokeFullSec);
  return {
    seq,
    thrower,
    team,
    center: { ...pos },
    popTick: tick,
    fadeTick,
    endTick: fadeTick + secToTicks(t.smokeFadeSec),
    originX,
    originY,
    originZ,
    cells,
    sortedIndex: order.map((o) => o.index),
    sortedSlot: order.map((o) => o.slot),
  };
}

function slotOf(s: Smoke, index: number): number {
  let lo = 0;
  let hi = s.sortedIndex.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = s.sortedIndex[mid] as number;
    if (m === index) return s.sortedSlot[mid] as number;
    if (m < index) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Remaining density factor of an HE hole at a point (1 = untouched). */
export function heHoleFactor(holes: readonly HeHole[], p: Vec3, sinceTick: number, tick: number, t: GrenadeCs2Tuning): number {
  let f = 1;
  for (const h of holes) {
    if (h.tick < sinceTick || h.tick > tick) continue;
    const age = (tick - h.tick) / TICK_RATE;
    if (age >= t.heHoleMaxSec) continue;
    const d = Math.sqrt((p.x - h.pos.x) ** 2 + (p.y - h.pos.y) ** 2 + (p.z - h.pos.z) ** 2);
    if (d >= t.heHoleInfluence) continue;
    const open = 1 - smoothstep(t.heHoleCore, t.heHoleFeather, d);
    const rec = Math.pow(smoothstep(t.heHoleRegrowStartSec, t.heHoleRegrowEndSec, age), t.heHoleRegrowExp);
    f *= 1 - open * (1 - t.heHoleResidual) * (1 - rec);
  }
  return f;
}

function cellDensity(s: Smoke, slot: number, center: Vec3, holes: readonly HeHole[], tick: number, t: GrenadeCs2Tuning): number {
  const c = s.cells[slot] as SmokeCell;
  if (tick < c.appearTick || tick >= s.endTick || tick < c.holeUntilTick) return 0;
  const base = tick < s.fadeTick ? 1 : (s.endTick - tick) / (s.endTick - s.fadeTick);
  return base * heHoleFactor(holes, center, s.popTick, tick, t);
}

/** Smoke density (0..1) at a point: the densest smoke voxel containing it. */
export function smokeDensityAt(state: GrenadeState, p: Vec3, tick: number, t: GrenadeCs2Tuning): number {
  const n = t.smokeGridCells;
  const v = t.smokeVoxel;
  let best = 0;
  for (const s of state.smokes) {
    const i = Math.floor((p.x - s.originX) / v);
    const j = Math.floor((p.y - s.originY) / v);
    const k = Math.floor((p.z - s.originZ) / v);
    if (i < 0 || j < 0 || k < 0 || i >= n || j >= n || k >= n) continue;
    const idx = i + n * j + n * n * k;
    const slot = slotOf(s, idx);
    if (slot < 0) continue;
    best = Math.max(best, cellDensity(s, slot, cellCenter(s, idx, t), state.heHoles, tick, t));
  }
  return best;
}

/** Smoke a segment crosses, in units of full-density path length (sampled every voxel / 5). */
export function smokeOpticalLength(state: GrenadeState, a: Vec3, b: Vec3, tick: number, t: GrenadeCs2Tuning, stopAt = Infinity): number {
  if (state.smokes.length === 0) return 0;
  const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
  if (len === 0) return 0;
  const extent = t.smokeGridCells * t.smokeVoxel;
  let any = false;
  for (const s of state.smokes) {
    if (Math.max(a.x, b.x) < s.originX || Math.min(a.x, b.x) > s.originX + extent) continue;
    if (Math.max(a.y, b.y) < s.originY || Math.min(a.y, b.y) > s.originY + extent) continue;
    if (Math.max(a.z, b.z) < s.originZ || Math.min(a.z, b.z) > s.originZ + extent) continue;
    any = true;
  }
  if (!any) return 0;
  const step = t.smokeVoxel / 5;
  const count = Math.max(1, Math.ceil(len / step));
  const ds = len / count;
  let acc = 0;
  for (let q = 0; q < count; q++) {
    const f = (q + 0.5) / count;
    const d = smokeDensityAt(state, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }, tick, t);
    acc += d * ds;
    if (acc >= stopAt) return acc;
  }
  return acc;
}

/** True if smoke hides b from a (the segment crosses at least `smokeOpaqueLength` of full-density smoke). */
export function smokeBlocks(state: GrenadeState, a: Vec3, b: Vec3, tick: number, t: GrenadeCs2Tuning): boolean {
  return smokeOpticalLength(state, a, b, tick, t, t.smokeOpaqueLength) >= t.smokeOpaqueLength;
}

/** A bullet from a to b: clears the voxels within bulletHoleRadius of its path for bulletHoleSec. Returns the count. */
export function smokeBulletHole(state: GrenadeState, a: Vec3, b: Vec3, tick: number, t: GrenadeCs2Tuning): number {
  const r2 = t.bulletHoleRadius * t.bulletHoleRadius;
  const until = tick + secToTicks(t.bulletHoleSec);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  let count = 0;
  for (const s of state.smokes) {
    for (const c of s.cells) {
      const p = cellCenter(s, c.index, t);
      let f = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2 : 0;
      f = Math.max(0, Math.min(1, f));
      const qx = a.x + dx * f - p.x;
      const qy = a.y + dy * f - p.y;
      const qz = a.z + dz * f - p.z;
      if (qx * qx + qy * qy + qz * qz <= r2) {
        c.holeUntilTick = Math.max(c.holeUntilTick, until);
        count++;
      }
    }
  }
  return count;
}

/** Remember an HE blast for smoke holes (the last five). */
export function addHeHole(state: GrenadeState, pos: Vec3, tick: number): void {
  state.heHoles.push({ pos: { ...pos }, tick });
  while (state.heHoles.length > HE_HOLE_SLOTS) state.heHoles.shift();
}

/** Voxel centres of a smoke that are visible (density > 0) at `tick`, for renderers. */
export function smokeVoxels(state: GrenadeState, seq: number, tick: number, t: GrenadeCs2Tuning): { pos: Vec3; density: number }[] {
  const out: { pos: Vec3; density: number }[] = [];
  for (const s of state.smokes) {
    if (s.seq !== seq) continue;
    for (let k = 0; k < s.cells.length; k++) {
      const c = s.cells[k] as SmokeCell;
      const p = cellCenter(s, c.index, t);
      const d = cellDensity(s, k, p, state.heHoles, tick, t);
      if (d > 0) out.push({ pos: p, density: d });
    }
  }
  return out;
}
