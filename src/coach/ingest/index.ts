export { ingestMatch, reasonName } from './ingest';
export { segmentRounds } from './rounds';
export type { RoundSegment, Segmentation } from './rounds';
export { aliveTimeline, isAlive, playedRounds, roundAtTick, roundRows } from './access';
export { computeScoreboard, EXACT_KEYS, reconcile, STAT_KEYS } from './validate';
export type { ReconRow, Reconciliation, StatKey, StatLine } from './validate';
