/**
 * G6: every scenario (fixtures/scenarios/*.json) and the no-human round through the harness, one block each: the
 * summary's headline, the kills, LIVE switches, and the engine's `script: scripted hit through geometry` audit lines
 * (docs/vision.md). For before/after tables when sight or aim changes.
 *
 *   npx tsx tools/scenario-outcomes.ts [name …]
 */
import { readdirSync } from 'node:fs';
import { summarize } from '../src/core/index';
import { tickOf } from '../src/core/index';
import { NO_HUMAN, ROOT, deaths, loadHarnessData, runHarness, type HarnessRun } from './harness';
import { HumanBot, liveSwitches, loadScenario } from './human-bot';

function report(name: string, run: HarnessRun): void {
  const host = run.host as unknown as { combatLog?: () => readonly { tick: number; text: string }[] };
  const audit = (host.combatLog?.() ?? []).filter((l) => l.text.startsWith('script: scripted hit through geometry'));
  console.log(`## ${name}`);
  console.log(`headline: ${summarize(run.model, run.entries).headline}`);
  console.log(`kills: ${deaths(run.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}`).join(', ')}`);
  console.log(`LIVE: ${liveSwitches(run.entries).map((s) => `${s.tick} ${s.id} (${s.trigger ?? '?'})`).join(', ') || 'none'}`);
  for (const l of audit) console.log(`  ${l.text}`);
  console.log('');
}

const data = loadHarnessData();
const only = process.argv.slice(2);
if (only.length === 0 || only.includes('nohuman')) report('nohuman', runHarness(data, NO_HUMAN));
for (const f of readdirSync(`${ROOT}/fixtures/scenarios`).filter((x) => x.endsWith('.json')).sort()) {
  const name = f.replace(/\.json$/, '');
  if (only.length > 0 && !only.includes(name)) continue;
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${f}`);
  const bot = HumanBot.fromScenario(data, s);
  report(name, runHarness(data, { human: s.human, driver: bot, lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, takeover: s.takeover === null ? null : tickOf(s.takeover) }));
}
