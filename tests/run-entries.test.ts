/**
 * P1: the end-of-round summary off the frame's hot path (src/app/run-entries.ts). Regression for "when the round ends,
 * the game gets super laggy": the 3D page ran summarize(model, log) (~200 ms, mostly parsing the log's JSON lines)
 * on every frame from 2 s after the round end. The cache parses the log a few lines per frame, computes the summary
 * once per key, and gives the same summary as summarize(model, log).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLog } from '../src/contracts/index';
import { RoundModel, summarize } from '../src/core/index';
import { RunEntries, SummaryCache } from '../src/app/run-entries';
import { GOLDEN_DIR, gunzipText } from '../tools/golden-fixtures';
import { ROOT, loadHarnessData } from '../tools/harness';

const data = loadHarnessData();
const model = new RoundModel(data.round);
const golden = SessionLog.fromText(gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, 'round-nohuman.jsonl.gz'))));

/** A clock that advances 1 ms per reading. */
function fakeClock(): () => number {
  let t = 0;
  return () => t++;
}

describe('RunEntries', () => {
  it('parses within the budget, a little per call, until caught up', () => {
    const r = new RunEntries();
    expect(r.behind(golden)).toBe(golden.length);
    // Budget 3 ms on a clock that ticks 1 ms per reading: 3 lines per call.
    expect(r.sync(golden, 3, fakeClock())).toBe(false);
    expect(r.entries).toHaveLength(3);
    expect(r.behind(golden)).toBe(golden.length - 3);
    expect(r.sync(golden, Infinity)).toBe(true);
    expect(r.entries).toHaveLength(golden.length);
    expect(r.entries[100]).toEqual(golden.at(100));
  });

  it('keeps the parsed prefix across a rewind (SessionLog.head) and re-parses only what changed', () => {
    const r = new RunEntries();
    r.sync(golden, Infinity);
    const first = r.entries[0];
    const cut = golden.head(1000);
    expect(r.sync(cut, 0)).toBe(true);
    expect(r.entries).toHaveLength(1000);
    expect(r.entries[0]).toBe(first);
    // A different log of the same length: nothing in common past the first differing line.
    const other = SessionLog.fromText(golden.lines().slice(1, 11).join('\n'));
    r.sync(other, Infinity);
    expect(r.entries).toEqual([...Array(10).keys()].map((i) => other.at(i)));
  });
});

describe('SummaryCache', () => {
  it('gives the same summary as summarize(model, log)', () => {
    const c = new SummaryCache();
    expect(c.get(model, golden, 'k', Infinity)).toEqual(summarize(model, golden));
  });

  it('returns null while catching up, then computes once per key', () => {
    const c = new SummaryCache();
    let frames = 0;
    let s = c.get(model, golden, 'end|9', 0);
    while (s === null) {
      frames++;
      s = c.get(model, golden, 'end|9', 0);
    }
    // Budget 0: at least one line per frame, so it caught up in about as many frames as lines (never all at once).
    expect(frames).toBeGreaterThan(100);
    // Every later frame with the same key: the cached object, no work.
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) expect(c.get(model, golden, 'end|9')).toBe(s);
    expect(performance.now() - t0).toBeLessThan(50);
    // A new key (a post-round death) recomputes; invalidate (a rewind before the end) forgets it.
    const s2 = c.get(model, golden, 'end|10');
    expect(s2).not.toBe(s);
    expect(s2).toEqual(s);
    c.invalidate();
    expect(c.get(model, golden, 'end|10')).not.toBe(s2);
  });
});

describe('the apps never summarize on the frame path', () => {
  it('src/app3d/main.ts and src/app/main.ts call summarize() only from the window test hooks', () => {
    for (const file of ['src/app3d/main.ts', 'src/app/main.ts']) {
      const calls = readFileSync(resolve(ROOT, file), 'utf8')
        .split('\n')
        .filter((l) => /\bsummarize\(/.test(l) && !/^\s*(\/\/|\/?\*)/.test(l));
      expect(calls.every((l) => /^\s*summary: \(\) => summarize\(/.test(l)), `${file}: ${calls.join(' | ')}`).toBe(true);
    }
  });
});
