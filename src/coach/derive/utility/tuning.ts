/**
 * K4: typed loader for data/coach/tuning/utility.json (throws, flashes, grenade detectors). Every number is checked.
 */
import json from '../../../../data/coach/tuning/utility.json';
import { numbers, section } from '../../analyze/area-tuning';

export interface UtilityTuning {
  throws: {
    matchSlackTicks: number; matchRadius: number; heDamageTicks: number; fireEndSlackTicks: number;
    fireRadius: number; fireHeight: number; fireDefaultSec: number; smokeDefaultSec: number;
    placeSampleRows: number; placeRadius: number; fireNearRadius: number;
  };
  flash: { minBlindSec: number; killWindowCapSec: number; minFlashes: number; noEnemyShare: number; minTeamFlashFights: number; strengthEnemiesPerFlash: number };
  unused: { minGrenades: number; minDeaths: number };
  buy: { minRounds: number };
  damage: { minFires: number; wastedFireShare: number; minGrenades: number; strengthDamagePerGrenade: number };
  scoring: { nScale: number; precision: number; impactWastedFlash: number; impactTeamFlash: number; impactUnusedDeath: number; impactNoUtilRound: number; impactWastedFire: number };
}

/** The listed numbers of each section, checked (K2's area-tuning helpers); notes (`_` keys) are dropped. */
export function checkNumbers<T>(json: unknown, shape: Record<string, readonly string[]>, what: string): T {
  const file = `data/coach/tuning/${what}.json`;
  const out: Record<string, Record<string, number>> = {};
  for (const sec of Object.keys(shape).sort()) out[sec] = numbers(section(json, sec, file), shape[sec] ?? [], `${file} ${sec}`);
  return out as unknown as T;
}

export function loadUtilityTuning(j: unknown): UtilityTuning {
  return checkNumbers<UtilityTuning>(j, {
    throws: ['matchSlackTicks', 'matchRadius', 'heDamageTicks', 'fireEndSlackTicks', 'fireRadius', 'fireHeight', 'fireDefaultSec', 'smokeDefaultSec', 'placeSampleRows', 'placeRadius', 'fireNearRadius'],
    flash: ['minBlindSec', 'killWindowCapSec', 'minFlashes', 'noEnemyShare', 'minTeamFlashFights', 'strengthEnemiesPerFlash'],
    unused: ['minGrenades', 'minDeaths'],
    buy: ['minRounds'],
    damage: ['minFires', 'wastedFireShare', 'minGrenades', 'strengthDamagePerGrenade'],
    scoring: ['nScale', 'precision', 'impactWastedFlash', 'impactTeamFlash', 'impactUnusedDeath', 'impactNoUtilRound', 'impactWastedFire'],
  }, 'utility');
}

export const UTILITY_TUNING: UtilityTuning = loadUtilityTuning(json);
