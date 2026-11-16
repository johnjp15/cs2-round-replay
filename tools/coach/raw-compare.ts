/**
 * Column-by-column and event-by-event comparison of two `RawDemo`s (the browser parser against the native Node
 * adapter). Used by tests/coach/parser-conformance.test.ts and tools/coach/parser-conformance.ts.
 *
 * Rules: integer columns and strings must be equal; floats are equal when both are NaN or |a − b| ≤ `floatTol`
 * (default 1e-4: both parsers decode the same 32-bit values, so in practice they are identical). Events are compared
 * list by list; inside one tick the order of records may differ between parsers (the native adapter sorts
 * demoparser2's grouped-by-type output by tick; the WebAssembly side keeps the demo's own order), so records of the
 * same tick are compared as sorted sets. `header.parser` is not compared.
 *
 * Velocity: demoparser2 derives it from the previous ticks' positions. The native adapter parses multi-threaded (the
 * demo is split at its full packets, every 3840 ticks) and in 4000-tick chunks, so its first one or two ticks after
 * each split have no history and are NaN; the WebAssembly parser runs one continuous pass and has a value there.
 * The other way round, after one of the demo's own skipped ticks the single pass gives NaN where the native split has
 * a value. `nanOk` lists the columns where NaN on one side against a number on the other is accepted and only counted
 * (`nanAccepted`: 659 of 566,250 velocity cells on the test demo).
 */
import { PLAYER_COLUMNS, TICK_COLUMNS } from '../../src/coach/model/raw';
import type { RawDemo } from '../../src/coach/model/raw';

export interface CompareOptions {
  floatTol?: number;
  /** Stop listing differences after this many (counts are still complete). */
  maxDiffs?: number;
  /** Columns where NaN on one side vs a number on the other is accepted (default vx, vy, vz). */
  nanOk?: string[];
}

export interface CompareResult {
  diffs: string[];
  /** Per tick column: number of differing cells. */
  columnMismatches: Record<string, number>;
  /** Largest float difference seen per float column (finite pairs). */
  maxFloatDiff: Record<string, number>;
  checked: { cells: number; events: number };
  /** Per column: cells with NaN on exactly one side (accepted, see nanOk). */
  nanAccepted: Record<string, number>;
}

const isFloat = (a: ArrayLike<number>): boolean => a instanceof Float32Array || a instanceof Float64Array;

function eqNum(a: number, b: number, tol: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= tol;
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'number') return Number.isNaN(x) ? 'NaN' : Math.round(x * 1e4) / 1e4;
    if (ArrayBuffer.isView(x)) return Array.from(x as unknown as ArrayLike<number>);
    return x;
  });
}

function deepEq(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return eqNum(a, b, tol);
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const x = a as unknown as ArrayLike<number>, y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!eqNum(x[i] ?? 0, y[i] ?? 0, tol)) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEq(v, b[i], tol));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return false;
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol));
  }
  return a === b;
}

export function compareRawDemos(a: RawDemo, b: RawDemo, opts: CompareOptions = {}): CompareResult {
  const tol = opts.floatTol ?? 1e-4;
  const max = opts.maxDiffs ?? 50;
  const diffs: string[] = [];
  const add = (s: string): void => { if (diffs.length < max) diffs.push(s); };
  const res: CompareResult = { diffs, columnMismatches: {}, maxFloatDiff: {}, checked: { cells: 0, events: 0 }, nanAccepted: {} };
  const nanOkCols = new Set(opts.nanOk ?? ['vx', 'vy', 'vz']);

  if (a.format !== b.format) add(`format ${a.format} vs ${b.format}`);
  const ha = { ...a.header, parser: '' }, hb = { ...b.header, parser: '' };
  if (!deepEq(ha, hb, 0)) add(`header ${canon(ha)} vs ${canon(hb)}`);
  if (!deepEq(a.players, b.players, 0)) add(`players differ: ${a.players.length} vs ${b.players.length}`);
  if (!deepEq(a.names, b.names, 0)) add(`names differ: weapons ${canon(a.names.weapons)} vs ${canon(b.names.weapons)}; places ${a.names.places.length} vs ${b.names.places.length}`);

  if (a.ticks.count !== b.ticks.count) add(`ticks.count ${a.ticks.count} vs ${b.ticks.count}`);
  const cols = [...Object.keys(TICK_COLUMNS), ...Object.keys(PLAYER_COLUMNS)] as (keyof typeof TICK_COLUMNS | keyof typeof PLAYER_COLUMNS)[];
  const P = a.players.length;
  for (const k of cols) {
    const x = a.ticks[k], y = b.ticks[k];
    if (x.constructor !== y.constructor) add(`ticks.${k}: ${x.constructor.name} vs ${y.constructor.name}`);
    if (x.length !== y.length) { add(`ticks.${k}: length ${x.length} vs ${y.length}`); continue; }
    const fl = isFloat(x);
    let bad = 0, worst = 0, filled = 0;
    const nanOk = nanOkCols.has(k);
    for (let i = 0; i < x.length; i++) {
      const u = x[i] ?? 0, v = y[i] ?? 0;
      let ok = fl ? eqNum(u, v, tol) : u === v;
      if (!ok && nanOk && Number.isNaN(v) !== Number.isNaN(u)) { ok = true; filled++; }
      if (fl && Number.isFinite(u) && Number.isFinite(v)) worst = Math.max(worst, Math.abs(u - v));
      if (!ok) {
        if (bad < 3) {
          const per = k in TICK_COLUMNS ? 1 : P;
          add(`ticks.${k}[${i}] (t=${Math.floor(i / per)}, tick ${a.ticks.tick[Math.floor(i / per)]}, p=${i % per}): ${u} vs ${v}`);
        }
        bad++;
      }
    }
    res.checked.cells += x.length;
    if (bad > 0) res.columnMismatches[k] = bad;
    if (filled > 0) res.nanAccepted[k] = filled;
    if (fl) res.maxFloatDiff[k] = worst;
  }

  for (const k of Object.keys(a.events) as (keyof RawDemo['events'])[]) {
    const x = a.events[k] as unknown as { tick: number }[], y = b.events[k] as unknown as { tick: number }[];
    if (x.length !== y.length) add(`events.${k}: ${x.length} vs ${y.length}`);
    const n = Math.min(x.length, y.length);
    let bad = 0;
    for (let i = 0; i < n;) {
      // the block of records with the same tick (in a)
      let j = i;
      const t = x[i]?.tick;
      while (j < n && x[j]?.tick === t) j++;
      const bx = x.slice(i, j).map(canon).sort(), by = y.slice(i, j).map(canon).sort();
      for (let q = 0; q < bx.length; q++) {
        if (bx[q] !== by[q]) {
          if (bad < 3) add(`events.${k} at tick ${t}: ${bx[q]} vs ${by[q]}`);
          bad++;
        }
      }
      res.checked.events += j - i;
      i = j;
    }
    if (bad > 0) add(`events.${k}: ${bad} records differ`);
  }

  if (a.projectiles.length !== b.projectiles.length) add(`projectiles: ${a.projectiles.length} vs ${b.projectiles.length}`);
  let pbad = 0;
  for (let i = 0; i < Math.min(a.projectiles.length, b.projectiles.length); i++) {
    if (!deepEq(a.projectiles[i], b.projectiles[i], 0)) {
      if (pbad < 3) add(`projectiles[${i}]: ${canon({ ...a.projectiles[i], path: a.projectiles[i]?.path.length })} vs ${canon({ ...b.projectiles[i], path: b.projectiles[i]?.path.length })}`);
      pbad++;
    }
  }
  if (pbad > 0) add(`projectiles: ${pbad} differ`);
  if (!deepEq(a.inventories, b.inventories, 0)) {
    add(`inventories: ${a.inventories.length} vs ${b.inventories.length}`);
    for (let i = 0, shown = 0; i < Math.min(a.inventories.length, b.inventories.length) && shown < 3; i++) {
      if (!deepEq(a.inventories[i], b.inventories[i], 0)) { add(`inventories[${i}]: ${canon(a.inventories[i])} vs ${canon(b.inventories[i])}`); shown++; }
    }
  }
  if (!deepEq(a.scoreboard, b.scoreboard, tol)) add(`scoreboard: ${canon(a.scoreboard)} vs ${canon(b.scoreboard)}`);
  return res;
}
