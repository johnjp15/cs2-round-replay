/** Typed loader for data/coach/tuning/report.json: the framework's own tunables (prioritizer, confidence, clock). */
import json from '../../../data/coach/tuning/report.json';
import { numbers, section, stringList } from './area-tuning';

const FILE = 'data/coach/tuning/report.json';

const PRIORITIZER_KEYS = [
  'maxFixes', 'maxStrengths', 'minConfidence', 'minImpact', 'minPriority', 'instanceScale', 'minLobby',
  'strengthFloor', 'recurrenceStep', 'recurrenceMax',
] as const;

export interface ReportTuning {
  prioritizer: Record<(typeof PRIORITIZER_KEYS)[number], number>;
  /** Detector (or finding-id prefix) → fixability 0–1; `fixabilityDefault` for the rest. */
  fixability: Record<string, number>;
  fixabilityDefault: number;
  /** Root family name → detector ids (or finding-id prefixes) that share a root cause. */
  families: Record<string, string[]>;
  /** Detectors whose impact counts every instance and is scaled by the lobby excess of the key metric. */
  baseline: { lobby: string[] };
  /** Precision gate: measured precision (K11) per detector; below `minPrecision` its findings are observations. */
  gate: { minPrecision: number; measured: Record<string, number> };
  confidence: { strengthMaxRank: number; strengthMinLobby: number };
  clock: { roundSec: number; bombSec: number };
}

function numberMap(o: Record<string, unknown>, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(o).sort()) {
    if (k.startsWith('_')) continue;
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ${k} must be a number`);
    out[k] = v;
  }
  return out;
}

export function loadReportTuning(j: unknown): ReportTuning {
  const fx = numberMap(section(j, 'fixability', FILE), `${FILE} fixability`);
  const fixabilityDefault = fx['default'];
  if (fixabilityDefault === undefined) throw new Error(`${FILE} fixability: default must be a number`);
  delete fx['default'];
  const fam = section(j, 'families', FILE);
  const families: Record<string, string[]> = {};
  for (const k of Object.keys(fam).sort()) if (!k.startsWith('_')) families[k] = stringList(fam, k, `${FILE} families`);
  const gate = section(j, 'gate', FILE);
  return {
    prioritizer: numbers(section(j, 'prioritizer', FILE), PRIORITIZER_KEYS, `${FILE} prioritizer`),
    fixability: fx,
    fixabilityDefault,
    families,
    baseline: { lobby: stringList(section(j, 'baseline', FILE), 'lobby', `${FILE} baseline`) },
    gate: { ...numbers(gate, ['minPrecision'], `${FILE} gate`), measured: numberMap(section(j, 'gate.measured', FILE), `${FILE} gate.measured`) },
    confidence: numbers(section(j, 'confidence', FILE), ['strengthMaxRank', 'strengthMinLobby'], `${FILE} confidence`),
    clock: numbers(section(j, 'clock', FILE), ['roundSec', 'bombSec'], `${FILE} clock`),
  };
}

export const REPORT_TUNING: ReportTuning = loadReportTuning(json);
