import { describe, expect, it } from 'vitest';
import type { Observe, PawnObs } from '../src/contracts/index';
import { RoundClock } from '../src/core/index';
import {
  clockView,
  hasAmmo,
  hpBand,
  overlayForKey,
  roundStateOf,
  scoreView,
  statusBadge,
  toggleOverlay,
  weaponName,
  youView,
  type Overlays,
  type RoundStateLike,
} from '../src/app/hud-model';
import { NO_BOMB, type BombState } from '../src/app/scene';

const CLOCK = new RoundClock(98.25, 40);
const BEFORE = { ct: 11, t: 15 };

function obs(tick: number, round?: RoundStateLike): Observe {
  // Without `round`, this exercises the HUD's fallback path (RoundClock + bomb events);
  // every engine now provides Observe.round (C3), so the omission needs a cast.
  const o = { tick, t: tick / 64, pawns: [], events: [], human: null };
  return round === undefined ? (o as unknown as Observe) : ({ ...o, round } as Observe);
}

describe('status badges', () => {
  it('maps act.status modes to badges', () => {
    expect(statusBadge('REPLAY', false)).toEqual({ text: 'REPLAY', tone: 'subtle' });
    expect(statusBadge('LIVE', false)).toEqual({ text: 'LIVE', tone: 'alert' });
    expect(statusBadge('DEAD', false)).toEqual({ text: 'DEAD', tone: 'dead' });
    expect(statusBadge(null, false)).toEqual({ text: 'REPLAY', tone: 'subtle' });
  });

  it("marks the human's own pawn, unless it is dead", () => {
    expect(statusBadge('REPLAY', true)).toEqual({ text: 'YOU', tone: 'human' });
    expect(statusBadge('DEAD', true)).toEqual({ text: 'DEAD', tone: 'dead' });
    expect(statusBadge('REPLAY', true, false)).toEqual({ text: 'DEAD', tone: 'dead' });
    expect(statusBadge('LIVE', false, false)).toEqual({ text: 'DEAD', tone: 'dead' });
  });
});

describe('names and bands', () => {
  it('names weapons for the kill feed and status card', () => {
    expect(weaponName('ak47')).toBe('AK-47');
    expect(weaponName('ssg08')).toBe('SSG 08');
    expect(weaponName(null)).toBe('World');
    expect(weaponName('famas')).toBe('famas');
    expect(hasAmmo('deagle')).toBe(true);
    expect(hasAmmo('smoke')).toBe(false);
    expect([hpBand(100), hpBand(51), hpBand(50), hpBand(21), hpBand(20), hpBand(0)]).toEqual(['ok', 'ok', 'hurt', 'hurt', 'low', 'low']);
  });

  it("builds cart's status card", () => {
    const p: PawnObs = {
      id: 'cart',
      team: 'T',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      hp: 27,
      armor: 64,
      alive: true,
      weapon: 'ak47',
      ammo: { clip: 12, reserve: 60 },
      crouching: false,
      sees: [],
    };
    expect(youView(p)).toEqual({ id: 'cart', team: 'T', alive: true, hp: 27, armor: 64, weapon: 'AK-47', ammo: '12 / 60', band: 'hurt' });
    expect(youView({ ...p, weapon: 'knife' }).ammo).toBeNull();
    expect(youView({ ...p, alive: false })).toMatchObject({ hp: 0, armor: 0, band: 'low' });
  });
});

describe('view toggles', () => {
  it('F, G, T and Tab toggle follow, ghost, tracks and the panel', () => {
    expect(['KeyF', 'KeyG', 'KeyT', 'Tab', 'KeyW', 'Digit1'].map(overlayForKey)).toEqual(['follow', 'ghost', 'tracks', 'panel', null, null]);
    const o: Overlays = { follow: false, ghost: true, tracks: false, panel: true };
    expect(toggleOverlay(o, 'ghost')).toEqual({ ...o, ghost: false });
    expect(toggleOverlay(toggleOverlay(o, 'tracks'), 'tracks')).toEqual(o);
  });
});

describe('clock and score (fallback: RoundClock and events)', () => {
  it('shows the round clock until the plant', () => {
    expect(clockView(obs(0), CLOCK, NO_BOMB, null)).toEqual({ text: '1:39', mode: 'round', bombLeft: null, winner: null, reason: null });
    expect(clockView(obs(1000), CLOCK, NO_BOMB, null).text).toBe(CLOCK.hudClock(1000));
  });

  it('turns into the bomb timer after the plant, with the share of time left', () => {
    const bomb: BombState = { ...NO_BOMB, phase: 'planted', plantTick: 1761, pos: { x: -1982, y: 311, z: -160 }, planter: 'barely' };
    const c = clockView(obs(1761 + 640), CLOCK, bomb, null);
    expect(c).toMatchObject({ text: '30.0', mode: 'bomb' });
    expect(c.bombLeft).toBeCloseTo(0.75, 9);
    expect(clockView(obs(1761 + 640), CLOCK, { ...bomb, phase: 'defusing', defuser: 'sp4rtan', defuseStartTick: 2300 }, null).mode).toBe('defusing');
  });

  it('freezes on the defuse and names the winner', () => {
    const bomb: BombState = { ...NO_BOMB, phase: 'defused', plantTick: 1761, pos: { x: 0, y: 0, z: 0 }, endTick: 4275 };
    const end = { tick: 4275, winner: 'CT' as const, reason: 'bomb_defused' as const };
    const c = clockView(obs(4400), CLOCK, bomb, end);
    expect(c).toMatchObject({ text: CLOCK.hudBomb(4275, 1761), mode: 'defused', winner: 'CT', reason: 'bomb_defused' });
    expect(scoreView(obs(4400), BEFORE, end)).toEqual({ ct: 12, t: 15 });
    expect(scoreView(obs(4400), BEFORE, null)).toEqual(BEFORE);
    expect(clockView(obs(4400), CLOCK, NO_BOMB, { tick: 3000, winner: 'T', reason: 'elimination' })).toMatchObject({ text: CLOCK.hudClock(3000), mode: 'over', winner: 'T' });
  });
});

describe('clock and score from observe.round (C3)', () => {
  const live: RoundStateLike = {
    phase: 'live',
    score: { ct: 11, t: 15 },
    winner: null,
    reason: null,
    endTick: null,
    timeLeftSec: 61.3,
    bomb: { state: 'carried', carrier: 'barely', pos: null, plantTick: null, defuser: null, defuseEndTick: null },
  };

  it('is read only when present and shaped right', () => {
    expect(roundStateOf(obs(5))).toBeNull();
    expect(roundStateOf(obs(5, live))).toBe(live);
    expect(roundStateOf({ ...obs(5), round: 3 } as unknown as Observe)).toBeNull();
  });

  it('drives the clock, the bomb timer and the score', () => {
    expect(clockView(obs(2366, live), CLOCK, NO_BOMB, null)).toMatchObject({ text: '1:02', mode: 'round' });
    const planted: RoundStateLike = { ...live, phase: 'planted', bomb: { ...live.bomb, state: 'planted', carrier: null, plantTick: 1761, pos: { x: 0, y: 0, z: 0 } } };
    expect(clockView(obs(1761 + 64, planted), CLOCK, NO_BOMB, null)).toMatchObject({ text: '39.0', mode: 'bomb' });
    const over: RoundStateLike = { ...planted, phase: 'over', winner: 'CT', reason: 'bomb_defused', endTick: 4275, score: { ct: 12, t: 15 } };
    expect(clockView(obs(4300, over), CLOCK, NO_BOMB, null)).toMatchObject({ mode: 'defused', winner: 'CT', text: CLOCK.hudBomb(4275, 1761) });
    expect(scoreView(obs(4300, over), BEFORE, null)).toEqual({ ct: 12, t: 15 });
  });
});
