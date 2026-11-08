/**
 * G6: every scenario (fixtures/scenarios/*.json) and the no-human round through the harness, one block each: the
 * summary's headline, the kills, LIVE switches, and the engine's `script: scripted hit through geometry` audit lines
 * (docs/vision.md). For before/after tables when sight or aim changes.
 *
 *   npx tsx tools/scenario-outcomes.ts [--map <id>] [name …]
 */
import { readdirSync } from 'node:fs';
import { summarize } from '../src/core/index';
import { tickOf } from '../src/core/index';
import { NO_HUMAN, ROOT, deaths, loadHarnessData, runHarness, type HarnessRun } from './harness';
import { HumanBot, liveSwitches, loadScenario } from './human-bot';
import { parseMapId } from '../src/contracts/maps';

/**
 * Audit lines that are a known CS2-vs-2020 map difference, not a position error (docs/vision.md): the window duel's
 * scripted hits, with cart and Lokier at their video-fitted positions (tools/sight-snap.ts MAP_DIFFERENCES).
 */
const MAP_DIFFERENCE_AUDIT: readonly { pair: string; tick: number }[] = [
  { pair: 'lokier -> cart', tick: 1184 },
  { pair: 'cart -> lokier', tick: 1203 },
];

export function auditLabel(text: string): string {
  const known = MAP_DIFFERENCE_AUDIT.some((k) => text.includes(`: ${k.pair} `) && text.includes(` at tick ${k.tick} `));
  return known ? `${text} [known CS2-vs-2020 map difference: the Apartments window over B; not a position error]` : text;
}

function report(name: string, run: HarnessRun): void {
  const host = run.host as unknown as { combatLog?: () => readonly { tick: number; text: string }[] };
  const audit = (host.combatLog?.() ?? []).filter((l) => l.text.startsWith('script: scripted hit through geometry'));
  console.log(`## ${name}`);
  console.log(`headline: ${summarize(run.model, run.entries).headline}`);
  console.log(`kills: ${deaths(run.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}`).join(', ')}`);
  console.log(`LIVE: ${liveSwitches(run.entries).map((s) => `${s.tick} ${s.id} (${s.trigger ?? '?'})`).join(', ') || 'none'}`);
  for (const l of audit) console.log(`  ${auditLabel(l.text)}`);
  console.log('');
}

const argv = process.argv.slice(2);
const mapAt = argv.indexOf('--map');
const data = loadHarnessData(ROOT, parseMapId(mapAt < 0 ? null : argv[mapAt + 1]));
const only = mapAt < 0 ? argv : argv.filter((_a, i) => i !== mapAt && i !== mapAt + 1);
if (only.length === 0 || only.includes('nohuman')) report('nohuman', runHarness(data, NO_HUMAN));
for (const f of readdirSync(`${ROOT}/fixtures/scenarios`).filter((x) => x.endsWith('.json')).sort()) {
  const name = f.replace(/\.json$/, '');
  if (only.length > 0 && !only.includes(name)) continue;
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${f}`);
  const bot = HumanBot.fromScenario(data, s);
  report(name, runHarness(data, { human: s.human, driver: bot, lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, takeover: s.takeover === null ? null : tickOf(s.takeover) }));
}
