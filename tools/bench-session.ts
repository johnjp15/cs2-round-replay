/**
 * Cost of one Session.step() over a full round, in Node (docs/app.md "Worker decision").
 *
 *   npx tsx tools/bench-session.ts [--runs 3]
 *
 * Two Cores, both spectating (no human, so Core drives all ten pawns):
 * - `B1 core`: the Core as it is (pawns stand still after the setup).
 * - `running`: a test-only Core whose pawns all run (forward 1, a little strafe, turning), so every
 *   tick runs ten full movement steps with wall clamping. A stand-in for B2's walking puppets.
 * Each run steps the recording's length (meta.durationSec × 64 ticks), timing every step.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { Observe, PawnInput, PawnObs } from '../src/contracts/index';
import { ReplayCore } from '../src/core/index';
import { Session, defaultCore, parseSessionData, type CoreFactory } from '../src/app/session';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

class RunningCore extends ReplayCore {
  protected override pawnInput(p: PawnObs, o: Observe): PawnInput {
    const i = o.pawns.findIndex((q) => q.id === p.id);
    return { id: p.id, forward: 1, side: 0.3, yaw: (o.tick * 1.5 + i * 36) % 360, pitch: 0, buttons: [] };
  }
}

const running: CoreFactory = (p) => new RunningCore(p.model, p.schedule, p.tuning, p.seed);

function pct(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

function bench(name: string, core: CoreFactory, runs: number): void {
  const data = parseSessionData(read('../data/round.json'), read('../data/mirage-nav.json'), read('../data/tuning.json'), read('../data/mirage-vismask.json'));
  const ticks = Math.round(data.round.meta.durationSec * 64);
  for (let r = 0; r < runs; r++) {
    const s = new Session({ ...data, seed: 1, human: null, core });
    const times = new Float64Array(ticks);
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) {
      const a = performance.now();
      s.step();
      times[i] = performance.now() - a;
    }
    const total = performance.now() - t0;
    const sorted = times.slice().sort();
    const text = s.log().toText();
    const r0 = performance.now();
    const snap = s.snapshot();
    const fresh = new Session({ ...data, seed: 1, human: null, core });
    fresh.restore(snap);
    const restoreMs = performance.now() - r0;
    console.log(
      `${name.padEnd(8)} run ${r + 1}: ${ticks} ticks in ${total.toFixed(0)} ms | ` +
        `mean ${(total / ticks).toFixed(3)} p50 ${pct(sorted, 0.5).toFixed(3)} p90 ${pct(sorted, 0.9).toFixed(3)} ` +
        `p99 ${pct(sorted, 0.99).toFixed(3)} p99.9 ${pct(sorted, 0.999).toFixed(3)} max ${(sorted[ticks - 1] as number).toFixed(3)} ms | ` +
        `log ${(text.length / 1e6).toFixed(1)} MB | restore ${restoreMs.toFixed(0)} ms`,
    );
  }
}

const arg = process.argv.indexOf('--runs');
const runs = arg >= 0 ? Number(process.argv[arg + 1]) : 3;
console.log(`Node ${process.version}`);
bench('B1 core', defaultCore, runs);
bench('running', running, runs);
