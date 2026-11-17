/** Typed loader for data/coach/tuning/movement.json. */
import json from '../../../../data/coach/tuning/movement.json';
import { numbers, section, stringList } from '../../analyze/area-tuning';

const F = 'data/coach/tuning/movement.json';

export interface MovementTuning {
  reload: { nearUnits: number; fullShare: number; minInstances: number; nScale: number; precision: number; costDeath: number; costNear: number; costFull: number };
  caughtOut: { items: string[]; throwGraceMs: number; throwAimDeg: number; minInstances: number; nScale: number; precision: number; costDeath: number };
}

export function loadMovementTuning(j: unknown): MovementTuning {
  const co = section(j, 'caughtOut', F);
  return {
    reload: numbers(section(j, 'reload', F), ['nearUnits', 'fullShare', 'minInstances', 'nScale', 'precision', 'costDeath', 'costNear', 'costFull'], `${F} reload`),
    caughtOut: {
      items: stringList(co, 'items', `${F} caughtOut`),
      ...numbers(co, ['throwGraceMs', 'throwAimDeg', 'minInstances', 'nScale', 'precision', 'costDeath'], `${F} caughtOut`),
    },
  };
}

export const MOVEMENT_TUNING: MovementTuning = loadMovementTuning(json);
