/**
 * V1 · the recorded round in 3D vs the tape (docs/golden.md): the no-human Sim3DHost run must end "Played it like the
 * tape: CT defuse, 0.72 s left" with the nine kills on the recording's ticks, the plant on 1761 and the defuse
 * 3955 → 4275. Exits non-zero on any difference.
 *
 *   npx tsx tools/e2e/round.ts        (npm run test:e2e:round)
 */
import { summarize as summarizeRound } from '../../src/core/index';
import { summarize } from '../harness';
import { loadHarness3dData, runHarness3d } from '../harness3d';

const KILLS = [32, 794, 816, 1142, 1203, 2829, 3222, 3766, 4442];
const HEADLINE = 'Played it like the tape: CT defuse, 0.72 s left';

const data = loadHarness3dData();
const t0 = Date.now();
const run = runHarness3d(data, { human: null, driver: null, seed: 1, lastTick: 'end', takeover: null });
const s = summarize(run, null);
const headline = summarizeRound(run.model, run.entries).headline;
const kills = s.deaths.map((d) => d.tick);
const bomb = s.bomb.map((b) => `${b.phase}@${b.tick}`);
const problems: string[] = [];
if (headline !== HEADLINE) problems.push(`headline "${headline}" ≠ "${HEADLINE}"`);
if (JSON.stringify(kills) !== JSON.stringify(KILLS)) problems.push(`kills ${kills.join(', ')} ≠ ${KILLS.join(', ')}`);
for (const want of ['planted@1761', 'defuse_start@3955', 'defused@4275']) if (!bomb.includes(want)) problems.push(`bomb: no ${want} (${bomb.join(', ')})`);
console.log(`3D no-human run: ${s.ticks} ticks, digest ${s.digest}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  ${headline}`);
console.log(`  kills ${kills.join(', ')}; bomb ${bomb.join(', ')}`);
if (problems.length > 0) {
  console.error(`FAIL:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('OK: the 3D round plays like the tape.');
