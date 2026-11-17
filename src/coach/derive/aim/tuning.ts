/** Typed loader for data/coach/tuning/aim.json (the aim area's derive, metrics and detectors). */
import json from '../../../../data/coach/tuning/aim.json';
import { numberList, numbers, section, stringList } from '../../analyze/area-tuning';

const F = 'data/coach/tuning/aim.json';

export interface AimTuning {
  shots: { buttonWindowMs: number; burstGapCycles: number; sprayMin: number };
  target: { baseDeg: number; bodyRadius: number; maxDeg: number; clearRatio: number; maxDistance: number };
  body: { halfWidth: number; top: number; bottom: number; centre: number };
  bands: { edges: number[]; names: string[] };
  counterStrafe: {
    kinds: string[]; crouchDuck: number; moveFraction: number; lateCapMs: number; fixShare: number; minN: number;
    nScale: number; precision: number; costHit: number;
  };
  spray: { bulletFrom: number; maxBullet: number; offDeg: number; minBullets: number; minBucket: number; nScale: number; precision: number; costPerSpray: number };
  rangeDiscipline: { longUnits: number; minBullets: number; afterBullet: number; minInstances: number; nScale: number; precision: number; costPerSpray: number };
  firstBullet: { minN: number; nScale: number; precision: number; gapToMedian: number; costPerMiss: number };
}

export function loadAimTuning(j: unknown): AimTuning {
  const s = (k: string): Record<string, unknown> => section(j, k, F);
  const bands = s('bands');
  const cs = s('counterStrafe');
  const t: AimTuning = {
    shots: numbers(s('shots'), ['buttonWindowMs', 'burstGapCycles', 'sprayMin'], `${F} shots`),
    target: numbers(s('target'), ['baseDeg', 'bodyRadius', 'maxDeg', 'clearRatio', 'maxDistance'], `${F} target`),
    body: numbers(s('body'), ['halfWidth', 'top', 'bottom', 'centre'], `${F} body`),
    bands: { edges: numberList(bands, 'edges', `${F} bands`, true), names: stringList(bands, 'names', `${F} bands`) },
    counterStrafe: {
      kinds: stringList(cs, 'kinds', `${F} counterStrafe`),
      ...numbers(cs, ['crouchDuck', 'moveFraction', 'lateCapMs', 'fixShare', 'minN', 'nScale', 'precision', 'costHit'], `${F} counterStrafe`),
    },
    spray: numbers(s('spray'), ['bulletFrom', 'maxBullet', 'offDeg', 'minBullets', 'minBucket', 'nScale', 'precision', 'costPerSpray'], `${F} spray`),
    rangeDiscipline: numbers(s('rangeDiscipline'), ['longUnits', 'minBullets', 'afterBullet', 'minInstances', 'nScale', 'precision', 'costPerSpray'], `${F} rangeDiscipline`),
    firstBullet: numbers(s('firstBullet'), ['minN', 'nScale', 'precision', 'gapToMedian', 'costPerMiss'], `${F} firstBullet`),
  };
  if (t.bands.names.length !== t.bands.edges.length + 1) throw new Error(`${F}: bands.names needs one more entry than bands.edges`);
  return t;
}

export const AIM_TUNING: AimTuning = loadAimTuning(json);

/** The band name of a distance. */
export function bandOf(dist: number, t: AimTuning = AIM_TUNING): string {
  let k = 0;
  while (k < t.bands.edges.length && dist >= (t.bands.edges[k] as number)) k++;
  return t.bands.names[k] as string;
}
