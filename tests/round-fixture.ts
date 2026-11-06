/** Loads data/round.json and data/tuning.json for Core tests (file I/O stays in tests). */
import { readFileSync } from 'node:fs';
import { parseRound, parseTuning, type RoundData, type Tuning } from '../src/contracts/index';

export const ROUND_TEXT = readFileSync(new URL('../data/round.json', import.meta.url), 'utf8');
export const TUNING_TEXT = readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8');

export function loadRound(): RoundData {
  return parseRound(JSON.parse(ROUND_TEXT));
}

export function loadTuning(): Tuning {
  return parseTuning(TUNING_TEXT);
}

/** A fresh, mutable deep copy of round.json for negative tests. */
export function roundJson(): Record<string, unknown> {
  return JSON.parse(ROUND_TEXT) as Record<string, unknown>;
}
