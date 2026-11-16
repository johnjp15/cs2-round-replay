/** Typed loader for data/coach/tuning/report.json: the framework's own tunables (prioritizer, confidence, clock). */
import json from '../../../data/coach/tuning/report.json';
import { numbers, section } from './area-tuning';

const FILE = 'data/coach/tuning/report.json';

export interface ReportTuning {
  prioritizer: { maxFixes: number; maxStrengths: number; minConfidence: number };
  confidence: { strengthMaxRank: number; strengthMinLobby: number };
  clock: { roundSec: number; bombSec: number };
}

export function loadReportTuning(j: unknown): ReportTuning {
  return {
    prioritizer: numbers(section(j, 'prioritizer', FILE), ['maxFixes', 'maxStrengths', 'minConfidence'], `${FILE} prioritizer`),
    confidence: numbers(section(j, 'confidence', FILE), ['strengthMaxRank', 'strengthMinLobby'], `${FILE} confidence`),
    clock: numbers(section(j, 'clock', FILE), ['roundSec', 'bombSec'], `${FILE} clock`),
  };
}

export const REPORT_TUNING: ReportTuning = loadReportTuning(json);
