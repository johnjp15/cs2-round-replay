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
import { cycleTicksOf, tapSpacing, type PawnMode, type ScriptPlan, type ScriptedEvents } from './scripted';

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
  /** True while the duel's `block_damage shooter → target` is in force. */
  blocked: boolean;
  /** The next recorded hit to land (an index into `hits`). */
  next: number;
  /** Observe tick the next recorded hit lands on (scheduled), else null. */
  dueTick: number | null;
  /** His last would-hit shot on the target (a `blocked_hit`) in the recorded spray before the next hit, else null. */
  aimedTick: number | null;
  /** His last shot (any `shot` event) while in the duel, else null. */
  lastShotTick: number | null;
  /** His would-hit shots on the target reported while blocked (the `blocked_hit` events). */
  shots: number;
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
  return duels.map((d) => ({ key: d.key, shift: null, fromTick: null, toTick: null, startedTick: null, blocked: false, next: 0, dueTick: null, aimedTick: null, lastShotTick: null, shots: 0, done: false }));
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

  /** Snapshots from before G5 have none: every duel starts afresh. */
  restore(s: readonly DuelState[]): void {
    this.st = this.duels.map((d) => {
      const q = s.find((x) => x.key === d.key);
      if (q === undefined) return initialDuelStates([d])[0] as DuelState;
      return { key: q.key, shift: q.shift, fromTick: q.fromTick, toTick: q.toTick, startedTick: q.startedTick, blocked: q.blocked, next: q.next, dueTick: q.dueTick, aimedTick: q.aimedTick, lastShotTick: q.lastShotTick, shots: q.shots, done: q.done };
    });
  }

  /** The duel blocks in force (shooter → target), for a resync rewind (they are re-sent with B3's). */
  standingBlocks(): { attacker: PlayerId; victim: PlayerId }[] {
    const out: { attacker: PlayerId; victim: PlayerId }[] = [];
    this.duels.forEach((d, i) => {
      if (this.st[i]?.blocked === true) out.push({ attacker: d.shooter, victim: d.target });
    });
    return out;
  }

  /**
   * One tick (not the setup step), every duel in order; appends its actions to `out`. `modes`: every pawn's Core mode
   * after this tick's LIVE switches and rejoins. `encounters` / `states`: the scheduled encounters and their state.
   */
  step(o: Observe, modes: readonly PawnMode[], encounters: readonly EncounterPlan[], states: readonly EncounterState[], script: ScriptedEvents, out: Action[]): void {
    for (let i = 0; i < this.duels.length; i++) this.duelStep(this.duels[i] as DuelPlan, this.st[i] as DuelState, o, modes, encounters, states, script, out);
  }

  /**
   * One duel, one tick:
   * 1. Armed: an encounter-anchored duel once its encounter has seen the human at the spot (its hit's shift; the window
   *    from that sighting to the shifted last press), any other at once on the recorded ticks. Not armed yet: nothing.
   * 2. His shots this observe, while the block was in force: every `shot` of his, and every `blocked_hit` on the target
   *    (a shot that would have hit). The next recorded hit, at its shifted tick K, lands
   *    - on K, if his spray is on the target through it: at act K − action latency he has had a would-hit shot since
   *      the recorded spray's first shot (shifted, less one fire cycle) and is still firing (a shot within one cycle
   *      before K). The tape's spray at Lokier: 18.517–19.0 s, the kill at 18.80 s, its 4th shot; tape-like play lands
   *      the kill on 18.80 s although the engine's cadence puts that shot a tick later;
   *    - else one action latency after his first would-hit shot reported after that act (he fired late);
   *    and never before K: his shots before it miss, so the target's recorded hit on him lands first. A shot that would
   *    hit but leaves him firing too short of K is a miss, as on the tape. Without hits (sp4rtan) his shots just do
   *    nothing.
   * 3. A scheduled hit is sent `actionLatencyTicks` before its tick (B3's damage rules: dropped if he or the target is
   *    dead or the target LIVE then; a non-lethal hit stays non-lethal).
   * 4. Over when the target or he is dead, or the window (and its last report) has passed with nothing due.
   * 5. The block is in force while he is in the duel: alive, the target alive and REPLAY, inside the window, within
   *    `humanSpotToleranceUnits` of the duel's spot, or a hit is due. Logged the first tick he is in it, and when it is
   *    over.
   */
  private duelStep(d: DuelPlan, s: DuelState, o: Observe, modes: readonly PawnMode[], encounters: readonly EncounterPlan[], states: readonly EncounterState[], script: ScriptedEvents, out: Action[]): void {
    if (s.done) return;
    const tick = o.tick;
    const what = `duel ${d.shooter} -> ${d.target}`;
    if (o.human !== d.shooter) {
      // Nobody plays him (watching: the recording's own shots run), or he was let go of: no duel, no block.
      if (s.blocked) this.unblock(d, s, out);
      return;
    }
    if (s.shift === null && !this.arm(d, s, o.tick, encounters, states, script)) return;
    const shift = s.shift as number;
    const from = s.fromTick as number;
    const to = s.toTick as number;
    const r = this.tuning.replay;
    const la = r.actionLatencyTicks;
    const li = r.inputLatencyTicks;
    const me = pawnOf(o, d.shooter);
    const target = pawnOf(o, d.target);

    // 2. His shots this observe (while blocked: in the duel), and the next recorded hit.
    const h0 = d.hits[s.next];
    const k0 = h0 === undefined ? null : h0.tick + shift;
    if (s.blocked) {
      for (const e of o.events) {
        if (e.type === 'shot' && e.shooter === d.shooter) s.lastShotTick = tick;
        if (e.type !== 'blocked_hit' || e.attacker !== d.shooter || e.victim !== d.target) continue;
        s.shots++;
        if (h0 === undefined || k0 === null || s.dueTick !== null || tick < d.firstShotTick + shift - d.cycleTicks) continue;
        if (tick <= k0 - la) {
          s.aimedTick = tick;
          continue;
        }
        // Too late to land on K: one action latency after this shot.
        s.dueTick = tick + la;
        out.push({ type: 'log', level: 'info', text: `${what}: his shot at tick ${tick} would hit (${e.hitgroup}): the recorded ${hitText(h0)} lands at tick ${s.dueTick} (recorded ${h0.tick})` });
      }
      if (h0 !== undefined && k0 !== null && s.dueTick === null && tick === k0 - la && s.aimedTick !== null && s.lastShotTick !== null && s.lastShotTick >= k0 - d.cycleTicks) {
        s.dueTick = k0;
        out.push({
          type: 'log',
          level: 'info',
          text: `${what}: his spray is on ${d.target} through the recorded ${hitText(h0)} (on target at tick ${s.aimedTick}, still firing at tick ${s.lastShotTick}): it lands at tick ${k0} (recorded ${h0.tick})`,
        });
      }
    }

    // 3. A scheduled hit, one action latency before its tick.
    if (s.dueTick !== null && tick >= s.dueTick - la) {
      const h = d.hits[s.next] as DamageEntry;
      const due = s.dueTick;
      s.dueTick = null;
      s.aimedTick = null;
      s.next++;
      const why = me === undefined || !me.alive ? `${d.shooter} is dead` : target === undefined || !target.alive ? `${d.target} is dead` : modeOf(modes, d.target) === 'LIVE' ? `${d.target} is LIVE` : null;
      const hp = target?.hp ?? 0;
      const amount = h.lethal || h.amount < hp ? h.amount : hp - 1;
      if (why === null && amount > 0) {
        out.push({ type: 'damage', attacker: d.shooter, victim: d.target, amount, armor: h.armor ?? 0, hitgroup: h.hitgroup, weapon: h.weapon, lethal: h.lethal });
      } else {
        out.push({ type: 'log', level: 'info', text: `${what}: dropped the recorded ${hitText(h)} due at tick ${due}: ${why ?? `${d.target} has ${hp} hp`}` });
      }
    }

    // 4. Over?
    const over =
      me === undefined || !me.alive ? `${d.shooter} is dead` : target === undefined || !target.alive ? `${d.target} is dead` : tick > to + li && s.dueTick === null ? 'the recorded duel is over' : null;
    if (over !== null) {
      s.done = true;
      if (s.blocked) this.unblock(d, s, out);
      if (s.startedTick !== null) out.push({ type: 'log', level: 'info', text: `${what}: over at tick ${tick}, ${over}; ${s.shots} would-hit shot${s.shots === 1 ? '' : 's'} blocked` });
      return;
    }

    // 5. In the duel now?
    const inDuel =
      me !== undefined && target !== undefined && modeOf(modes, d.target) === 'REPLAY' && ((tick >= from && tick <= to && dist2(me.pos, d.spot) <= r.humanSpotToleranceUnits) || s.dueTick !== null);
    if (inDuel && s.startedTick === null) {
      s.startedTick = tick;
      const outcome = d.hits.length === 0 ? 'no damage' : d.hits.map((h) => `${hitText(h)} at tick ${h.tick + shift}`).join(', ');
      out.push({ type: 'log', level: 'info', text: `${what}: in the recorded duel from tick ${tick} (${tenthsText(shift, true)} s against the recording, to tick ${to}); his shots on ${d.target} land as recorded: ${outcome}` });
    }
    if (inDuel && !s.blocked) {
      out.push({ type: 'block_damage', attacker: d.shooter, victim: d.target });
      s.blocked = true;
    } else if (!inDuel && s.blocked) {
      this.unblock(d, s, out);
    }
  }

  /**
   * Arm the duel if its shift is known now (see duelStep); false while it isn't (or never will be: then it is over). A
   * takeover in the middle of the recorded spray (G4): the puppet's shots of it that went ahead (B3 decided the fire
   * item while nobody played him, and aims it at the target) and landed before this tick start his spray, so a player
   * who takes over at 18.6 s and keeps firing continues the tape's spray.
   */
  private arm(d: DuelPlan, s: DuelState, tick: number, encounters: readonly EncounterPlan[], states: readonly EncounterState[], script: ScriptedEvents): boolean {
    if (d.encounter === null) {
      s.shift = 0;
      s.fromTick = d.fromTick;
      s.toTick = d.toTick;
    } else {
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
    }
    if (d.fireKeys.some((k) => script.decision(k) === true)) {
      for (const k of d.puppetShotTicks) {
        if (k >= tick || k < d.firstShotTick + s.shift - d.cycleTicks) continue;
        s.aimedTick = k;
        s.lastShotTick = k;
      }
    }
    return true;
  }

  private unblock(d: DuelPlan, s: DuelState, out: Action[]): void {
    out.push({ type: 'unblock_damage', attacker: d.shooter, victim: d.target });
    s.blocked = false;
  }
}
