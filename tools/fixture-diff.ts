/**
 * Compare two SessionLog fixtures (or logs) line by line and say what changed, split into what the Core does (its
 * acts) and what the engine reports (the observes): pawn fields (sees separately), events by type, the round state.
 * For explaining a digest change (docs/golden.md "Updating fixtures").
 *
 *   npx tsx tools/fixture-diff.ts <old.jsonl[.gz]> <new.jsonl[.gz]>
 *   git show main:fixtures/golden/round-nohuman.jsonl.gz > /tmp/old.jsonl.gz
 *   npx tsx tools/fixture-diff.ts /tmp/old.jsonl.gz fixtures/golden/round-nohuman.jsonl.gz
 *
 * Exits 1 if any act differs (the Core behaved differently), else 0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { stableStringify, type LogEntry, type ObsEvent, type PawnObs } from '../src/contracts/index';

export interface FixtureDiff {
  readonly lines: { readonly old: number; readonly new: number };
  /** Lines whose act differs, and the first such tick. */
  readonly acts: { readonly count: number; readonly first: number | null };
  /**
   * V2: per act part (`input.<field>` of the pawn inputs, `actions` by type, `status`): lines where it differs, and the
   * first tick. A look change alone shows as input.yaw / input.pitch plus input.forward / input.side (the stick is
   * relative to the yaw; the world move is the same, so `pos` stays equal).
   */
  readonly actFields: Readonly<Record<string, { count: number; first: number }>>;
  readonly controls: number;
  /** Per pawn field (pos, hp, sees, …): lines where some pawn's value differs, and the first tick. */
  readonly pawnFields: Readonly<Record<string, { count: number; first: number }>>;
  /** Per event type: lines whose events of that type differ, and the first tick. */
  readonly events: Readonly<Record<string, { count: number; first: number }>>;
  /** Lines whose observe.round differs. */
  readonly round: { readonly count: number; readonly first: number | null };
  /** Lines whose observe differs only in `sees`. */
  readonly seesOnly: number;
}

function readLog(path: string): LogEntry[] {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

function bump(m: Record<string, { count: number; first: number }>, key: string, tick: number): void {
  const e = m[key];
  if (e === undefined) m[key] = { count: 1, first: tick };
  else e.count++;
}

export function diffLogs(a: readonly LogEntry[], b: readonly LogEntry[]): FixtureDiff {
  let acts = 0;
  let firstAct: number | null = null;
  let controls = 0;
  let rounds = 0;
  let firstRound: number | null = null;
  let seesOnly = 0;
  const pawnFields: Record<string, { count: number; first: number }> = {};
  const events: Record<string, { count: number; first: number }> = {};
  const actFields: Record<string, { count: number; first: number }> = {};
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as LogEntry;
    const y = b[i] as LogEntry;
    const tick = y.observe.tick;
    if (stableStringify(x.act) !== stableStringify(y.act)) {
      acts++;
      firstAct ??= tick;
      const af = new Set<string>();
      const ia = x.act.inputs;
      const ib = y.act.inputs;
      if (ia.length !== ib.length) af.add('inputs (count)');
      ia.forEach((p, k) => {
        const q = ib[k];
        if (q === undefined) return;
        for (const key of new Set([...Object.keys(p), ...Object.keys(q)]) as Set<keyof typeof p>) if (stableStringify(p[key]) !== stableStringify(q[key])) af.add(`input.${String(key)}`);
      });
      for (const t of new Set([...x.act.actions, ...y.act.actions].map((e) => e.type))) {
        if (stableStringify(x.act.actions.filter((e) => e.type === t)) !== stableStringify(y.act.actions.filter((e) => e.type === t))) af.add(`actions.${t}`);
      }
      if (stableStringify(x.act.status) !== stableStringify(y.act.status)) af.add('status');
      for (const f of af) bump(actFields, f, tick);
    }
    if (stableStringify(x.controls) !== stableStringify(y.controls)) controls++;
    const fields = new Set<string>();
    x.observe.pawns.forEach((p, k) => {
      const q = y.observe.pawns[k] as PawnObs;
      for (const key of Object.keys(p) as (keyof PawnObs)[]) if (stableStringify(p[key]) !== stableStringify(q[key])) fields.add(key);
    });
    for (const f of fields) bump(pawnFields, f, tick);
    const types = new Set([...x.observe.events, ...y.observe.events].map((e) => e.type));
    let evDiff = false;
    for (const t of types) {
      const ex = x.observe.events.filter((e: ObsEvent) => e.type === t);
      const ey = y.observe.events.filter((e: ObsEvent) => e.type === t);
      if (stableStringify(ex) !== stableStringify(ey)) {
        bump(events, t, tick);
        evDiff = true;
      }
    }
    const roundDiff = stableStringify(x.observe.round) !== stableStringify(y.observe.round);
    if (roundDiff) {
      rounds++;
      firstRound ??= tick;
    }
    const other = stableStringify({ ...x.observe, pawns: x.observe.pawns.map((p) => ({ ...p, sees: [] })) }) !== stableStringify({ ...y.observe, pawns: y.observe.pawns.map((p) => ({ ...p, sees: [] })) });
    if (fields.has('sees') && !other && !evDiff && !roundDiff) seesOnly++;
  }
  return { lines: { old: a.length, new: b.length }, acts: { count: acts, first: firstAct }, actFields, controls, pawnFields, events, round: { count: rounds, first: firstRound }, seesOnly };
}

export function formatDiff(d: FixtureDiff): string {
  const lines = [
    `lines: ${d.lines.old} → ${d.lines.new}`,
    `Core acts that differ: ${d.acts.count}${d.acts.first === null ? '' : ` (first at tick ${d.acts.first})`}; controls: ${d.controls}`,
    `act parts (lines that differ, first tick): ${Object.keys(d.actFields).length === 0 ? 'none' : Object.entries(d.actFields).map(([k, v]) => `${k} ${v.count} (${v.first})`).join(', ')}`,
    `observe, pawn fields (lines that differ, first tick): ${Object.keys(d.pawnFields).length === 0 ? 'none' : Object.entries(d.pawnFields).map(([k, v]) => `${k} ${v.count} (${v.first})`).join(', ')}`,
    `observe, events by type: ${Object.keys(d.events).length === 0 ? 'none' : Object.entries(d.events).map(([k, v]) => `${k} ${v.count} (${v.first})`).join(', ')}`,
    `observe.round: ${d.round.count}${d.round.first === null ? '' : ` (first at tick ${d.round.first})`}`,
    `lines that differ only in sees: ${d.seesOnly}`,
  ];
  return lines.join('\n');
}

function main(): void {
  const [oldPath, newPath] = process.argv.slice(2);
  if (oldPath === undefined || newPath === undefined) {
    console.error('usage: npx tsx tools/fixture-diff.ts <old.jsonl[.gz]> <new.jsonl[.gz]>');
    process.exit(2);
  }
  const d = diffLogs(readLog(oldPath), readLog(newPath));
  console.log(formatDiff(d));
  if (d.acts.count > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
