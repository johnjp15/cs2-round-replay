import { describe, expect, it } from 'vitest';
import type { PawnObs } from '../src/contracts/index';
import { aimOffsetPx, cycleTarget, nextSpectateMode, spectatable, spectatePanel } from '../src/app3d/spectate';

const pawn = (id: string, team: 'T' | 'CT', alive = true): PawnObs => ({ id, team, alive, hp: alive ? 76.4 : 0, armor: 100, pos: { x: 0, y: 0, z: 0 }, sees: [] }) as unknown as PawnObs;

describe('spectating', () => {
  it('cycles first person → third person → free fly', () => {
    expect(nextSpectateMode('pov')).toBe('follow');
    expect(nextSpectateMode('follow')).toBe('free');
    expect(nextSpectateMode('free')).toBe('pov');
  });

  it('cycles players both ways, wrapping', () => {
    const ids = ['a', 'b', 'c'];
    expect(cycleTarget(ids, 'a', 1)).toBe('b');
    expect(cycleTarget(ids, 'c', 1)).toBe('a');
    expect(cycleTarget(ids, 'a', -1)).toBe('c');
    expect(cycleTarget(ids, 'dead', 1)).toBe('a');
    expect(cycleTarget(ids, 'dead', -1)).toBe('c');
    expect(cycleTarget([], 'x', 1)).toBe('x');
  });

  it('a dead human spectates living teammates only while there are any', () => {
    const ps = [pawn('cart', 'T', false), pawn('mate', 'T'), pawn('donk', 'CT')];
    expect(spectatable(ps, 'T')).toEqual(['mate']);
    expect(spectatable(ps, null)).toEqual(['mate', 'donk']);
    expect(spectatable([pawn('cart', 'T', false), pawn('donk', 'CT')], 'T')).toEqual(['donk']);
  });

  it('puts the crosshair at the aim: centred without punch, above centre when the aim is above the view', () => {
    expect(aimOffsetPx({ yaw: 10, pitch: 5 }, { yaw: 10, pitch: 5 }, 73.74, 720)).toEqual({ x: 0, y: 0 });
    // 1° up at a 73.74° vertical FOV on 720 px: tan(1°) / tan(36.87°) × 360 ≈ 8.38 px above centre.
    const up = aimOffsetPx({ yaw: 0, pitch: 0 }, { yaw: 0, pitch: -1 }, 73.74, 720);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(-((Math.tan(Math.PI / 180) / Math.tan((36.87 * Math.PI) / 180)) * 360), 2);
    // Aim to the left (yaw + = counter-clockwise = left): negative x.
    expect(aimOffsetPx({ yaw: 0, pitch: 0 }, { yaw: 1, pitch: 0 }, 73.74, 720).x).toBeLessThan(0);
  });

  it('writes the spectator panel', () => {
    const p = spectatePanel(pawn('donk', 'CT'), 2, 'pov', 'AK-47', true);
    expect(p).toEqual({ name: 'donk', team: 'CT', stats: '76 HP · 100 armor · AK-47 · 2 kills', mode: '1st person', hints: 'Mouse 1 / 2 switch player · V mode · E take control of cart' });
    expect(spectatePanel(pawn('a', 'T'), 1, 'follow', 'Knife', false)?.stats).toContain('1 kill');
    expect(spectatePanel(null, 0, 'pov', '', false)).toBeNull();
  });
});
