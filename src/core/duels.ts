/**
 * Recorded duels of the human (G5). Once the player controls cart he never fires by himself (the Core sends the human
 * nothing), but his recorded engagements stay *recorded duels*: the duel with Lokier at the Apartments window, the
 * spray at the defusing sp4rtan and the post-round shots at sp4rtan. While he is in one (alive, at cart's recorded spot
 * within `humanSpotToleranceUnits`, inside its window, the target a REPLAY puppet) his bullets on that target do no
 * engine damage (`block_damage`); the engine reports where they would have hit (`blocked_hit`), and the recorded outcome
 * is applied to those shots: Lokier's kill (AK-47, head) on its recorded tick, time-shifted with Lokier's scheduled
 * encounter; no damage on sp4rtan, as on the tape. Outside a duel (another place, time or target) his bullets are real,
 * so different input still changes history; if he never fires on the target, nothing is forced (Lokier lives).
 * docs/core.md "Recorded duels of the human".
 *
 * Portable style (docs/port-notes.md "Recorded duels of the human"): plain data, integer ticks, duels in plan order,
 * log texts from integer arithmetic only.
 */
import { roundNumber, type Action, type Observe, type PawnObs, type PlayerId, type Tuning, type Vec3, type WeaponId } from '../contracts/index';
import type { EncounterPlan, EncounterState } from './divergence';
import { tenthsText, trackPosAt } from './divergence';
import { dist2 } from './puppet';
import type { RoundModel } from './round-model';
import type { DamageEntry } from './schedule';
import { cycleTicksOf, tapSpacing, type PawnMode, type ScriptPlan } from './scripted';

/** One recorded duel of the default human (built once from the plan; immutable). */
export interface DuelPlan {
  /** `duel:<i>`, in the order of the human's engagements. */
  readonly key: string;
  /** The default human (cart). */
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  /** The recorded weapon (the engagement's fire item). */
  readonly weapon: WeaponId;
  /** The B3 engagement it replays (`aim:<i>`) and its fire items (`fire:<i>`: the puppet's recorded spray). */
  readonly aimKey: string;
  readonly fireKeys: readonly string[];
  /** The ticks the puppet's shots of those fire items land on (B3's fit), in order. */
  readonly puppetShotTicks: readonly number[];
  /**
   * The recorded window (act ticks): the engagement's aim start (its first press − `preAimSec`) to its last press. A
   * duel that answers a scheduled encounter opens instead on the tick the shooter first saw the human at the spot
   * (the encounter's `seenTick`, the time shift's origin), so firing before the recorded first shot is inside it.
   */
  readonly fromTick: number;
  readonly toTick: number;
  /** The first and last recorded shot (observe ticks). */
  readonly firstShotTick: number;
  readonly lastShotTick: number;
  /**
   * Cart's recorded spot in the duel: an encounter's spot when it answers one (his position at the target's recorded
   * hit, so the duel and the encounter agree on "at the spot"), else his recorded position halfway through his shots.
   * He is in the duel within `humanSpotToleranceUnits` (2D) of it.
   */
  readonly spot: Vec3;
  /** The recorded damage of his shots on the target in the duel, in tick order (cart → Lokier: the lethal headshot); empty = no damage. */
  readonly hits: readonly DamageEntry[];
  /** The scheduled encounter it answers (the target's recorded hit on him in this duel), whose time shift it takes; null: on the recorded ticks. */
  readonly encounter: string | null;
  /** One fire cycle of the weapon in whole ticks (AK-47: 7): a held trigger fires at least once in any such span. */
  readonly cycleTicks: number;
}

/** One duel's run-time state (plain data; in the Core snapshot). */
export interface DuelState {
  readonly key: string;
  /** Armed: the time shift (ticks) and the window (act ticks) it runs with, fixed on the first tick it is known; null before. */
  shift: number | null;
  fromTick: number | null;
  toTick: number | null;
  /** First tick the human was in the duel (logged then), else null. */
  startedTick: number | null;
  /** True while he is in the duel (alive, the target alive and REPLAY, inside the window, at the spot). */
  engaged: boolean;
  /** His hits on the target while in the duel (real `damage` events: D1, his bullets are never blocked). */
  hits: number;
  /** Over for good: the window has passed, or the target or he died. */
  done: boolean;
}

/**
 * The recorded duels of the default human: one per B3 engagement in which he shoots an enemy (cart: Lokier
 * 18.14–18.98 s, sp4rtan 65.55–66.89 s and 68.30–69.27 s). Its weapon and shots are the fire items inside it, its
 * outcome the recorded damage on the target whose aim falls in it, and it answers a scheduled encounter whose recorded
 * hit on him falls in it (Lokier's 73 at 18.50 s).
 */
export function buildDuels(model: RoundModel, plan: ScriptPlan, encounters: readonly EncounterPlan[], tuning: Tuning): DuelPlan[] {
  const human = model.players.find((p) => p.isHumanDefault)?.id ?? null;
  if (human === null) return [];
  const li = tuning.replay.inputLatencyTicks;
  const team = model.player(human).team;
  const out: DuelPlan[] = [];
  for (const e of plan.engagementsOf(human)) {
    if (model.player(e.target).team === team) continue;
    const fire = plan.fireOf(human).filter((f) => f.target === e.target && f.fromTick >= e.fromTick && f.toTick <= e.toTick);
    const first = fire[0];
    if (first === undefined) continue;
    const shots: number[] = [];
    const landed: number[] = [];
    for (const f of fire) {
      for (const k of f.recordedTicks.length > 0 ? f.recordedTicks : f.shotTicks) shots.push(k);
      for (const k of f.shotTicks) landed.push(k);
    }
    shots.sort((a, b) => a - b);
    landed.sort((a, b) => a - b);
    const hits = plan.damage.filter((d) => d.entry.attacker === human && d.entry.victim === e.target && d.entry.tick - li >= e.fromTick && d.entry.tick - li <= e.toTick).map((d) => d.entry);
    const enc = encounters.find((p) => p.shooter === e.target && p.victim === human && p.damage.tick - li >= e.fromTick && p.damage.tick - li <= e.toTick) ?? null;
    const gun = tuning.weapons[first.weapon];
    out.push({
      key: `duel:${out.length}`,
      shooter: human,
      target: e.target,
      weapon: first.weapon,
      aimKey: e.key,
      fireKeys: fire.map((f) => f.key),
      puppetShotTicks: landed,
      fromTick: e.fromTick,
      toTick: e.toTick,
      firstShotTick: shots[0] as number,
      lastShotTick: shots[shots.length - 1] as number,
      spot: enc === null ? canonicalPos(trackPosAt(model, human, Math.floor(((shots[0] as number) + (shots[shots.length - 1] as number)) / 2))) : { x: enc.spot.x, y: enc.spot.y, z: enc.spot.z },
      hits,
      encounter: enc === null ? null : enc.key,
      cycleTicks: gun === undefined ? 2 : tapSpacing(cycleTicksOf(gun)),
    });
  }
  return out;
}

/** A position with its coordinates rounded to 6 decimals (an interpolated track point; plain data for the port). */
function canonicalPos(p: Vec3): Vec3 {
  return { x: roundNumber(p.x), y: roundNumber(p.y), z: roundNumber(p.z) };
}

function initialDuelStates(duels: readonly DuelPlan[]): DuelState[] {
  return duels.map((d) => ({ key: d.key, shift: null, fromTick: null, toTick: null, startedTick: null, engaged: false, hits: 0, done: false }));
}

function pawnOf(o: Observe, id: PlayerId): PawnObs | undefined {
  return o.pawns.find((p) => p.id === id);
}

function modeOf(modes: readonly PawnMode[], id: PlayerId): PawnMode['mode'] | null {
  return modes.find((m) => m.id === id)?.mode ?? null;
}

/** "kill (ak47, head)" / "27 hp (ak47, chest)": a recorded hit, for the log. */
function hitText(h: DamageEntry): string {
  return `${h.lethal ? 'kill' : `${h.amount} hp`} (${h.weapon}, ${h.hitgroup})`;
}

/**
 * The human's recorded duels at run time. ReplayCore calls `step` every step but the setup one, after the divergence
 * triggers and the rejoin (so it sees this tick's modes) and before B3's scheduled actions.
 */
export class HumanDuels {
  readonly duels: readonly DuelPlan[];
  private readonly tuning: Tuning;
  private st: DuelState[];

  constructor(model: RoundModel, plan: ScriptPlan, encounters: readonly EncounterPlan[], tuning: Tuning) {
    this.tuning = tuning;
    this.duels = buildDuels(model, plan, encounters, tuning);
    this.st = initialDuelStates(this.duels);
  }

  get state(): DuelState[] {
    return this.st;
  }

  reset(): void {
    this.st = initialDuelStates(this.duels);
  }

  /**
   * Snapshots from before G5 have none: every duel starts afresh. A snapshot from before D1 (G5's state, with `blocked`,
   * `next`, `dueTick`, …) keeps its window and start; its block, if one was in force, is not restored (D1 sends none).
   */
  restore(s: readonly DuelState[]): void {
    this.st = this.duels.map((d) => {
      const q = s.find((x) => x.key === d.key) as (Partial<DuelState> & { key: string }) | undefined;
      if (q === undefined) return initialDuelStates([d])[0] as DuelState;
      return { key: q.key, shift: q.shift ?? null, fromTick: q.fromTick ?? null, toTick: q.toTick ?? null, startedTick: q.startedTick ?? null, engaged: q.engaged ?? false, hits: q.hits ?? 0, done: q.done ?? false };
    });
  }

  /**
   * True while `attacker` (the human) is in a recorded duel with `victim`, as of the last step: his hits on it are the
   * recorded engagement, so they don't make it LIVE (Divergence's damage trigger asks this; D1).
   */
  engaged(attacker: PlayerId, victim: PlayerId): boolean {
    return this.duels.some((d, i) => d.shooter === attacker && d.target === victim && this.st[i]?.engaged === true);
  }

  /**
   * One tick (not the setup step), every duel in order; appends its logs to `out`. `modes`: every pawn's Core mode
   * after this tick's LIVE switches and rejoins. `encounters` / `states`: the scheduled encounters and their state.
   */
  step(o: Observe, modes: readonly PawnMode[], encounters: readonly EncounterPlan[], states: readonly EncounterState[], out: Action[]): void {
    for (let i = 0; i < this.duels.length; i++) this.duelStep(this.duels[i] as DuelPlan, this.st[i] as DuelState, o, modes, encounters, states, out);
  }

  /**
   * One duel, one tick (D1, John 2026-11-07 13:10: his shots do real damage at once, like CS2, inside recorded duels too):
   * 1. Armed: an encounter-anchored duel once its encounter has seen the human at the spot (its hit's shift; the window
   *    from that sighting to the shifted last press), any other at once on the recorded ticks. Not armed yet: nothing.
   * 2. His hits on the target this observe, while in the duel, are counted. They are the engine's (hitbox, armor,
   *    falloff, penetration, tagging); the Core sends no block and no scripted damage for him.
   * 3. Over when the target or he is dead, or the window has passed: logged with how the target's death compares with
   *    the tape's (a kill before the recorded tick is fine: the target's remaining script is dropped by B3, his
   *    encounter is over, and the divergence rules decide the rest).
   * 4. In the duel: he alive, the target alive and REPLAY, inside the window, within `humanSpotToleranceUnits` of the
   *    duel's spot. Logged the first tick he is in it. While in it his hits on the target don't make it LIVE.
   */
  private duelStep(d: DuelPlan, s: DuelState, o: Observe, modes: readonly PawnMode[], encounters: readonly EncounterPlan[], states: readonly EncounterState[], out: Action[]): void {
    if (s.done) return;
    const tick = o.tick;
    const what = `duel ${d.shooter} -> ${d.target}`;
    if (o.human !== d.shooter) {
      // Nobody plays him (watching: the recording's own shots run), or he was let go of: no duel.
      s.engaged = false;
      return;
    }
    if (s.shift === null && !this.arm(d, s, encounters, states)) return;
    const shift = s.shift as number;
    const from = s.fromTick as number;
    const to = s.toTick as number;
    const r = this.tuning.replay;
    const me = pawnOf(o, d.shooter);
    const target = pawnOf(o, d.target);

    // 2. His hits on the target (real damage).
    if (s.engaged) for (const e of o.events) if (e.type === 'damage' && e.attacker === d.shooter && e.victim === d.target) s.hits++;

    // 3. Over?
    const over =
      me === undefined || !me.alive ? `${d.shooter} is dead` : target === undefined || !target.alive ? this.deathText(d, o, shift) : tick > to + r.inputLatencyTicks ? 'the recorded duel is over' : null;
    if (over !== null) {
      s.done = true;
      s.engaged = false;
      if (s.startedTick !== null) out.push({ type: 'log', level: 'info', text: `${what}: over at tick ${tick}, ${over}; ${s.hits} hit${s.hits === 1 ? '' : 's'} on ${d.target} in it` });
      return;
    }

    // 4. In the duel now?
    s.engaged = me !== undefined && target !== undefined && modeOf(modes, d.target) === 'REPLAY' && tick >= from && tick <= to && dist2(me.pos, d.spot) <= r.humanSpotToleranceUnits;
    if (s.engaged && s.startedTick === null) {
      s.startedTick = tick;
      const tape = d.hits.length === 0 ? 'no damage' : d.hits.map((h) => `${hitText(h)} at tick ${h.tick + shift}`).join(', ');
      out.push({ type: 'log', level: 'info', text: `${what}: in the recorded duel from tick ${tick} (${tenthsText(shift, true)} s against the recording, to tick ${to}); his shots on ${d.target} are real (the tape: ${tape})` });
    }
  }

  /** "lokier is dead (cart's kill, -0.3 s against the tape's kill at tick 1203)", or just "lokier is dead". */
  private deathText(d: DuelPlan, o: Observe, shift: number): string {
    const kill = o.events.find((e) => e.type === 'death' && e.victim === d.target);
    const lethal = d.hits.find((h) => h.lethal);
    if (kill === undefined || kill.type !== 'death' || kill.attacker !== d.shooter) return `${d.target} is dead`;
    if (lethal === undefined) return `${d.target} is dead (${d.shooter}'s kill; not on the tape)`;
    const k = lethal.tick + shift;
    return `${d.target} is dead (${d.shooter}'s kill, ${tenthsText(o.tick - k, true)} s against the tape's kill at tick ${k})`;
  }

  /** Arm the duel if its shift is known now (see duelStep); false while it isn't (or never will be: then it is over). */
  private arm(d: DuelPlan, s: DuelState, encounters: readonly EncounterPlan[], states: readonly EncounterState[]): boolean {
    if (d.encounter === null) {
      s.shift = 0;
      s.fromTick = d.fromTick;
      s.toTick = d.toTick;
      return true;
    }
    const i = encounters.findIndex((e) => e.key === d.encounter);
    const p = encounters[i];
    const e = states[i];
    if (p === undefined || e === undefined) return false;
    if (e.phase === 'done') {
      // Its encounter ended before it saw him at the spot (the shooter LIVE or dead, or he died): no duel.
      s.done = true;
      return false;
    }
    if (e.seenTick === null || e.shotTick === null) return false;
    s.shift = e.shotTick - p.damage.tick;
    s.fromTick = e.seenTick;
    s.toTick = d.toTick + s.shift;
    return true;
  }
}
