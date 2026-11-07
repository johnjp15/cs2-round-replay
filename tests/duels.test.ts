/**
 * G5 acceptance: the recorded duels of the human (docs/core.md "Recorded duels of the human"), through the headless
 * harness (the app's Session with the real Core and Sim2DHost, seed 1). Once the player controls cart he never fires
 * by himself; while he is in one of cart's recorded duels his bullets on its target do no engine damage and the
 * recorded outcome is applied to them (Lokier's headshot kill on its tick; no damage on sp4rtan). Outside a duel his
 * bullets are real. Timelines: `npx vitest run tests/duels.test.ts --reporter=verbose`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, replay, SessionLog, stableStringify, type LogEntry, type ObsEvent } from '../src/contracts/index';
import { ReplayCore, summarize, tickOf } from '../src/core/index';
import { walkQueryOf } from '../src/app/index';
import { FOLLOW_SCRIPT, playScript } from '../tools/follow-script';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, formatTimeline, liveSwitches, loadScenario, timeline } from '../tools/human-bot';
import { formatViolations, reactViolations } from '../tools/react-check';

const data = loadHarnessData();
const golden = runHarness(data, NO_HUMAN);
const LOKIER_HIT = 1184;
const LOKIER_KILL = 1203;

function scenario(name: string): HarnessRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const run = runHarness(data, { human: s.human, driver: HumanBot.fromScenario(data, s), lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, takeover: s.takeover === null ? null : tickOf(s.takeover) });
  console.log(`[scenario ${name}] ${s.description}\n${formatTimeline(timeline(run.entries).filter((t) => t.kind !== 'dropped'))}\n`);
  reactRuns.push({ name, run });
  return run;
}

/** G7: this file's scenario runs, for the react invariant (tools/react-check.ts) at the end. */
const reactRuns: { name: string; run: HarnessRun }[] = [];

/** Every death as `tick killer>victim weapon[ HS]`, in order. */
const killKeys = (r: HarnessRun): string[] => deaths(r.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim} ${d.weapon ?? '-'}${d.headshot ? ' HS' : ''}`);
const eventsOf = <T extends ObsEvent['type']>(r: HarnessRun, type: T): (Extract<ObsEvent, { type: T }> & { tick: number })[] => {
  const out: (Extract<ObsEvent, { type: T }> & { tick: number })[] = [];
  for (const e of r.entries) for (const ev of e.observe.events) if (ev.type === type) out.push({ ...(ev as Extract<ObsEvent, { type: T }>), tick: e.observe.tick });
  return out;
};
const duelLogs = (r: HarnessRun): { tick: number; text: string }[] => coreLogs(r.entries).filter((l) => l.text.startsWith('duel '));
const damageOn = (r: HarnessRun, attacker: string, victim: string) => eventsOf(r, 'damage').filter((d) => d.attacker === attacker && d.victim === victim);

describe('the recorded duels of the round', () => {
  it('cart has three, from his engagements: Lokier at the window (it answers Lokier’s encounter), the defuse spray and the post-round shots at sp4rtan', () => {
    const core = new ReplayCore(golden.model, golden.session.schedule, data.tuning, 1, walkQueryOf(data));
    const enc = core.divergence.encounters[0];
    const d = core.duels.duels.map((x) => ({ key: x.key, target: x.target, weapon: x.weapon, aim: x.aimKey, from: x.fromTick, to: x.toTick, shots: [x.firstShotTick, x.lastShotTick], hits: x.hits.map((h) => `${h.tick} ${h.weapon} ${h.hitgroup}${h.lethal ? ' lethal' : ''}`), encounter: x.encounter, cycle: x.cycleTicks }));
    expect(d).toEqual([
      { key: 'duel:0', target: 'lokier', weapon: 'ak47', aim: 'aim:4', from: 1161, to: 1215, shots: [1185, 1216], hits: ['1203 ak47 head lethal'], encounter: 'enc:0', cycle: 7 },
      { key: 'duel:1', target: 'sp4rtan', weapon: 'ak47', aim: 'aim:10', from: 4195, to: 4281, shots: [4218, 4282], hits: [], encounter: null, cycle: 7 },
      { key: 'duel:2', target: 'sp4rtan', weapon: 'ak47', aim: 'aim:11', from: 4371, to: 4433, shots: [4395, 4433], hits: [], encounter: null, cycle: 7 },
    ]);
    // The Lokier duel's spot is the encounter's (cart at the recorded hit), so both agree on "at the spot".
    expect(core.duels.duels[0]?.spot).toEqual(enc?.spot);
    // Nobody plays in the golden master: the duels never act (no duel log, no block of a pair with cart after the setup).
    expect(duelLogs(golden)).toEqual([]);
    expect(eventsOf(golden, 'blocked_hit')).toEqual([]);
  });
});

describe('tape-identical input reproduces the tape (fixtures/scripts/cart-follows-recording.json)', () => {
  const run = playScript(data, readFileSync(`${ROOT}/${FOLLOW_SCRIPT}`, 'utf8'));
  console.log(`[follow-recording]\n${formatTimeline(timeline(run.entries).filter((t) => t.kind !== 'dropped'))}\n`);

  it('"Played it like the tape: CT defuse, 0.72 s left": all nine recorded kills on their recorded ticks, nobody LIVE', () => {
    expect(summarize(run.model, run.entries).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
    expect(killKeys(run)).toEqual(killKeys(golden));
    expect(killKeys(run)).toContain(`${LOKIER_KILL} cart>lokier ak47 HS`);
    expect(killKeys(run)).toContain('4442 sp4rtan>cart ak47');
    expect(liveSwitches(run.entries)).toEqual([]);
    // Lokier's recorded hit lands on its tick (he sees cart on course at the window: the recorded tick), 73 / 7.
    expect(damageOn(run, 'lokier', 'cart')).toEqual([expect.objectContaining({ tick: LOKIER_HIT, amount: 73, armor: 7, scripted: true, weapon: 'ssg08' })]);
    expect((run.entries[LOKIER_HIT] as LogEntry).observe.pawns.find((p) => p.id === 'cart')).toMatchObject({ hp: 27, armor: 93 });
  });

  it('the duel with Lokier: his shots before 18.80 s do nothing; his spray is on Lokier through it, so the recorded kill lands on 18.80 s', () => {
    // Only the duel's kill hurts Lokier: a scripted AK-47 headshot on the recorded tick.
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ tick: LOKIER_KILL, scripted: true, weapon: 'ak47', hitgroup: 'head' })]);
    const blocked = eventsOf(run, 'blocked_hit').filter((e) => e.victim === 'lokier');
    expect(blocked.length).toBeGreaterThan(0);
    for (const b of blocked) expect(b.tick).toBeLessThan(LOKIER_KILL);
    const logs = duelLogs(run).filter((l) => l.text.startsWith('duel cart -> lokier'));
    expect(logs.map((l) => l.tick)).toEqual([1126, LOKIER_KILL - 1, LOKIER_KILL]);
    expect(logs[0]?.text).toBe('duel cart -> lokier: in the recorded duel from tick 1126 (+0.0 s against the recording, to tick 1215); his shots on lokier land as recorded: kill (ak47, head) at tick 1203');
    expect(logs[1]?.text).toMatch(/^duel cart -> lokier: his spray is on lokier through the recorded kill \(ak47, head\) \(on target at tick \d+, still firing at tick \d+\): it lands at tick 1203 \(recorded 1203\)$/);
    // The block is in force from the sighting at the window to the kill.
    const blocks = run.entries.flatMap((e) => e.act.actions.filter((a) => (a.type === 'block_damage' || a.type === 'unblock_damage') && a.attacker === 'cart' && a.victim === 'lokier').map((a) => `${e.observe.tick} ${a.type}`));
    expect(blocks).toEqual(['1126 block_damage', `${LOKIER_KILL} unblock_damage`]);
  });

  it('the sprays at sp4rtan (the defuse, after the round) do no damage, as on the tape: he defuses and kills cart after the round', () => {
    expect(damageOn(run, 'cart', 'sp4rtan')).toEqual([]);
    const sp = duelLogs(run).filter((l) => l.text.startsWith('duel cart -> sp4rtan'));
    expect(sp.map((l) => l.tick)).toEqual([4195, 4283, 4371, 4435]);
    expect(sp[0]?.text).toContain('his shots on sp4rtan land as recorded: no damage');
    expect(eventsOf(run, 'bomb').find((b) => b.phase === 'defused')?.tick).toBe(4275);
  });

  it('replays identically through a fresh Core; a Core snapshot mid-duel (the kill due) continues exactly; a resync there re-blocks the duel', () => {
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, data.tuning, 1, walkQueryOf(data));
    const log = SessionLog.fromText(run.log.toText());
    expect(replay(log, fresh())).toMatchObject({ identical: true, mismatchCount: 0 });
    const at = LOKIER_KILL - 4;
    const a = fresh();
    for (let i = 0; i < at; i++) {
      const e = log.at(i) as LogEntry;
      for (const c of e.controls) a.control(c);
      a.step(e.observe);
    }
    const b = fresh();
    b.restore(a.snapshot());
    for (let i = at; i < at + 64; i++) {
      const e = log.at(i) as LogEntry;
      expect(stableStringify(canonicalize(b.step(e.observe)))).toBe(stableStringify(e.act));
    }
    // A resync rewind to that point (no engine snapshot, as in CS2): the prefix blocks cart → lokier again.
    const c = fresh();
    c.restore(a.snapshot());
    c.control({ type: 'rewind', id: 'mid-duel' });
    const act = c.step((log.at(at) as LogEntry).observe);
    const cartLokier = act.actions.filter((x) => (x.type === 'block_damage' || x.type === 'unblock_damage') && x.attacker === 'cart' && x.victim === 'lokier');
    expect(cartLokier.map((x) => x.type)).toEqual(['block_damage']);
  });
});

describe('perfect aim from his very first shot (duel-perfect-aim)', () => {
  const run = scenario('duel-perfect-aim');

  it('Lokier’s hit lands first; every shot before 18.80 s would have hit and does nothing; the kill lands on 18.80 s, not on his first shot', () => {
    const shots = eventsOf(run, 'shot').filter((s) => s.shooter === 'cart' && s.tick < LOKIER_KILL);
    const blocked = eventsOf(run, 'blocked_hit').filter((e) => e.victim === 'lokier');
    console.log(`[duel-perfect-aim] cart's shots before the kill: ${shots.map((s) => s.tick).join(' ')}; would hit: ${blocked.map((b) => `${b.tick} ${b.hitgroup}`).join(', ')}`);
    // He opened fire before the tape's first shot (18.517 s) and his first shot would already have hit, in the head.
    expect(shots[0]?.tick).toBeLessThan(1185);
    expect(blocked[0]).toMatchObject({ tick: shots[0]?.tick, hitgroup: 'head' });
    expect(blocked.length).toBeGreaterThanOrEqual(5);
    expect(damageOn(run, 'lokier', 'cart')).toEqual([expect.objectContaining({ tick: LOKIER_HIT, amount: 73, scripted: true })]);
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ tick: LOKIER_KILL, scripted: true, hitgroup: 'head' })]);
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ tick: LOKIER_KILL, attacker: 'cart', weapon: 'ak47', headshot: true });
  });

  it('nobody goes LIVE, and the round is the tape', () => {
    expect(liveSwitches(run.entries)).toEqual([]);
    expect(killKeys(run)).toEqual(killKeys(golden));
    expect(summarize(run.model, run.entries).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
  });
});

describe('outside the duel his bullets are real (early-peek-lokier)', () => {
  const run = scenario('early-peek-lokier');

  it('shot from the Apartments corridor at 16.4 s, before Lokier has seen him at the window: Lokier dies to his real bullet then', () => {
    const k = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(k).toMatchObject({ attacker: 'cart', weapon: 'ak47' });
    expect(k?.tick).toBeLessThan(1126);
    expect(damageOn(run, 'cart', 'lokier').every((d) => !d.scripted)).toBe(true);
    // No duel with Lokier (it never started: the encounter was still waiting), no blocked shot, no hit on cart.
    expect(duelLogs(run).filter((l) => l.text.startsWith('duel cart -> lokier'))).toEqual([]);
    expect(eventsOf(run, 'blocked_hit').filter((e) => e.victim === 'lokier')).toEqual([]);
    expect(damageOn(run, 'lokier', 'cart')).toEqual([]);
    expect(coreLogs(run.entries).some((l) => l.text === `encounter lokier -> cart: over at tick ${k?.tick ?? 0}, lokier is dead`)).toBe(true);
  });

  it('the rest of the round goes on: CT defuse; the kill of Lokier is moved, not forced', () => {
    const s = summarize(run.model, run.entries);
    expect(s.result).toMatchObject({ winner: 'CT', reason: 'bomb_defused' });
    expect(s.kills.find((x) => x.victim === 'lokier')).toMatchObject({ status: 'shifted', killer: 'cart' });
    console.log(`[early-peek-lokier] ${s.headline}; switches ${liveSwitches(run.entries).map((x) => `${x.id}@${x.tick} ${x.trigger}`).join(', ')}`);
  });
});

describe('a takeover mid-duel (takeover-mid-duel, 18.6 s)', () => {
  const run = scenario('takeover-mid-duel');

  it('watching to 18.6 s is the golden master; from the takeover the duel’s rules apply: he keeps spraying, the kill lands on 18.80 s', () => {
    const k = tickOf(18.6);
    const lines = run.log.lines();
    const goldenLines = golden.log.lines();
    for (let i = 0; i < k; i++) expect(lines[i] === goldenLines[i], `line ${i}`).toBe(true);
    expect(duelLogs(run).filter((l) => l.text.startsWith('duel cart -> lokier')).map((l) => l.tick)).toEqual([k, LOKIER_KILL - 1, LOKIER_KILL]);
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ tick: LOKIER_KILL, scripted: true, hitgroup: 'head' })]);
    expect(liveSwitches(run.entries)).toEqual([]);
    expect(summarize(run.model, run.entries).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
  });
});

describe('G7: if they can attack, they do (tools/react-check.ts), over this file’s scenarios', () => {
  it('no alive REPLAY bot has an off-script enemy in sight for more than a reaction time unless the recording covers it', () => {
    expect(reactRuns.length).toBeGreaterThanOrEqual(3);
    for (const { name, run } of reactRuns) {
      const v = reactViolations(run, data.tuning);
      console.log(`[react ${name}] ${v.length} violations${v.length > 0 ? `\n${formatViolations(v)}` : ''}`);
      expect([name, v]).toEqual([name, []]);
    }
  });
});
