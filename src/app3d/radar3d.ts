/**
 * U1: what the radar shows, as CS2 does (pure; tests/app3d-radar.test.ts; docs/app3d.md "Radar").
 *
 * The rules are CS:GO's radar and spotting code, which CS2 still follows on screen (the same "?" last-seen marker
 * and fading X): **[RADAR]** `game/client/cstrike15/Scaleform/HUD/sfhudradar.cpp`, **[SPOT]**
 * `game/server/cstrike15/cs_entity_spotting.cpp`, `cs_player.cpp`, `weapon_c4.cpp` of the CS:GO source as mirrored
 * in SwagSoftware/Kisak-Strike (commit 4c2fdc31, read 2026-11-07). CS2's own radar code is not public, so the
 * timings are unverified for CS2 and kept as the tunables below.
 *
 * - Teammates are always on the radar (a player's spot rules are SPOT_RULE_ENEMY | SPOT_RULE_ALWAYS_SEEN_BY_FRIEND:
 *   [SPOT] cs_player.cpp).
 * - An enemy is "spotted" while any alive player of the viewer's team sees it (the viewer included: `sees`, which
 *   has the FOV, walls and smoke). The server re-evaluates spotting every ENTITY_SPOT_FREQUENCY = 0.5 s ([SPOT]), so
 *   a dot appears up to 0.5 s late and lingers up to 0.5 s after the last sight. While spotted, the dot follows the
 *   enemy.
 * - When the spot is lost, the dot becomes the ghost icon (the "?") at the last spotted position and fades out
 *   linearly over GHOST_FADE_TIME = 6 s ([RADAR] SetupIconsFromStates).
 * - A dead player is an X at the death position fading over DEAD_FADE_TIME = 4 s, for an enemy only if it was
 *   spotted when it died ([RADAR]: dead icons need m_bIsSpotted).
 * - The C4: Terrorists always see it, CTs only when spotted (SPOT_RULE_CT | SPOT_RULE_ALWAYS_SEEN_BY_T, [SPOT]
 *   weapon_c4.cpp); a carrier's dot carries the bomb icon wherever the carrier is on the radar ([RADAR]
 *   m_bBombIsSpotted from HasC4). The planted bomb is shown to everyone here (PLANTED_BOMB_FOR_ALL, the brief;
 *   CS:GO's rule would need a CT to spot it). A dropped bomb is shown to Ts only (the sim has no bomb spotting).
 *
 * Times are round ticks (64 per second), so a paused round pauses the fades and the result is deterministic.
 */
import type { Observe, PlayerId, Team, Vec3 } from '../contracts/index';

/** Spotting is re-evaluated this often (s): [SPOT] ENTITY_SPOT_FREQUENCY 0.5f. */
export const SPOT_INTERVAL_S = 0.5;
/** The "?" ghost fades out over this long (s): [RADAR] GHOST_FADE_TIME 6.0f. */
export const GHOST_FADE_S = 6;
/** A dead player's X fades out over this long (s): [RADAR] DEAD_FADE_TIME 4.0f. */
export const DEAD_FADE_S = 4;
/** The planted bomb is on everyone's radar (the brief; CS:GO needs a CT to spot it). */
export const PLANTED_BOMB_FOR_ALL = true;

const TICK_RATE = 64;
const SPOT_TICKS = Math.round(SPOT_INTERVAL_S * TICK_RATE);
const GHOST_TICKS = GHOST_FADE_S * TICK_RATE;
const DEAD_TICKS = DEAD_FADE_S * TICK_RATE;

export type RadarRules = 'cs2' | 'all';

export interface RadarMark {
  readonly id: PlayerId;
  readonly team: Team;
  readonly x: number;
  readonly y: number;
  /** dot: on the radar now; ghost: the "?" at the last spotted position; dead: the X. */
  readonly kind: 'dot' | 'ghost' | 'dead';
  /** 0..1 (the fades). */
  readonly alpha: number;
  /** Carries the C4 (the bomb icon on the dot). */
  readonly bomb: boolean;
}

export interface RadarBomb {
  readonly x: number;
  readonly y: number;
  readonly state: 'dropped' | 'planted' | 'defused' | 'exploded';
}

interface EnemyState {
  spotted: boolean;
  pos: Vec3;
  /** Tick the spot was lost (the ghost's start), or null. */
  lostTick: number | null;
  /** Death tick and whether it was spotted then (null: alive). */
  deadTick: number | null;
  deadSeen: boolean;
}

/** One team's view of the other team: which enemies are spotted, where the ghosts are. */
class TeamSpotting {
  readonly team: Team;
  private readonly enemies = new Map<PlayerId, EnemyState>();
  private lastBucket = -1;

  constructor(team: Team) {
    this.team = team;
  }

  reset(): void {
    this.enemies.clear();
    this.lastBucket = -1;
  }

  ingest(o: Observe): void {
    const bucket = Math.floor(o.tick / SPOT_TICKS);
    const evaluate = bucket !== this.lastBucket;
    this.lastBucket = bucket;
    let seen: Set<PlayerId> | null = null;
    if (evaluate) {
      seen = new Set();
      for (const p of o.pawns) if (p.team === this.team && p.alive) for (const s of p.sees) seen.add(s);
    }
    for (const p of o.pawns) {
      if (p.team === this.team) continue;
      let e = this.enemies.get(p.id);
      if (e === undefined) {
        e = { spotted: false, pos: p.pos, lostTick: null, deadTick: p.alive ? null : o.tick - DEAD_TICKS, deadSeen: false };
        this.enemies.set(p.id, e);
      }
      if (!p.alive) {
        if (e.deadTick === null) {
          e.deadTick = o.tick;
          e.deadSeen = e.spotted;
          if (e.spotted) e.pos = p.pos;
          e.spotted = false;
        }
        continue;
      }
      e.deadTick = null;
      if (seen !== null) {
        const now = seen.has(p.id);
        if (e.spotted && !now) e.lostTick = o.tick;
        if (now) e.lostTick = null;
        e.spotted = now;
      }
      if (e.spotted) e.pos = p.pos;
    }
  }

  state(id: PlayerId): EnemyState | undefined {
    return this.enemies.get(id);
  }
}

/** Both teams' spotting, fed every tick (RadarTracker.ingest), read by the HUD (marks). */
export class RadarTracker {
  private readonly teams: Record<Team, TeamSpotting> = { T: new TeamSpotting('T'), CT: new TeamSpotting('CT') };
  /** Death tick of every pawn (teammates' X fade). */
  private readonly deaths = new Map<PlayerId, number>();

  /** Start over at this state (restart, seek): nothing spotted yet, so no ghosts. */
  reset(o: Observe): void {
    this.teams.T.reset();
    this.teams.CT.reset();
    this.deaths.clear();
    for (const p of o.pawns) if (!p.alive) this.deaths.set(p.id, o.tick - DEAD_TICKS);
    this.ingest(o);
  }

  /** One tick's state (call for every tick, in order). */
  ingest(o: Observe): void {
    for (const p of o.pawns) {
      if (p.alive) this.deaths.delete(p.id);
      else if (!this.deaths.has(p.id)) this.deaths.set(p.id, o.tick);
    }
    this.teams.T.ingest(o);
    this.teams.CT.ingest(o);
  }

  /** Whether `id` is spotted by `team` now (teammates always are). */
  spotted(team: Team, id: PlayerId, o: Observe): boolean {
    const p = o.pawns.find((q) => q.id === id);
    if (p === undefined) return false;
    return p.team === team || this.teams[team].state(id)?.spotted === true;
  }

  /** What `team`'s radar shows at observe `o` under `rules` ('all': every pawn, no fades). */
  marks(o: Observe, team: Team, rules: RadarRules): RadarMark[] {
    const out: RadarMark[] = [];
    const carrier = o.round.bomb.state === 'carried' ? o.round.bomb.carrier : null;
    for (const p of o.pawns) {
      const bomb = p.id === carrier && p.alive;
      if (rules === 'all' || p.team === team) {
        if (p.alive) out.push({ id: p.id, team: p.team, x: p.pos.x, y: p.pos.y, kind: 'dot', alpha: 1, bomb });
        else {
          const age = o.tick - (this.deaths.get(p.id) ?? o.tick);
          const alpha = rules === 'all' ? 1 : 1 - age / DEAD_TICKS;
          if (alpha > 0) out.push({ id: p.id, team: p.team, x: p.pos.x, y: p.pos.y, kind: 'dead', alpha, bomb: false });
        }
        continue;
      }
      const e = this.teams[team].state(p.id);
      if (e === undefined) continue;
      if (!p.alive) {
        if (!e.deadSeen || e.deadTick === null) continue;
        const alpha = 1 - (o.tick - e.deadTick) / DEAD_TICKS;
        if (alpha > 0) out.push({ id: p.id, team: p.team, x: e.pos.x, y: e.pos.y, kind: 'dead', alpha, bomb: false });
      } else if (e.spotted) {
        out.push({ id: p.id, team: p.team, x: p.pos.x, y: p.pos.y, kind: 'dot', alpha: 1, bomb });
      } else if (e.lostTick !== null) {
        const alpha = 1 - (o.tick - e.lostTick) / GHOST_TICKS;
        if (alpha > 0) out.push({ id: p.id, team: p.team, x: e.pos.x, y: e.pos.y, kind: 'ghost', alpha, bomb: false });
      }
    }
    return out;
  }

  /** The bomb on `team`'s radar when it isn't carried (null: not shown). */
  bomb(o: Observe, team: Team, rules: RadarRules): RadarBomb | null {
    const b = o.round.bomb;
    if (b.pos === null || b.state === 'carried') return null;
    const show = rules === 'all' || team === 'T' || b.state !== 'dropped' && (b.state !== 'planted' || PLANTED_BOMB_FOR_ALL);
    return show ? { x: b.pos.x, y: b.pos.y, state: b.state } : null;
  }
}
