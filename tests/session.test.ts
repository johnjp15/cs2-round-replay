import { describe, expect, it } from 'vitest';
import { SessionLog, replay, stableStringify, type PlayerId } from '../src/contracts/index';
import { startActions } from '../src/core/index';
import { NO_CONTROLS, humanInput, type HeldControls } from '../src/app/input';
import { Session, defaultCore, parseSessionData } from '../src/app/session';
import { ROUND_TEXT, TUNING_TEXT, loadRound } from './round-fixture';
import { readFileSync } from 'node:fs';
import { nav, tuning } from './sim2d-fixtures';

const round = loadRound();
const SEED = 7;

function newSession(human?: PlayerId | null): Session {
  return human === undefined ? new Session({ round, nav, tuning, seed: SEED }) : new Session({ round, nav, tuning, seed: SEED, human });
}

type Script = (s: Session, tick: number) => void;

function run(s: Session, ticks: number, script: Script = () => undefined): void {
  for (let i = 0; i < ticks; i++) {
    script(s, s.tick);
    s.step();
  }
}

function held(...names: (keyof HeldControls)[]): HeldControls {
  const c: Record<keyof HeldControls, boolean> = { ...NO_CONTROLS };
  for (const n of names) c[n] = true;
  return c;
}

/** A human playing cart: runs north-east, walks, aims around, switches to the knife and back, changes speed. */
const playCart: Script = (s, tick) => {
  if (tick === 10) s.setHumanInput(humanInput('cart', held('up', 'right'), 45));
  if (tick === 60) s.setHumanInput(humanInput('cart', held('left', 'walk'), 170.5));
  if (tick === 80) s.requestWeaponSlot(3);
  if (tick === 100) s.control({ type: 'speed', x: 2 });
  if (tick === 120) s.setHumanInput(humanInput('cart', held('down', 'duck', 'attack'), -91.25));
  if (tick === 140) s.requestWeaponSlot(1);
  if (tick === 160) s.setHumanInput(humanInput('cart', held('up'), 12));
  if (tick === 200) s.control({ type: 'pause', paused: true });
  if (tick === 200) s.control({ type: 'pause', paused: false });
  if (tick === 220) s.setHumanInput(null);
  if (tick === 250) s.setHumanInput(humanInput('cart', held('right', 'down'), 300));
};

/** A different human, to make a branch diverge. */
const otherCart: Script = (s, tick) => {
  if (tick === 151) s.setHumanInput(humanInput('cart', held('down', 'left'), -30));
  if (tick === 170) s.requestWeaponSlot(4);
  if (tick === 180) s.control({ type: 'speed', x: 0.5 });
};

function cart(s: Session): { x: number; y: number; weapon: string } {
  const p = s.observe().pawns.find((q) => q.id === 'cart');
  if (p === undefined) throw new Error('no cart');
  return { x: p.pos.x, y: p.pos.y, weapon: p.weapon };
}

describe('Session', () => {
  it('sets the round up on tick 0: start is logged and Core emits startActions', () => {
    const s = newSession();
    expect(s.tick).toBe(0);
    expect(s.log().length).toBe(0);
    s.step();
    const first = s.log().at(0);
    expect(first?.controls).toEqual([{ type: 'start' }]);
    // startActions, then (B3) block_damage between the puppets (cart, the human, is in none of them).
    const setup = startActions(s.model, tuning);
    expect(first?.act.actions.slice(0, setup.length)).toEqual(setup);
    const blocks = first?.act.actions.slice(setup.length) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const a of blocks) {
      expect(a.type).toBe('block_damage');
      if (a.type === 'block_damage') expect([a.attacker, a.victim]).not.toContain('cart');
    }
    expect(first?.observe.human).toBe('cart');
    expect(s.tick).toBe(1);
    expect(cart(s)).toMatchObject({ x: -391, y: 909, weapon: 'ak47' });
    expect(s.clock.hudClock(s.tick)).toBe('1:39');
  });

  it('300 ticks, restart(), 300 ticks again: byte-identical log (bots only and with a human)', () => {
    for (const script of [undefined, playCart]) {
      const s = newSession();
      const fresh = stableStringify(s.snapshot());
      run(s, 300, script);
      const first = s.log().toText();
      expect(s.log().length).toBe(300);
      s.restart();
      // Back to the tick-0 state, byte for byte.
      expect(stableStringify(s.snapshot())).toBe(fresh);
      expect(s.tick).toBe(0);
      expect(s.log().length).toBe(0);
      run(s, 300, script);
      expect(s.log().toText()).toBe(first);
      expect(s.log().digest()).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('applies the human input: cart moves, switches weapons, and the rest follow their tracks (B2 puppets)', () => {
    const s = newSession();
    run(s, 300, playCart);
    const c = cart(s);
    expect(Math.hypot(c.x + 391, c.y - 909)).toBeGreaterThan(50);
    expect(c.weapon).toBe('ak47');
    const knifeAt = s.log().get(100)?.observe.pawns.find((p) => p.id === 'cart');
    expect(knifeAt?.weapon).toBe('knife');
    // The app's set_weapon actions are not in the logged Act ...
    for (const line of s.log().lines()) expect(line.includes('"type":"set_weapon","weapon":"knife"')).toBe(false);
    // ... so the log replays identically against a fresh Core.
    const core = defaultCore({ model: s.model, schedule: s.schedule, tuning, seed: SEED, nav });
    expect(replay(SessionLog.fromText(s.log().toText()), core)).toMatchObject({ identical: true, mismatchCount: 0, ticks: 300 });
    // Controls are logged on the line of the tick they preceded.
    expect(s.log().get(100)?.controls).toEqual([{ type: 'speed', x: 2 }]);
    expect(s.log().get(200)?.controls).toEqual([
      { type: 'pause', paused: true },
      { type: 'pause', paused: false },
    ]);
    expect(s.speed).toBe(2);
    expect(s.paused).toBe(false);
    // Everyone else is a puppet on its recorded track (incredibad's ends at 0.5 s; he holds still).
    const last = s.observe();
    for (const p of last.pawns) {
      if (p.id === 'cart') continue;
      const rec = s.model.trackAtTick(p.id, last.tick)?.pos ?? s.model.track(p.id).at(-1);
      expect(rec, p.id).toBeDefined();
      expect(Math.hypot(p.pos.x - (rec?.x ?? 0), p.pos.y - (rec?.y ?? 0)), p.id).toBeLessThan(tuning.replay.driftNudgeUnits);
    }
  });

  it('snapshot at tick 150 → restore → identical continuation', () => {
    const straight = newSession();
    run(straight, 300, playCart);

    const s = newSession();
    run(s, 150, playCart);
    const snap = s.snapshot();
    const snapText = stableStringify(snap);
    // Diverge: a different human for 150 ticks.
    run(s, 150, otherCart);
    expect(s.log().toText()).not.toBe(straight.log().toText());
    s.restore(snap);
    expect(s.tick).toBe(150);
    expect(s.log().length).toBe(150);
    expect(stableStringify(s.snapshot())).toBe(snapText);
    run(s, 150, playCart);
    expect(s.log().toText()).toBe(straight.log().toText());

    // The snapshot is plain JSON: it survives a round trip through text.
    const t = newSession();
    t.restore(JSON.parse(snapText) as typeof snap);
    run(t, 150, playCart);
    expect(t.log().toText()).toBe(straight.log().toText());
  });

  it('restore rejects snapshots of another seed or of a human this session can’t have', () => {
    const snap = newSession().snapshot();
    expect(() => new Session({ round, nav, tuning, seed: SEED + 1 }).restore(snap)).toThrow(/seed/);
    // G4: a watching session may restore one where cart is controlled (its playable pawn), not one with another human.
    expect(() => new Session({ round, nav, tuning, seed: SEED, human: null, playable: null }).restore(snap)).toThrow(/human/);
    expect(() => new Session({ round, nav, tuning, seed: SEED, human: null, playable: 'donk' }).restore(snap)).toThrow(/human/);
    const watching = newSession(null);
    watching.restore(snap);
    expect(watching.human).toBe('cart');
  });

  it('spectate mode: human null in every observe, Core drives all ten pawns', () => {
    const s = newSession(null);
    run(s, 300);
    for (let i = 0; i < s.log().length; i++) {
      const e = s.log().at(i);
      expect(e?.observe.human).toBeNull();
      // Every alive pawn (B3 kills incredibad at 0.5 s and snakelore at 12.4 s).
      if (i > 0) expect(e?.act.inputs).toHaveLength(e?.observe.pawns.filter((p) => p.alive).length ?? -1);
    }
    expect(() => s.setHumanInput(humanInput('cart', held('up'), 90))).toThrow(/spectating/);
    expect(s.requestWeaponSlot(3)).toBe(false);
    // Human mode: Core leaves cart's input to the human.
    const h = newSession();
    run(h, 3);
    expect(h.log().at(2)?.act.inputs.map((q) => q.id)).not.toContain('cart');
  });

  it('forwards controls: bad speed throws and is not logged; checkpoint / rewind / seek are not logged (B5)', () => {
    const s = newSession();
    expect(() => s.control({ type: 'speed', x: 0 })).toThrow(RangeError);
    expect(() => s.control({ type: 'rewind', id: 'nope' })).toThrow(/no checkpoint nope/);
    s.control({ type: 'checkpoint', id: 'zero' });
    s.control({ type: 'seek', t: 0 });
    s.control({ type: 'speed', x: 4 });
    s.step();
    expect(s.log().at(0)?.controls).toEqual([{ type: 'start' }, { type: 'speed', x: 4 }]);
    s.control({ type: 'restart' });
    expect(s.log().length).toBe(0);
    expect(s.speed).toBe(1);
  });

  it('parseSessionData builds the same session from the raw files', () => {
    const navText = readFileSync(new URL('../data/mirage-nav.json', import.meta.url), 'utf8');
    const fromText = new Session({ ...parseSessionData(ROUND_TEXT, navText, TUNING_TEXT), seed: SEED });
    const fromValues = new Session({ ...parseSessionData(JSON.parse(ROUND_TEXT), JSON.parse(navText), JSON.parse(TUNING_TEXT)), seed: SEED });
    const reference = newSession();
    for (const s of [fromText, fromValues, reference]) run(s, 64, playCart);
    expect(fromText.log().toText()).toBe(reference.log().toText());
    expect(fromValues.log().toText()).toBe(reference.log().toText());
  });

  it('exports the log as a trace for the web replay page', () => {
    const s = newSession();
    run(s, 128);
    const trace = s.trace();
    expect(trace.players).toHaveLength(10);
    // 10 Hz samples over ticks 0..127: i = 0..19 (tick 19 × 6.4 = 121.6 → 122).
    expect(trace.tracks['cart']).toHaveLength(20);
    expect(trace.tracks['cart']?.[1]).toEqual([0.094, -391, 909, -84, 0]);
  });
});
