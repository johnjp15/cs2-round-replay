/**
 * B4 acceptance: divergence scenarios (fixtures/scenarios/*.json, played by the human-bot, tools/human-bot.ts) through
 * the headless harness, i.e. the app's Session with the real Core and Sim2DHost. Everything is deterministic (seed 1).
 * Each test prints its timeline (switches to LIVE with their triggers, encounters, deaths, the round end): run with
 * `npx vitest run tests/scenarios.test.ts --reporter=verbose`. Where an outcome depends on the 2D engine's toy AI (who
 * wins a LIVE fight), the tests assert the trigger logic and the invariants and print the winner.
 *
 * The invariant every scenario shares ("small drift doesn't spread"): a puppet nothing touched replays exactly. On
 * every tick a pawn is REPLAY and alive both here and in the no-human golden master, has not been body-blocked and
 * has not been LIVE yet, it is where the golden master has it (within 0.01 units). G1: a pawn that rejoined its
 * recording is REPLAY again but catching up from where its LIVE self left it, so it is measured up to its first switch
 * (tests/rejoin.test.ts checks what it does after).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, canonicalize, replay, stableStringify, type DamageEvent, type LogEntry, type Observe, type PlayerId } from '../src/contracts/index';
import { ReplayCore, tickOf } from '../src/core/index';
import { walkQueryOf } from '../src/app/index';
import { FOLLOW_SCRIPT, playScript } from '../tools/follow-script';
import { checkSees, clearAimPoints } from '../tools/sight-check';
import type { MapGeometry } from '../src/sim2d/index';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, ScenarioError, formatTimeline, liveSwitches, loadScenario, parseScenario, rejoins, timeline, type TimelineEvent } from '../tools/human-bot';
import { formatViolations, reactViolations } from '../tools/react-check';

const data = loadHarnessData();
const tuning = data.tuning;
const golden = runHarness(data, NO_HUMAN);
const goldenSnaps = snapTicks(golden);

interface ScenarioRun {
  readonly run: HarnessRun;
  readonly bot: HumanBot;
  readonly tl: readonly TimelineEvent[];
}

/** Every scenario run of this file (and G7: the follow run), for the G6 checks and the G7 react invariant at the end. */
const played: { name: string; run: HarnessRun }[] = [];

function play(name: string): ScenarioRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const bot = HumanBot.fromScenario(data, s);
  const run = runHarness(data, { human: s.human, driver: bot, lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, takeover: s.takeover === null ? null : tickOf(s.takeover) });
  const tl = timeline(run.entries);
  console.log(`[scenario ${name}] ${s.description}\n${formatTimeline(tl)}\n`);
  played.push({ name, run });
  return { run, bot, tl };
}

/**
 * G6: engine bullet hits whose segment (the shooter's eye to where the ray enters the victim's circle, at the hit band's
 * height; positions, yaw and posture as the observe of the hit reports them) crosses a wall of the CS2 mesh: none.
 */
function hitsThroughWalls(run: HarnessRun): string[] {
  const g = data.geometry as MapGeometry;
  const d = tuning.damage;
  const out: string[] = [];
  for (const e of run.entries) {
    for (const ev of e.observe.events) {
      if (ev.type !== 'damage' || ev.scripted || ev.attacker === null || ev.weapon === null || tuning.weapons[ev.weapon] === undefined) continue;
      const a = pawnAt(e, ev.attacker);
      const v = pawnAt(e, ev.victim);
      const rad = (a.yaw * Math.PI) / 180;
      const cx = v.pos.x - a.pos.x;
      const cy = v.pos.y - a.pos.y;
      const along = cx * Math.cos(rad) + cy * Math.sin(rad);
      const perp2 = Math.max(0, cx * cx + cy * cy - along * along);
      const enter = cx * cx + cy * cy <= d.pawnRadius * d.pawnRadius ? 0 : along - Math.sqrt(Math.max(0, d.pawnRadius * d.pawnRadius - perp2));
      const band = (d.bandHeights[ev.hitgroup] ?? 0) * (v.crouching ? d.crouchEyeHeight / d.eyeHeight : 1);
      const eye = a.pos.z + (a.crouching ? d.crouchEyeHeight : d.eyeHeight);
      const f = g.traceSight(a.pos.x, a.pos.y, eye, a.pos.x + Math.cos(rad) * enter, a.pos.y + Math.sin(rad) * enter, v.pos.z + band);
      if (f < 1) out.push(`${e.observe.tick} ${ev.attacker}->${ev.victim} ${ev.weapon} ${ev.hitgroup}`);
    }
  }
  return out;
}

const pawnAt = (e: LogEntry, id: PlayerId): Observe['pawns'][number] => e.observe.pawns.find((p) => p.id === id) as Observe['pawns'][number];
const statusAt = (e: LogEntry, id: PlayerId) => e.act.status.find((s) => s.id === id);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Damage events (with their observe tick). */
function damages(entries: readonly LogEntry[]): (DamageEvent & { tick: number })[] {
  const out: (DamageEvent & { tick: number })[] = [];
  for (const e of entries) for (const ev of e.observe.events) if (ev.type === 'damage') out.push({ ...ev, tick: e.observe.tick });
  return out;
}

/** Ticks (after setup) at which a pawn was teleported (a puppet's snap to its track). */
function snapTicks(run: HarnessRun): Map<PlayerId, number[]> {
  const out = new Map<PlayerId, number[]>();
  run.entries.forEach((e, k) => {
    if (k === 0) return;
    for (const a of e.act.actions) if (a.type === 'teleport') out.set(a.id, [...(out.get(a.id) ?? []), k]);
  });
  return out;
}

/**
 * Per pawn, the largest distance from the golden master's position on ticks it is REPLAY and alive in both runs, not
 * body-blocked yet, not LIVE yet, and (G3) not past a snap the golden master made that this run held back: a puppet
 * never snaps in the human's sight (B2), and on CS2 Mirage the golden master snaps where the recording runs into CS2's
 * walls (docs/core.md "Snaps").
 */
/**
 * The largest distance of each REPLAY pawn from its golden-master position while both runs have it REPLAY and alive,
 * up to its first body block, LIVE switch or missed golden snap: `strict` until the scenario first changes its look
 * (act yaw or pitch), `loose` after. F1: a different look (a dropped fight's pre-aim) rotates the stick, whose 6-decimal
 * rounding can flip a stair step later (barely on the tunnel stairs at 42.8 s when cart has killed Zwomp).
 */
function replayDeviation(run: HarnessRun): { strict: Map<PlayerId, number>; loose: Map<PlayerId, number> } {
  const strict = new Map<PlayerId, number>();
  const loose = new Map<PlayerId, number>();
  const firstBlock = new Map<PlayerId, number>();
  const lookFrom = new Map<PlayerId, number>();
  for (const b of run.bodyBlocks) if (!firstBlock.has(b.id)) firstBlock.set(b.id, b.tick);
  for (const s of liveSwitches(run.entries)) if ((firstBlock.get(s.id) ?? Infinity) > s.tick) firstBlock.set(s.id, s.tick);
  const mine = snapTicks(run);
  for (const [id, ticks] of goldenSnaps) {
    const held = ticks.find((k) => k < run.entries.length && !(mine.get(id) ?? []).includes(k));
    if (held !== undefined && (firstBlock.get(id) ?? Infinity) > held) firstBlock.set(id, held);
  }
  for (let k = 1; k < run.entries.length && k < golden.entries.length; k++) {
    const e = run.entries[k] as LogEntry;
    const g = golden.entries[k] as LogEntry;
    for (const id of PLAYER_IDS) {
      if ((firstBlock.get(id) ?? Infinity) <= k) continue;
      const ie = e.act.inputs.find((q) => q.id === id);
      const ig = g.act.inputs.find((q) => q.id === id);
      if (!lookFrom.has(id) && ie !== undefined && ig !== undefined && (ie.yaw !== ig.yaw || ie.pitch !== ig.pitch)) lookFrom.set(id, k);
      const p = pawnAt(e, id);
      const q = pawnAt(g, id);
      if (statusAt(e, id)?.mode !== 'REPLAY' || statusAt(g, id)?.mode !== 'REPLAY' || !p.alive || !q.alive) continue;
      const out = (lookFrom.get(id) ?? Infinity) <= k ? loose : strict;
      out.set(id, Math.max(out.get(id) ?? 0, dist(p.pos, q.pos)));
    }
  }
  return { strict, loose };
}

function expectUntouchedReplay(run: HarnessRun): void {
  const d = replayDeviation(run);
  for (const [id, x] of d.strict) expect(x, `${id} off the golden master while REPLAY`).toBeLessThan(0.01);
  // One stair step (tuning.movement.stepSize 18) at most once the look differs.
  for (const [id, x] of d.loose) expect(x, `${id} off the golden master while REPLAY, after its look changed`).toBeLessThan(tuning.movement.stepSize);
}

/** The single round_end, checked against the game rules (who is alive, the bomb). */
function expectRoundEndByRules(run: HarnessRun): { tick: number; winner: string; reason: string } {
  const ends: { tick: number; winner: string; reason: string }[] = [];
  for (const e of run.entries) for (const ev of e.observe.events) if (ev.type === 'round_end') ends.push({ tick: e.observe.tick, winner: ev.winner, reason: ev.reason });
  expect(ends).toHaveLength(1);
  const end = ends[0] as { tick: number; winner: string; reason: string };
  const o = (run.entries[end.tick] as LogEntry).observe;
  const alive = (team: string): number => o.pawns.filter((p) => p.team === team && p.alive).length;
  if (end.reason === 'elimination') expect(alive(end.winner === 'T' ? 'CT' : 'T')).toBe(0);
  if (end.reason === 'bomb_exploded') expect(o.events.some((ev) => ev.type === 'bomb' && ev.phase === 'exploded')).toBe(true);
  if (end.reason === 'bomb_defused') expect(o.events.some((ev) => ev.type === 'bomb' && ev.phase === 'defused')).toBe(true);
  expect(run.entries.some((e) => e.act.actions.some((a) => a.type === 'end_round'))).toBe(false);
  return end;
}

/** The switches with their log line's reason. */
function switches(run: HarnessRun): { id: PlayerId; tick: number; trigger: string | null; text: string }[] {
  const logs = coreLogs(run.entries).filter((l) => / LIVE: /.test(l.text));
  return liveSwitches(run.entries).map((s) => ({ ...s, text: logs.find((l) => l.tick === s.tick && l.text.startsWith(`${s.id} LIVE`))?.text ?? '' }));
}

const encounterLogs = (run: HarnessRun): { tick: number; text: string }[] => coreLogs(run.entries).filter((l) => l.text.startsWith('encounter '));
const seenTick = (run: HarnessRun): number | null => {
  const l = encounterLogs(run).find((x) => x.text.includes(' in sight at the spot at tick '));
  return l === undefined ? null : l.tick;
};

/** Recorded deaths and damage not involving `skip` before `until`, as [tick, attacker, victim, amount]. */
function recordedHits(entries: readonly LogEntry[], skip: readonly PlayerId[], until: number): (string | number | null)[][] {
  return damages(entries)
    .filter((d) => d.tick < until && !skip.includes(d.victim) && (d.attacker === null || !skip.includes(d.attacker)))
    .map((d) => [d.tick, d.attacker, d.victim, d.amount]);
}

const LOKIER_DEATH = 1203;
const GRACE = Math.round(tuning.replay.outliveGraceSec * 64);

/**
 * G1: the recorded events that don't involve cart, on the golden master's observe ticks (= the tape's): barely's
 * plant, his kill of Zwomp, sp4rtan's kills of donk and barely, the kit defuse and its round end.
 */
// G3: the plant 7 ticks after the tape's 1761. On CS2 Mirage barely, LIVE after killing Lokier, leaves the Balcony by
// its west end (CS2 walls in the 2020 drop under the Apartments window) and goes round the B-site box the recording
// walks through, so G1's plant shift starts his USE 7 ticks late; everything after it is on the tape's ticks.
// G8: 6 ticks late (1767): his LIVE leg now jumps onto the Balcony's sill at once instead of pushing into it.
const TAPE_AFTER_LOKIER = [
  ['bomb', 1767, 'planted'],
  ['kill', 2829, 'barely>zwomp'],
  ['kill', 3222, 'sp4rtan>donk'],
  ['kill', 3766, 'sp4rtan>barely'],
  ['bomb', 3955, 'defuse_start'],
  ['bomb', 4275, 'defused'],
  ['end', 4275, 'CT bomb_defused'],
];

/** The run's version of TAPE_AFTER_LOKIER (same kinds, its own ticks), for an exact comparison. */
function tapeAfterLokier(run: HarnessRun): (string | number)[][] {
  const out: (string | number)[][] = [];
  for (const e of run.entries) {
    for (const ev of e.observe.events) {
      if (ev.type === 'bomb' && (ev.phase === 'planted' || ev.phase === 'defuse_start' || ev.phase === 'defused')) out.push(['bomb', e.observe.tick, ev.phase]);
      if (ev.type === 'death' && ev.attacker !== null && ev.victim !== 'cart' && ev.attacker !== 'cart' && e.observe.tick > 1300) out.push(['kill', e.observe.tick, `${ev.attacker}>${ev.victim}`]);
      if (ev.type === 'round_end') out.push(['end', e.observe.tick, `${ev.winner} ${ev.reason}`]);
    }
  }
  return out.filter((x) => x[0] !== 'kill' || !String(x[2]).includes('lokier'));
}

describe('scenario files', () => {
  it('parse, and bad ones are refused with the path', () => {
    for (const n of ['lokier-late', 'never-peeks', 'mid-zwomp', 'flank-sp4rtan', 'cart-dies', 'block-barely', 'block-sp4rtan', 'smoke-window', 'cart-goes-a', 'miss-lokier-shop', 'takeover-duel', 'duel-perfect-aim', 'early-peek-lokier', 'takeover-mid-duel', 'peek-before-eradicate', 'window-2s-early', 'window-6s-early', 'kill-lokier-early']) {
      expect(loadScenario(`${ROOT}/fixtures/scenarios/${n}.json`).name).toBe(n);
    }
    expect(() => parseScenario({ steps: [{ do: 'dance' }] })).toThrow(ScenarioError);
    expect(() => parseScenario({ steps: [{ do: 'holdStill' }] })).toThrow(/exactly one of sec, until/);
    expect(() => parseScenario({ steps: [{ do: 'aimAt', id: 'bob' }] })).toThrow(/steps\[0\]\.id/);
    expect(() => parseScenario({ steps: [{ do: 'walkTo', pos: [1, 2], speed: 3 }] })).toThrow(/unknown key "speed"/);
    expect(parseScenario({ steps: [{ do: 'fire' }] }).steps[0]).toEqual({ do: 'fire', untilDead: true, maxSec: 3 });
    expect(parseScenario({ steps: [{ do: 'aimAt', id: 'lokier' }] }).steps[0]).toEqual({ do: 'aimAt', id: 'lokier', band: 'head', offsetDeg: 0 });
  });
});

describe('1. no-op guard', () => {
  it('the golden no-human round: no pawn goes LIVE, no set_mode, no HUMAN status', () => {
    expect(liveSwitches(golden.entries)).toEqual([]);
    expect(golden.entries.some((e) => e.act.actions.some((a) => a.type === 'set_mode' || a.type === 'unblock_damage'))).toBe(false);
    expect(golden.entries.some((e) => e.act.status.some((s) => s.mode === 'HUMAN' || s.trigger !== null))).toBe(false);
  });

  it('cart follows his recording: nobody goes LIVE, and the round is the tape (D1: but his real headshot kills Lokier 0.19 s early)', () => {
    const run = playScript(data, readFileSync(`${ROOT}/${FOLLOW_SCRIPT}`, 'utf8'));
    played.push({ name: 'cart-follows-recording', run });
    const sw = switches(run);
    console.log(`[no-op guard, cart-follows-recording] switches:\n${sw.map((s) => `  ${s.tick} (${(s.tick / 64).toFixed(2)} s) ${s.text}`).join('\n')}\n${formatTimeline(timeline(run.entries))}\n`);
    expect(sw).toEqual([]);
    // Cart's recorded spray during the defuse (65.9–66.9 s, 11 shots, no damage on the tape): the follow script looks
    // where his recorded view does (tools/follow-aim.ts), 17–22° off sp4rtan, so it misses as it did; sp4rtan defuses.
    const spray = run.entries.filter((e) => e.observe.tick >= 4210 && e.observe.tick <= 4290 && e.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === 'cart'));
    expect(spray.length).toBeGreaterThanOrEqual(10);
    expect(damages(run.entries).some((d) => d.attacker === 'cart' && d.victim === 'sp4rtan')).toBe(false);
    const end = expectRoundEndByRules(run);
    expect(end).toEqual({ tick: 4275, winner: 'CT', reason: 'bomb_defused' });
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.score).toEqual({ ct: 12, t: 15 });
    // G5: Lokier sees cart at the window on course, so his hit lands on the recorded tick (18.50 s, 73 / 7). D1 (John
    // 13:10): cart's bullets in the recorded duel are real, so his first would-hit AK bullet kills Lokier at 18.61 s
    // (G5 held the kill to the tape's 18.80 s), after the hit. Every other kill is the golden master's, on its tick, the
    // post-round one on cart included (tests/duels.test.ts has the details).
    const seen = seenTick(run);
    expect(seen).not.toBeNull();
    const key = (r: HarnessRun): string[] => deaths(r.entries).filter((d) => d.victim !== 'lokier').map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim} ${d.weapon ?? '-'}${d.headshot ? ' HS' : ''}`);
    expect(key(run)).toEqual(key(golden));
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ tick: 1191, attacker: 'cart', headshot: true });
    expect(damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart')).toEqual([expect.objectContaining({ tick: 1184, amount: 73, armor: 7, scripted: true })]);
    // Lokier saw cart earlier too (10.9 s, down the corridor from Truck), with cart on course: no divergence.
    expect(run.entries.some((e) => e.observe.tick < 800 && pawnAt(e, 'lokier').sees.includes('cart'))).toBe(true);
    expectUntouchedReplay(run);
    // G6: the window duel is in sight on the CS2 mesh (the duel tracks, docs/vision.md "Recorded duels"): the encounter
    // fires at the window, and cart's kill goes through the window, not a wall. No false sighting, no hit through a wall.
    expect(seen).toBeGreaterThan(1117);
    expect(seen).toBeLessThan(1117 + Math.round(tuning.replay.encounterDelaySec * 64));
    expect(checkSees(run.entries, data.geometry as MapGeometry, tuning).blocked).toEqual([]);
    expect(hitsThroughWalls(run)).toEqual([]);
  });
});

describe('2. cart kills Lokier about 3 s late', () => {
  const { run } = play('lokier-late');

  it('Lokier takes his scripted shot about 1 s after first seeing cart at the window, and cart kills him for real', () => {
    const seen = seenTick(run) as number;
    const delay = Math.round(tuning.replay.encounterDelaySec * 64);
    expect(seen).toBeGreaterThan(1117 + 2 * 64);
    // The first tick Lokier sees cart within humanSpotToleranceUnits of the recorded spot at the window (he may see him
    // a little earlier further along the corridor: an expected pair then, so no divergence).
    const spot = run.core.divergence.encounters[0]?.spot as { x: number; y: number };
    const atSpot = (e: LogEntry): boolean => pawnAt(e, 'lokier').sees.includes('cart') && dist(pawnAt(e, 'cart').pos, spot) <= tuning.replay.humanSpotToleranceUnits;
    expect(atSpot(run.entries[seen] as LogEntry)).toBe(true);
    expect(run.entries.slice(1, seen).some(atSpot)).toBe(false);
    expect(switches(run).some((s) => s.tick < seen)).toBe(false);
    const hit = damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart');
    expect(hit).toEqual([expect.objectContaining({ tick: seen + delay, amount: 73, armor: 7, scripted: true, weapon: 'ssg08' })]);
    expect(pawnAt(run.entries[seen + delay] as LogEntry, 'cart')).toMatchObject({ hp: 27, armor: 93 });
    // The engine's own SSG bullet was blocked for the scripted shot: one hit, and the shot was fired.
    expect((run.entries[seen + delay] as LogEntry).observe.events.some((e) => e.type === 'shot' && e.shooter === 'lokier')).toBe(true);
    const kill = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(kill).toMatchObject({ attacker: 'cart' });
    // G6: his peek spot is in sight of Lokier through the window on the CS2 mesh, so his real headshot kills him (21.42 s)
    // with no recorded duel needed (G5 alone: the duel's scripted kill at 18.80 s + 2.64 s, the old spot behind the sill).
    expect(damages(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ scripted: false, attacker: 'cart', hitgroup: 'head' });
    const late = ((kill?.tick ?? 0) - LOKIER_DEATH) / 64;
    console.log(`[lokier-late] seen ${seen}, scripted hit ${seen + delay}, kill ${kill?.tick} (${late.toFixed(2)} s after the recorded 18.80 s)`);
    expect(late).toBeGreaterThan(2);
    expect(kill?.tick).toBeLessThan(LOKIER_DEATH + GRACE);
  });

  it('nobody else changes mode before the Ts reach B site, and nobody else’s recorded kill or damage moves', () => {
    const sw = switches(run);
    const first = sw[0];
    expect(first === undefined || first.tick > 1761).toBe(true); // the plant, on B site
    // No switch at all: cart's later spray at the defusing sp4rtan misses as on the tape (he follows his recording
    // again, tools/follow-aim.ts), so everything not involving cart and Lokier lands on the golden master's ticks.
    const until = first === undefined ? Infinity : first.tick;
    expect(sw).toEqual([]);
    expect(rejoins(run.entries)).toEqual([]); // G1: unchanged (digest 98c7d557): nobody goes LIVE, so nobody rejoins
    expect(recordedHits(run.entries, ['cart', 'lokier'], until)).toEqual(recordedHits(golden.entries, ['cart', 'lokier'], until));
    const bomb = (r: HarnessRun) => r.entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'bomb' && e.observe.tick < until).map((ev) => [e.observe.tick, ev.type === 'bomb' ? ev.phase : '']));
    expect(bomb(run)).toEqual(bomb(golden));
    expectUntouchedReplay(run);
  });

  it('replays identically through a fresh Core, and a Core snapshot mid-encounter continues exactly', () => {
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, tuning, 1, walkQueryOf(data));
    const log = SessionLog.fromText(run.log.toText());
    expect(replay(log, fresh())).toMatchObject({ identical: true, mismatchCount: 0 });
    const seen = seenTick(run) as number;
    const a = fresh();
    for (let i = 0; i <= seen + 10; i++) {
      const e = log.at(i) as LogEntry;
      for (const c of e.controls) a.control(c);
      a.step(e.observe);
    }
    const b = fresh();
    b.restore(a.snapshot());
    for (let i = seen + 11; i < seen + 300; i++) {
      const e = log.at(i) as LogEntry;
      expect(stableStringify(canonicalize(b.step(e.observe)))).toBe(stableStringify(e.act));
    }
  });
});

describe('3. cart never peeks', () => {
  const { run } = play('never-peeks');

  it('Lokier outlives his recording at 18.8 + 3 s and goes LIVE for good holding B (G8: retake); the Ts walking onto the site see him and go LIVE', () => {
    const sw = switches(run);
    expect(sw[0]).toMatchObject({ id: 'lokier', tick: LOKIER_DEATH + GRACE, trigger: 'outlived' });
    // G8: his fate (cart's kill) is gone: LIVE for good, as a CT survivor: retake (hold where his track ends, on B).
    expect(sw[0]?.text).toBe('lokier LIVE: outlived recording (+3.0 s); goal retake, 0 waypoints');
    const mode = (run.entries[LOKIER_DEATH + GRACE] as LogEntry).act.actions.find((a) => a.type === 'set_mode');
    const last = run.model.track('lokier').at(-1) as { x: number; y: number; z: number };
    expect(mode).toEqual({ type: 'set_mode', id: 'lokier', mode: 'LIVE', goal: { route: [], role: 'retake', hold: { x: last.x, y: last.y, z: last.z } } });
    // Every pawn that goes LIVE while Lokier lives does so because of him: a T that sees him (or hears him fire).
    const lokierDeath = deaths(run.entries).find((d) => d.victim === 'lokier')?.tick as number;
    const during = sw.filter((s) => s.tick > LOKIER_DEATH + GRACE && s.tick <= lokierDeath);
    expect(during.length).toBeGreaterThan(0);
    for (const s of during) {
      expect(['barely', 'donk']).toContain(s.id);
      expect(s.text).toMatch(/LIVE: (sees lokier \(LIVE\)|heard lokier fire)/);
    }
    expect(during[0]).toMatchObject({ id: 'barely', trigger: 'sighting' });
    // The fight is real: Lokier dies to engine damage.
    expect(damages(run.entries).find((d) => d.victim === 'lokier' && d.tick === lokierDeath)?.scripted).toBe(false);
    console.log(`[never-peeks] switches: ${sw.map((s) => `${s.id}@${s.tick} ${s.trigger}`).join(', ')}; Lokier killed by ${deaths(run.entries).find((d) => d.victim === 'lokier')?.attacker} at ${lokierDeath}`);
  });

  it('the round still ends by the game rules', () => {
    const end = expectRoundEndByRules(run);
    console.log(`[never-peeks] round_end at ${end.tick} (${(end.tick / 64).toFixed(2)} s): ${end.winner} ${end.reason}`);
    expectUntouchedReplay(run);
  });

  it('G1: barely (after Lokier) and sp4rtan (after cart) rejoin, so the rest is the tape: CT defuse (B4 alone: T elimination at 59.61 s)', () => {
    expect([...new Set(rejoins(run.entries).map((b) => b.id))]).toEqual(['barely', 'sp4rtan']);
    // T1: barely holds Catwalk now (not the underpass beneath it), so when sp4rtan's gunfire made him LIVE (40.30 s)
    // he saw Zwomp walking up Catwalk on his inferred route and killed him for real at 2650 (41.41 s, tape 2829). G8:
    // calm, he turns at a running player's pace (ai.lookTurnRateDegPerTick) and doesn't catch Zwomp before he is back
    // on his tape: the kill is the tape's again. Everything else is the tape. tests/rejoin.test.ts has the details.
    expect(tapeAfterLokier(run)).toEqual(TAPE_AFTER_LOKIER);
  });
});

describe('4. cart pushes Mid and kills Zwomp around 30 s', () => {
  const { run } = play('mid-zwomp');

  it('Zwomp dies for real; barely’s 44.2 s kill is dropped and barely keeps replaying', () => {
    const z = deaths(run.entries).find((d) => d.victim === 'zwomp');
    expect(z).toMatchObject({ attacker: 'cart' });
    expect(((z?.tick ?? 0) / 64)).toBeGreaterThan(29.5);
    expect(((z?.tick ?? 0) / 64)).toBeLessThan(30.5);
    const texts = coreLogs(run.entries).map((l) => l.text);
    expect(texts).toContain('script: dropped barely ak47 burst at zwomp (7 shots from tick 2789): zwomp is dead');
    expect(texts).toContain('script: dropped damage barely -> zwomp (lethal at tick 2829): zwomp is dead');
    expect(liveSwitches(run.entries).some((s) => s.id === 'barely')).toBe(false);
    expect(deaths(run.entries).find((d) => d.victim === 'barely')).toMatchObject({ tick: 3766, attacker: 'sp4rtan' });
  });

  it('sp4rtan goes LIVE only if he is within hearing range of the shots', () => {
    let min = Infinity;
    for (const e of run.entries) {
      for (const ev of e.observe.events) {
        if (ev.type === 'sound' && ev.kind === 'shot' && ev.source === 'cart') min = Math.min(min, dist(pawnAt(e, 'sp4rtan').pos, ev.pos));
      }
    }
    console.log(`[mid-zwomp] sp4rtan's closest distance to cart's shots: ${min.toFixed(0)} u (hearing range ${tuning.replay.hearingRangeUnits})`);
    const sp = liveSwitches(run.entries).find((s) => s.id === 'sp4rtan');
    if (min > tuning.replay.hearingRangeUnits) expect(sp).toBeUndefined();
    else expect(sp).toMatchObject({ trigger: 'gunfire' });
  });

  it('everything else is unchanged', () => {
    expect(liveSwitches(run.entries).map((s) => s.id)).toEqual(['zwomp']);
    expect(rejoins(run.entries)).toEqual([]); // G1: unchanged (digest 9f45a713): zwomp dies a tick after going LIVE
    expect(recordedHits(run.entries, ['cart', 'lokier', 'zwomp'], Infinity)).toEqual(recordedHits(golden.entries, ['cart', 'lokier', 'zwomp'], Infinity));
    const ev = (r: HarnessRun) => r.entries.flatMap((e) => e.observe.events.filter((x) => x.type === 'bomb' || x.type === 'round_end').map((x) => [e.observe.tick, JSON.stringify(x)]));
    expect(ev(run)).toEqual(ev(golden));
    expectRoundEndByRules(run);
    expectUntouchedReplay(run);
  });
});

describe('5. cart catches sp4rtan on his flank around 45 s', () => {
  const { run } = play('flank-sp4rtan');

  it('sp4rtan dies; donk and barely survive their recorded deaths and go LIVE for good (G8: fate, execute: guard the bomb); T elimination, 11 – 16', () => {
    const sp = deaths(run.entries).find((d) => d.victim === 'sp4rtan');
    expect(sp).toMatchObject({ attacker: 'cart' });
    expect(Math.abs((sp?.tick ?? 0) / 64 - 45)).toBeLessThan(1);
    // G1: unchanged (digest 1f63a158): sp4rtan dies, donk and barely have no tape left (outlived), so nobody rejoins.
    expect(rejoins(run.entries)).toEqual([]);
    const sw = switches(run).filter((s) => s.id !== 'sp4rtan');
    // G8: their killer (sp4rtan) is a puppet, so their fate is gone one tick after the recorded death (before G8:
    // outlived, 3 s later, standing at the end of their tracks meanwhile); the survivor's role is execute (the bomb is
    // planted: guard it).
    expect(sw.map((s) => [s.id, s.tick, s.trigger])).toEqual([
      ['donk', 3222 + 1, 'fate'],
      ['barely', 3766 + 1, 'fate'],
    ]);
    for (const s of sw) {
      const set = (run.entries[s.tick] as LogEntry).act.actions.find((a) => a.type === 'set_mode' && a.id === s.id);
      expect(set?.type === 'set_mode' ? set.goal?.role : null).toBe('execute');
    }
    const end = expectRoundEndByRules(run);
    expect(end).toEqual({ tick: sp?.tick, winner: 'T', reason: 'elimination' });
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.score).toEqual({ ct: 11, t: 16 });
    expectUntouchedReplay(run);
  });

  it('after the round the bomb still ticks: the LIVE guards leave its blast and survive it (they used to die in it)', () => {
    const blast = run.entries.find((e) => e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'exploded')) as LogEntry;
    expect(blast.observe.tick).toBe(4321);
    const bomb = blast.observe.round.bomb.pos as { x: number; y: number; z: number };
    for (const id of ['donk', 'barely'] as const) {
      const p = pawnAt(blast, id);
      const d = Math.hypot(p.pos.x - bomb.x, p.pos.y - bomb.y, p.pos.z - bomb.z);
      console.log(`[flank-sp4rtan] ${id} at the explosion: ${d.toFixed(0)} u from the bomb, ${p.hp} HP`);
      expect(p.alive, id).toBe(true);
    }
    expect(deaths(run.entries).filter((d) => d.victim === 'donk' || d.victim === 'barely')).toEqual([]);
    // donk (LIVE from 50.36 s; 53.3 s before G8) is out of the radius; barely (from 58.86 s; 61.8 s before G8) too.
    const donk = pawnAt(blast, 'donk');
    expect(Math.hypot(donk.pos.x - bomb.x, donk.pos.y - bomb.y, donk.pos.z - bomb.z)).toBeGreaterThanOrEqual(tuning.bomb.radius);
  });
});

describe('6. cart dies early', () => {
  const { run } = play('cart-dies');

  it('G7: at the window 9.4 s before the recorded sighting, beyond encounterWindowSec: the encounter is cancelled, no scripted 73, Lokier goes LIVE on that tick (a real fight)', () => {
    // Before G7 the encounter time-shifted the recorded hit to 9.02 s (cart 27 HP) and Lokier only went LIVE when cart
    // walked off the window at 10.4 s.
    const enc = encounterLogs(run);
    expect(enc[0]?.text).toMatch(/^encounter lokier -> cart: cancelled at tick \d+, cart in sight at the spot -9\.\d s against the recording, beyond the encounter window \(3\.0 s\): a real fight$/);
    expect(seenTick(run)).toBeNull();
    expect(damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart' && d.scripted)).toEqual([]);
    const lk = switches(run).find((s) => s.id === 'lokier');
    expect(lk).toMatchObject({ trigger: 'sighting', tick: enc[0]?.tick });
    expect(lk?.text).toMatch(/^lokier LIVE: sees cart \(the human\), not in the recording/);
    console.log(`[cart-dies] cancelled at ${enc[0]?.tick}, lokier LIVE ${lk?.tick}; kills: ${deaths(run.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}`).join(', ')}`);
  });

  it('G1/G6/G7: Lokier kills cart for real, rejoins and kills eradicate on the tape’s tick; barely kills the outlived Lokier and rejoins; the rest is the tape', () => {
    const death = deaths(run.entries).find((d) => d.victim === 'cart');
    expect(death).toMatchObject({ attacker: 'lokier', weapon: 'ssg08' });
    expect(damages(run.entries).find((d) => d.victim === 'cart' && d.tick === death?.tick)?.scripted).toBe(false);
    expect(rejoins(run.entries).map((b) => b.id)).toEqual(['lokier', 'barely']);
    expect(deaths(run.entries).map((d) => [d.tick, d.attacker, d.victim])).toContainEqual([816, 'lokier', 'eradicate']);
    const lk = switches(run).filter((s) => s.id === 'lokier');
    expect(lk.map((s) => s.trigger)).toEqual(['sighting', 'outlived']);
    expect(lk[1]?.tick).toBe(LOKIER_DEATH + GRACE);
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ attacker: 'barely' });
    expect(tapeAfterLokier(run)).toEqual(TAPE_AFTER_LOKIER);
  });

  it('the round continues and every untouched puppet still replays', () => {
    const death = deaths(run.entries).find((d) => d.victim === 'cart')?.tick as number;
    const end = expectRoundEndByRules(run);
    // G7: cart may live to the end of the round (he dies in the bomb's blast on its tick).
    expect(end.tick).toBeGreaterThanOrEqual(death);
    // Recorded events between puppets that nothing reached land on the recorded ticks: snarlbot's two kills,
    // sp4rtan's kill of snarlbot, barely's plant.
    const ticks = deaths(run.entries).map((d) => [d.tick, d.attacker, d.victim]);
    for (const k of [[32, 'snarlbot', 'incredibad'], [794, 'snarlbot', 'snakelore'], [1142, 'sp4rtan', 'snarlbot']]) expect(ticks).toContainEqual(k);
    // G6: barely's plant is 7 ticks late (1768, the tape's 1761), as in never-peeks: he went LIVE for the outlived Lokier.
    // G8: 6 ticks (1767), as in never-peeks.
    expect(run.entries.some((e) => e.observe.tick === 1767 && e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'planted' && ev.id === 'barely'))).toBe(true);
    expectUntouchedReplay(run);
  });
});

describe('7. body block', () => {
  it('cart in barely’s path in the Apartments corridor: teammates are not solid, so barely is never pushed and keeps replaying', () => {
    const { run } = play('block-barely');
    let closest = Infinity;
    for (const e of run.entries) if (pawnAt(e, 'cart').sees.includes('barely')) closest = Math.min(closest, dist(pawnAt(e, 'cart').pos, pawnAt(e, 'barely').pos));
    expect(closest).toBeLessThan(2 * tuning.collision.pawnRadius);
    expect(tuning.collision.solidTeammates).toBe(false);
    expect(run.bodyBlocks.filter((b) => b.id === 'barely')).toEqual([]);
    // barely goes LIVE only when Lokier, who outlived his recording (cart never peeked), comes into his sight.
    const sw = switches(run);
    expect(sw.some((s) => s.trigger === 'blocked')).toBe(false);
    expect(sw.find((s) => s.id === 'barely')?.tick ?? Infinity).toBeGreaterThan(LOKIER_DEATH + GRACE);
    expect(rejoins(run.entries)).toEqual([]); // G1: unchanged (digest cce6b0c0): the scenario ends at 21.5 s, before anyone goes LIVE
    expectUntouchedReplay(run);
  });

  it('G7: cart in sp4rtan’s way to the bomb, face to face where the tape has him in Shop: sp4rtan sees him and fights (sighting), before any body block', () => {
    const { run } = play('block-sp4rtan');
    const sw = switches(run);
    // Before G7 the recorded pair (cart / barely see sp4rtan on B from 58.6 s, ± 2 s) covered the sighting at any
    // range and place, so sp4rtan stood REPLAY with cart in sight (and then in contact) for 2.2 s until the block
    // trigger fired at 59.16 s. Since G7 a recorded pair within closeRangeUnits needs cart about where the tape has him.
    // Then the LIVE sp4rtan's fight goes on: he hits barely (REPLAY: LIVE by damage) and kills him 0.3 s before the tape.
    expect(sw[0]).toMatchObject({ id: 'sp4rtan', trigger: 'sighting' });
    expect(sw.some((s) => s.trigger === 'blocked')).toBe(false);
    expect(sw[0]?.text).toMatch(/^sp4rtan LIVE: sees cart \(the human\), not in the recording/);
    const k = (sw[0] as { tick: number }).tick;
    const e = run.entries[k] as LogEntry;
    expect(dist(pawnAt(e, 'cart').pos, pawnAt(e, 'sp4rtan').pos)).toBeLessThanOrEqual(tuning.replay.closeRangeUnits);
    expect(run.core.divergence.index.saw('sp4rtan', 'cart', k)).toBe(true);
    // G1: once cart is dead and it is calm, sp4rtan rejoins. G8: his LIVE fight with cart no longer hits barely, and
    // he is LIVE on the tick of his scripted kill of barely (58.84 s), so it is dropped: barely survives his recorded
    // death and plays on for good (fate, execute: guard the bomb). Before G8 the LIVE spray killed barely at 58.58 s and
    // sp4rtan defused on the tape's tick; now the round is a real 1v1 (outcome printed), ending by the rules.
    const back = rejoins(run.entries).filter((b) => b.id === 'sp4rtan');
    expect(back.length).toBeGreaterThan(0);
    expect((back[0] as { tick: number }).tick).toBeGreaterThan(deaths(run.entries).find((d) => d.victim === 'cart')?.tick ?? Infinity);
    const barely = switches(run).filter((s) => s.id === 'barely');
    if (deaths(run.entries).every((d) => d.victim !== 'barely' || d.tick > 3766)) expect(barely.at(-1)).toMatchObject({ tick: 3767, trigger: 'fate' });
    const end = expectRoundEndByRules(run);
    console.log(`[block-sp4rtan] round_end ${end.tick}: ${end.winner} ${end.reason}; kills ${deaths(run.entries).filter((d) => d.tick > 3600).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}`).join(', ')}`);
    expectUntouchedReplay(run);
  });
});

describe('8. smoke on Lokier’s angle', () => {
  const { run } = play('smoke-window');

  it('Lokier’s scheduled shot waits until cart is actually visible', () => {
    const spot = run.core.divergence.encounters[0]?.spot as { x: number; y: number };
    const tol = tuning.replay.humanSpotToleranceUnits;
    // cart throws a smoke, and stands at his recorded spot at the recorded hit (18.50 s), unseen by Lokier.
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'sound' && ev.kind === 'grenade' && ev.source === 'cart' && e.observe.tick > 15 * 64))).toBe(true);
    const atSpot = run.entries.filter((e) => e.observe.tick >= 1150 && e.observe.tick <= 1250 && dist(pawnAt(e, 'cart').pos, spot) <= tol);
    expect(atSpot.length).toBeGreaterThan(50);
    for (const e of atSpot) expect(pawnAt(e, 'lokier').sees).not.toContain('cart');
    // G6: it is the smoke that hides him: at the window, on the CS2 mesh, the two would see each other.
    for (const e of atSpot.filter((x) => x.observe.tick % 16 === 0 && dist(pawnAt(x, 'cart').pos, { x: -1712, y: 700 }) <= 24)) expect(clearAimPoints(data.geometry as MapGeometry, tuning, pawnAt(e, 'lokier'), pawnAt(e, 'cart')).length).toBeGreaterThan(0);
    // The encounter starts on the first tick Lokier sees cart at the spot, the hit lands encounterDelaySec later.
    const seen = seenTick(run) as number;
    const firstSeen = run.entries.find((e) => e.observe.tick > 1100 && pawnAt(e, 'lokier').sees.includes('cart') && dist(pawnAt(e, 'cart').pos, spot) <= tol)?.observe.tick;
    expect(seen).toBe(firstSeen);
    expect(seen).toBeGreaterThan(19.3 * 64);
    const delay = Math.round(tuning.replay.encounterDelaySec * 64);
    expect(damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart')).toEqual([expect.objectContaining({ tick: seen + delay, amount: 73, scripted: true })]);
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ attacker: 'cart' });
    expect(liveSwitches(run.entries)).toEqual([]);
    expect(rejoins(run.entries)).toEqual([]); // G1: unchanged (digest ce1bff8f): no switch
    expectUntouchedReplay(run);
  });
});

describe('9. cart goes A instead of B and never fires (G1)', () => {
  const { run } = play('cart-goes-a');

  it('sp4rtan meets cart in A main on his flank and kills him, then rejoins his recording', () => {
    const sp = switches(run).filter((s) => s.id === 'sp4rtan');
    expect(sp).toEqual([expect.objectContaining({ trigger: 'sighting', text: expect.stringMatching(/^sp4rtan LIVE: sees cart \(the human\)/) })]);
    const k = deaths(run.entries).find((d) => d.victim === 'cart');
    expect(k).toMatchObject({ attacker: 'sp4rtan' });
    expect(damages(run.entries).some((d) => d.attacker === 'cart')).toBe(false); // cart never fires
    const back = rejoins(run.entries).filter((b) => b.id === 'sp4rtan');
    expect(back).toHaveLength(1);
    expect((back[0] as { tick: number }).tick).toBeGreaterThan(k?.tick ?? Infinity);
  });

  it('Lokier outlives his recording on B; barely kills him and rejoins; everything else is the tape: CT defuse, 0.72 s left', () => {
    expect(switches(run).find((s) => s.id === 'lokier')).toMatchObject({ tick: LOKIER_DEATH + GRACE, trigger: 'outlived' });
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ attacker: 'barely' });
    // G3: barely is back first (tick 1483, as on main), sp4rtan after his fight in A main (later on CS2 Mirage).
    expect(rejoins(run.entries).map((b) => b.id)).toEqual(['barely', 'sp4rtan']);
    expect(tapeAfterLokier(run)).toEqual(TAPE_AFTER_LOKIER);
    expectRoundEndByRules(run);
    expectUntouchedReplay(run);
  });
});

describe('10. cart misses Lokier at the window and hides in Shop (G1)', () => {
  const { run } = play('miss-lokier-shop');

  it('the scripted hit lands, cart’s spray misses, Lokier lives on and outlives his recording', () => {
    const hit = damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart');
    // G5: on the recorded tick (he plays his recording up to the window: on course at the sighting; before G5 1190).
    expect(hit).toEqual([expect.objectContaining({ tick: 1184, amount: 73, armor: 7, scripted: true })]);
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === 'cart'))).toBe(true);
    expect(damages(run.entries).some((d) => d.attacker === 'cart')).toBe(false);
    // He is in the recorded duel, but none of his (real, D1) shots hits Lokier: Lokier lives.
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'blocked_hit'))).toBe(false);
    expect(coreLogs(run.entries).filter((l) => l.text.startsWith('duel cart -> lokier')).map((l) => l.text)).toEqual([
      // G6: from 1138 (1126 before): Lokier first sees him at the window on the CS2 mesh then. D1: the log wording.
      'duel cart -> lokier: in the recorded duel from tick 1138 (+0.0 s against the recording, to tick 1215); his shots on lokier are real (the tape: kill (ak47, head) at tick 1203)',
      'duel cart -> lokier: over at tick 1217, the recorded duel is over; 0 hits on lokier in it',
    ]);
    expect(switches(run).find((s) => s.id === 'lokier')).toMatchObject({ tick: LOKIER_DEATH + GRACE, trigger: 'outlived' });
  });

  it('barely kills Lokier and rejoins; cart sits out the round in Shop; everything else is the tape: CT defuse', () => {
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ attacker: 'barely' });
    expect(rejoins(run.entries).map((b) => b.id)).toEqual(['barely']);
    expect(tapeAfterLokier(run)).toEqual(TAPE_AFTER_LOKIER);
    const last = run.entries[run.entries.length - 1] as LogEntry;
    expect(pawnAt(last, 'cart')).toMatchObject({ alive: true, hp: 27 });
    expect(dist(pawnAt(last, 'cart').pos, { x: -2360, y: -642 })).toBeLessThan(48);
    expectRoundEndByRules(run);
    expectUntouchedReplay(run);
  });
});

describe('G7: if they can attack, they do (tools/react-check.ts), over the golden master and every scenario of this file', () => {
  it('no alive REPLAY bot has an off-script enemy in sight for more than a reaction time unless the recording covers it', () => {
    expect(played.length).toBeGreaterThanOrEqual(11);
    for (const { name, run } of [{ name: 'golden', run: golden }, ...played]) {
      const v = reactViolations(run, tuning);
      console.log(`[react ${name}] ${v.length} violations${v.length > 0 ? `\n${formatViolations(v)}` : ''}`);
      expect([name, v]).toEqual([name, []]);
    }
  });
});

describe('G6: sight and bullets on the CS2 mesh, in the golden master and every scenario', () => {
  it('no sees entry has every aim point blocked by the mesh, and no engine bullet hits through a wall (printed)', () => {
    const g = data.geometry as MapGeometry;
    expect(played.length).toBeGreaterThanOrEqual(10);
    for (const { name, run } of [{ name: 'golden', run: golden }, ...played]) {
      const c = checkSees(run.entries, g, tuning);
      const walls = hitsThroughWalls(run);
      console.log(`[G6 ${name}] ${c.entries} sees entries (${c.enemyEntries} enemy), ${c.blocked.length} with every aim point blocked; ${c.enemyEyeBlocked} enemy entries seen past the eye line; engine bullet hits through walls: ${walls.length}`);
      expect([name, c.blocked.slice(0, 5)]).toEqual([name, []]);
      expect([name, walls]).toEqual([name, []]);
    }
  });

  it("John's case (cart-dies): donk never hits Lokier, and nobody is shot from across the Apartments", () => {
    const run = (played.find((p) => p.name === 'cart-dies') as { run: HarnessRun }).run;
    expect(damages(run.entries).filter((d) => d.attacker === 'donk' && d.victim === 'lokier')).toEqual([]);
    expect(run.entries.some((e) => e.observe.tick > 0 && pawnAt(e, 'donk').sees.includes('lokier') && pawnAt(e, 'donk').pos.x > -900)).toBe(false);
  });
});
