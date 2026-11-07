/**
 * Scripted events (B3): REPLAY puppets act the recording. They aim and shoot on the recorded ticks,
 * switch and pick up weapons, throw their utility, plant and defuse, and the recorded damage is applied
 * as scripted `damage` actions while the engine's own bullet damage between puppets is blocked. Every
 * effect goes through `inputs` (yaw, pitch, ATTACK, USE) or contract `actions`, so the same Core drives
 * CS2 bots through usercmd injection. See docs/core.md "Scripted events".
 *
 * - `ScriptPlan`: everything the schedule asks for, worked out once into act ticks: fire items (sprays,
 *   taps, bursts, implied kill shots), aim engagements, damage, inventory changes, utility, plant and defuse.
 * - `ScriptedEvents`: the per-tick part. `blockActions` (round start), `actions` (scripted actions, drop
 *   logs, fallbacks) and `input` (the look and buttons layered on a puppet's movement input).
 *
 * Latency: an input sent in the Act of tick k shows its effect (a `shot` event) in the Observe of tick
 * k + `inputLatencyTicks`; an action's effect (a `damage` event, the new weapon) shows in the Observe of
 * k + `actionLatencyTicks`. Scripted inputs and actions are sent that much early, so the events land on the
 * recorded ticks. "An event lands on tick t" means it is in the Observe whose `tick` is t.
 *
 * Portable style: plain data, integer ticks, no closures as state. The per-run state (`ScriptState`) is
 * small plain data that ReplayCore snapshots.
 */
import {
  PLAYER_IDS,
  compareOrdinal,
  roundNumber,
  sortButtons,
  type Action,
  type Button,
  type DamageTuning,
  type GrenadeId,
  type Mode,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type Tuning,
  type Vec3,
  type WeaponId,
  type WeaponTuning,
} from '../contracts/index';
import { TICK_RATE } from './clock';
import { bandPoint, lookToward, type AimBand, type Look } from './aim';
import { withLook } from './puppet';
import type { RoundModel } from './round-model';
import type { BurstEntry, DamageEntry, EventSchedule, KillEntry, ShotEntry } from './schedule';

/** Slack for comparing fractional tick times with integer ticks (the engine rounds them to 6 decimals). */
const TICK_EPS = 1e-9;
/**
 * Spray phase fit: the hold may start this many ticks before or after the first recorded shot (minus the
 * latency), whichever puts the engine's cadence closest to the recorded ticks. In this order on a tie.
 */
export const SPRAY_FIT_SHIFTS: readonly number[] = [0, -1, 1, -2, 2];

/** Seconds to whole ticks, half up (`Math.Floor(sec * 64 + 0.5)` in C#). */
export function secTicks(sec: number): number {
  return Math.floor(sec * TICK_RATE + 0.5);
}

/** Seconds to whole ticks, rounded up (a deploy must be complete). */
export function ceilTicks(sec: number): number {
  return Math.ceil(sec * TICK_RATE - TICK_EPS);
}

/** Ticks between shots of a gun: 64 × 60 / rpm (fractional; AK-47 6.4). */
export function cycleTicksOf(gun: WeaponTuning): number {
  return (TICK_RATE * 60) / gun.rpm;
}

/**
 * The fire cadence of a held trigger (docs/combat.md, fire rules): shot k leaves the barrel `offsets[k]`
 * ticks after the press. Due times accumulate the fractional cycle (rounded to 6 decimals, as the engine
 * stores them) and a shot fires on the first tick at or after its due time: AK-47 0, 7, 13, 20, 26, 32, …
 */
export function cadenceOffsets(n: number, cycle: number): number[] {
  const out: number[] = [];
  let due = 0;
  for (let k = 0; k < n; k++) {
    const o = Math.ceil(due - TICK_EPS);
    out.push(o === 0 ? 0 : o); // never -0
    due = roundNumber(due + cycle);
  }
  return out;
}

/** Ticks between separate presses so each one fires: the cycle rounded up, at least 2 (press, release). */
export function tapSpacing(cycle: number): number {
  return Math.max(2, Math.ceil(cycle - TICK_EPS));
}

export interface SprayFit {
  /** ATTACK spans (act ticks): one hold, or two when one can't land every shot within a tick. */
  readonly attack: readonly AttackSpan[];
  /** Observe ticks the shots land on. */
  readonly shots: readonly number[];
  /** Largest |landed − recorded| (ticks). */
  readonly maxError: number;
}

/**
 * Hold ATTACK from each `starts[i]` until `counts[i]` more shots have fired, under the engine's fire rule
 * for an automatic gun (docs/combat.md): a held trigger fires on the first tick at or after the due time;
 * the next shot is due one cycle after the previous due time if that shot fired within a tick of being
 * due, else one cycle after the tick it fired. Returns the ATTACK spans and the fire ticks (act ticks), or
 * null if a hold would start before the previous one has been released for a tick.
 */
export function simulateHolds(starts: readonly number[], counts: readonly number[], cycle: number): { attack: AttackSpan[]; fires: number[] } | null {
  const attack: AttackSpan[] = [];
  const fires: number[] = [];
  let due = -Infinity;
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i] as number;
    const prev = attack[attack.length - 1];
    if (prev !== undefined && from < prev.to + 2) return null;
    let t = from;
    let left = counts[i] as number;
    let to = from;
    while (left > 0) {
      if (t + TICK_EPS >= due) {
        const base = due > t - 1 ? due : t;
        due = roundNumber(base + cycle);
        fires.push(t);
        to = t;
        left--;
      }
      t++;
    }
    attack.push({ from, to });
  }
  return { attack, fires };
}

/**
 * How to hold ATTACK so a spray's shots land closest to the recorded ticks. One hold, starting at
 * `recorded[0] − latency` shifted by each of SPRAY_FIT_SHIFTS; if none lands every shot within one tick,
 * also two holds split before each shot (each start shifted the same way), which re-phases the cadence
 * when the recording has two shots closer together than the gun allows. Best = smallest largest error,
 * then smallest sum of squared errors, then fewer holds, then the earlier candidate.
 */
export function fitSpray(recorded: readonly number[], cycle: number, latency: number): SprayFit {
  const n = recorded.length;
  const r0 = recorded[0] as number;
  let best: ScoredFit | null = null;
  for (const d of SPRAY_FIT_SHIFTS) best = better(best, scoreHolds([r0 - latency + d], [n], recorded, cycle, latency));
  if (best === null || best.fit.maxError > 1) {
    for (let j = 1; j < n; j++) {
      for (const d1 of SPRAY_FIT_SHIFTS) {
        for (const d2 of SPRAY_FIT_SHIFTS) best = better(best, scoreHolds([r0 - latency + d1, (recorded[j] as number) - latency + d2], [j, n - j], recorded, cycle, latency));
      }
    }
  }
  if (best === null) throw new Error('fitSpray: no candidate');
  return best.fit;
}

interface ScoredFit {
  readonly fit: SprayFit;
  readonly sq: number;
}

function scoreHolds(starts: readonly number[], counts: readonly number[], recorded: readonly number[], cycle: number, latency: number): ScoredFit | null {
  const sim = simulateHolds(starts, counts, cycle);
  if (sim === null) return null;
  const shots = sim.fires.map((f) => f + latency);
  let maxError = 0;
  let sq = 0;
  for (let k = 0; k < shots.length; k++) {
    const e = Math.abs((shots[k] as number) - (recorded[k] as number));
    if (e > maxError) maxError = e;
    sq += e * e;
  }
  return { fit: { attack: sim.attack, shots, maxError }, sq };
}

/** The better of two candidates (smaller largest error, then smaller squared error); `a` on a tie. */
function better(a: ScoredFit | null, b: ScoredFit | null): ScoredFit | null {
  if (a === null) return b;
  if (b === null) return a;
  if (b.fit.maxError < a.fit.maxError || (b.fit.maxError === a.fit.maxError && b.sq < a.sq)) return b;
  return a;
}

/** Item deploy time in ticks: the gun's `deploySec`, `grenades.deploySec`, else `damage.defaultDeploySec` (knife, c4). */
export function deployTicksOf(item: WeaponId, tuning: Tuning): number {
  const gun = tuning.weapons[item];
  if (gun !== undefined) return ceilTicks(gun.deploySec);
  if (item === 'smoke' || item === 'flash' || item === 'he' || item === 'molotov') return ceilTicks(tuning.grenades.deploySec);
  return ceilTicks(tuning.damage.defaultDeploySec);
}

/**
 * The weapon the recording shows `id` holding at `tick`: the drawn kit weapon (primary, else secondary,
 * else knife), then every scheduled pickup and weapon switch up to and including `tick`.
 */
export function recordedWeaponAt(model: RoundModel, schedule: EventSchedule, id: PlayerId, tick: number): WeaponId {
  const kit = model.player(id).kit;
  let w: WeaponId = kit.primary ?? kit.secondary ?? 'knife';
  for (const e of schedule.events) {
    if (e.tick > tick) break;
    if ((e.type === 'pickup' || e.type === 'weapon_switch') && e.id === id) w = e.weapon;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** `tap`: one press per recorded shot; `spray`: one hold; `burst`: a count-only row; `implied`: a kill with no recorded shot. */
export type FireKind = 'tap' | 'spray' | 'burst' | 'implied';

/** Act ticks [from, to] (inclusive) with ATTACK held. */
export interface AttackSpan {
  readonly from: number;
  readonly to: number;
}

/** One unit of fire: a spray, a tap, a burst or an implied kill shot. */
export interface FireItem {
  /** `fire:<index>`, the decision key. */
  readonly key: string;
  readonly kind: FireKind;
  readonly shooter: PlayerId;
  readonly target: PlayerId | null;
  readonly weapon: WeaponId;
  /** ATTACK spans, in order. */
  readonly attack: readonly AttackSpan[];
  /** Observe ticks the shots should land on (engine cadence + inputLatencyTicks). */
  readonly shotTicks: readonly number[];
  /** Recorded shot ticks (exact-time shots; empty for bursts and implied shots). */
  readonly recordedTicks: readonly number[];
  /** First and last act tick with ATTACK. */
  readonly fromTick: number;
  readonly toTick: number;
}

/** A shooter aims at one target over [fromTick, toTick] (act ticks). */
export interface Engagement {
  /** `aim:<index>`, the decision key. */
  readonly key: string;
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  /** `head` if a recorded hit or kill of the engagement is a headshot, else `chest`. */
  readonly band: AimBand;
  readonly fromTick: number;
  readonly toTick: number;
  /**
   * G6: the recorded spots the shooter pre-aims at while it doesn't see the target (B3 "Aim"): for each merged window,
   * its last act tick and the target's recorded position where that shot or hit lands (act tick + input latency), in
   * tick order. Absent (run-time engagements, B4): the shooter keeps its hold (if any) until it sees the target.
   */
  readonly spots?: readonly AimSpot[];
}

/** G6: where an engagement's shooter pre-aims (the target's recorded feet) until act tick `tick`. */
export interface AimSpot {
  readonly tick: number;
  readonly pos: Vec3;
}

/** A scheduled damage entry, sent as a `damage` action at `emitTick`. */
export interface DamageItem {
  readonly entry: DamageEntry;
  readonly emitTick: number;
}

/** A weapon switch or pickup, sent at `emitTick` (`give` first for a pickup). */
export interface InventoryItem {
  readonly id: PlayerId;
  readonly weapon: WeaponId;
  /** Recorded tick. */
  readonly tick: number;
  readonly emitTick: number;
  /** Pickup: the `give` before the `set_weapon` (gun: its tuning clip / reserve). */
  readonly give: { readonly clip: number; readonly reserve: number } | null;
}

/** One grenade throw (act ticks). */
export interface UtilityItem {
  readonly id: PlayerId;
  readonly kind: GrenadeId;
  /** Recorded throw tick. */
  readonly tick: number;
  /** `set_weapon <kind>`. */
  readonly selectTick: number;
  /** ATTACK held (pin pulled) on [attackFrom, attackTo]. */
  readonly attackFrom: number;
  readonly attackTo: number;
  /** First tick without ATTACK: the throw. */
  readonly releaseTick: number;
  /** `set_weapon <previous>` if the pawn holds something else. */
  readonly restoreTick: number;
  readonly previous: WeaponId;
}

/** The bomb plant (act ticks). */
export interface PlantItem {
  readonly id: PlayerId;
  readonly pos: Vec3;
  /** Recorded plant tick. */
  readonly tick: number;
  /** `set_weapon c4`, so the c4 is deployed when USE starts. */
  readonly selectTick: number;
  /** USE held and no stick on [useFrom, useTo] until a `planted` event arrives. */
  readonly useFrom: number;
  readonly useTo: number;
  /** No `planted` event by this tick: `plant` action. */
  readonly fallbackTick: number;
  /** Weapon to go back to after the plant. */
  readonly previous: WeaponId;
}

/** The defuse (act ticks). */
export interface DefuseItem {
  readonly id: PlayerId;
  readonly bombPos: Vec3;
  /** Recorded defuse start and end ticks. */
  readonly startTick: number;
  readonly endTick: number;
  /** Look at the bomb from here (preAimSec before USE) to useTo. */
  readonly lookFrom: number;
  /** USE held and no stick on [useFrom, useTo] until `defused` / `exploded`. */
  readonly useFrom: number;
  readonly useTo: number;
  /** No `defuse_start` event by this tick: `defuse_start` action. */
  readonly fallbackTick: number;
}

/** Everything the schedule asks the puppets to do, in act ticks. Immutable; depends only on the data and tuning. */
export class ScriptPlan {
  readonly fire: readonly FireItem[];
  readonly engagements: readonly Engagement[];
  readonly damage: readonly DamageItem[];
  readonly inventory: readonly InventoryItem[];
  readonly utility: readonly UtilityItem[];
  readonly plant: PlantItem | null;
  readonly defuse: DefuseItem | null;
  /** Fire items and engagements per player, PLAYER_IDS order (lookups). */
  private readonly fireByPlayer: readonly (readonly FireItem[])[];
  private readonly aimByPlayer: readonly (readonly Engagement[])[];

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning) {
    const r = tuning.replay;
    const li = r.inputLatencyTicks;
    const la = r.actionLatencyTicks;
    const preAim = secTicks(r.preAimSec);

    this.fire = buildFire(schedule, tuning);
    this.fireByPlayer = PLAYER_IDS.map((id) => this.fire.filter((f) => f.shooter === id));
    this.damage = schedule.ofType('damage').map((entry) => ({ entry, emitTick: entry.tick - la }));
    this.engagements = buildEngagements(this.fire, this.damage, preAim, li, (id, tick) => recordedFeet(model, id, tick));
    this.aimByPlayer = PLAYER_IDS.map((id) => this.engagements.filter((e) => e.shooter === id));

    const inventory: InventoryItem[] = [];
    for (const e of schedule.events) {
      if (e.type === 'weapon_switch') inventory.push({ id: e.id, weapon: e.weapon, tick: e.tick, emitTick: e.tick - la, give: null });
      if (e.type === 'pickup') {
        const gun = tuning.weapons[e.weapon];
        const isGun = gun !== undefined;
        if (!isGun && !isGrenade(e.weapon) && e.weapon !== 'c4' && e.weapon !== 'knife') throw new Error(`pickup ${e.weapon} by ${e.id}: no weapons.${e.weapon} tuning`);
        inventory.push({ id: e.id, weapon: e.weapon, tick: e.tick, emitTick: e.tick - la, give: isGun ? { clip: gun.clip, reserve: gun.reserve } : { clip: 0, reserve: 0 } });
      }
    }
    this.inventory = inventory;

    const hold = Math.max(1, secTicks(r.throwHoldSec));
    this.utility = schedule.ofType('utility').map((u) => {
      const release = u.tick - li;
      const attackFrom = release - hold;
      return {
        id: u.id,
        kind: u.kind,
        tick: u.tick,
        selectTick: attackFrom - deployTicksOf(u.kind, tuning),
        attackFrom,
        attackTo: release - 1,
        releaseTick: release,
        restoreTick: release + 1,
        previous: recordedWeaponAt(model, schedule, u.id, u.tick),
      };
    });

    const plant = schedule.ofType('plant')[0] ?? null;
    if (plant === null) {
      this.plant = null;
    } else {
      const useFrom = plant.tick - secTicks(tuning.bomb.plantSec) - li;
      this.plant = {
        id: plant.id,
        pos: plant.pos,
        tick: plant.tick,
        selectTick: useFrom - deployTicksOf('c4', tuning),
        useFrom,
        useTo: plant.tick,
        fallbackTick: plant.tick + r.plantFallbackTicks,
        previous: recordedWeaponAt(model, schedule, plant.id, plant.tick),
      };
    }

    const ds = schedule.ofType('defuse_start')[0] ?? null;
    const de = schedule.ofType('defuse_end')[0] ?? null;
    if (ds === null || de === null || plant === null) {
      this.defuse = null;
    } else {
      const useFrom = ds.tick - li;
      this.defuse = {
        id: ds.id,
        bombPos: plant.pos,
        startTick: ds.tick,
        endTick: de.tick,
        lookFrom: useFrom - preAim,
        useFrom,
        useTo: de.tick,
        fallbackTick: ds.tick + r.defuseFallbackTicks,
      };
    }
  }

  /** Fire items of one shooter, in order. */
  fireOf(id: PlayerId): readonly FireItem[] {
    return this.fireByPlayer[PLAYER_IDS.indexOf(id)] ?? [];
  }

  /** Engagements of one shooter, in order. */
  engagementsOf(id: PlayerId): readonly Engagement[] {
    return this.aimByPlayer[PLAYER_IDS.indexOf(id)] ?? [];
  }
}

function isGrenade(w: WeaponId): w is GrenadeId {
  return w === 'smoke' || w === 'flash' || w === 'he' || w === 'molotov';
}

interface FireDraft {
  readonly kind: FireKind;
  readonly shooter: PlayerId;
  readonly target: PlayerId | null;
  readonly weapon: WeaponId;
  readonly attack: AttackSpan[];
  readonly shotTicks: number[];
  readonly recordedTicks: number[];
}

/** Taps landing on the observe ticks `ticks`: one press each, `latency` ticks early. */
function taps(ticks: readonly number[], latency: number): { attack: AttackSpan[]; shotTicks: number[] } {
  return { attack: ticks.map((t) => ({ from: t - latency, to: t - latency })), shotTicks: [...ticks] };
}

/** A hold from act tick `press` for `n` shots of a gun with this cycle. */
function hold(press: number, n: number, cycle: number, latency: number): { attack: AttackSpan[]; shotTicks: number[] } {
  const off = cadenceOffsets(n, cycle);
  return { attack: [{ from: press, to: press + (off[n - 1] as number) }], shotTicks: off.map((o) => press + latency + o) };
}

/**
 * Fire items from the schedule:
 * - shots: a shooter's consecutive shots with one automatic weapon at one target, each at most
 *   `sprayGapFactor` cycles after the previous, are one spray (ATTACK held, phase-fitted); every other
 *   shot is a tap (press on its tick, release on the next);
 * - bursts (count only): a spray (automatic) or taps one cycle apart (semi-automatic) whose last shot is
 *   the related kill (the shooter's first kill in the window, of the burst's target if it has one);
 *   without one, `count` taps evenly through the window;
 * - kills with no recorded shot or burst of that killer at that victim (kill feed only): one implied tap
 *   on the kill tick.
 */
function buildFire(schedule: EventSchedule, tuning: Tuning): FireItem[] {
  const r = tuning.replay;
  const li = r.inputLatencyTicks;
  const preAim = secTicks(r.preAimSec);
  const drafts: FireDraft[] = [];
  const shots = schedule.ofType('shot');
  const bursts = schedule.ofType('burst');
  const kills = schedule.ofType('kill');

  for (const id of PLAYER_IDS) {
    let group: ShotEntry[] = [];
    const flush = (): void => {
      const first = group[0];
      if (first === undefined) return;
      const gun = tuning.weapons[first.weapon] ?? null;
      if (gun !== null && gun.automatic && group.length >= 2) {
        const recorded = group.map((s) => s.tick);
        const fit = fitSpray(recorded, cycleTicksOf(gun), li);
        drafts.push({ kind: 'spray', shooter: id, target: first.target, weapon: first.weapon, attack: [...fit.attack], shotTicks: [...fit.shots], recordedTicks: recorded });
      } else {
        for (const s of group) drafts.push({ kind: 'tap', shooter: id, target: s.target, weapon: s.weapon, ...taps([s.tick], li), recordedTicks: [s.tick] });
      }
      group = [];
    };
    for (const s of shots) {
      if (s.shooter !== id) continue;
      const last = group[group.length - 1];
      const gun = tuning.weapons[s.weapon] ?? null;
      const joins =
        last !== undefined &&
        gun !== null &&
        gun.automatic &&
        s.weapon === last.weapon &&
        s.target === last.target &&
        s.tick - last.tick <= r.sprayGapFactor * cycleTicksOf(gun) + TICK_EPS;
      if (!joins) flush();
      group.push(s);
    }
    flush();
  }

  for (const b of bursts) {
    const kill = relatedKill(b, kills);
    const target = b.target ?? kill?.victim ?? null;
    drafts.push({ kind: 'burst', shooter: b.shooter, target, weapon: b.weapon, ...burstPresses(b, kill, tuning.weapons[b.weapon] ?? null, li), recordedTicks: [] });
  }

  for (const k of kills) {
    const shot = shots.some((s) => s.shooter === k.killer && s.target === k.victim && s.tick <= k.tick && s.tick >= k.tick - preAim);
    const burst = bursts.some((b) => b.shooter === k.killer && (b.target === null || b.target === k.victim) && k.tick >= b.tick0 && k.tick <= b.tick1);
    if (shot || burst) continue;
    drafts.push({ kind: 'implied', shooter: k.killer, target: k.victim, weapon: k.weapon, ...taps([k.tick], li), recordedTicks: [] });
  }

  const ordered = drafts
    .map((d, i) => ({ d, i, from: (d.attack[0] as AttackSpan).from }))
    .sort((a, b) => a.from - b.from || compareOrdinal(a.d.shooter, b.d.shooter) || a.i - b.i);
  return ordered.map((x, i) => ({
    key: `fire:${i}`,
    ...x.d,
    fromTick: (x.d.attack[0] as AttackSpan).from,
    toTick: (x.d.attack[x.d.attack.length - 1] as AttackSpan).to,
  }));
}

/** The shooter's first kill inside the burst window, of the burst's target when it names one. */
function relatedKill(b: BurstEntry, kills: readonly KillEntry[]): KillEntry | null {
  for (const k of kills) {
    if (k.killer === b.shooter && k.tick >= b.tick0 && k.tick <= b.tick1 && (b.target === null || k.victim === b.target)) return k;
  }
  return null;
}

/** ATTACK spans and landing ticks for a count-only burst (see buildFire). */
function burstPresses(b: BurstEntry, kill: KillEntry | null, gun: WeaponTuning | null, li: number): { attack: AttackSpan[]; shotTicks: number[] } {
  const n = Math.max(1, b.count);
  const cycle = gun === null ? 0 : cycleTicksOf(gun);
  const automatic = gun !== null && gun.automatic;
  const spacing = tapSpacing(cycle);
  if (kill !== null) {
    if (automatic && n >= 2) {
      const last = cadenceOffsets(n, cycle)[n - 1] as number;
      return hold(Math.max(b.tick0 - li, kill.tick - li - last), n, cycle, li);
    }
    const ticks: number[] = [];
    for (let k = 0; k < n; k++) ticks.push(kill.tick - (n - 1 - k) * spacing);
    return taps(ticks, li);
  }
  const step = (b.tick1 - b.tick0) / n;
  if (step >= spacing) {
    const ticks: number[] = [];
    for (let k = 0; k < n; k++) ticks.push(b.tick0 + Math.floor((k + 0.5) * step + 0.5));
    return taps(ticks, li);
  }
  if (automatic) return hold(b.tick0 - li, n, cycle, li);
  const ticks: number[] = [];
  for (let k = 0; k < n; k++) ticks.push(b.tick0 + k * spacing);
  return taps(ticks, li);
}

interface AimWindow {
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  readonly from: number;
  readonly to: number;
  readonly head: boolean;
}

/**
 * Engagements: one aim window per fire item with a target ([first press − preAim, last press]) and per
 * damage entry ([its tick − inputLatency − preAim, its tick − inputLatency]); a shooter's overlapping or
 * touching windows at the same target merge. `head` if any merged damage entry is a headshot.
 */
function buildEngagements(fire: readonly FireItem[], damage: readonly DamageItem[], preAim: number, li: number, recordedAt: (id: PlayerId, tick: number) => Vec3 | null): Engagement[] {
  const windows: AimWindow[] = [];
  for (const f of fire) if (f.target !== null && f.target !== f.shooter) windows.push({ shooter: f.shooter, target: f.target, from: f.fromTick - preAim, to: f.toTick, head: false });
  for (const d of damage) {
    const e = d.entry;
    if (e.attacker === e.victim) continue;
    windows.push({ shooter: e.attacker, target: e.victim, from: e.tick - li - preAim, to: e.tick - li, head: e.hitgroup === 'head' });
  }
  const out: Engagement[] = [];
  for (const shooter of PLAYER_IDS) {
    for (const target of PLAYER_IDS) {
      const mine = windows
        .map((w, i) => ({ w, i }))
        .filter((x) => x.w.shooter === shooter && x.w.target === target)
        .sort((a, b) => a.w.from - b.w.from || a.w.to - b.w.to || a.i - b.i)
        .map((x) => x.w);
      let cur: { from: number; to: number; head: boolean; ends: number[] } | null = null;
      const push = (c: { from: number; to: number; head: boolean; ends: number[] }): void => {
        out.push({ key: '', shooter, target, band: c.head ? 'head' : 'chest', fromTick: c.from, toTick: c.to, spots: aimSpots(target, c.ends, li, recordedAt) });
      };
      for (const w of mine) {
        if (cur !== null && w.from <= cur.to + 1) {
          cur = { from: cur.from, to: Math.max(cur.to, w.to), head: cur.head || w.head, ends: [...cur.ends, w.to] };
          continue;
        }
        if (cur !== null) push(cur);
        cur = { from: w.from, to: w.to, head: w.head, ends: [w.to] };
      }
      if (cur !== null) push(cur);
    }
  }
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.fromTick - b.e.fromTick || compareOrdinal(a.e.shooter, b.e.shooter) || a.i - b.i)
    .map((x, i) => ({ ...x.e, key: `aim:${i}` }));
}

/** G6: the recorded position at `tick`, clamped to the track's ends (a victim's track can end just before the kill). */
function recordedFeet(model: RoundModel, id: PlayerId, tick: number): Vec3 | null {
  const at = model.trackAtTick(id, tick);
  if (at !== null) return at.pos;
  const track = model.track(id);
  const first = track[0];
  const last = track[track.length - 1];
  if (first === undefined || last === undefined) return null;
  const s = tick / TICK_RATE <= first.t ? first : last;
  return { x: s.x, y: s.y, z: s.z };
}

/** G6: an engagement's pre-aim spots: per distinct window end (act tick), the target's recorded feet where it lands. */
function aimSpots(target: PlayerId, ends: readonly number[], li: number, recordedAt: (id: PlayerId, tick: number) => Vec3 | null): AimSpot[] {
  const out: AimSpot[] = [];
  for (const tick of [...new Set(ends)].sort((a, b) => a - b)) {
    const pos = recordedAt(target, tick + li);
    if (pos !== null) out.push({ tick, pos: { x: pos.x, y: pos.y, z: pos.z } });
  }
  return out;
}

/** G6: the spot an engagement pre-aims at on act tick `tick`: the first whose tick is still ahead, else the last; null without spots. */
export function aimSpotAt(e: Engagement, tick: number): AimSpot | null {
  const spots = e.spots ?? [];
  for (const s of spots) if (s.tick >= tick) return s;
  return spots[spots.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Whether a fire item or engagement goes ahead; decided once, on the first tick it is active. */
export interface ScriptDecision {
  readonly key: string;
  readonly ok: boolean;
}

/** ScriptedEvents' per-run state (plain data; ReplayCore snapshots it). */
export interface ScriptState {
  /** Tick of the first `planted` bomb event seen, or null. */
  plantedTick: number | null;
  /** Tick of the first `defuse_start` bomb event of the defuser seen, or null. */
  defuseStartedTick: number | null;
  /** Tick of the first `defused` or `exploded` bomb event seen, or null. */
  defuseEndedTick: number | null;
  /** Decisions so far, in the order they were made. */
  decisions: ScriptDecision[];
  /**
   * B4: fire items and engagements added at run time (a scheduled encounter's time-shifted shot, src/core/divergence.ts),
   * in the order added. They are decided and played like the plan's own.
   */
  extraFire: FireItem[];
  extraEngagements: Engagement[];
  /** B4: angles held at a point (a scheduled encounter's shooter watching the recorded spot), in the order added. */
  holds: HoldItem[];
  /**
   * G1: every LIVE period of a pawn, in the order they began: from the tick it went LIVE to the tick it rejoined
   * (null while LIVE). What fell inside one is dropped (docs/core.md "Rejoin"): a fire item or engagement it was in
   * the middle of when it went LIVE, a grenade throw that overlaps it.
   */
  liveSpans: LiveSpan[];
  /** G1: ticks the scripted plant (USE window and fallback) runs late: the planter rejoined inside his plant window. */
  plantShift: number;
}

/** G1: one LIVE period of a pawn, [from, to) in ticks (`to` null while it lasts). */
export interface LiveSpan {
  readonly id: PlayerId;
  readonly from: number;
  to: number | null;
}

/**
 * B4: a puppet holds an angle: from `fromTick` until `toTick` (inclusive; null = open) it looks at `point` whenever no
 * defuse look or engagement is active. A scheduled encounter's shooter watches the spot where the recording has the
 * human (Lokier holding the Apartments window).
 */
export interface HoldItem {
  readonly key: string;
  readonly id: PlayerId;
  readonly point: Vec3;
  readonly fromTick: number;
  toTick: number | null;
}

/** A pawn's Core mode (ReplayCore's per-pawn state fits). */
export interface PawnMode {
  readonly id: PlayerId;
  readonly mode: Mode;
}

export function initialScriptState(): ScriptState {
  return { plantedTick: null, defuseStartedTick: null, defuseEndedTick: null, decisions: [], extraFire: [], extraEngagements: [], holds: [], liveSpans: [], plantShift: 0 };
}

function copyFire(f: FireItem): FireItem {
  return { ...f, attack: f.attack.map((a) => ({ from: a.from, to: a.to })), shotTicks: [...f.shotTicks], recordedTicks: [...f.recordedTicks] };
}

/**
 * The per-tick side of the plan. ReplayCore calls `blockActions` on the setup step, `actions` every step
 * (after the setup, before the puppets' inputs) and `input` for each puppet's movement input.
 *
 * Rules (docs/core.md "Scripted events"):
 * - Nothing is scripted for the human's pawn (`observe.human`): no inputs, no inventory, no plant or
 *   defuse, and no scripted damage to or from it. Puppets still aim and shoot at the human; the engine
 *   decides those hits.
 * - A fire item or engagement whose shooter or target is dead or LIVE when it starts is dropped (fire
 *   items are logged once). A spray that started goes on to its end even if its target dies.
 * - A damage entry whose attacker or victim is dead or LIVE at its emission tick is dropped and logged.
 */
export class ScriptedEvents {
  readonly plan: ScriptPlan;
  private readonly model: RoundModel;
  private readonly tuning: Tuning;
  private st: ScriptState;

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning) {
    this.model = model;
    this.tuning = tuning;
    this.plan = new ScriptPlan(model, schedule, tuning);
    this.st = initialScriptState();
  }

  /** Live state (mutated by `actions`). */
  get state(): ScriptState {
    return this.st;
  }

  reset(): void {
    this.st = initialScriptState();
  }

  /** Replace the state (snapshot restore). Copies it. */
  restore(s: ScriptState): void {
    this.st = {
      plantedTick: s.plantedTick,
      defuseStartedTick: s.defuseStartedTick,
      defuseEndedTick: s.defuseEndedTick,
      decisions: s.decisions.map((d) => ({ key: d.key, ok: d.ok })),
      extraFire: s.extraFire.map(copyFire),
      extraEngagements: s.extraEngagements.map((e) => ({ ...e })),
      holds: s.holds.map((h) => ({ key: h.key, id: h.id, point: { x: h.point.x, y: h.point.y, z: h.point.z }, fromTick: h.fromTick, toTick: h.toTick })),
      // Snapshots from before G1 have neither.
      liveSpans: (s.liveSpans ?? []).map((x) => ({ id: x.id, from: x.from, to: x.to })),
      plantShift: s.plantShift ?? 0,
    };
  }

  /** G1: `id` went LIVE on `tick` (opens a LIVE span). */
  noteLive(id: PlayerId, tick: number): void {
    this.st.liveSpans.push({ id, from: tick, to: null });
  }

  /** G1: `id` rejoined its recording on `tick` (closes its open LIVE span). */
  noteRejoin(id: PlayerId, tick: number): void {
    for (const x of this.st.liveSpans) if (x.id === id && x.to === null) x.to = tick;
  }

  /** G1: true when `id` was LIVE at some tick of [a, b] (inclusive). */
  liveDuring(id: PlayerId, a: number, b: number): boolean {
    for (const x of this.st.liveSpans) if (x.id === id && x.from <= b && (x.to === null || x.to > a)) return true;
    return false;
  }

  /** G1: true when `id` went LIVE after `fromTick` and no later than `toTick` (an item it was in the middle of). */
  private wentLiveDuring(id: PlayerId, fromTick: number, toTick: number): boolean {
    for (const x of this.st.liveSpans) if (x.id === id && x.from > fromTick && x.from <= toTick) return true;
    return false;
  }

  /**
   * G1: the planter rejoined inside his plant window on `tick`: the USE window and the fallback run `shift` ticks
   * late (the c4 is drawn at the rejoin, so the USE waits for its deploy). Logged when it is late at all.
   */
  shiftPlant(shift: number, tick: number, out: Action[]): void {
    const pl = this.plan.plant;
    if (pl === null || shift <= 0) return;
    this.st.plantShift = shift;
    out.push({ type: 'log', level: 'info', text: `script: plant by ${pl.id} runs ${tenths(shift)} s late (rejoined at tick ${tick}): USE from tick ${pl.useFrom + shift}` });
  }

  /** The plant as it runs: the plan's, moved by `plantShift` (G1). */
  plantItem(): PlantItem | null {
    const pl = this.plan.plant;
    const d = this.st.plantShift;
    if (pl === null || d === 0) return pl;
    return { ...pl, selectTick: pl.selectTick + d, useFrom: pl.useFrom + d, useTo: pl.useTo + d, fallbackTick: pl.fallbackTick + d };
  }

  /** The decision for a fire item or engagement key, or null before it is made. */
  decision(key: string): boolean | null {
    const d = this.st.decisions.find((x) => x.key === key);
    return d === undefined ? null : d.ok;
  }

  /**
   * B4: decide a fire item or engagement now as not going ahead, silently (a scheduled encounter replaces the
   * recorded shot with a time-shifted one). No effect if it is decided already.
   */
  suppress(key: string): void {
    if (this.decision(key) === null) this.st.decisions.push({ key, ok: false });
  }

  /** B4: add a fire item at run time (decided on its first active tick, like the plan's). Keys must be unique. */
  addFire(f: FireItem): void {
    if (this.st.extraFire.some((x) => x.key === f.key) || this.plan.fire.some((x) => x.key === f.key)) throw new Error(`ScriptedEvents.addFire: duplicate key ${f.key}`);
    this.st.extraFire.push(copyFire(f));
  }

  /** B4: add an engagement at run time. Keys must be unique. */
  addEngagement(e: Engagement): void {
    if (this.st.extraEngagements.some((x) => x.key === e.key) || this.plan.engagements.some((x) => x.key === e.key)) throw new Error(`ScriptedEvents.addEngagement: duplicate key ${e.key}`);
    this.st.extraEngagements.push({ ...e });
  }

  /** B4: hold an angle (see HoldItem). Keys must be unique. */
  addHold(h: HoldItem): void {
    if (this.st.holds.some((x) => x.key === h.key)) throw new Error(`ScriptedEvents.addHold: duplicate key ${h.key}`);
    this.st.holds.push({ key: h.key, id: h.id, point: { x: h.point.x, y: h.point.y, z: h.point.z }, fromTick: h.fromTick, toTick: h.toTick });
  }

  /** B4: stop holding an angle after `tick` (no effect on an unknown or ended hold). */
  endHold(key: string, tick: number): void {
    const h = this.st.holds.find((x) => x.key === key);
    if (h !== undefined && h.toTick === null) h.toTick = tick;
  }

  /** The angle `id` holds at `tick` (the first open hold), or null. */
  holdAt(id: PlayerId, tick: number): HoldItem | null {
    for (const h of this.st.holds) if (h.id === id && tick >= h.fromTick && (h.toTick === null || tick <= h.toTick)) return h;
    return null;
  }

  /** Fire items of one shooter: the plan's, then the run-time ones (B4). */
  private fireItemsOf(id: PlayerId): readonly FireItem[] {
    const extra = this.st.extraFire.filter((f) => f.shooter === id);
    return extra.length === 0 ? this.plan.fireOf(id) : [...this.plan.fireOf(id), ...extra];
  }

  /** Engagements of one shooter: the plan's, then the run-time ones (B4). */
  private engagementItemsOf(id: PlayerId): readonly Engagement[] {
    const extra = this.st.extraEngagements.filter((e) => e.shooter === id);
    return extra.length === 0 ? this.plan.engagementsOf(id) : [...this.plan.engagementsOf(id), ...extra];
  }

  /**
   * Round start: `block_damage` for every ordered pair of enemies that are both REPLAY and neither the
   * human, so the engine's own bullets and grenades between puppets do no damage (the recorded damage is
   * scripted). Friendly fire is off, so teammates need no block. Each such puppet is also blocked on
   * itself (attacker = victim): its own HE and molotov can't hurt it, since the recording has no
   * self-damage and the throws are guesses (`throwPitchDeg`). In attacker, then victim order.
   */
  blockActions(o: Observe, modes: readonly PawnMode[]): Action[] {
    const out: Action[] = [];
    for (const a of PLAYER_IDS) {
      if (a === o.human || modeOf(modes, a) !== 'REPLAY') continue;
      for (const b of PLAYER_IDS) {
        if (b === o.human || modeOf(modes, b) !== 'REPLAY') continue;
        if (a !== b && this.model.player(a).team === this.model.player(b).team) continue;
        out.push({ type: 'block_damage', attacker: a, victim: b });
      }
    }
    return out;
  }

  /**
   * This tick's scripted actions, appended to `out` in this order: bomb-event bookkeeping, inventory
   * (`give`, `set_weapon`), `damage`, drop logs for fire items starting now, grenade selection and
   * restore, plant (select, restore, fallback), defuse (fallback).
   */
  actions(o: Observe, modes: readonly PawnMode[], out: Action[]): void {
    const tick = o.tick;
    const s = this.st;
    this.noteBombEvents(o);

    // Inventory. A pickup and a switch to the same weapon on one tick send one set_weapon.
    const switched: { id: PlayerId; weapon: WeaponId }[] = [];
    for (const it of this.plan.inventory) {
      if (it.emitTick !== tick || !actorOk(o, modes, it.id)) continue;
      if (it.give !== null) out.push({ type: 'give', id: it.id, item: it.weapon, clip: it.give.clip, reserve: it.give.reserve });
      if (switched.some((x) => x.id === it.id && x.weapon === it.weapon)) continue;
      out.push({ type: 'set_weapon', id: it.id, weapon: it.weapon });
      switched.push({ id: it.id, weapon: it.weapon });
    }

    // Damage.
    for (const d of this.plan.damage) {
      if (d.emitTick !== tick) continue;
      const e = d.entry;
      const what = `damage ${e.attacker} -> ${e.victim} (${e.lethal ? 'lethal' : `${e.amount} hp`} at tick ${e.tick})`;
      if (e.attacker === o.human || e.victim === o.human) {
        out.push({ type: 'log', level: 'debug', text: `script: no scripted ${what}: ${o.human ?? ''} is the human` });
        continue;
      }
      const why = unavailable(o, modes, e.attacker) ?? unavailable(o, modes, e.victim);
      if (why !== null) {
        out.push({ type: 'log', level: 'info', text: `script: dropped ${what}: ${why}` });
        continue;
      }
      // G1: a recorded non-lethal hit stays non-lethal on a pawn with less HP than the tape (a rejoined pawn hurt while
      // LIVE): it takes it down to 1 HP, and the recorded kill comes on its tick.
      const hp = pawnOf(o, e.victim)?.hp ?? 0;
      const amount = e.lethal || e.amount < hp ? e.amount : hp - 1;
      if (amount <= 0) {
        out.push({ type: 'log', level: 'info', text: `script: dropped ${what}: ${e.victim} has ${hp} hp` });
        continue;
      }
      out.push({ type: 'damage', attacker: e.attacker, victim: e.victim, amount, armor: e.armor ?? 0, hitgroup: e.hitgroup, weapon: e.weapon, lethal: e.lethal });
    }

    // Fire items and engagements (the plan's, then B4's run-time ones): decide on the first active tick.
    const fire = s.extraFire.length === 0 ? this.plan.fire : [...this.plan.fire, ...s.extraFire];
    const engagements = s.extraEngagements.length === 0 ? this.plan.engagements : [...this.plan.engagements, ...s.extraEngagements];
    for (const f of fire) {
      if (tick < f.fromTick || tick > f.toTick || this.decision(f.key) !== null) continue;
      let ok = f.shooter !== o.human;
      if (ok) {
        const why = unavailable(o, modes, f.shooter) ?? (f.target === null ? null : unavailable(o, modes, f.target));
        if (why !== null) {
          ok = false;
          const at = f.target === null ? '' : ` at ${f.target}`;
          out.push({ type: 'log', level: 'info', text: `script: dropped ${f.shooter} ${f.weapon} ${f.kind}${at} (${f.shotTicks.length} shot${f.shotTicks.length === 1 ? '' : 's'} from tick ${f.fromTick}): ${why}` });
        }
      }
      s.decisions.push({ key: f.key, ok });
    }
    for (const e of engagements) {
      if (tick < e.fromTick || tick > e.toTick || this.decision(e.key) !== null) continue;
      const ok = e.shooter !== o.human && unavailable(o, modes, e.shooter) === null && unavailable(o, modes, e.target) === null;
      s.decisions.push({ key: e.key, ok });
    }

    // Utility: select the grenade, then (after the throw) the previous weapon.
    for (const u of this.plan.utility) {
      if (this.liveDuring(u.id, u.selectTick, u.restoreTick)) continue;
      if (tick === u.selectTick && actorOk(o, modes, u.id)) out.push({ type: 'set_weapon', id: u.id, weapon: u.kind });
      if (tick === u.restoreTick && actorOk(o, modes, u.id) && pawnOf(o, u.id)?.weapon !== u.previous) out.push({ type: 'set_weapon', id: u.id, weapon: u.previous });
    }

    // Plant: c4 out, USE (input), then back to the gun; fallback `plant` if the engine didn't plant.
    const pl = this.plantItem();
    if (pl !== null && actorOk(o, modes, pl.id)) {
      // (G1: a plant shifted after a rejoin draws the c4 on its new draw tick only if it isn't out already.)
      if (tick === pl.selectTick && (s.plantShift === 0 || pawnOf(o, pl.id)?.weapon !== 'c4')) out.push({ type: 'set_weapon', id: pl.id, weapon: 'c4' });
      const plantedNow = s.plantedTick === tick && tick >= pl.useFrom;
      // G1: no fallback for a planter who was LIVE in the USE window (he isn't where the tape has him planting).
      const fallback = tick === pl.fallbackTick && s.plantedTick === null && !this.liveDuring(pl.id, pl.useFrom, pl.fallbackTick);
      if (fallback) {
        out.push({ type: 'plant', id: pl.id, pos: { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z } });
        out.push({ type: 'log', level: 'info', text: `script: no planted event by tick ${tick}, sending plant for ${pl.id} at (${pl.pos.x}, ${pl.pos.y}, ${pl.pos.z})` });
      }
      if ((plantedNow || fallback) && pawnOf(o, pl.id)?.weapon !== pl.previous) out.push({ type: 'set_weapon', id: pl.id, weapon: pl.previous });
    }

    // Defuse: USE (input); fallback `defuse_start` if the engine didn't report one.
    const df = this.plan.defuse;
    if (df !== null && tick === df.fallbackTick && actorOk(o, modes, df.id) && s.defuseStartedTick === null && s.defuseEndedTick === null && bombInReach(o, df.id, this.tuning)) {
      out.push({ type: 'defuse_start', id: df.id });
      out.push({ type: 'log', level: 'info', text: `script: no defuse_start event by tick ${tick}, sending defuse_start for ${df.id}` });
    }
  }

  /**
   * The scripted look and buttons on top of a puppet's movement input `base` (B2), for pawn `p`:
   * - look: at the bomb during the defuse (from `lookFrom`), else at the target's `band` point during an
   *   engagement, else at a held angle's point (B4); turned from `prevYaw` (the last commanded yaw) and the observed pitch at most
   *   `aimTurnRateDegPerTick`. A grenade throw (ATTACK window and release) uses `throwPitchDeg`. Applied
   *   with `withLook`, so the pawn keeps moving the same way.
   * - ATTACK: the grenade's pin window during a throw; none while a grenade or the c4 is out for the
   *   script; otherwise every fire item that is on at this tick.
   * - Plant / defuse: USE and no stick (WALK / DUCK dropped) inside the USE window until the engine
   *   reports the plant / the end of the defuse.
   * The caller writes the returned yaw back to the puppet state, so the turn limit continues from it.
   */
  input(base: PawnInput, p: PawnObs, o: Observe, prevYaw: number): PawnInput {
    const tick = o.tick;
    const r = this.tuning.replay;
    const d: DamageTuning = this.tuning.damage;
    const crouching = base.buttons.includes('DUCK');
    const prev: Look = { yaw: prevYaw, pitch: p.pitch };
    let look: Look | null = null;

    const df = this.plan.defuse;
    const defusing = df !== null && df.id === p.id && this.st.defuseEndedTick === null;
    if (defusing && tick >= df.lookFrom && tick <= df.useTo) {
      look = lookToward(prev, p.pos, crouching, df.bombPos, d, r.aimTurnRateDegPerTick);
    } else {
      const eng = this.activeEngagement(p.id, tick);
      const target = eng === null ? undefined : pawnOf(o, eng.target);
      if (eng !== null && target !== undefined) {
        // G6: track the body only while the engine reports the target in the shooter's sight; otherwise pre-aim at the
        // recorded spot (no tracking through walls). The recorded damage still lands on its tick.
        const seen = p.sees.includes(eng.target);
        const spot = seen ? null : aimSpotAt(eng, tick);
        if (seen) look = lookToward(prev, p.pos, crouching, bandPoint(target.pos, target.crouching, eng.band, d), d, r.aimTurnRateDegPerTick);
        else if (spot !== null) look = lookToward(prev, p.pos, crouching, bandPoint(spot.pos, false, eng.band, d), d, r.aimTurnRateDegPerTick);
      }
    }
    if (look === null) {
      const hold = this.holdAt(p.id, tick);
      if (hold !== null) look = lookToward(prev, p.pos, crouching, hold.point, d, r.aimTurnRateDegPerTick);
    }

    const u = this.plan.utility.find((x) => x.id === p.id && tick >= x.selectTick && tick <= x.releaseTick && !this.liveDuring(x.id, x.selectTick, x.restoreTick)) ?? null;
    if (u !== null && tick >= u.attackFrom) look = { yaw: look === null ? base.yaw : look.yaw, pitch: r.throwPitchDeg };

    let input = look === null || (look.yaw === base.yaw && look.pitch === base.pitch) ? base : withLook(base, look.yaw, look.pitch);

    const pl = this.plantItem();
    const planting = pl !== null && pl.id === p.id && this.st.plantedTick === null;
    const buttons: Button[] = input.buttons.filter((b) => b !== 'ATTACK');
    if (u !== null) {
      if (tick >= u.attackFrom && tick <= u.attackTo) buttons.push('ATTACK');
    } else if (!(planting && tick >= pl.selectTick && tick <= pl.useTo) && this.attacking(p.id, tick)) {
      buttons.push('ATTACK');
    }
    input = { ...input, buttons: sortButtons(buttons) };

    if ((planting && tick >= pl.useFrom && tick <= pl.useTo) || (defusing && tick >= df.useFrom && tick <= df.useTo)) {
      input = { ...input, forward: 0, side: 0, buttons: ['USE'] };
    }
    return input;
  }

  /** True if a fire item of `id` that goes ahead holds ATTACK at `tick`. */
  attacking(id: PlayerId, tick: number): boolean {
    for (const f of this.fireItemsOf(id)) {
      if (tick < f.fromTick || tick > f.toTick || this.decision(f.key) !== true || this.wentLiveDuring(id, f.fromTick, tick)) continue;
      if (f.attack.some((a) => tick >= a.from && tick <= a.to)) return true;
    }
    return false;
  }

  /** The engagement `id` aims in at `tick`: among those that go ahead, the one ending first (then starting first, then by target). */
  activeEngagement(id: PlayerId, tick: number): Engagement | null {
    let best: Engagement | null = null;
    for (const e of this.engagementItemsOf(id)) {
      if (tick < e.fromTick || tick > e.toTick || this.decision(e.key) !== true || this.wentLiveDuring(id, e.fromTick, tick)) continue;
      if (best === null || e.toTick < best.toTick || (e.toTick === best.toTick && (e.fromTick < best.fromTick || (e.fromTick === best.fromTick && compareOrdinal(e.target, best.target) < 0)))) best = e;
    }
    return best;
  }

  private noteBombEvents(o: Observe): void {
    const s = this.st;
    const df = this.plan.defuse;
    for (const ev of o.events) {
      if (ev.type !== 'bomb') continue;
      if (ev.phase === 'planted' && s.plantedTick === null) s.plantedTick = o.tick;
      if (ev.phase === 'defuse_start' && s.defuseStartedTick === null && (df === null || ev.id === df.id)) s.defuseStartedTick = o.tick;
      if ((ev.phase === 'defused' || ev.phase === 'exploded') && s.defuseEndedTick === null) s.defuseEndedTick = o.tick;
    }
  }
}

function modeOf(modes: readonly PawnMode[], id: PlayerId): Mode | null {
  return modes.find((m) => m.id === id)?.mode ?? null;
}

function pawnOf(o: Observe, id: PlayerId): PawnObs | undefined {
  return o.pawns.find((p) => p.id === id);
}

/** Why `id` can't take part in a scripted shot or damage (dead, LIVE, not observed), or null. */
function unavailable(o: Observe, modes: readonly PawnMode[], id: PlayerId): string | null {
  const p = pawnOf(o, id);
  if (p === undefined) return `${id} is not in the observe`;
  if (!p.alive) return `${id} is dead`;
  if (modeOf(modes, id) === 'LIVE') return `${id} is LIVE`;
  return null;
}

/**
 * G1: a `defuse_start` fallback must be a defuse, not one from across the map (a LIVE T may have planted the bomb
 * somewhere else): false only when the round shows the bomb planted at a known spot further than `bomb.defuseRange`
 * (2D) from the defuser. An engine that reports no bomb state keeps the fallback.
 */
function bombInReach(o: Observe, id: PlayerId, tuning: Tuning): boolean {
  const p = pawnOf(o, id);
  const b = o.round.bomb;
  if (p === undefined || b.state !== 'planted' || b.pos === null) return true;
  return Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) <= tuning.bomb.defuseRange;
}

/** A tick count as seconds with one decimal, from integer arithmetic only (13 → "0.2"). */
function tenths(ticks: number): string {
  const t = Math.floor((Math.abs(ticks) * 10) / TICK_RATE + 0.5);
  return `${ticks < 0 && t > 0 ? '-' : ''}${Math.floor(t / 10)}.${t % 10}`;
}

/** True when `id` is a puppet the script may drive this tick: alive, REPLAY and not the human. */
function actorOk(o: Observe, modes: readonly PawnMode[], id: PlayerId): boolean {
  return id !== o.human && pawnOf(o, id)?.alive === true && modeOf(modes, id) === 'REPLAY';
}
