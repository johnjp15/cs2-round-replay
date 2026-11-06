/**
 * The committed C# port fixtures (fixtures/golden, docs/golden.md) still hold for the current TypeScript Core and
 * engine. A failure here means the behaviour changed: run `npm run fixtures:update` and explain the diff in the PR.
 *
 * Per fixture: the inputs it was made from are the current data files; the gzip header is platform-free; the
 * content matches the manifest (digest, ticks); every line replays through a fresh Core with an identical act,
 * and the Core asks the walk query exactly the oracle's questions, in order, getting the oracle's answers. The short
 * human fixture is also re-run through the harness (engine included) and must come out byte for byte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLog, fnv1a32Hex, replay, stableStringify, type Vec3, type WalkQuery } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/index';
import { FIXTURE_SPECS, GOLDEN_DIR, gunzipText, parseWalkOracle, readManifest, runFixture, type FixtureEntry, type OracleTick } from '../tools/golden-fixtures';
import { ROOT, canonicalHash, loadHarnessData, logDigest } from '../tools/harness';

const data = loadHarnessData();
const manifest = readManifest();
const STALE = 'run `npm run fixtures:update` and explain the diff in the PR';

/**
 * The 2D nav walk query, checked against the oracle: every call must be the oracle's next call for the tick the
 * Core is stepping (coordinates compared as the log writes them), and the answers must agree.
 */
class OracleWalk implements WalkQuery {
  tick = -1;
  private next = 0;
  private readonly calls: { tick: number; a: Vec3; b: Vec3; walkable: boolean }[];
  private readonly nav: NavWalkQuery;
  problems: string[] = [];
  count = 0;

  constructor(oracle: readonly OracleTick[], nav: NavWalkQuery) {
    this.calls = oracle.flatMap((t) => t.calls.map((c) => ({ tick: t.tick, a: c.a, b: c.b, walkable: c.walkable })));
    this.nav = nav;
  }

  isWalkableLine(a: Vec3, b: Vec3): boolean {
    const want = this.calls[this.next++];
    const real = this.nav.isWalkableLine(a, b);
    this.count++;
    if (this.problems.length < 5) {
      const q = stableStringify({ a, b, tick: this.tick });
      if (want === undefined) this.problems.push(`extra call ${q}`);
      else if (q !== stableStringify({ a: want.a, b: want.b, tick: want.tick })) this.problems.push(`call ${this.next - 1}: ${q} != oracle ${stableStringify(want)}`);
      else if (real !== want.walkable) this.problems.push(`call ${this.next - 1}: nav says ${real}, oracle ${want.walkable}`);
    }
    return real;
  }

  get remaining(): number {
    return this.calls.length - this.next;
  }
}

/** Replay a log, telling the oracle walk which tick the Core is on. */
function replayWithOracle(log: SessionLog, f: FixtureEntry, oracle: readonly OracleTick[]): { result: ReturnType<typeof replay>; walk: OracleWalk } {
  const walk = new OracleWalk(oracle, new NavWalkQuery(data.nav));
  const core = new ReplayCore(new RoundModel(data.round), new EventSchedule(data.round), data.tuning, f.seed, walk);
  // A thin ICore around the Core that sets the oracle's tick before each step.
  const ticking = {
    step: (o: Parameters<ReplayCore['step']>[0]) => {
      walk.tick = o.tick;
      return core.step(o);
    },
    control: (c: Parameters<ReplayCore['control']>[0]) => core.control(c),
    snapshot: () => core.snapshot(),
    restore: (s: Parameters<ReplayCore['restore']>[0]) => core.restore(s),
  };
  return { result: replay(log, ticking), walk };
}

describe('fixtures/golden/manifest.json', () => {
  it('lists every fixture spec, and the committed fixtures stay under 3 MB', () => {
    expect(manifest, `${GOLDEN_DIR}/manifest.json is missing: ${STALE}`).not.toBeNull();
    expect(manifest?.fixtures.map((f) => f.name)).toEqual(FIXTURE_SPECS.map((s) => s.name));
    const total = (manifest?.fixtures ?? []).reduce((n, f) => n + f.bytes + f.walkBytes, 0);
    expect(total).toBeLessThan(3_000_000);
  });
});

for (const spec of FIXTURE_SPECS) {
  const f = manifest?.fixtures.find((x) => x.name === spec.name);
  describe(`fixture ${spec.name}`, () => {
    if (f === undefined) {
      it('is in the manifest', () => expect(f, STALE).toBeDefined());
      return;
    }
    const gz = readFileSync(resolve(ROOT, GOLDEN_DIR, f.file));
    const walkGz = readFileSync(resolve(ROOT, GOLDEN_DIR, f.walkFile));
    const text = gunzipText(gz);
    const walkText = gunzipText(walkGz);

    it('was made from the current data files, script and settings', () => {
      expect({ tuning: f.tuningHash, round: f.roundHash, nav: f.navHash, vision: f.visionHash }, STALE).toEqual({
        tuning: canonicalHash(data.sources.tuning),
        round: canonicalHash(data.sources.round),
        nav: canonicalHash(data.sources.nav),
        vision: canonicalHash(data.sources.vision),
      });
      expect(f.scriptHash, STALE).toBe(spec.script === null ? null : canonicalHash(readFileSync(resolve(ROOT, spec.script), 'utf8')));
      expect({ human: f.human, script: f.script, seed: f.seed, until: f.until }, STALE).toEqual({ human: spec.human, script: spec.script, seed: spec.seed, until: spec.until });
    });

    it('is gzip with a fixed header (no mtime, no file name, OS unknown) and matches the manifest', () => {
      for (const b of [gz, walkGz]) expect([...b.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
      expect({ bytes: gz.length, walkBytes: walkGz.length }).toEqual({ bytes: f.bytes, walkBytes: f.walkBytes });
      expect(fnv1a32Hex(text)).toBe(f.digest);
      expect(fnv1a32Hex(walkText)).toBe(f.walkDigest);
      expect(Buffer.byteLength(text, 'utf8')).toBe(f.rawBytes);
      const log = SessionLog.fromText(text);
      // Canonical text: re-serializing every line gives the same bytes.
      expect(log.digest()).toBe(f.digest);
      expect(log.length).toBe(f.ticks);
      expect([log.at(0)?.observe.tick, log.at(log.length - 1)?.observe.tick]).toEqual([f.firstTick, f.lastTick]);
      // One line per tick, no gaps or repeats: a port must feed every one.
      for (let i = 0; i < log.length; i++) expect(log.at(i)?.observe.tick).toBe(f.firstTick + i);
    });

    it('replays identically through a fresh Core, asking the walk oracle’s questions in order', () => {
      const oracle = parseWalkOracle(walkText);
      expect(oracle.reduce((n, t) => n + t.calls.length, 0)).toBe(f.walkCalls);
      const { result, walk } = replayWithOracle(SessionLog.fromText(text), f, oracle);
      expect(result.diffs.slice(0, 1), STALE).toEqual([]);
      expect(result).toMatchObject({ identical: true, mismatchCount: 0, ticks: f.ticks });
      expect(walk.problems, STALE).toEqual([]);
      expect({ count: walk.count, remaining: walk.remaining }).toEqual({ count: f.walkCalls, remaining: 0 });
    });

    if (spec.human !== null) {
      it('comes out byte for byte when the harness runs it again (engine included)', () => {
        const run = runFixture(data, spec);
        expect(logDigest(run.log), STALE).toBe(f.digest);
        expect(fnv1a32Hex(run.log.toText())).toBe(f.digest);
      });
    }
  });
}
