/**
 * The C4 in the 2D sim: plant, timer and beeps, explosion, defuse, drop and pickup. Pure functions over
 * plain data, in the style of grenades.ts: they return the new bomb state and a list of outcomes
 * (events, inventory changes, explosion damage, round-end requests) that Sim2DHost applies in order.
 * Rules and numbers: docs/combat.md, "Bomb and round rules"; every value comes from `tuning.bomb`.
 *
 * Per tick (after movement, weapons, grenades and scripted damage) the host first applies the Core's
 * queued `plant` / `defuse_start` / `defuse_stop` actions (applyBombAction), then stepBomb:
 * 1. plant progress: cancel, complete, or start (first eligible T by id);
 * 2. a dead pawn's c4 drops where it died; an alive T within `pickupRange` picks it up;
 * 3. a planted bomb whose explode tick has come explodes (a defuse in progress gets `defuse_stop` first);
 *    otherwise the defuse in progress is cancelled or completes, or one starts (first eligible CT by id),
 *    and the bomb beeps when a beep is due.
 * USE must be held on every tick of a plant or defuse, the completion tick included.
 */
import {
  compareOrdinal,
  roundNumber,
  type BombEvent,
  type BombObs,
  type BombState,
  type BombTuning,
  type DefuseStartAction,
  type DefuseStopAction,
  type PlantAction,
  type PlayerId,
  type RoundEndReason,
  type SoundEvent,
  type Team,
  type Vec3,
} from '../contracts/index';
import { TICKS_PER_SEC } from './movement';
import { ticksAfter } from './round';

/** A plant in progress (USE held with the c4 drawn in a bombsite). Ticks are integers. */
export interface PlantProgress {
  readonly id: PlayerId;
  readonly startTick: number;
  /** The plant completes on this tick if USE is still held. */
  readonly endTick: number;
}

/** A defuse in progress. */
export interface DefuseProgress {
  readonly id: PlayerId;
  readonly startTick: number;
  /** The defuse completes on this tick (if it is before the explosion). */
  readonly endTick: number;
  /** Started by a `defuse_start` action: needs neither USE nor range, only an alive defuser. */
  readonly forced: boolean;
}

/** Bomb state (plain data; snapshotted). Ticks are integers. */
export interface BombData {
  readonly state: BombState;
  /** Where it lies (dropped) or the bomb (planted, defused, exploded); null while carried. */
  readonly pos: Vec3 | null;
  readonly planter: PlayerId | null;
  readonly plantTick: number | null;
  readonly explodeTick: number | null;
  readonly nextBeepTick: number | null;
  readonly plant: PlantProgress | null;
  readonly defuse: DefuseProgress | null;
  /** Who defused it and on which tick (state defused). */
  readonly defusedBy: PlayerId | null;
  readonly defusedTick: number | null;
}

/** What the bomb rules see of a pawn this tick. */
export interface BombPawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly alive: boolean;
  /** Active item. */
  readonly weapon: string;
  /** USE held this tick. */
  readonly use: boolean;
  readonly hasC4: boolean;
  /** Carries a defuse kit (`defuser`). */
  readonly hasKit: boolean;
  /** Standing in a bombsite (the nav place name starts with "Bombsite"). The host may leave it false for pawns that can't plant. */
  readonly inSite: boolean;
}

export type BombOutcome =
  | { readonly type: 'event'; readonly event: BombEvent | SoundEvent }
  /** Remove the c4 from this pawn's inventory (planted or dropped). */
  | { readonly type: 'take_c4'; readonly id: PlayerId }
  /** Give this pawn the c4 (picked up). */
  | { readonly type: 'give_c4'; readonly id: PlayerId }
  /** Explosion damage before armor (hitgroup generic, no attacker). */
  | { readonly type: 'hurt'; readonly victim: PlayerId; readonly damage: number }
  /** The bomb ends the round (the host ignores it if the round already ended). */
  | { readonly type: 'round_end'; readonly winner: Team; readonly reason: RoundEndReason };

export interface BombStep {
  readonly bomb: BombData;
  readonly outcomes: BombOutcome[];
}

/** The plant / defuse actions of the contract. */
export type BombAction = PlantAction | DefuseStartAction | DefuseStopAction;

export interface BombActionResult extends BombStep {
  /** Why the action was not applied, or null. */
  readonly note: string | null;
}

/** Nav place names that count as bombsites. */
export const BOMBSITE_PREFIX = 'Bombsite';

export function isBombsite(place: string): boolean {
  return place.startsWith(BOMBSITE_PREFIX);
}

/** Before anyone has the c4 (state carried, no carrier until a pawn is given one). */
export function freshBomb(): BombData {
  return {
    state: 'carried',
    pos: null,
    planter: null,
    plantTick: null,
    explodeTick: null,
    nextBeepTick: null,
    plant: null,
    defuse: null,
    defusedBy: null,
    defusedTick: null,
  };
}

/**
 * B5 (`set_round`, resync rewind): the bomb as an Observe shows it, at observe tick `tick`. What the contract carries
 * comes back (state, position, plant tick and with it the explode tick and the beeps, who defused it and when); a plant
 * or defuse in progress does not (CS2 can't restore one either): it starts again if USE is still held. The c4 item is
 * the inventories' business (`strip` / `give`). `planter` is not observed and stays null.
 */
export function bombFromObs(o: BombObs, tick: number, bt: BombTuning): BombData {
  const fresh = freshBomb();
  const pos = o.pos === null ? null : copyVec(o.pos);
  switch (o.state) {
    case 'carried':
      return fresh;
    case 'dropped':
      return { ...fresh, state: 'dropped', pos };
    case 'planted':
    case 'defused':
    case 'exploded': {
      if (o.plantTick === null) return { ...fresh, state: o.state, pos };
      const explodeTick = ticksAfter(o.plantTick, bt.timerSec);
      const done = o.state !== 'planted';
      return {
        ...fresh,
        state: o.state,
        pos,
        plantTick: o.plantTick,
        explodeTick,
        nextBeepTick: done ? null : nextBeep(tick, explodeTick, bt),
        defusedBy: o.state === 'defused' ? o.defuser : null,
        defusedTick: o.state === 'defused' ? o.defuseEndTick : null,
      };
    }
  }
}

/** Planted and neither defused nor exploded. */
export function isTicking(b: BombData): boolean {
  return b.state === 'planted';
}

/** The tick after `tick` at which the bomb beeps next: every `beepSec`, every `beepFastSec` once `beepFastLastSec` or less are left. */
export function nextBeep(tick: number, explodeTick: number, bt: BombTuning): number {
  const leftSec = (explodeTick - tick) / TICKS_PER_SEC;
  return ticksAfter(tick, leftSec > bt.beepFastLastSec ? bt.beepSec : bt.beepFastSec);
}

/** Explosion damage at 3D distance `dist` before armor: linear from `damage` at 0 to 0 at `radius` (6 decimals). */
export function explosionDamage(dist: number, bt: Pick<BombTuning, 'damage' | 'radius'>): number {
  if (!(dist < bt.radius)) return 0;
  return roundNumber(bt.damage * (1 - dist / bt.radius));
}

/** 2D distance check (inclusive). */
export function within2D(a: Vec3, b: Vec3, range: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= range * range;
}

function canPlant(p: BombPawn): boolean {
  return p.alive && p.team === 'T' && p.weapon === 'c4' && p.hasC4 && p.use && p.inSite;
}

function canDefuse(p: BombPawn, bombPos: Vec3, bt: BombTuning): boolean {
  return p.alive && p.team === 'CT' && p.use && within2D(p.pos, bombPos, bt.defuseRange);
}

function byId(pawns: readonly BombPawn[]): BombPawn[] {
  return [...pawns].sort((a, b) => compareOrdinal(a.id, b.id));
}

function find(pawns: readonly BombPawn[], id: PlayerId): BombPawn | null {
  return pawns.find((p) => p.id === id) ?? null;
}

function copyVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function bombEvent(phase: BombEvent['phase'], id: PlayerId | null, pos: Vec3 | null): BombOutcome {
  return { type: 'event', event: { type: 'bomb', phase, id, pos: pos === null ? null : copyVec(pos) } };
}

/**
 * Pawns whose movement is locked this tick (CS freezes a planting or defusing player): the planter and the
 * defuser if their plant / defuse goes on, or the pawn that would start one. Evaluated before movement with
 * the same rules stepBomb uses after it; a locked pawn does not move, so both see the same position.
 */
export function lockedPawns(b: BombData, tick: number, pawns: readonly BombPawn[], bt: BombTuning): PlayerId[] {
  const out: PlayerId[] = [];
  const sorted = byId(pawns);
  if (b.state === 'carried') {
    if (b.plant !== null) {
      const p = find(sorted, b.plant.id);
      if (p !== null && canPlant(p)) out.push(p.id);
    } else {
      const p = sorted.find((q) => canPlant(q));
      if (p !== undefined) out.push(p.id);
    }
  }
  if (b.state === 'planted' && b.pos !== null && b.explodeTick !== null && tick < b.explodeTick) {
    const pos = b.pos;
    if (b.defuse !== null) {
      const d = b.defuse;
      const p = find(sorted, d.id);
      if (p !== null && p.alive && (d.forced || canDefuse(p, pos, bt))) out.push(p.id);
    } else {
      const p = sorted.find((q) => canDefuse(q, pos, bt));
      if (p !== undefined) out.push(p.id);
    }
  }
  return out.sort(compareOrdinal);
}

/** Plant the bomb at `pos` on `tick`: the c4 leaves every inventory (and the ground). */
function planted(b: BombData, id: PlayerId, pos: Vec3, tick: number, pawns: readonly BombPawn[], bt: BombTuning, out: BombOutcome[]): BombData {
  for (const p of pawns) if (p.hasC4) out.push({ type: 'take_c4', id: p.id });
  const explodeTick = ticksAfter(tick, bt.timerSec);
  out.push(bombEvent('planted', id, pos));
  return { ...b, state: 'planted', pos: copyVec(pos), planter: id, plantTick: tick, explodeTick, nextBeepTick: nextBeep(tick, explodeTick, bt), plant: null };
}

function startDefuse(b: BombData, p: BombPawn, tick: number, forced: boolean, bt: BombTuning, out: BombOutcome[]): BombData {
  const endTick = ticksAfter(tick, p.hasKit ? bt.defuseKitSec : bt.defuseSec);
  out.push(bombEvent('defuse_start', p.id, b.pos));
  return { ...b, defuse: { id: p.id, startTick: tick, endTick, forced } };
}

function stopDefuse(b: BombData, out: BombOutcome[]): BombData {
  if (b.defuse === null) return b;
  out.push(bombEvent('defuse_stop', b.defuse.id, b.pos));
  return { ...b, defuse: null };
}

/**
 * One tick of bomb rules (see the file comment for the order). `pawns` is the state after this tick's
 * movement, shots, grenades and scripted damage. Explosion damage is returned as `hurt` outcomes in id order,
 * computed from the positions in `pawns` (3D distance from the bomb to the body centre at stomach height
 * `bodyHeight`, through walls).
 */
export function stepBomb(b0: BombData, tick: number, pawns0: readonly BombPawn[], bt: BombTuning, bodyHeight: number): BombStep {
  const out: BombOutcome[] = [];
  const pawns = byId(pawns0);
  let b = b0;

  // 1. Plant progress.
  if (b.state === 'carried') {
    if (b.plant !== null) {
      const p = find(pawns, b.plant.id);
      if (p === null || !canPlant(p)) b = { ...b, plant: null };
      else if (tick >= b.plant.endTick) b = planted(b, p.id, p.pos, tick, pawns, bt, out);
    }
    if (b.state === 'carried' && b.plant === null) {
      const p = pawns.find((q) => canPlant(q));
      if (p !== undefined) b = { ...b, plant: { id: p.id, startTick: tick, endTick: ticksAfter(tick, bt.plantSec) } };
    }
  }

  // 2. Drop and pickup.
  let holders = pawns.filter((p) => p.hasC4).map((p) => p.id);
  if (b.state === 'carried') {
    const dead = pawns.filter((p) => p.hasC4 && !p.alive);
    const first = dead[0];
    if (first !== undefined && !pawns.some((p) => p.hasC4 && p.alive)) {
      for (const p of dead) out.push({ type: 'take_c4', id: p.id });
      holders = [];
      b = { ...b, state: 'dropped', pos: copyVec(first.pos), plant: null };
    }
  }
  if (b.state === 'dropped' && b.pos !== null && holders.length === 0) {
    const pos = b.pos;
    const p = pawns.find((q) => q.alive && q.team === 'T' && within2D(q.pos, pos, bt.pickupRange));
    if (p !== undefined) {
      out.push({ type: 'give_c4', id: p.id });
      b = { ...b, state: 'carried', pos: null };
    }
  }

  // 3. Planted: explosion, else defuse and beeps.
  if (b.state === 'planted' && b.pos !== null && b.explodeTick !== null) {
    const pos = b.pos;
    const explodeTick = b.explodeTick;
    if (tick >= explodeTick) {
      b = stopDefuse(b, out);
      out.push(bombEvent('exploded', null, pos));
      for (const p of pawns) {
        if (!p.alive) continue;
        const dist = Math.hypot(p.pos.x - pos.x, p.pos.y - pos.y, p.pos.z + bodyHeight - pos.z);
        const damage = explosionDamage(dist, bt);
        if (damage > 0) out.push({ type: 'hurt', victim: p.id, damage });
      }
      out.push({ type: 'round_end', winner: 'T', reason: 'bomb_exploded' });
      return { bomb: { ...b, state: 'exploded', nextBeepTick: null }, outcomes: out };
    }
    if (b.defuse !== null) {
      const d = b.defuse;
      const p = find(pawns, d.id);
      if (p === null || !p.alive || (!d.forced && !canDefuse(p, pos, bt))) {
        b = stopDefuse(b, out);
      } else if (tick >= d.endTick) {
        out.push(bombEvent('defused', d.id, pos));
        out.push({ type: 'round_end', winner: 'CT', reason: 'bomb_defused' });
        return { bomb: { ...b, state: 'defused', defuse: null, defusedBy: d.id, defusedTick: tick, nextBeepTick: null }, outcomes: out };
      }
    }
    if (b.defuse === null) {
      const p = pawns.find((q) => canDefuse(q, pos, bt));
      if (p !== undefined) b = startDefuse(b, p, tick, false, bt, out);
    }
    if (b.nextBeepTick !== null && tick >= b.nextBeepTick) {
      out.push({ type: 'event', event: { type: 'sound', source: null, pos: copyVec(pos), kind: 'bomb' } });
      b = { ...b, nextBeepTick: nextBeep(tick, explodeTick, bt) };
    }
  }
  return { bomb: b, outcomes: out };
}

/**
 * A Core `plant` / `defuse_start` / `defuse_stop` action on `tick` (scripted fallbacks for the USE rules):
 * - `plant {id, pos}`: an alive T plants at `pos` at once, if the bomb is not planted yet. The c4 leaves
 *   whoever has it (or the ground); the planter need not carry it.
 * - `defuse_start {id}`: an alive CT starts defusing the planted bomb, wherever it stands and without USE
 *   (kit time if it has a defuser). If it is already defusing, its defuse becomes forced and keeps its end tick.
 * - `defuse_stop {id}`: stops that pawn's defuse.
 * Anything else is returned with a note and changes nothing.
 */
export function applyBombAction(b: BombData, a: BombAction, tick: number, pawns: readonly BombPawn[], bt: BombTuning): BombActionResult {
  const out: BombOutcome[] = [];
  const p = find(pawns, a.id);
  const none = (note: string): BombActionResult => ({ bomb: b, outcomes: [], note });
  if (p === null) return none('unknown pawn');
  switch (a.type) {
    case 'plant': {
      if (!p.alive) return none('planter is dead');
      if (p.team !== 'T') return none('only a T can plant');
      if (b.state !== 'carried' && b.state !== 'dropped') return none(`bomb is ${b.state}`);
      const bomb = planted({ ...b, plant: null }, p.id, a.pos, tick, byId(pawns), bt, out);
      return { bomb, outcomes: out, note: null };
    }
    case 'defuse_start': {
      if (!p.alive) return none('defuser is dead');
      if (p.team !== 'CT') return none('only a CT can defuse');
      if (b.state !== 'planted') return none(`bomb is ${b.state}`);
      if (b.defuse !== null && b.defuse.id !== p.id) return none(`${b.defuse.id} is defusing`);
      if (b.defuse !== null) return { bomb: { ...b, defuse: { ...b.defuse, forced: true } }, outcomes: [], note: null };
      return { bomb: startDefuse(b, p, tick, true, bt, out), outcomes: out, note: null };
    }
    case 'defuse_stop': {
      if (b.defuse === null || b.defuse.id !== p.id) return none('not defusing');
      return { bomb: stopDefuse(b, out), outcomes: out, note: null };
    }
  }
}
