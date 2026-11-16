/**
 * K4 table `utility.throws`: every grenade thrown in a played round, joined to its detonation and to what it did.
 *
 * Joining (docs/coach/utility.md): a projectile (`raw.projectiles`) is joined to a detonation of its kind by the same
 * thrower whose tick lies in [first sample, last sample + matchSlackTicks] and whose position is within matchRadius of
 * one of the path's samples. Among those, one with the projectile's entity id wins, then the nearest in space, then
 * the earliest. Entity ids are reused across throws, so the id alone never decides; each detonation is used once.
 * Molotov and incendiary fires (`inferno_startburn`) carry the inferno's entity, not the projectile's, so they join on
 * thrower, time and place alone. A detonation no projectile claimed becomes a throw without a path. Smoke and fire
 * expiries join their start by entity id and time.
 *
 * Effects:
 * - flash: every `player_blind` of the flash (its entity and the detonation tick, else thrower and tick), labelled
 *   enemy / team / self, with the victim's alive state; for a blinded enemy, whether the thrower's team killed him
 *   within min(duration, killWindowCapSec); for a blinded teammate, the tick he died or took enemy damage in that window.
 * - he and fire: damage from health deltas (`core.hurts`), to enemies and to teammates; fire also counts the
 *   seconds any living enemy stood inside it (fireRadius / fireHeight around the startburn point).
 * - smoke: landing and lifetime from the detonation and its expiry.
 */
import type { TeamId } from '../../model/match';
import { PATH_NONE, PATH_STEP } from '../../model/raw';
import type { RawDetonation, RawProjectile } from '../../model/raw';
import { alive, dist2d, dist3d, liveRoundOf, placeAt, pos, rowAt, rowBefore, secToTicks, teamOf, ticksToSec, type Vec3 } from '../positioning/grid';
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { HURTS, type HurtRow } from '../hurts';
import { PLACE_INDEX } from './places';
import { UTILITY_TUNING, type UtilityTuning } from './tuning';

export type ThrowType = 'flash' | 'he' | 'fire' | 'smoke' | 'decoy';

export interface Blinded {
  victim: number;
  /** Seconds (the event's duration). */
  duration: number;
  tick: number;
  rel: 'enemy' | 'team' | 'self';
  /** The victim was alive at the blind (blinds of dead players and spectators are kept but never counted). */
  alive: boolean;
  /** duration ≥ minBlindSec and alive. */
  counts: boolean;
  /** Enemy: the thrower's team killed him within min(duration, cap); the killer slot and tick. */
  killedBy: number;
  killTick: number | null;
  /** Teammate or self: the tick he died or took enemy damage within min(duration, cap), else null. */
  fightTick: number | null;
}

export interface Hit {
  victim: number;
  tick: number;
  removed: number;
  enemy: boolean;
}

export interface Throw {
  /** Index in the table. */
  id: number;
  round: number;
  thrower: number;
  team: TeamId | null;
  type: ThrowType;
  /** The projectile entity (or the detonation's when there is no projectile). */
  entity: number;
  /** The projectile's first sample (null without a projectile). */
  throwTick: number | null;
  throwPos: Vec3 | null;
  /** The thrower's place at the throw (or at the detonation without a projectile). */
  throwPlace: string;
  detTick: number | null;
  detPos: Vec3 | null;
  /** Place name nearest the landing (the detonation, else the path's last sample). */
  landPlace: string;
  /** Smoke or fire expiry; flash and HE: the detonation tick. */
  endTick: number | null;
  /** Seconds from detonation to expiry (0 for flash and HE). */
  lifetimeSec: number;
  blinds: Blinded[];
  enemiesBlinded: number;
  teammatesBlinded: number;
  selfBlinded: boolean;
  /** Sum of counted enemy blind durations, seconds. */
  enemyBlindSec: number;
  /** A counted enemy was killed by the thrower's team inside the window. */
  ledToKill: boolean;
  hits: Hit[];
  enemyDamage: number;
  teamDamage: number;
  /** Fire: seconds with at least one living enemy inside it, and within fireNearRadius of it. */
  fireEnemySec: number;
  fireNearSec: number;
}

const PROJ_KIND: Readonly<Record<string, ThrowType>> = {
  flashbang: 'flash', he_grenade: 'he', hegrenade: 'he', smoke: 'smoke', smokegrenade: 'smoke', molotov: 'fire',
  incgrenade: 'fire', decoy: 'decoy',
};
const START_KINDS: ReadonlySet<string> = new Set(['flash', 'he', 'smoke', 'fire', 'decoy']);
const END_OF: Readonly<Record<string, RawDetonation['kind']>> = { smoke: 'smoke_end', fire: 'fire_end', decoy: 'decoy_end' };

/** Path samples (non-missing) of a projectile, with their ticks. */
export function pathSamples(p: RawProjectile): { tick: number; at: Vec3 }[] {
  const out: { tick: number; at: Vec3 }[] = [];
  for (let k = 0; k + 2 < p.path.length; k += 3) {
    const x = p.path[k] ?? PATH_NONE;
    if (x === PATH_NONE) continue;
    out.push({ tick: p.t0 + (k / 3) * PATH_STEP, at: [x, p.path[k + 1] ?? 0, p.path[k + 2] ?? 0] });
  }
  return out;
}

function detPos(d: RawDetonation): Vec3 {
  return [d.x, d.y, d.z];
}

interface Join {
  proj: RawProjectile | null;
  det: RawDetonation | null;
}

/** Join projectiles to detonations (see the file comment). */
export function joinProjectiles(projectiles: readonly RawProjectile[], dets: readonly RawDetonation[], tune: UtilityTuning['throws']): Join[] {
  const used = new Uint8Array(dets.length);
  const joins: Join[] = [];
  const order = projectiles.map((_, i) => i).sort((a, b) => {
    const pa = projectiles[a] as RawProjectile;
    const pb = projectiles[b] as RawProjectile;
    return pa.t0 - pb.t0 || pa.thrower - pb.thrower || pa.entity - pb.entity || a - b;
  });
  for (const i of order) {
    const p = projectiles[i] as RawProjectile;
    const kind = PROJ_KIND[p.type];
    if (kind === undefined) continue;
    const samples = pathSamples(p);
    let best = -1;
    let bestKey: [number, number, number] = [2, Infinity, Infinity];
    dets.forEach((d, j) => {
      if (used[j] === 1 || d.kind !== kind || d.p !== p.thrower) return;
      if (d.tick < p.t0 || d.tick > p.t1 + tune.matchSlackTicks) return;
      let near = Infinity;
      for (const s of samples) near = Math.min(near, dist3d(s.at, detPos(d)));
      if (samples.length === 0) near = 0;
      if (near > tune.matchRadius) return;
      const key: [number, number, number] = [d.entity === p.entity ? 0 : 1, near, d.tick];
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = j;
        bestKey = key;
      }
    });
    if (best >= 0) used[best] = 1;
    joins.push({ proj: p, det: best >= 0 ? (dets[best] as RawDetonation) : null });
  }
  dets.forEach((d, j) => {
    if (used[j] === 0 && START_KINDS.has(d.kind)) joins.push({ proj: null, det: d });
  });
  return joins;
}

export function buildThrows(ctx: AnalysisContext): Throw[] {
  const { raw, match } = ctx;
  const tune = UTILITY_TUNING;
  const places = ctx.table(PLACE_INDEX);
  const hurts = ctx.table(HURTS);
  const dets = raw.events.detonations;
  const joins = joinProjectiles(raw.projectiles, dets, tune.throws);

  // Expiry of each smoke / fire / decoy start: the first matching end after it with the same entity.
  const endUsed = new Uint8Array(dets.length);
  const endOf = (d: RawDetonation): number | null => {
    const want = END_OF[d.kind];
    if (want === undefined) return null;
    for (let j = 0; j < dets.length; j++) {
      const e = dets[j] as RawDetonation;
      if (endUsed[j] === 1 || e.kind !== want || e.entity !== d.entity || e.tick < d.tick) continue;
      endUsed[j] = 1;
      return e.tick;
    }
    return null;
  };

  const blindUsed = new Uint8Array(raw.events.blinds.length);
  const throws: Throw[] = [];
  const rows = joins.map((j) => {
    const tick = j.proj ? j.proj.t0 : (j.det as RawDetonation).tick;
    return { j, tick };
  }).sort((a, b) => a.tick - b.tick || (a.j.det?.tick ?? 0) - (b.j.det?.tick ?? 0) || (a.j.proj?.thrower ?? a.j.det?.p ?? 0) - (b.j.proj?.thrower ?? b.j.det?.p ?? 0));

  for (const { j } of rows) {
    const thrower = j.proj ? j.proj.thrower : (j.det as RawDetonation).p;
    const type: ThrowType = j.proj ? (PROJ_KIND[j.proj.type] as ThrowType) : ((j.det as RawDetonation).kind as ThrowType);
    const anchor = j.proj ? j.proj.t0 : (j.det as RawDetonation).tick;
    const round = liveRoundOf(match, j.det?.tick ?? anchor);
    if (round === null || thrower < 0 || thrower >= raw.players.length) continue;
    const team = teamOf(match, thrower);
    const samples = j.proj ? pathSamples(j.proj) : [];
    const first = samples[0] ?? null;
    const last = samples[samples.length - 1] ?? null;
    const det = j.det;
    const land: Vec3 | null = det ? detPos(det) : last ? last.at : null;
    const endTick = det ? (type === 'flash' || type === 'he' ? det.tick : endOf(det)) : null;
    const lifeDefault = type === 'smoke' ? tune.throws.smokeDefaultSec : type === 'fire' ? tune.throws.fireDefaultSec : 0;
    const lifetimeSec = det === null ? 0 : endTick !== null ? ticksToSec(raw, endTick - det.tick) : lifeDefault;
    const throwRow = rowAt(raw, first?.tick ?? anchor);
    const t: Throw = {
      id: throws.length, round: round.number, thrower, team, type, entity: j.proj ? j.proj.entity : (det as RawDetonation).entity,
      throwTick: first ? first.tick : null, throwPos: first ? first.at : null, throwPlace: placeAt(raw, throwRow, thrower),
      detTick: det ? det.tick : null, detPos: det ? detPos(det) : null,
      landPlace: land ? places.placeAt(land[0], land[1], land[2]) : '',
      endTick, lifetimeSec, blinds: [], enemiesBlinded: 0, teammatesBlinded: 0, selfBlinded: false, enemyBlindSec: 0,
      ledToKill: false, hits: [], enemyDamage: 0, teamDamage: 0, fireEnemySec: 0, fireNearSec: 0,
    };
    if (type === 'flash' && det) flashEffects(ctx, t, det, blindUsed, hurts);
    throws.push(t);
  }
  assignDamage(ctx, throws, hurts);
  for (const t of throws) if (t.type === 'fire' && t.detTick !== null && t.detPos !== null) fireEnemySeconds(ctx, t);
  throws.forEach((t, k) => { t.id = k; });
  return throws;
}

function flashEffects(ctx: AnalysisContext, t: Throw, det: RawDetonation, used: Uint8Array, hurts: readonly HurtRow[]): void {
  const { raw, match } = ctx;
  const tune = UTILITY_TUNING.flash;
  const blinds = raw.events.blinds;
  const pick = (byEntity: boolean): void => {
    blinds.forEach((b, k) => {
      if (used[k] === 1 || b.attacker !== t.thrower || b.tick < det.tick || b.tick > det.tick + 2) return;
      if (byEntity && b.entity !== det.entity) return;
      used[k] = 1;
      const victimTeam = teamOf(match, b.victim);
      const rel: Blinded['rel'] = b.victim === t.thrower ? 'self' : victimTeam !== null && victimTeam === t.team ? 'team' : 'enemy';
      const isAlive = b.victim >= 0 && b.victim < raw.players.length && alive(raw, rowBefore(raw, b.tick + 1), b.victim);
      const counts = isAlive && victimTeam !== null && b.duration >= tune.minBlindSec;
      const window = secToTicks(raw, Math.min(b.duration, tune.killWindowCapSec));
      let killedBy = -1;
      let killTick: number | null = null;
      let fightTick: number | null = null;
      for (const kill of raw.events.kills) {
        if (kill.tick < b.tick || kill.tick > b.tick + window || kill.victim !== b.victim) continue;
        if (rel === 'enemy' && kill.attacker >= 0 && teamOf(match, kill.attacker) === t.team) { killedBy = kill.attacker; killTick = kill.tick; }
        if (rel !== 'enemy' && fightTick === null) fightTick = kill.tick;
        break;
      }
      if (rel !== 'enemy') {
        for (const h of hurts) {
          if (h.hurt.tick < b.tick || h.hurt.tick > b.tick + window) continue;
          if (h.hurt.victim === b.victim && h.enemy && h.damage > 0) { fightTick = fightTick === null ? h.hurt.tick : Math.min(fightTick, h.hurt.tick); break; }
        }
      }
      t.blinds.push({ victim: b.victim, duration: b.duration, tick: b.tick, rel, alive: isAlive, counts, killedBy, killTick, fightTick });
    });
  };
  pick(true);
  if (t.blinds.length === 0) pick(false);
  t.blinds.sort((a, b) => a.victim - b.victim || a.tick - b.tick);
  for (const b of t.blinds) {
    if (!b.counts) continue;
    if (b.rel === 'enemy') {
      t.enemiesBlinded++;
      t.enemyBlindSec += b.duration;
      if (b.killedBy >= 0) t.ledToKill = true;
    } else if (b.rel === 'team') t.teammatesBlinded++;
    else t.selfBlinded = true;
  }
}

/** HE and fire damage from `core.hurts`, each hurt to at most one throw. */
function assignDamage(ctx: AnalysisContext, throws: Throw[], hurts: readonly HurtRow[]): void {
  const { raw } = ctx;
  const tune = UTILITY_TUNING.throws;
  for (const row of hurts) {
    const h = row.hurt;
    const isHe = h.weapon === 'hegrenade';
    const isFire = h.weapon === 'inferno' || h.weapon === 'molotov' || h.weapon === 'incgrenade';
    if (!isHe && !isFire) continue;
    let best: Throw | null = null;
    let bestD = Infinity;
    const vpos = pos(raw, rowBefore(raw, h.tick), h.victim);
    for (const t of throws) {
      if (t.thrower !== h.attacker || t.detTick === null || t.detPos === null) continue;
      if (isHe) {
        if (t.type !== 'he' || h.tick < t.detTick || h.tick > t.detTick + tune.heDamageTicks) continue;
      } else {
        if (t.type !== 'fire') continue;
        const end = (t.endTick ?? t.detTick + secToTicks(raw, tune.fireDefaultSec)) + tune.fireEndSlackTicks;
        if (h.tick < t.detTick || h.tick > end) continue;
      }
      const d = isHe ? Math.abs(h.tick - t.detTick) : dist2d(vpos, t.detPos);
      if (d < bestD) { best = t; bestD = d; }
    }
    if (best === null) continue;
    best.hits.push({ victim: h.victim, tick: h.tick, removed: row.damage, enemy: row.enemy });
    if (row.enemy) best.enemyDamage += row.damage;
    else if (h.victim !== h.attacker && ctx.teamOf(h.victim) !== null && ctx.teamOf(h.victim) === ctx.teamOf(h.attacker)) best.teamDamage += row.damage;
  }
}

/** Seconds of a fire's life with at least one living enemy of the thrower inside it, and near it. */
function fireEnemySeconds(ctx: AnalysisContext, t: Throw): void {
  const { raw, match } = ctx;
  const tune = UTILITY_TUNING.throws;
  const at = t.detPos as Vec3;
  const start = t.detTick as number;
  const end = t.endTick ?? start + secToTicks(raw, tune.fireDefaultSec);
  const r0 = rowAt(raw, start);
  const r1 = rowAt(raw, end);
  let inside = 0;
  let near = 0;
  for (let r = r0; r < r1; r++) {
    let isIn = false;
    let isNear = false;
    for (let p = 0; p < raw.players.length && !isIn; p++) {
      const tm = teamOf(match, p);
      if (tm === null || tm === t.team || !alive(raw, r, p)) continue;
      const q = pos(raw, r, p);
      const d = dist2d(q, at);
      if (d <= tune.fireNearRadius) isNear = true;
      if (d <= tune.fireRadius && Math.abs(q[2] - at[2]) <= tune.fireHeight) isIn = true;
    }
    const dt = (raw.ticks.tick[r + 1] ?? 0) - (raw.ticks.tick[r] ?? 0);
    if (isIn) inside += dt;
    if (isNear || isIn) near += dt;
  }
  t.fireEnemySec = ticksToSec(raw, inside);
  t.fireNearSec = ticksToSec(raw, near);
}

export const THROWS: TableDef<Throw[]> = { id: 'utility.throws', build: buildThrows };
