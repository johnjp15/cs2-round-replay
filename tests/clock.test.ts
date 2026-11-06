import { describe, expect, it } from 'vitest';
import { RoundClock, TICK_RATE, tOf, tickOf } from '../src/core/index';
import { loadRound } from './round-fixture';

const clock = RoundClock.fromRound(loadRound());
const PLANT_TICK = 1761;

describe('RoundClock', () => {
  it('converts between seconds and ticks', () => {
    expect(TICK_RATE).toBe(64);
    expect(tickOf(0.5)).toBe(32);
    expect(tickOf(27.517)).toBe(PLANT_TICK);
    expect(tickOf(12.4)).toBe(794); // 793.6 rounds up
    expect(tOf(64)).toBe(1);
    expect(tOf(816)).toBe(12.75);
  });

  it('counts the round clock down from 98.25 s', () => {
    expect(clock.clock0).toBe(98.25);
    expect(clock.remaining(0)).toBe(98.25);
    expect(clock.remaining(64)).toBe(97.25);
  });

  it('shows the HUD round clock as in the breakdown (ceil of the remaining seconds)', () => {
    const table: [number, string][] = [
      [0, '1:39'],
      [0.5, '1:38'],
      [12.4, '1:26'],
      [12.75, '1:26'],
      [17.85, '1:21'],
      [18.8, '1:20'],
      [24.4, '1:14'],
    ];
    for (const [t, hud] of table) expect(clock.hudClock(tickOf(t)), `t ${t}`).toBe(hud);
    expect(clock.hudClock(tickOf(98.25))).toBe('0:00');
    expect(clock.hudClock(tickOf(120))).toBe('0:00');
    expect(clock.hudClock(tickOf(88.25))).toBe('0:10');
  });

  it('runs the 40 s bomb timer from the plant', () => {
    expect(clock.bombRemaining(PLANT_TICK, PLANT_TICK)).toBe(40);
    expect(clock.bombExplodeTick(PLANT_TICK)).toBe(PLANT_TICK + 40 * 64);
    const table: [number, string][] = [
      [44.2, '23.3'],
      [50.35, '17.2'],
      [58.85, '8.7'],
      [61.8, '5.7'],
    ];
    for (const [t, hud] of table) expect(clock.hudBomb(tickOf(t), PLANT_TICK), `t ${t}`).toBe(hud);
    expect(clock.hudBomb(PLANT_TICK, PLANT_TICK)).toBe('40.0');
    expect(clock.hudBomb(clock.bombExplodeTick(PLANT_TICK) + 10, PLANT_TICK)).toBe('0.0');
  });
});
