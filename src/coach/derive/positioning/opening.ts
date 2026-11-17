/**
 * K4 table `positioning.opening`: the first kill between enemies of each played round (the opening duel): who, where,
 * with what, the sides, the round clock, the round's outcome, and how far each was pushed toward the enemy spawn
 * (0 = own spawn, 1 = the enemy's; spawns are the sides' mean positions at freeze end).
 */
import type { Side } from '../../model/match';
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { dist2d, placeAt, pos, rowAt, rowBefore, sideOf, spawnOf, teamOf, ticksToSec, weaponAt, type Vec3 } from './grid';
import { TRADES } from './trades';

export interface OpeningRow {
  round: number;
  k: number;
  tick: number;
  attacker: number;
  victim: number;
  attackerSide: Side;
  victimSide: Side;
  attackerPlace: string;
  victimPlace: string;
  attackerPos: Vec3;
  victimPos: Vec3;
  /** The kill's weapon, and the victim's weapon in hand. */
  weapon: string;
  victimWeapon: string;
  clockSec: number;
  winnerSide: Side | null;
  /** The opener's team won the round. */
  attackerWon: boolean;
  /** Progress toward the enemy spawn, 0–1 (null when a spawn is unknown). */
  victimPush: number | null;
  attackerPush: number | null;
}

/** 0 at the own spawn, 1 at the enemy spawn. */
export function pushProgress(at: Vec3, own: Vec3 | null, enemy: Vec3 | null): number | null {
  if (own === null || enemy === null) return null;
  const a = dist2d(at, own);
  const b = dist2d(at, enemy);
  return a + b === 0 ? null : a / (a + b);
}

export function buildOpening(ctx: AnalysisContext): OpeningRow[] {
  const { raw, match } = ctx;
  const trades = ctx.table(TRADES);
  const out: OpeningRow[] = [];
  const done = new Set<number>();
  for (const tr of trades) {
    if (!tr.enemy || done.has(tr.round)) continue;
    const round = match.rounds.find((r) => r.number === tr.round);
    const kill = raw.events.kills[tr.k];
    if (!round || !kill) continue;
    done.add(tr.round);
    const as = sideOf(round, teamOf(match, tr.attacker)) as Side;
    const vs = sideOf(round, teamOf(match, tr.victim)) as Side;
    const vr = rowBefore(raw, tr.tick);
    const kr = rowAt(raw, tr.tick);
    const vpos = pos(raw, vr, tr.victim);
    const apos = pos(raw, kr, tr.attacker);
    const spawn = { T: spawnOf(raw, round, 'T'), CT: spawnOf(raw, round, 'CT') };
    out.push({
      round: tr.round, k: tr.k, tick: tr.tick, attacker: tr.attacker, victim: tr.victim, attackerSide: as, victimSide: vs,
      attackerPlace: placeAt(raw, kr, tr.attacker), victimPlace: placeAt(raw, vr, tr.victim), attackerPos: apos, victimPos: vpos,
      weapon: kill.weapon, victimWeapon: weaponAt(raw, vr, tr.victim),
      clockSec: round.freezeEndTick !== null ? ticksToSec(raw, tr.tick - round.freezeEndTick) : 0,
      winnerSide: round.winnerSide, attackerWon: round.winner === teamOf(match, tr.attacker),
      victimPush: pushProgress(vpos, spawn[vs], spawn[as]), attackerPush: pushProgress(apos, spawn[as], spawn[vs]),
    });
  }
  return out;
}

export const OPENING: TableDef<OpeningRow[]> = { id: 'positioning.opening', build: buildOpening };
