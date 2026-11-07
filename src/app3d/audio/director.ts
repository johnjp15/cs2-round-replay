/**
 * A1: what the game sounds like, tick by tick (pure: no Web Audio; tested in Node with a fake sink). The app feeds
 * every observed tick (events, the 3D bullets, the grenade effects); the director turns them into sound cues from
 * the table (events.ts) on a `SoundSink` (engine.ts in the browser):
 *
 *  - `shot` → `fire.<gun>` at the shooter (+ the AWP / SSG 08 bolt after the shot); `sound reload` → the reload
 *    stages at their fractions of the reload time the weapon state machine reports (`reloadSec`);
 *  - `sound footstep` / `land` → `step.<team>.<surface>` / `land.<surface>`; `sound bomb` → the planted C4's beep
 *    (the host times the beeps, so the ramp is CS2's); `sound grenade` → the pop of the grenade that was nearest;
 *  - `damage` / `death` → flesh, Kevlar, headshot (the helmet dink when armor took part), the attacker's feedback
 *    and kill confirm in the listener's head, the victim's own hit sounds when the listener is the victim;
 *  - `bomb` → plant, defuse start, defused, explosion, the announcer; `round_end` → the round-end music by side;
 *  - bullets (`Sim3DHost.shots()`): world impacts where a wall stopped one, the whiz when one passed the listener;
 *  - grenade effects: throw when one appears, bounce when a flying one turns from falling to rising, the molotov's
 *    burn loop while its fire lasts; weapon changes: the draw sound.
 *
 * Seeks and rewinds (the tick jumping) reset the state without sounding anything and stop the loops.
 *
 * A2: every cue carries its tick (the engine schedules it at that tick's audio time) and its source pawn (CS2's
 * per-entity instance limits); cues silent by construction (the competitive round-start music, `snd_roundstart_volume
 * 0`) aren't sent; the planted C4 beeps on CS2's accelerating cadence from the plant (`c4BeepTicks`), switching to
 * `C4.PlantSound_10sec` for the last 10 s, instead of the host's fixed 1 s / 0.5 s beeps (which stay as the AI's
 * "heard the bomb" event); every cue is counted by tick (`log`) for the checks.
 */
import type { ObsEvent, Observe, PawnObs, PlayerId, Team, Vec3 } from '../../contracts/index';
import type { Effect } from '../../app/effects';
import { GUN_SOUNDS, RELOAD_STAGES, RELOAD_STAGE_IDS, SOUNDS, grenadeOf, gunOf, type Surface } from './events';
import { closestApproach } from './spatial';
import { AUDIO_TUNING } from './tuning';

const TICKS_PER_SEC = 64;

/** Where the director sends its cues. `origin`: pos is a pawn's origin (the event's `position_offset` applies). */
export interface SoundSink {
  play(id: string, pos: Vec3 | null, opts: CueOptions): void;
  loop(key: string, id: string, pos: Vec3): void;
  stopLoop(key: string): void;
  stopAll(): void;
}

export interface CueOptions {
  /** The listener's own pawn made it: played in the head, at the curve's nearest point. */
  readonly self?: boolean;
  /** The tick it belongs to (absent: play now). */
  readonly tick?: number;
  /** The pawn that made it (CS2's instance_limit is per entity). */
  readonly source?: string;
  readonly origin?: boolean;
  /** Extra gain (music cvars). */
  readonly gain?: number;
}

export interface Bullet {
  readonly shooter: PlayerId;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly victim: PlayerId | null;
  readonly wall: boolean;
}

export interface DirectorInput {
  readonly observe: Observe;
  readonly bullets: readonly Bullet[];
  readonly effects: readonly Effect[];
  /** Whose ears: the first-person / followed pawn, or null (free camera). */
  readonly listener: PlayerId | null;
  /** The listener's ear (the camera), Source units. */
  readonly ear: Vec3;
  /** Seconds the current reload of `id` lasts (the weapon state machine), or null if it isn't reloading. */
  readonly reloadSec: (id: PlayerId) => number | null;
  /** Seconds between shots of a gun (the bolt after an AWP shot). */
  readonly cycleSec: (weapon: string) => number;
}

interface Pending {
  readonly tick: number;
  readonly id: string;
  readonly pawn: PlayerId;
}

interface Tracked {
  readonly kind: string;
  readonly thrower: PlayerId;
  readonly phase: Effect['phase'];
  readonly pos: Vec3;
  readonly vz: number;
}

/** Played cues (tests, the browser check): the last 64. */
export interface CueRecord {
  readonly tick: number;
  readonly id: string;
}

/**
 * The ticks the planted C4 beeps on (plant at `plantTick`, explodes `timerSec` later) and whether each is in the last
 * 10 s. Cadence: the next beep after max(0.15, 0.1 + 0.9 × left / timer) s, so 1 s apart at the plant down to 0.15 s
 * at the end: CS:GO's planted-C4 think, which CS2 kept by ear (**assumed**: CS2's code isn't public). The last 10 s
 * play `C4.PlantSound_10sec` (CS2's sound event; "New sound for final 10 seconds of bomb beeping", CS2 update of
 * 2023-10-17).
 */
export function c4BeepTicks(plantTick: number, timerSec: number): { tick: number; last10: boolean }[] {
  const out: { tick: number; last10: boolean }[] = [];
  const end = plantTick + timerSec * TICKS_PER_SEC;
  let t = plantTick / TICKS_PER_SEC;
  for (;;) {
    const left = end / TICKS_PER_SEC - t;
    t += Math.max(0.15, 0.1 + 0.9 * Math.max(0, left) / timerSec);
    const tick = Math.round(t * TICKS_PER_SEC);
    if (tick >= end) break;
    out.push({ tick, last10: end - tick <= 10 * TICKS_PER_SEC });
  }
  return out;
}

export class SoundDirector {
  private lastTick: number | null = null;
  private weapons = new Map<PlayerId, string>();
  private tracked = new Map<number, Tracked>();
  private pending: Pending[] = [];
  private loops = new Set<string>();
  readonly recent: CueRecord[] = [];
  /** Cues played since the start (stats). */
  played = 0;
  private tickNow = 0;
  private ricochet = 0;
  /** The planted bomb's beeps (its plant tick and the schedule), or null. */
  private beeps: { plant: number; list: { tick: number; last10: boolean }[]; next: number } | null = null;
  /** Every cue by tick since the last reset, up to 20,000 (the checks count shots and steps in a window). */
  readonly log: CueRecord[] = [];

  constructor(
    private readonly sink: SoundSink,
    /** Footstep surface under a position (Mirage's mesh has no materials: concrete everywhere until X1's 2020 map). */
    private readonly surfaceAt: (pos: Vec3) => Surface = () => 'concrete',
    /** The bomb timer (data/tuning.json bomb.timerSec, CS2's mp_c4timer 40). */
    private readonly bombTimerSec = 40,
  ) {}

  /** Forget everything (seek, rewind, restart): no sound, loops stopped. */
  reset(): void {
    this.lastTick = null;
    this.weapons.clear();
    this.tracked.clear();
    this.pending = [];
    this.beeps = null;
    this.log.length = 0;
    for (const k of this.loops) this.sink.stopLoop(k);
    this.loops.clear();
    this.sink.stopAll();
  }

  /** A cue of the current tick (`now`: the human's input, played at once). */
  private cue(id: string, pos: Vec3 | null, opts: CueOptions = {}, now = false): void {
    if (SOUNDS[id] === undefined) return;
    // Silent by construction (a cvar at 0, e.g. snd_roundstart_volume 0): nothing to play.
    if (opts.gain !== undefined && opts.gain <= 0) return;
    this.sink.play(id, pos, now ? opts : { ...opts, tick: this.tickNow });
    this.played++;
    const rec = { tick: this.tickNow, id };
    this.recent.push(rec);
    if (this.recent.length > 64) this.recent.shift();
    if (this.log.length < 20000) this.log.push(rec);
  }

  private pawnCue(id: string, p: PawnObs, listener: PlayerId | null): void {
    this.cue(id, p.pos, { origin: true, self: p.id === listener, source: p.id });
  }

  ingest(inp: DirectorInput): void {
    const o = inp.observe;
    const tick = o.tick;
    // A jump in time (seek, rewind, restart): resync silently.
    if (this.lastTick !== null && (tick <= this.lastTick || tick > this.lastTick + 8)) this.reset();
    const fresh = this.lastTick === null;
    this.lastTick = tick;
    this.tickNow = tick;
    const pawns = new Map<PlayerId, PawnObs>();
    for (const p of o.pawns) pawns.set(p.id, p);
    if (fresh) {
      // The first tick after a start, seek or rewind: its own events are new (the ticks skipped over were never fed
      // here, so nothing is replayed); the state (weapons, grenades in flight, the bomb's beeps) is taken as it is.
      for (const p of o.pawns) this.weapons.set(p.id, p.weapon);
      this.trackEffects(inp, false);
      if (tick <= 1) this.cue('round.start', null, { gain: AUDIO_TUNING.music.roundStart });
      for (const e of o.events) this.event(e, pawns, inp);
      this.bullets(inp, pawns);
      this.bomb(o);
      return;
    }
    // Scheduled stages (reloads, bolts) that are due.
    if (this.pending.length > 0) {
      const due = this.pending.filter((q) => q.tick <= tick);
      this.pending = this.pending.filter((q) => q.tick > tick);
      for (const q of due) {
        const p = pawns.get(q.pawn);
        if (p !== undefined && p.alive) this.pawnCue(q.id, p, inp.listener);
      }
    }
    // Weapon changes: the draw sound (a reload in progress is cancelled by the switch).
    for (const p of o.pawns) {
      const was = this.weapons.get(p.id);
      if (was !== undefined && was !== p.weapon && p.alive) {
        this.pending = this.pending.filter((q) => q.pawn !== p.id);
        this.pawnCue(`draw.${p.weapon}`, p, inp.listener);
      }
      this.weapons.set(p.id, p.weapon);
    }
    for (const e of o.events) this.event(e, pawns, inp);
    this.bullets(inp, pawns);
    this.trackEffects(inp, true);
    this.bomb(o);
  }

  /** The planted C4's beeps on CS2's cadence (also after a seek into a planted round). */
  private bomb(o: Observe): void {
    const b = o.round.bomb;
    if (b.state !== 'planted' || b.plantTick === null || b.pos === null) {
      this.beeps = null;
      return;
    }
    if (this.beeps === null || this.beeps.plant !== b.plantTick) {
      const list = c4BeepTicks(b.plantTick, this.bombTimerSec);
      let next = 0;
      while (next < list.length && (list[next] as { tick: number }).tick < o.tick) next++;
      this.beeps = { plant: b.plantTick, list, next };
    }
    const bp = this.beeps;
    while (bp.next < bp.list.length && (bp.list[bp.next] as { tick: number }).tick <= o.tick) {
      const e = bp.list[bp.next] as { tick: number; last10: boolean };
      bp.next++;
      if (e.tick === o.tick) this.cue(e.last10 ? 'c4.beep.10s' : 'c4.beep', b.pos);
    }
  }

  private event(e: ObsEvent, pawns: Map<PlayerId, PawnObs>, inp: DirectorInput): void {
    const L = inp.listener;
    const team: Team | null = L === null ? null : (pawns.get(L)?.team ?? null);
    switch (e.type) {
      case 'shot': {
        const p = pawns.get(e.shooter);
        const gun = gunOf(e.weapon);
        if (p === undefined || gun === null) return;
        this.pawnCue(`fire.${gun}`, p, L);
        const bolt = GUN_SOUNDS[gun].boltAfterShot;
        if (bolt !== undefined) {
          const c = inp.cycleSec(e.weapon) * TICKS_PER_SEC;
          this.pending.push({ tick: this.tickNow + Math.round(c * 0.38), id: `cycle.${gun}.back`, pawn: p.id }, { tick: this.tickNow + Math.round(c * 0.6), id: `cycle.${gun}.forward`, pawn: p.id });
        }
        return;
      }
      case 'sound': {
        const p = e.source === null ? undefined : pawns.get(e.source);
        switch (e.kind) {
          case 'footstep':
            if (p !== undefined) this.pawnCue(`step.${p.team}.${this.surfaceAt(e.pos)}`, p, L);
            return;
          case 'land':
            if (p !== undefined) this.pawnCue(`land.${this.surfaceAt(e.pos)}`, p, L);
            return;
          case 'bomb':
            // The host's beep (fixed 1 s / 0.5 s, the AI hears it): the sound is CS2's cadence in bomb().
            return;
          case 'reload': {
            const gun = p === undefined ? null : gunOf(p.weapon);
            if (p === undefined || gun === null) return;
            const sec = inp.reloadSec(p.id);
            if (sec === null || sec <= 0) return;
            const fr = RELOAD_STAGES[gun];
            for (const st of RELOAD_STAGE_IDS) {
              const f = fr[st];
              if (f !== undefined && GUN_SOUNDS[gun].stages[st] !== undefined) this.pending.push({ tick: this.tickNow - 1 + Math.max(1, Math.round(f * sec * TICKS_PER_SEC)), id: `reload.${gun}.${st}`, pawn: p.id });
            }
            return;
          }
          case 'grenade': {
            // The pop of the flying grenade nearest to where it went off.
            let best: Tracked | null = null;
            let bd = Infinity;
            for (const t of this.tracked.values()) {
              if (t.phase !== 'flying') continue;
              const d = Math.hypot(t.pos.x - e.pos.x, t.pos.y - e.pos.y, t.pos.z - e.pos.z);
              if (d < bd) {
                bd = d;
                best = t;
              }
            }
            const kind = best === null ? null : grenadeOf(best.kind);
            if (kind !== null) this.cue(`pop.${kind === 'incgrenade' ? 'molotov' : kind}`, e.pos);
            return;
          }
          case 'shot':
            return;
        }
        return;
      }
      case 'damage': {
        const v = pawns.get(e.victim);
        if (v === undefined) return;
        const bullet = e.weapon !== null && (gunOf(e.weapon) !== null || e.weapon === 'knife');
        if (!bullet) return;
        if (e.weapon === 'knife') {
          this.cue('knife.hit', v.pos, { origin: true });
          return;
        }
        const head = e.hitgroup === 'head';
        const armored = e.armor > 0;
        if (e.victim === L) this.cue(head ? (armored ? 'victim.head.helmet' : 'victim.head') : 'victim.body', null);
        else this.cue(head ? (armored ? 'hit.head.helmet' : 'hit.head') : armored ? 'hit.armor' : 'hit.flesh', { x: v.pos.x, y: v.pos.y, z: v.pos.z + (head ? 62 : 40) });
        if (e.attacker === L && e.attacker !== null && head && !(e.victim === L)) this.cue(armored ? 'feedback.head.helmet' : 'feedback.head', null);
        return;
      }
      case 'death': {
        const v = pawns.get(e.victim);
        if (e.victim === L) this.cue('death.self', null);
        else if (v !== undefined) this.cue(e.headshot ? 'death.head' : 'death', v.pos, { origin: true });
        if (e.attacker !== null && e.attacker === L && e.victim !== L) this.cue(e.headshot ? 'kill.feedback.head' : 'kill.feedback', null);
        return;
      }
      case 'bomb': {
        const pos = e.pos;
        switch (e.phase) {
          case 'planted':
            if (pos !== null) this.cue('c4.plant', pos);
            this.cue('announce.planted', null, { gain: AUDIO_TUNING.music.announcer });
            this.cue('music.bomb', null, { gain: AUDIO_TUNING.music.mapObjective });
            return;
          case 'defuse_start':
            if (pos !== null) this.cue('c4.defuse.start', pos);
            return;
          case 'defused':
            if (pos !== null) this.cue('c4.defused', pos);
            this.cue('announce.defused', null, { gain: AUDIO_TUNING.music.announcer });
            return;
          case 'exploded':
            if (pos !== null) this.cue('c4.explode', pos);
            return;
          case 'defuse_stop':
            return;
        }
        return;
      }
      case 'round_end': {
        const won = team === null ? true : team === e.winner;
        this.cue(won ? 'round.won' : 'round.lost', null, { gain: AUDIO_TUNING.music.roundEnd });
        this.cue(e.winner === 'CT' ? 'announce.ctwin' : 'announce.twin', null, { gain: AUDIO_TUNING.music.announcer });
        return;
      }
      case 'blocked_hit':
        return;
    }
  }

  private bullets(inp: DirectorInput, pawns: Map<PlayerId, PawnObs>): void {
    for (const b of inp.bullets) {
      if (b.victim === null && b.wall) {
        this.cue('impact.concrete', b.to);
        // Every fourth wall hit also ricochets (deterministic; CS2 picks at random).
        if (++this.ricochet % 4 === 0) this.cue('ricochet', b.to);
      }
      if (b.shooter !== inp.listener && pawns.get(b.shooter) !== undefined) {
        const c = closestApproach(b.from, b.to, inp.ear);
        if (c !== null && c.distance <= AUDIO_TUNING.whizRange) {
          this.cue('whiz', { x: b.from.x + (b.to.x - b.from.x) * c.t, y: b.from.y + (b.to.y - b.from.y) * c.t, z: b.from.z + (b.to.z - b.from.z) * c.t });
        }
      }
    }
  }

  private trackEffects(inp: DirectorInput, sound: boolean): void {
    const seen = new Set<number>();
    const pawns = inp.observe.pawns;
    for (const e of inp.effects) {
      seen.add(e.seq);
      const prev = this.tracked.get(e.seq);
      const kind = grenadeOf(e.kind);
      const vz = prev === undefined ? 0 : (e.pos.z - prev.pos.z) * TICKS_PER_SEC;
      if (sound && kind !== null) {
        if (prev === undefined && e.phase === 'flying') {
          const thrower = pawns.find((p) => p.id === e.thrower);
          this.cue(`throw.${kind}`, thrower !== undefined ? thrower.pos : e.pos, { origin: thrower !== undefined, self: e.thrower === inp.listener });
        } else if (prev !== undefined && prev.phase === 'flying' && e.phase === 'flying' && prev.vz < -AUDIO_TUNING.bounceMinSpeed && vz > AUDIO_TUNING.bounceMinSpeed) {
          this.cue(`bounce.${kind}`, e.pos);
        }
        if (e.phase === 'fire' && (prev === undefined || prev.phase !== 'fire')) {
          const key = `burn.${e.seq}`;
          this.sink.loop(key, 'burn.molotov', e.pos);
          this.loops.add(key);
        }
      }
      this.tracked.set(e.seq, { kind: e.kind, thrower: e.thrower, phase: e.phase, pos: e.pos, vz });
    }
    for (const [seq, t] of [...this.tracked]) {
      if (seen.has(seq)) continue;
      this.tracked.delete(seq);
      const key = `burn.${seq}`;
      if (this.loops.has(key)) {
        this.sink.stopLoop(key);
        this.loops.delete(key);
        if (sound && t.phase === 'fire') this.cue('out.molotov', t.pos);
      }
    }
  }

  /** The human's own actions the host has no event for (local cues). */
  human(kind: 'dry' | 'knife' | 'zoomIn' | 'zoomOut' | 'pin' | 'plantStart' | 'keypress', weapon: string, pos: Vec3): void {
    const gun = gunOf(weapon);
    switch (kind) {
      case 'dry':
        if (gun !== null) this.cue(GUN_SOUNDS[gun].pistol ? 'dry.pistol' : 'dry.rifle', null, {}, true);
        return;
      case 'knife':
        this.cue('knife.swing', pos, { origin: true, self: true }, true);
        return;
      case 'zoomIn':
      case 'zoomOut':
        if (gun !== null) this.cue(`zoom.${gun}.${kind === 'zoomIn' ? 'in' : 'out'}`, null, {}, true);
        return;
      case 'pin': {
        const g = grenadeOf(weapon);
        if (g !== null) this.cue(`pin.${g}`, pos, { origin: true, self: true }, true);
        return;
      }
      case 'plantStart':
        this.cue('c4.initiate', pos, { origin: true, self: true }, true);
        return;
      case 'keypress':
        this.cue('c4.keypress', pos, { origin: true, self: true }, true);
        return;
    }
  }
}
