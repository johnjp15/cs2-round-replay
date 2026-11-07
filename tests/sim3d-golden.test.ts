/**
 * H1 acceptance, headless: the 3D host (Sim3DHost, src/sim3d) in the app's Session, through tools/harness3d.ts.
 *
 * - Nobody plays: the round reproduces the recording exactly (all 9 kills on their ticks, every recorded damage, the
 *   plant on 1761, the defuse 3955 → 4275, "Played it like the tape: CT defuse, 0.72 s left"), and against the 2D
 *   golden master (fixtures/golden/round-nohuman) every Core act and every observed field is identical, `sees`
 *   included: since G6 both hosts decide who sees whom with the same MeshSight on the CS2 mesh.
 * - A takeover at 30 s: the first 1,920 log lines are the watching run's, byte for byte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type LogEntry } from '../src/contracts/index';
import { summarize, tickOf } from '../src/core/index';
import { diffLogs } from '../tools/fixture-diff';
import { GOLDEN_DIR, gunzipText, readManifest } from '../tools/golden-fixtures';
import { ROOT, deaths, roundEvents } from '../tools/harness';
import { host3d, loadHarness3dData, runHarness3d } from '../tools/harness3d';

const data = loadHarness3dData();
const watching = runHarness3d(data, { human: null, driver: null, lastTick: 'end', seed: 1 });

const golden = readManifest()?.fixtures.find((f) => f.name === 'round-nohuman');
const goldenEntries: LogEntry[] = gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, golden?.file ?? 'round-nohuman.jsonl.gz')))
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as LogEntry);

describe('Sim3DHost, nobody plays (H1)', () => {
  it('reproduces every recorded kill on its tick', () => {
    expect(deaths(watching.entries).map((d) => `${d.tick} ${d.attacker} -> ${d.victim} ${d.weapon}${d.headshot ? ' HS' : ''}`)).toEqual([
      '32 snarlbot -> incredibad ak47',
      '794 snarlbot -> snakelore ak47',
      '816 lokier -> eradicate ssg08 HS',
      '1142 sp4rtan -> snarlbot deagle',
      '1203 cart -> lokier ak47 HS',
      '2829 barely -> zwomp ak47',
      '3222 sp4rtan -> donk ak47',
      '3766 sp4rtan -> barely ak47 HS',
      '4442 sp4rtan -> cart ak47',
    ]);
  });

  it('applies every recorded damage, and only scripted damage', () => {
    const dmg = watching.entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'damage').map((ev) => ({ tick: e.observe.tick, ev })));
    expect(dmg.every((d) => d.ev.type === 'damage' && d.ev.scripted)).toBe(true);
    const goldenDmg = goldenEntries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'damage').map((ev) => ({ tick: e.observe.tick, ev })));
    expect(dmg).toEqual(goldenDmg);
    // The two non-lethal duels of the breakdown: Lokier's 73 on cart, Sp4rtaN's 27 / 34 / 26 on donk.
    const hits = dmg.map((d) => (d.ev.type === 'damage' ? `${d.ev.attacker}>${d.ev.victim} ${d.ev.amount}/${d.ev.armor}` : ''));
    expect(hits).toContain('lokier>cart 73/7');
    for (const a of ['27', '34', '26']) expect(hits.some((h) => h.startsWith(`sp4rtan>donk ${a}/`))).toBe(true);
  });

  it('plants on 1761, defuses 3955 → 4275 and plays like the tape', () => {
    const bomb = roundEvents(watching.entries).map((e) => `${e.tick} ${e.kind}`);
    expect(bomb).toEqual(['1761 bomb planted', '3955 bomb defuse_start', '4275 bomb defused', '4275 round_end']);
    const end = watching.entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'round_end').map((ev) => ({ tick: e.observe.tick, ev })));
    expect(end.map((x) => (x.ev.type === 'round_end' ? `${x.tick} ${x.ev.winner} ${x.ev.reason}` : ''))).toEqual(['4275 CT bomb_defused']);
    expect(summarize(watching.model, watching.entries).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
  });

  it('matches the 2D golden master in every act and every observed field, sees included (G6: one MeshSight)', () => {
    const d = diffLogs(goldenEntries, watching.entries);
    expect(d.lines).toEqual({ old: 4517, new: 4517 });
    expect(d.acts.count).toBe(0);
    expect(d.controls).toBe(0);
    expect(d.pawnFields).toEqual({});
    expect(d.events).toEqual({});
    expect(d.round.count).toBe(0);
    expect(d.seesOnly).toBe(0);
    console.log(`3D vs 2D golden: identical; digest ${golden?.digest} (2D) vs ${watching.log.digest()} (3D)`);
  });

  it('fires the puppets’ bullets in 3D but blocks their damage (the scripted damage is the recording)', () => {
    // The engine traced every puppet shot; blocked hits are in the combat log, never applied.
    // G6: plus the audit of scripted hits whose eye-to-victim line crosses a wall (the same 9 as in 2D, docs/vision.md).
    const lines = host3d(watching).combatLog();
    expect(lines.every((l) => l.text.startsWith('blocked ') || l.text.startsWith('script: scripted hit through geometry: '))).toBe(true);
    expect(lines.filter((l) => l.text.startsWith('script: ')).map((l) => l.tick)).toEqual([32, 816, 1142, 1184, 1203, 2829, 3194, 3206, 3766]);
  });
});

describe('Sim3DHost takeover (H1, as G4 in 2D)', () => {
  it('a takeover at 30 s leaves the first 1,920 lines byte-identical to the watching run', () => {
    const at = tickOf(30);
    expect(at).toBe(1920);
    const r = runHarness3d(data, { human: 'cart', driver: null, lastTick: 'end', seed: 1, takeover: at });
    const a = watching.log.lines();
    const b = r.log.lines();
    expect(b.length).toBe(a.length);
    for (let k = 0; k < at; k++) if (a[k] !== b[k]) throw new Error(`line ${k} differs`);
    expect(b[at]).not.toBe(a[at]);
    const o = r.entries[at]?.observe;
    expect(o?.human).toBe('cart');
  });
});
