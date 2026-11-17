/**
 * K4 table `positioning.deaths`: one row per death of a player in a played round, with its context.
 *
 * The victim's state is read on the last row before the death tick (on the death tick he is already dead); the
 * killer's and the teammates' positions on the death tick's row. `inventories` holds the victim's items at the tick
 * before each death. With a sight mesh (`ctx.los`), each living teammate is checked for sight of the killer every
 * `trades.losStepTicks` ticks from the death through the trade window while both live (smokes ignored: the death
 * label work of K6 brings them in).
 */
import type { Side, TeamId } from '../../model/match';
import { FLAG } from '../../model/raw';
import { grenadesOf, isGun } from '../economy/prices';
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { HURTS } from '../hurts';
import {
  alive, dist2d, dist3d, flag, liveRoundOf, placeAt, pos, rowAt, rowBefore, secToTicks, sideOf, teamOf, ticksToSec, weaponAt, type Vec3,
} from './grid';
import { TRADES } from './trades';
import { POSITIONING_TUNING } from './tuning';

export interface TeammateAtDeath {
  p: number;
  /** Horizontal distance to the victim, units. */
  dist: number;
  pos: Vec3;
  /** Saw the killer inside the trade window (null without a sight mesh). */
  sawKiller: boolean | null;
  /** First tick he saw the killer, null if never (or no mesh). */
  sawTick: number | null;
  /** Health he removed from the killer inside the trade window. */
  damageToKiller: number;
  /** He killed the killer inside the trade window. */
  killedKiller: boolean;
  /** He held a gun on some row from the death through the window. */
  hadGun: boolean;
}

export interface DeathRow {
  /** Index into `raw.events.kills`. */
  k: number;
  round: number;
  tick: number;
  victim: number;
  team: TeamId;
  side: Side;
  /** -1 for the world or a suicide. */
  killer: number;
  /** The killer is an enemy player. */
  byEnemy: boolean;
  assister: number;
  weapon: string;
  headshot: boolean;
  /** Killer → victim, units (3D, feet to feet); the game's own figure in metres too. */
  distance: number;
  distanceM: number;
  victimPos: Vec3;
  killerPos: Vec3 | null;
  victimPlace: string;
  killerPlace: string;
  /** The victim's active weapon and state on the last row before death. */
  victimWeapon: string;
  reloading: boolean;
  scoped: boolean;
  airborne: boolean;
  planting: boolean;
  defusing: boolean;
  /** Seconds of flash left at death (0 = not flashed) and who threw it (-1 unknown). */
  flashedSec: number;
  flashedBy: number;
  grenades: string[];
  grenadeValue: number;
  teammates: TeammateAtDeath[];
  nearest: { p: number; dist: number } | null;
  /** Some teammate saw the killer inside the trade window (null without a sight mesh). */
  teammateSawKiller: boolean | null;
  /** Alive counts just before the death, the victim included. */
  aliveOwn: number;
  aliveEnemy: number;
  /** Seconds since freeze end, and the clock left (round clock before the plant, bomb timer after it is not modelled). */
  clockSec: number;
  timeLeftSec: number;
  bomb: 'none' | 'planted' | 'defused' | 'exploded';
  /** Seconds since the plant (null before or without one). */
  bombSec: number | null;
  traded: boolean;
  tradedBy: number;
  /** First death of the round (any cause). */
  firstDeath: boolean;
  /** The victim's team won the round. */
  roundWon: boolean;
}

function plantingAt(ctx: AnalysisContext, p: number, tick: number): boolean {
  let state = false;
  for (const b of ctx.raw.events.bomb) {
    if (b.tick > tick) break;
    if (b.p !== p) continue;
    if (b.kind === 'begin_plant') state = true;
    else if (b.kind === 'abort_plant' || b.kind === 'planted') state = false;
  }
  return state;
}

function defusingAt(ctx: AnalysisContext, p: number, tick: number): boolean {
  let state = false;
  for (const b of ctx.raw.events.bomb) {
    if (b.tick > tick) break;
    if (b.p !== p) continue;
    if (b.kind === 'begin_defuse') state = true;
    else if (b.kind === 'abort_defuse' || b.kind === 'defused') state = false;
  }
  return state;
}

export function buildDeaths(ctx: AnalysisContext): DeathRow[] {
  const { raw, match, los } = ctx;
  const tune = POSITIONING_TUNING;
  const trades = ctx.table(TRADES);
  const hurts = ctx.table(HURTS);
  const window = secToTicks(raw, tune.trades.windowSec);
  const step = Math.max(1, Math.round(tune.trades.losStepTicks));
  const P = raw.players.length;
  const seenRound = new Set<number>();
  const out: DeathRow[] = [];

  for (const tr of trades) {
    const kill = raw.events.kills[tr.k];
    const round = liveRoundOf(match, tr.tick);
    const team = teamOf(match, tr.victim);
    if (!kill || round === null || team === null) continue;
    const side = sideOf(round, team) as Side;
    const vr = rowBefore(raw, tr.tick);
    const kr = rowAt(raw, tr.tick);
    const victimPos = pos(raw, vr, tr.victim);
    const killer = kill.attacker >= 0 && kill.attacker < P && kill.attacker !== tr.victim ? kill.attacker : -1;
    const killerPos = killer >= 0 ? pos(raw, kr, killer) : null;
    const vi = vr * P + tr.victim;

    // Flash: the column at death, and the latest blind on him still running.
    const flashedSec = raw.ticks.flash[vi] ?? 0;
    let flashedBy = -1;
    if (flashedSec > 0) {
      for (const b of raw.events.blinds) {
        if (b.tick > tr.tick) break;
        if (b.victim === tr.victim && b.tick + secToTicks(raw, b.duration) >= tr.tick) flashedBy = b.attacker;
      }
    }

    let inv: string[] = [];
    for (const v of raw.inventories) {
      if (v.at === 'death' && v.p === tr.victim && v.tick <= tr.tick && v.tick >= tr.tick - 4) inv = v.items;
    }
    const nades = grenadesOf(inv);

    const teammates: TeammateAtDeath[] = [];
    for (const q of round.roster[team]) {
      if (q === tr.victim || !alive(raw, kr, q)) continue;
      const qp = pos(raw, kr, q);
      const tm: TeammateAtDeath = {
        p: q, dist: dist2d(qp, victimPos), pos: qp, sawKiller: los === null || killer < 0 ? null : false, sawTick: null,
        damageToKiller: 0, killedKiller: false, hadGun: false,
      };
      for (const h of hurts) {
        if (h.hurt.tick < tr.tick) continue;
        if (h.hurt.tick > tr.tick + window) break;
        if (h.hurt.attacker === q && h.hurt.victim === killer) tm.damageToKiller += h.damage;
      }
      if (killer >= 0) {
        for (const other of trades) {
          if (other.attacker === q && other.victim === killer && other.tick >= tr.tick && other.tick <= tr.tick + window) tm.killedKiller = true;
        }
      }
      const r1 = rowAt(raw, tr.tick + window);
      for (let r = kr; r <= r1 && !tm.hadGun; r += step) if (alive(raw, r, q) && isGun(weaponAt(raw, r, q))) tm.hadGun = true;
      if (los !== null && killer >= 0) {
        for (let tick = tr.tick; tick <= tr.tick + window; tick += step) {
          const r = rowAt(raw, tick);
          if (!alive(raw, r, q) || !alive(raw, r, killer)) break;
          const i = r * P + killer;
          const ii = r * P + q;
          const eye = los.eyePosition({ x: raw.ticks.x[ii] ?? 0, y: raw.ticks.y[ii] ?? 0, z: raw.ticks.z[ii] ?? 0 }, (raw.ticks.duck[ii] ?? 0) / 255);
          const vis = los.visible(eye, { x: raw.ticks.x[i] ?? 0, y: raw.ticks.y[i] ?? 0, z: raw.ticks.z[i] ?? 0, yaw: raw.ticks.yaw[i] ?? 0, duck: (raw.ticks.duck[i] ?? 0) / 255 }, null, 0, undefined, true);
          if (vis.any) { tm.sawKiller = true; tm.sawTick = raw.ticks.tick[r] ?? tick; break; }
        }
      }
      teammates.push(tm);
    }
    let nearest: DeathRow['nearest'] = null;
    for (const tm of teammates) if (nearest === null || tm.dist < nearest.dist) nearest = { p: tm.p, dist: tm.dist };

    let aliveOwn = 0;
    let aliveEnemy = 0;
    for (let q = 0; q < P; q++) {
      if (!alive(raw, vr, q)) continue;
      if (teamOf(match, q) === team) aliveOwn++;
      else aliveEnemy++;
    }
    if (!alive(raw, vr, tr.victim)) aliveOwn++;

    const clockSec = round.freezeEndTick !== null ? ticksToSec(raw, tr.tick - round.freezeEndTick) : 0;
    const b = round.bomb;
    let bomb: DeathRow['bomb'] = 'none';
    if (b.plantTick !== null && b.plantTick <= tr.tick) bomb = 'planted';
    if (b.defuseTick !== null && b.defuseTick <= tr.tick) bomb = 'defused';
    if (b.explodeTick !== null && b.explodeTick <= tr.tick) bomb = 'exploded';

    out.push({
      k: tr.k, round: round.number, tick: tr.tick, victim: tr.victim, team, side, killer, byEnemy: tr.enemy,
      assister: kill.assister, weapon: kill.weapon, headshot: kill.headshot,
      distance: killerPos ? dist3d(killerPos, victimPos) : 0, distanceM: kill.distance,
      victimPos, killerPos, victimPlace: placeAt(raw, vr, tr.victim), killerPlace: killer >= 0 ? placeAt(raw, kr, killer) : '',
      victimWeapon: weaponAt(raw, vr, tr.victim),
      reloading: flag(raw, vr, tr.victim, FLAG.reloading), scoped: flag(raw, vr, tr.victim, FLAG.scoped),
      airborne: flag(raw, vr, tr.victim, FLAG.airborne),
      planting: plantingAt(ctx, tr.victim, tr.tick), defusing: flag(raw, vr, tr.victim, FLAG.defusing) || defusingAt(ctx, tr.victim, tr.tick),
      flashedSec, flashedBy, grenades: nades.grenades, grenadeValue: nades.value,
      teammates, nearest,
      teammateSawKiller: los === null || killer < 0 ? null : teammates.some((t) => t.sawKiller === true),
      aliveOwn, aliveEnemy, clockSec, timeLeftSec: Math.max(0, tune.clock.roundSec - clockSec), bomb,
      bombSec: b.plantTick !== null && b.plantTick <= tr.tick ? ticksToSec(raw, tr.tick - b.plantTick) : null,
      traded: tr.traded, tradedBy: tr.tradedBy, firstDeath: !seenRound.has(round.number), roundWon: round.winner === team,
    });
    seenRound.add(round.number);
  }
  return out;
}

export const DEATHS: TableDef<DeathRow[]> = { id: 'positioning.deaths', build: buildDeaths };
