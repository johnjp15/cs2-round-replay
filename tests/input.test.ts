import { describe, expect, it } from 'vitest';
import {
  NO_CONTROLS,
  bindingForKey,
  bindingForMouseButton,
  buttonsFor,
  humanInput,
  moveDirection,
  toPawnFrame,
  weaponForSlot,
  yawToward,
  type HeldControls,
} from '../src/app/input';
import { fitView, screenToWorld, worldToRadar, worldToScreen, yawToScreenDir } from '../src/app/radar';
import { wishFromInput } from '../src/sim2d/movement';
import { tuning } from './sim2d-fixtures';

const MIRAGE = { posx: -3230, posy: 1713, scale: 5, size: 1024 };

function held(...names: (keyof HeldControls)[]): HeldControls {
  const c: Record<keyof HeldControls, boolean> = { ...NO_CONTROLS };
  for (const n of names) c[n] = true;
  return c;
}

describe('WASD relative to the screen', () => {
  it('W at yaw 90 (facing north) is forward 1', () => {
    expect(toPawnFrame(moveDirection(held('up')), 90)).toEqual({ forward: 1, side: 0 });
  });

  it('W at yaw 0 (facing east) is side −1: north is left of east-facing', () => {
    expect(toPawnFrame(moveDirection(held('up')), 0)).toEqual({ forward: 0, side: -1 });
  });

  it('D at yaw 90 is side +1 (strafe right = east)', () => {
    expect(toPawnFrame(moveDirection(held('right')), 90)).toEqual({ forward: 0, side: 1 });
  });

  it('S at yaw 180 (facing west) is side −1, A at yaw 0 is back', () => {
    expect(toPawnFrame(moveDirection(held('down')), 180)).toEqual({ forward: 0, side: -1 });
    expect(toPawnFrame(moveDirection(held('left')), 0)).toEqual({ forward: -1, side: 0 });
  });

  it('normalizes diagonals to length 1', () => {
    const d = moveDirection(held('up', 'right'));
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(d.y).toBeCloseTo(Math.SQRT1_2, 12);
    for (const yaw of [0, 33, 90, -135, 179.5]) {
      const { forward, side } = toPawnFrame(d, yaw);
      expect(Math.hypot(forward, side)).toBeCloseTo(1, 5);
    }
    const f = toPawnFrame(d, 90);
    expect(f.forward).toBeCloseTo(Math.SQRT1_2, 6);
    expect(f.side).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('opposite keys cancel; nothing held is no move', () => {
    expect(moveDirection(held('up', 'down'))).toEqual({ x: 0, y: 0 });
    expect(moveDirection(held('left', 'right', 'up'))).toEqual({ x: 0, y: 1 });
    expect(toPawnFrame(moveDirection(NO_CONTROLS), 47)).toEqual({ forward: 0, side: 0 });
  });

  it('moves the pawn in the screen direction whatever its yaw (through the movement model)', () => {
    const m = tuning.movement;
    const keys: [(keyof HeldControls)[], number, number][] = [
      [['up'], 0, 1],
      [['right'], 1, 0],
      [['down', 'left'], -Math.SQRT1_2, -Math.SQRT1_2],
      [['up', 'right'], Math.SQRT1_2, Math.SQRT1_2],
    ];
    for (const [names, ex, ey] of keys) {
      for (const yaw of [0, 37, 90, 145, -120, 180]) {
        const wish = wishFromInput(humanInput('cart', held(...names), yaw), 'ak47', m);
        expect(wish.dirX).toBeCloseTo(ex, 5);
        expect(wish.dirY).toBeCloseTo(ey, 5);
        expect(wish.speed).toBeCloseTo(215, 3);
      }
    }
  });
});

describe('buttons and bindings', () => {
  it('maps Shift, Ctrl/C, mouse, R and E to buttons in BUTTONS order', () => {
    expect(buttonsFor(held('walk'))).toEqual(['WALK']);
    expect(buttonsFor(held('reload', 'walk', 'duck', 'use', 'attack'))).toEqual(['ATTACK', 'USE', 'DUCK', 'WALK', 'RELOAD']);
    expect(buttonsFor(NO_CONTROLS)).toEqual([]);
    expect(bindingForKey('ShiftLeft')).toEqual({ kind: 'hold', control: 'walk' });
    expect(bindingForKey('ShiftRight')).toEqual({ kind: 'hold', control: 'walk' });
    expect(bindingForKey('ControlLeft')).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('KeyC')).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('KeyR')).toEqual({ kind: 'hold', control: 'reload' });
    expect(bindingForKey('KeyE')).toEqual({ kind: 'hold', control: 'use' });
    expect(bindingForKey('KeyW')).toEqual({ kind: 'hold', control: 'up' });
    expect(bindingForKey('KeyD')).toEqual({ kind: 'hold', control: 'right' });
    expect(bindingForKey('Digit4')).toEqual({ kind: 'slot', slot: 4 });
    expect(bindingForKey('KeyQ')).toBeNull();
    // G3: Space = JUMP (held: the movement jumps once per press).
    expect(bindingForKey('Space')).toEqual({ kind: 'hold', control: 'jump' });
    expect(buttonsFor(held('jump', 'duck', 'walk'))).toEqual(['DUCK', 'WALK', 'JUMP']);
    expect(bindingForMouseButton(0)).toEqual({ kind: 'hold', control: 'attack' });
    expect(bindingForMouseButton(2)).toEqual({ kind: 'hold', control: 'attack2' });
    expect(bindingForMouseButton(1)).toBeNull();
  });

  it('builds a full PawnInput for the human', () => {
    expect(humanInput('cart', held('up', 'walk', 'attack'), 90)).toEqual({ id: 'cart', forward: 1, side: 0, yaw: 90, pitch: 0, buttons: ['ATTACK', 'WALK'] });
  });
});

describe('mouse aim', () => {
  it('faces the cursor in world coordinates', () => {
    expect(yawToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)).toBe(0);
    expect(yawToward({ x: 0, y: 0 }, { x: 0, y: 100 }, 5)).toBe(90);
    expect(yawToward({ x: 0, y: 0 }, { x: -100, y: 0 }, 5)).toBe(180);
    expect(yawToward({ x: 10, y: 10 }, { x: 0, y: 0 }, 5)).toBe(-135);
    expect(yawToward({ x: 10, y: 10 }, { x: 10.5, y: 10 }, 5)).toBe(5);
  });

  it('a cursor straight above the pawn on screen means yaw 90 (north)', () => {
    const view = fitView(MIRAGE, 800, 600, 0);
    const cart = { x: -391, y: 909 };
    const s = worldToScreen(view, cart);
    const target = screenToWorld(view, { x: s.x, y: s.y - 50 });
    expect(target).not.toBeNull();
    if (target === null) return;
    expect(yawToward(cart, target, 0)).toBe(90);
    const right = screenToWorld(view, { x: s.x + 50, y: s.y });
    if (right === null) return;
    expect(yawToward(cart, right, 0)).toBe(0);
    // And the facing line drawn for yaw 90 points up the screen.
    expect(yawToScreenDir(90).x).toBeCloseTo(0, 12);
    expect(yawToScreenDir(90).y).toBeCloseTo(-1, 12);
  });
});

describe('radar transform', () => {
  it('matches docs/conventions.md: px = (x + 3230) / 5, py = (1713 − y) / 5', () => {
    expect(worldToRadar(MIRAGE, { x: -3230, y: 1713 })).toEqual({ x: 0, y: 0 });
    expect(worldToRadar(MIRAGE, { x: -391, y: 909 })).toEqual({ x: (-391 + 3230) / 5, y: (1713 - 909) / 5 });
  });

  it('fits the radar inside the canvas, centred, and inverts exactly', () => {
    const v = fitView(MIRAGE, 390, 700, 4);
    expect(v.side).toBe(382);
    expect(v.ox).toBe(4);
    expect(v.oy).toBe((700 - 382) / 2);
    const p = { x: 123.5, y: -456.25 };
    const back = screenToWorld(v, worldToScreen(v, p));
    expect(back?.x).toBeCloseTo(p.x, 9);
    expect(back?.y).toBeCloseTo(p.y, 9);
    expect(screenToWorld(fitView(MIRAGE, 0, 0), { x: 1, y: 1 })).toBeNull();
  });
});

describe('weapon slots', () => {
  const cart = ['ak47', 'knife', 'smoke'];
  it('selects the slot weapon, or nothing when empty or already out', () => {
    expect(weaponForSlot(3, cart, 'ak47')).toBe('knife');
    expect(weaponForSlot(1, cart, 'knife')).toBe('ak47');
    expect(weaponForSlot(1, cart, 'ak47')).toBeNull();
    expect(weaponForSlot(2, cart, 'ak47')).toBeNull();
    expect(weaponForSlot(4, cart, 'ak47')).toBe('smoke');
    expect(weaponForSlot(5, cart, 'ak47')).toBeNull();
    expect(weaponForSlot(5, ['c4', 'ak47'], 'ak47')).toBe('c4');
  });

  it('cycles grenades on repeated 4', () => {
    const donk = ['awp', 'flash', 'glock', 'knife', 'molotov'];
    expect(weaponForSlot(4, donk, 'awp')).toBe('flash');
    expect(weaponForSlot(4, donk, 'flash')).toBe('molotov');
    expect(weaponForSlot(4, donk, 'molotov')).toBe('flash');
    expect(weaponForSlot(2, donk, 'awp')).toBe('glock');
  });
});
