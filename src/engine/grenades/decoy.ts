/**
 * Decoy (docs/grenades.md, Decoy): once it comes to rest it plays the thrower's weapon in bursts for 15 s, then pops
 * for a few points of damage. The burst pattern is not public: bursts of 1–5 shots at the weapon's interval with
 * 0.4–2 s gaps, from the seeded hash (unverified, tunable).
 */
import type { GrenadeCs2Tuning, Team, Vec3 } from '../../contracts/index';
import { hashRandom, secToTicks, TICK_RATE } from './math';
import type { Decoy } from './types';

export function createDecoy(seed: number, seq: number, thrower: string, team: Team, pos: Vec3, tick: number, shotIntervalSec: number, t: GrenadeCs2Tuning): Decoy {
  const endTick = tick + secToTicks(t.decoyDurationSec);
  const interval = Math.max(1, Math.round((shotIntervalSec > 0 ? shotIntervalSec : t.decoyShotIntervalSec) * TICK_RATE));
  const shots: number[] = [];
  let at = tick;
  for (let burst = 0; burst < 1000 && at < endTick; burst++) {
    const span = t.decoyBurstMax - t.decoyBurstMin + 1;
    const n = t.decoyBurstMin + Math.min(span - 1, Math.floor(hashRandom(seed, seq, burst, 11) * span));
    for (let s = 0; s < n && at < endTick; s++) {
      shots.push(at);
      at += interval;
    }
    at += Math.round((t.decoyGapMinSec + (t.decoyGapMaxSec - t.decoyGapMinSec) * hashRandom(seed, seq, burst, 12)) * TICK_RATE);
  }
  return { seq, thrower, team, pos: { ...pos }, popTick: tick, endTick, shots };
}
