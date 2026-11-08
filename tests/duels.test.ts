/**
 * The recorded duels of the human (docs/core.md "Recorded duels of the human"), through the headless harness (the app's
 * Session with the real Core and Sim2DHost, seed 1). Once the player controls cart he never fires by himself. G5 resolved
 * his shots in a recorded duel like the tape (no damage until the tape's kill tick); D1 (John 2026-11-07 13:10): they do
 * real CS2 damage at once, there too. A kill before the tape's, inside the drift window, leaves the rest of the round on
 * script. Timelines: `npx vitest run tests/duels.test.ts --reporter=verbose`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, replay, SessionLog, stableStringify, type LogEntry, type ObsEvent } from '../src/contracts/index';
import { ReplayCore, summarize, tickOf } from '../src/core/index';
import { walkQueryOf } from '../src/app/index';
import { FOLLOW_SCRIPT, playScript } from '../tools/follow-script';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, formatTimeline, liveSwitches, loadScenario, parseScenario, timeline, type Scenario } from '../tools/human-bot';
import { formatViolations, reactViolations } from '../tools/react-check';

const data = loadHarnessData();
const golden = runHarness(data, NO_HUMAN);
const LOKIER_HIT = 1184;
const LOKIER_KILL = 1203;

function scenario(name: string, s: Scenario = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`)): HarnessRun {
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

describe('tape-identical input (fixtures/scripts/cart-follows-recording.json): the rest of the round stays on script', () => {
  const run = playScript(data, readFileSync(`${ROOT}/${FOLLOW_SCRIPT}`, 'utf8'));
  console.log(`[follow-recording]\n${formatTimeline(timeline(run.entries).filter((t) => t.kind !== 'dropped'))}\n`);
  const FOLLOW_KILL = 1191;

  it('"Same result, different round: CT defuse, 0.72 s left; 1 kill changed": his real headshot kills Lokier 0.19 s early, every other kill on its tick, nobody LIVE', () => {
    // D1: before, "Played it like the tape" (the duel held the kill to 18.80 s).
    expect(summarize(run.model, run.entries).headline).toBe('Same result, different round: CT defuse, 0.72 s left; 1 kill changed');
    expect(killKeys(run).filter((k) => !k.includes('>lokier'))).toEqual(killKeys(golden).filter((k) => !k.includes('>lokier')));
    expect(killKeys(run)).toContain(`${FOLLOW_KILL} cart>lokier ak47 HS`);
    expect(killKeys(run)).toContain('4442 sp4rtan>cart ak47');
    expect(liveSwitches(run.entries)).toEqual([]);
    // Lokier's recorded hit lands on its tick (he sees cart on course at the window: the recorded tick), 73 / 7, first.
    expect(damageOn(run, 'lokier', 'cart')).toEqual([expect.objectContaining({ tick: LOKIER_HIT, amount: 73, armor: 7, scripted: true, weapon: 'ssg08' })]);
    expect((run.entries[LOKIER_HIT] as LogEntry).observe.pawns.find((p) => p.id === 'cart')).toMatchObject({ hp: 27, armor: 93 });
    expect(eventsOf(run, 'bomb').map((b) => `${b.tick} ${b.phase}`)).toEqual(expect.arrayContaining(['1761 planted', '3955 defuse_start', '4275 defused']));
  });

  it('the duel with Lokier: his shots are real at once (the engine’s damage, no block, no scripted kill)', () => {
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ tick: FOLLOW_KILL, scripted: false, weapon: 'ak47', hitgroup: 'head', amount: 100 })]);
    expect(eventsOf(run, 'blocked_hit')).toEqual([]);
    const blocks = run.entries.flatMap((e) => e.act.actions.filter((a) => (a.type === 'block_damage' || a.type === 'unblock_damage') && a.attacker === 'cart' && a.victim === 'lokier').map((a) => `${e.observe.tick} ${a.type}`));
    expect(blocks).toEqual([]);
    const logs = duelLogs(run).filter((l) => l.text.startsWith('duel cart -> lokier'));
    // V2: from 1163 (main 1138): Lokier (SSG 08, slower than a walk) holds his angle instead of spinning to his
    // jiggle's heading, so he first sees cart when his aim turns to him. F1: 1138 again: he holds the window from 1.5 s
    // before the recorded sighting (the encounter's lead-in), so he sees cart the moment he is in sight there.
    expect(logs.map((l) => l.tick)).toEqual([1138, FOLLOW_KILL]);
    expect(logs[0]?.text).toBe('duel cart -> lokier: in the recorded duel from tick 1138 (+0.0 s against the recording, to tick 1215); his shots on lokier are real (the tape: kill (ak47, head) at tick 1203)');
    expect(logs[1]?.text).toBe("duel cart -> lokier: over at tick 1191, lokier is dead (cart's kill, -0.2 s against the tape's kill at tick 1203); 1 hit on lokier in it");
  });

  it('the sprays at sp4rtan (the defuse, after the round) are real and miss, as on the tape: he defuses and kills cart after the round', () => {
    expect(damageOn(run, 'cart', 'sp4rtan')).toEqual([]);
    const sp = duelLogs(run).filter((l) => l.text.startsWith('duel cart -> sp4rtan'));
    expect(sp.map((l) => l.tick)).toEqual([4195, 4283, 4371, 4435]);
    expect(sp[0]?.text).toContain('his shots on sp4rtan are real (the tape: no damage)');
    expect(eventsOf(run, 'bomb').find((b) => b.phase === 'defused')?.tick).toBe(4275);
  });

  it('replays identically through a fresh Core; a Core snapshot mid-duel continues exactly; a resync there sends no duel block', () => {
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, data.tuning, 1, walkQueryOf(data));
    const log = SessionLog.fromText(run.log.toText());
    expect(replay(log, fresh())).toMatchObject({ identical: true, mismatchCount: 0 });
    const at = FOLLOW_KILL - 4;
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
    // A resync rewind to that point (no engine snapshot, as in CS2): D1, nothing re-blocks cart → lokier (G5 did).
    const c = fresh();
    c.restore(a.snapshot());
    c.control({ type: 'rewind', id: 'mid-duel' });
    const act = c.step((log.at(at) as LogEntry).observe);
    expect(act.actions.some((x) => x.type === 'block_damage' && x.attacker === 'cart' && x.victim === 'lokier')).toBe(false);
  });
});

describe('perfect aim from his very first shot (duel-perfect-aim)', () => {
  const run = scenario('duel-perfect-aim');

  it('a headshot at 18.05 s kills Lokier at 18.05 s, before his hit: the hit never lands', () => {
    // D1: before, his shots were blocked and the kill landed on the tape's 18.80 s, after Lokier's hit.
    const shots = eventsOf(run, 'shot').filter((s) => s.shooter === 'cart');
    expect(shots[0]?.tick).toBeLessThan(1185);
    expect(eventsOf(run, 'blocked_hit')).toEqual([]);
    const k = deaths(run.entries).find((d) => d.victim === 'lokier');
    // His first shot kills on the observe that reports it (the engine's hit lands in the same tick).
    expect(k).toMatchObject({ tick: shots[0]?.tick, attacker: 'cart', weapon: 'ak47', headshot: true });
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ scripted: false, hitgroup: 'head' })]);
    expect(damageOn(run, 'lokier', 'cart')).toEqual([]);
    expect(coreLogs(run.entries).some((l) => l.text === `encounter lokier -> cart: over at tick ${k?.tick ?? 0}, lokier is dead`)).toBe(true);
  });

  it('nobody goes LIVE; the rest is on script: plant, defuse, every other kill on its tick (cart, on 100 HP, survives the post-round shot)', () => {
    expect(liveSwitches(run.entries)).toEqual([]);
    expect(killKeys(run).filter((k) => !k.includes('>lokier'))).toEqual(killKeys(golden).filter((k) => !k.includes('>lokier') && !k.includes('>cart')));
    expect(summarize(run.model, run.entries).headline).toBe('Same result, different round: CT defuse, 0.72 s left; 2 kills changed');
  });
});

describe('D1: he kills Lokier at 18.2 s, 0.6 s before the tape, inside the drift window (inline from duel-perfect-aim)', () => {
  const base = loadScenario(`${ROOT}/fixtures/scenarios/duel-perfect-aim.json`);
  const steps = base.steps.map((st, i) => (i === 0 && st.do === 'followRecording' ? { ...st, until: 18.15 } : st));
  const run = scenario('duel-kill-18.2', parseScenario({ ...base, name: 'duel-kill-18.2', description: 'D1: as duel-perfect-aim, but he stops at 18.15 s and kills Lokier with a real headshot about 18.2 s.', steps }));

  it('Lokier dies to his real headshot about 18.2 s; nobody LIVE; plant 1761, defuse 3955 → 4275 and every other kill on its tick', () => {
    const k = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(k).toMatchObject({ attacker: 'cart', headshot: true });
    expect(Math.abs((k?.tick ?? 0) - tickOf(18.2))).toBeLessThanOrEqual(4);
    expect(liveSwitches(run.entries)).toEqual([]);
    expect(eventsOf(run, 'bomb').map((b) => `${b.tick} ${b.phase}`)).toEqual(expect.arrayContaining(['1761 planted', '3955 defuse_start', '4275 defused']));
    // Lokier dies before his hit is due, so cart keeps 100 HP and survives sp4rtan's post-round shot (the second change).
    expect(killKeys(run).filter((x) => !x.includes('>lokier'))).toEqual(killKeys(golden).filter((x) => !x.includes('>lokier') && !x.includes('>cart')));
    expect(summarize(run.model, run.entries).result).toMatchObject({ winner: 'CT', reason: 'bomb_defused', endTick: 4275 });
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

  it('watching to 18.6 s is the golden master; from the takeover his shots are real: he keeps spraying and kills Lokier at once', () => {
    const k = tickOf(18.6);
    const lines = run.log.lines();
    const goldenLines = golden.log.lines();
    for (let i = 0; i < k; i++) expect(lines[i] === goldenLines[i], `line ${i}`).toBe(true);
    // D1: his first shot after the takeover is a real headshot (G5: the kill held to 18.80 s).
    const kill = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(kill).toMatchObject({ attacker: 'cart', headshot: true });
    expect(kill?.tick).toBeLessThan(LOKIER_KILL);
    expect(duelLogs(run).filter((l) => l.text.startsWith('duel cart -> lokier')).map((l) => l.tick)).toEqual([k, kill?.tick]);
    expect(damageOn(run, 'cart', 'lokier')).toEqual([expect.objectContaining({ tick: kill?.tick, scripted: false, hitgroup: 'head' })]);
    expect(liveSwitches(run.entries)).toEqual([]);
    // Lokier's hit landed on the puppet (27 HP), so the post-round kill of cart still happens: only Lokier's kill moved.
    expect(summarize(run.model, run.entries).headline).toBe('Same result, different round: CT defuse, 0.72 s left; 1 kill changed');
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
