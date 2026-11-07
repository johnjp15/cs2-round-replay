/**
 * G4 acceptance: the player takes control of cart at any tick (docs/core.md "Takeover"), through the headless harness
 * (the app's Session with the real Core and Sim2DHost, seed 1). Measured numbers are printed:
 * `npx vitest run tests/takeover.test.ts --reporter=verbose`.
 *
 * - Never taking control is the golden master, byte for byte, and ends "Played it like the tape".
 * - A takeover at T is invisible before T: the log's first T lines are the golden master's; at T = 0 it is the
 *   `--human cart` run byte for byte. On the takeover tick the observe differs only in `human`, and the Act lifts
 *   cart's damage blocks and logs the takeover.
 * - The scheduled encounter with Lokier, by takeover time: before he saw cart at the window (waiting), after (seen
 *   from the puppet's sighting), after the recorded hit (fired on the recorded ticks), after Lokier's death (none).
 * - Idle after the takeover: the outcome and the non-cart events against the tape (the table is printed).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, parseJsonLine, stableStringify, type LogEntry, type PlayerId } from '../src/contracts/index';
import { summarize, tickOf } from '../src/core/index';
import { Session } from '../src/app/session';
import { startHuman } from '../src/app/takeover';
import { GOLDEN_DIR, gunzipText, readManifest } from '../tools/golden-fixtures';
import { ROOT, coreLogs, deaths, loadHarnessData, logDigest, runHarness, type HarnessRun } from '../tools/harness';

const data = loadHarnessData();
/** The no-human golden master: the committed fixture (tests/fixtures.test.ts and the golden round keep it current). */
const GOLDEN = readManifest()?.fixtures.find((f) => f.name === 'round-nohuman');
const goldenLines = gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, GOLDEN?.file ?? 'round-nohuman.jsonl.gz')))
  .split('\n')
  .filter((l) => l !== '');
const END = goldenLines.length - 1;
const goldenAt = (k: number): LogEntry => parseJsonLine(goldenLines[k] ?? '') as unknown as LogEntry;

/** The takeover times of the acceptance (seconds), plus 18.0 s (Lokier has seen the puppet at the window) and 68 s (after the round end). */
const TAKEOVERS = [0, 5, 17.6, 18, 18.6, 30, 45, 60, 68] as const;

/** The recorded events that don't involve cart, with the golden master's observe ticks. */
const TAPE = [
  { key: 'plant', tick: 1761 },
  { key: 'barely -> zwomp', tick: 2829 },
  { key: 'sp4rtan -> donk', tick: 3222 },
  { key: 'sp4rtan -> barely', tick: 3766 },
  { key: 'defuse', tick: 4275 },
] as const;

function idle(t: number): HarnessRun {
  return runHarness(data, { human: 'cart', driver: null, lastTick: 'end', seed: 1, takeover: tickOf(t) });
}

const runs = new Map<number, HarnessRun>(TAKEOVERS.map((t) => [t, idle(t)]));
const run = (t: number): HarnessRun => runs.get(t) as HarnessRun;

/** Each tape event's tick in a run (null: it didn't happen), and the round's end. */
function events(r: HarnessRun): { key: string; tick: number | null }[] {
  const ds = deaths(r.entries);
  const bomb = (phase: string): number | null => {
    for (const e of r.entries) for (const ev of e.observe.events) if (ev.type === 'bomb' && ev.phase === phase) return e.observe.tick;
    return null;
  };
  return TAPE.map((x) => {
    if (x.key === 'plant') return { key: x.key, tick: bomb('planted') };
    if (x.key === 'defuse') return { key: x.key, tick: bomb('defused') };
    const [killer, victim] = x.key.split(' -> ') as [PlayerId, PlayerId];
    return { key: x.key, tick: ds.find((d) => d.attacker === killer && d.victim === victim)?.tick ?? null };
  });
}

function roundEnd(r: HarnessRun): string {
  for (const e of r.entries) for (const ev of e.observe.events) if (ev.type === 'round_end') return `${ev.winner} ${ev.reason} ${e.observe.round.score.ct}-${e.observe.round.score.t} @${e.observe.tick}`;
  return 'none';
}

const line = (r: HarnessRun, k: number): LogEntry => r.entries[k] as LogEntry;
const logsAt = (r: HarnessRun, k: number): string[] => coreLogs(r.entries).filter((l) => l.tick === k && l.level !== 'debug').map((l) => l.text);

describe('never taking control (G4)', () => {
  it('the app’s default session (watching) run to the end is the golden master and plays like the tape', () => {
    // The page's session at load: ?human= absent (main.ts: startHuman(params.get('human'))).
    const s = new Session({ ...data, seed: 1, human: startHuman(null) });
    expect([s.human, s.playable, s.takeoverTick, s.canTakeControl]).toEqual([null, 'cart', null, true]);
    while (s.tick <= END) s.step();
    expect(logDigest(s.log())).toBe(GOLDEN?.digest);
    expect(s.log().lines().length).toBe(goldenLines.length);
    expect(summarize(s.model, s.log()).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
    // Cart died after the round (69.41 s): no takeover any more.
    expect(s.takeControlBlocked()).toBe('cart is dead');
  }, 120_000);
});

describe('a takeover at T (G4)', () => {
  it('is invisible before T: the first T lines are the golden master’s; T = 0 is the --human cart run byte for byte', () => {
    for (const t of TAKEOVERS) {
      const k = tickOf(t);
      const lines = run(t).log.lines();
      let first = -1;
      for (let i = 0; i < k && first < 0; i++) if (lines[i] !== goldenLines[i]) first = i;
      expect(first, `T = ${t}`).toBe(-1);
      if (k > 0) expect(lines[k] === goldenLines[k], `T = ${t}: line ${k} differs`).toBe(false);
    }
    const human = runHarness(data, { human: 'cart', driver: null, lastTick: 'end', seed: 1 });
    expect(logDigest(run(0).log)).toBe(logDigest(human.log));
    expect(run(0).log.toText() === human.log.toText()).toBe(true);
  }, 120_000);

  it('on its tick the observe differs only in human; cart keeps the puppet’s state, his blocks are lifted, and he is the human from there', () => {
    for (const t of TAKEOVERS.filter((x) => x > 0)) {
      const r = run(t);
      const k = tickOf(t);
      const e = line(r, k);
      const g = goldenAt(k);
      expect(e.observe.human).toBe('cart');
      expect(stableStringify({ ...e.observe, human: null })).toBe(stableStringify(g.observe));
      // Lifted: cart's self pair, then both ways with every CT (none has lifted blocks while nobody plays), dead ones too.
      const lifted = e.act.actions.filter((a) => a.type === 'unblock_damage').map((a) => `${a.attacker}>${a.victim}`);
      const cts = PLAYER_IDS.filter((id) => data.round.players.find((p) => p.id === id)?.team === 'CT');
      expect(lifted).toEqual(['cart>cart', ...cts.flatMap((c) => [`cart>${c}`, `${c}>cart`])]);
      const cart = g.observe.pawns.find((p) => p.id === 'cart');
      expect(logsAt(r, k)[0]).toBe(`takeover: cart is the human from tick ${k} (${cart?.hp ?? 0} hp, ${cart?.weapon ?? ''}); 11 damage blocks lifted`);
      // Nothing moves him (a puppet's own snap on that tick, barely's at 45 s, is the golden master's too), and nothing
      // re-blocks him but the recorded duel he is in (G5: taken over at the window, 17.6–18.6 s, his bullets on Lokier).
      const reblocked = e.act.actions.flatMap((a) => (a.type === 'block_damage' && (a.attacker === 'cart' || a.victim === 'cart') ? [`${a.attacker}>${a.victim}`] : []));
      expect(reblocked, `T = ${t}`).toEqual(t >= 17.6 && t <= 18.6 ? ['cart>lokier'] : []);
      expect(e.act.actions.some((a) => (a.type === 'teleport' || a.type === 'set_mode') && a.id === 'cart')).toBe(false);
      // From the takeover on: HUMAN since T while alive, never in the Core's inputs, no scripted damage to or from him.
      for (let i = k; i < r.entries.length; i++) {
        const q = line(r, i);
        const alive = q.observe.pawns.find((p) => p.id === 'cart')?.alive === true;
        expect(q.act.inputs.some((x) => x.id === 'cart')).toBe(false);
        if (alive) expect(q.act.status.find((x) => x.id === 'cart')).toEqual({ id: 'cart', mode: 'HUMAN', trigger: null, sinceTick: k });
        for (const a of q.act.actions) if (a.type === 'damage') expect(a.attacker === 'cart' || (a.victim === 'cart' && a.attacker !== 'lokier')).toBe(false);
      }
    }
  }, 120_000);

  it('Lokier’s encounter: waiting before he saw cart at the window, seen from the puppet’s sighting, fired after the recorded hit, none after his death', () => {
    const hitOnCart = (r: HarnessRun): { tick: number; amount: number; scripted: boolean }[] => {
      const out: { tick: number; amount: number; scripted: boolean }[] = [];
      for (const e of r.entries) for (const ev of e.observe.events) if (ev.type === 'damage' && ev.victim === 'cart' && ev.attacker === 'lokier') out.push({ tick: e.observe.tick, amount: ev.amount, scripted: ev.scripted });
      return out;
    };
    // 5 s: waiting (Lokier hasn't seen cart at the window yet). 17.6 s (tick 1126) is the very tick Lokier first sees
    // him within the spot tolerance (17.59 s): waiting, then seen on that tick. G5: cart is on course then (where his
    // recording has him), so the hit lands on its recorded tick, 18.50 s (1184; before G5 1 s after the sighting, 1190),
    // and he is in the recorded duel with Lokier from that tick.
    expect(logsAt(run(5), 320)).toContain('encounter lokier -> cart: active from the takeover at tick 320, waiting for lokier to see cart at the spot');
    expect(logsAt(run(17.6), 1126)).toEqual([
      'takeover: cart is the human from tick 1126 (100 hp, ak47); 11 damage blocks lifted',
      'encounter lokier -> cart: active from the takeover at tick 1126, waiting for lokier to see cart at the spot',
      'encounter lokier -> cart: cart in sight at the spot at tick 1126 (+0.1 s against the recording), scripted hit due at tick 1184 (on course: the recorded tick)',
      'duel cart -> lokier: in the recorded duel from tick 1126 (+0.0 s against the recording, to tick 1215); his shots on lokier land as recorded: kill (ak47, head) at tick 1203',
    ]);
    expect(hitOnCart(run(17.6))).toEqual([{ tick: 1184, amount: 73, scripted: true }]);
    // 18.0 s: Lokier had the puppet in sight at the spot since 1126, on course, so the same hit, as for a human from the start.
    expect(logsAt(run(18), 1152)).toContain('encounter lokier -> cart: cart in sight at the spot since tick 1126 (+0.1 s against the recording), before the takeover at tick 1152; scripted hit due at tick 1184 (on course: the recorded tick)');
    expect(hitOnCart(run(18))).toEqual([{ tick: 1184, amount: 73, scripted: true }]);
    // B3's recorded hit (1184) is skipped once he is the human; it is the encounter's.
    for (const t of [0, 5, 17.6, 18]) expect(coreLogs(run(t).entries).some((l) => l.text.startsWith('script: no scripted damage lokier -> cart (73 hp at tick 1184)'))).toBe(true);
    // 18.6 s: the recorded hit landed on the puppet at 18.50 s; cart is on 27 HP and must kill Lokier himself (idle: he doesn't).
    expect(logsAt(run(18.6), 1190)).toContain('encounter lokier -> cart: the recorded hit (73 hp) landed on tick 1184, before the takeover at tick 1190');
    expect(hitOnCart(run(18.6))).toEqual([{ tick: 1184, amount: 73, scripted: true }]);
    expect(line(run(18.6), 1190).observe.pawns.find((p) => p.id === 'cart')?.hp).toBe(27);
    expect(coreLogs(run(18.6).entries).some((l) => l.text.startsWith('script: no scripted damage cart -> lokier (lethal at tick 1203)'))).toBe(true);
    // Lokier outlives his recording (no human kill) in every idle run from before 18.80 s.
    for (const t of [0, 5, 17.6, 18, 18.6]) expect(coreLogs(run(t).entries).some((l) => l.tick === 1395 && l.text.startsWith('lokier LIVE: outlived recording (+3.0 s)'))).toBe(true);
    // After his death (18.80 s): nothing to activate.
    for (const t of [30, 45, 60, 68]) expect(logsAt(run(t), tickOf(t))).toContain(`encounter lokier -> cart: none after the takeover at tick ${tickOf(t)}, lokier is dead`);
  }, 120_000);

  it('idle after the takeover: the round against the tape (printed); events that move are explained in docs/core.md "Takeover"', () => {
    const rows: string[] = ['| T (s) | prefix = golden | outcome | plant | barely → Zwomp | sp4rtan → donk | sp4rtan → barely | defuse | headline |', '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'];
    const got: Record<string, { end: string; events: (number | null)[] }> = {};
    for (const t of TAKEOVERS) {
      const r = run(t);
      const ev = events(r);
      got[String(t)] = { end: roundEnd(r), events: ev.map((x) => x.tick) };
      const cell = (x: { key: string; tick: number | null }, i: number): string => {
        const want = TAPE[i]?.tick ?? 0;
        if (x.tick === null) return '–';
        return x.tick === want ? `**${(x.tick / 64).toFixed(2)}**` : `${(x.tick / 64).toFixed(2)} (${x.tick - want > 0 ? '+' : ''}${x.tick - want})`;
      };
      rows.push(`| ${t} | yes | ${roundEnd(r)} | ${ev.map(cell).join(' | ')} | ${summarize(r.model, r.entries).headline} |`);
    }
    console.log(`[takeover, idle after] (bold: on the golden master's tick)\n${rows.join('\n')}\n`);
    const tape = TAPE.map((x) => x.tick);
    const defuse = 'CT bomb_defused 12-15 @4275';
    // Lokier outlives an idle cart; barely, LIVE to kill him, rejoins and plants 7 ticks late (as in never-peeks).
    const late = [1768, 2829, 3222, 3766, 4275];
    expect(got).toEqual({
      '0': { end: defuse, events: late },
      '5': { end: defuse, events: late },
      // Cart idle at the Apartments window with 27 HP: sp4rtan's recorded flank passes there; he sees cart (off
      // course), goes LIVE and kills him, and the gunfire makes donk and barely LIVE; the toy AI's fight kills donk.
      '17.6': { end: defuse, events: [1768, 2829, 3053, 3766, 4275] },
      '18': { end: defuse, events: [1768, 2829, 3046, 3766, 4275] },
      '18.6': { end: defuse, events: [1768, 2829, 3044, 3766, 4275] },
      '30': { end: defuse, events: tape },
      '45': { end: defuse, events: tape },
      '60': { end: defuse, events: tape },
      '68': { end: defuse, events: tape },
    });
  }, 120_000);
});
