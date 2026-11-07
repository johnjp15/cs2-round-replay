/**
 * W1: the 3D page's controls (pure parts): the fixed crosshair (#32), wheel jump across frames and ticks (#40), Q =
 * lastinv (#41), the round hotkeys (#49), the Ctrl+W banner and the zoom guard (#35, #53), and the inspect / knife
 * viewmodel poses (#42, #38).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_MAP } from '../src/app/input';
import { ctrlWBanner } from '../src/app/play-guard';
import { blocksWheelZoom } from '../src/app3d/controls-dom';
import { DEFAULT_HOTKEYS, HotkeyMatcher, canBindHotkey, parseHotkeys, rebindHotkey } from '../src/app3d/hotkeys3d';
import { LastInv, WheelJump, crosshairOffsetPx, lastInvSlots, wheelJumps } from '../src/app3d/input3d';
import { aimOffsetPx } from '../src/app3d/spectate';
import { modelOf } from '../src/app3d/viewmodels/models';
import { INSPECT_SEC, freshPose, vmPose, type VmAnim } from '../src/app3d/viewmodels/pose';
import { VmTracker } from '../src/app3d/viewmodels/tracker';
import type { PawnObs } from '../src/contracts/index';

describe('crosshair (#32: cl_crosshair_recoil 0)', () => {
  const cam = { yaw: 10, pitch: -2 };
  const bullet = { yaw: 10.5, pitch: -6 };
  const px = (c: { yaw: number; pitch: number }, a: { yaw: number; pitch: number }) => aimOffsetPx(c, a, 73.74, 1000);
  it('stays at the screen centre by default, whatever the punch', () => {
    expect(crosshairOffsetPx(false, cam, bullet, px)).toEqual({ x: 0, y: 0 });
  });
  it('with "Crosshair follows recoil" it sits where the next bullet goes (above and right of centre here)', () => {
    const o = crosshairOffsetPx(true, cam, bullet, px);
    expect(o.y).toBeLessThan(-20);
    expect(o).toEqual(px(cam, bullet));
  });
});

describe('wheel jump (#40)', () => {
  it('a notch between ticks is held until a tick runs, then released for a tick', () => {
    const w = new WheelJump();
    expect(w.held()).toBe(false);
    w.notch();
    // Three frames run no tick (uncapped fps): JUMP stays held.
    for (let i = 0; i < 3; i++) {
      expect(w.held()).toBe(true);
      w.ticksRan(0);
    }
    expect(w.held()).toBe(true);
    w.ticksRan(1); // the tick saw JUMP
    expect(w.held()).toBe(false); // a release tick
    w.notch(); // a notch during the release waits for it
    expect(w.held()).toBe(false);
    w.ticksRan(1);
    expect(w.held()).toBe(true);
    w.ticksRan(2);
    expect(w.held()).toBe(false);
    w.ticksRan(1);
    expect(w.held()).toBe(false);
  });
  it('many notches while pending do not queue more than one jump', () => {
    const w = new WheelJump();
    for (let i = 0; i < 10; i++) w.notch();
    const seen: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(w.held());
      w.ticksRan(1);
    }
    expect(seen).toEqual([true, false, true, false, false, false, false, false]);
  });
  it('down / up per the checkboxes', () => {
    expect(wheelJumps({ down: true, up: false }, 100)).toBe(true);
    expect(wheelJumps({ down: true, up: false }, -100)).toBe(false);
    expect(wheelJumps({ down: false, up: true }, -3)).toBe(true);
    expect(wheelJumps({ down: false, up: false }, 100)).toBe(false);
  });
});

describe('Q = lastinv (#41)', () => {
  it('toggles knife ↔ rifle, reaches a grenade through the slot cycle, and does nothing without a previous item', () => {
    const carried = ['ak47', 'deagle', 'flash', 'he', 'knife', 'smoke'];
    expect(lastInvSlots('ak47', 'knife', carried)).toEqual([1]);
    expect(lastInvSlots('knife', 'ak47', carried)).toEqual([3]);
    // Slot 4 cycles he → flash → smoke (input.ts SLOT_WEAPONS order).
    expect(lastInvSlots('smoke', 'ak47', carried)).toEqual([4, 4, 4]);
    expect(lastInvSlots('he', 'flash', carried)).toEqual([4, 4]); // flash → smoke → he
    expect(lastInvSlots(null, 'ak47', carried)).toEqual([]);
    expect(lastInvSlots('awp', 'ak47', carried)).toEqual([]);
  });
  it('remembers the item held before the last switch', () => {
    const l = new LastInv();
    l.observe('ak47');
    l.observe('ak47');
    expect(l.previous).toBeNull();
    l.observe('knife');
    expect(l.previous).toBe('ak47');
    l.observe('ak47');
    expect(l.previous).toBe('knife');
  });
});

describe('round hotkeys (#49)', () => {
  it('defaults far from WASD: Enter, P, Backspace twice', () => {
    expect(DEFAULT_HOTKEYS).toEqual({ start: 'Enter', pause: 'KeyP', restart: 'Backspace' });
    for (const code of Object.values(DEFAULT_HOTKEYS)) expect(DEFAULT_KEY_MAP.has(code)).toBe(false);
  });
  it('restart needs two presses within 1 s; start and pause one', () => {
    const m = new HotkeyMatcher();
    expect(m.press('Enter', 0)).toBe('start');
    expect(m.press('KeyP', 10)).toBe('pause');
    expect(m.press('Backspace', 100)).toBeNull();
    expect(m.armed(500)).toBe(true);
    expect(m.press('Backspace', 1200)).toBeNull(); // 1.1 s later: a new first press
    expect(m.press('Backspace', 1900)).toBe('restart');
    expect(m.press('Backspace', 2000)).toBeNull();
    // Another hotkey in between disarms it.
    m.press('Backspace', 3000);
    m.press('KeyP', 3100);
    expect(m.press('Backspace', 3200)).toBeNull();
  });
  it('refuses keys near WASD, CS2 binds and game keys; swaps on a clash; parses stored values', () => {
    for (const c of ['KeyW', 'KeyQ', 'KeyF', 'KeyG', 'KeyR', 'KeyB', 'KeyC', 'Digit3', 'Space', 'ControlLeft', 'ShiftLeft', 'Tab', 'Escape']) expect(canBindHotkey(c)).toBe(false);
    expect(canBindHotkey('Home')).toBe(true);
    expect(canBindHotkey('KeyK', (c) => c === 'KeyK')).toBe(false);
    expect(rebindHotkey(DEFAULT_HOTKEYS, 'start', 'KeyP')).toEqual({ start: 'KeyP', pause: 'Enter', restart: 'Backspace' });
    expect(rebindHotkey(DEFAULT_HOTKEYS, 'restart', 'KeyR')).toBeNull();
    expect(parseHotkeys({ start: 'Home', pause: 'KeyW' })).toEqual({ start: 'Home', pause: 'KeyP', restart: 'Backspace' });
    expect(parseHotkeys({ start: 'KeyP' })).toEqual(DEFAULT_HOTKEYS);
    expect(parseHotkeys('junk')).toEqual(DEFAULT_HOTKEYS);
  });
});

describe('Ctrl+scroll and Ctrl+W (#35, #53)', () => {
  it('Ctrl / ⌘ + wheel (and a pinch, sent with ctrlKey) is cancelled', () => {
    expect(blocksWheelZoom({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(blocksWheelZoom({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(blocksWheelZoom({ ctrlKey: false, metaKey: false })).toBe(false);
  });
  it('the banner shows while playing whenever Ctrl+W can still close the tab', () => {
    expect(ctrlWBanner(true, false, false, true, false)).toBe('Press ⛶ for fullscreen to disable Ctrl+W');
    expect(ctrlWBanner(true, true, false, true, true)).toBe('');
    expect(ctrlWBanner(true, false, true, true, false)).toBe('');
    expect(ctrlWBanner(false, false, false, true, false)).toBe('');
    expect(ctrlWBanner(true, false, false, false, false)).toMatch(/can’t block Ctrl\+W/);
  });
});

const anim = (weapon: string, extra: Partial<VmAnim> = {}): VmAnim => ({ weapon, sinceShot: 1e6, cycle: 0.1, reload: null, deploy: null, swing: null, plant: null, primed: false, thrown: null, speed: 0, time: 0, ...extra });

describe('inspect and knife poses (#42, #38)', () => {
  it('inspects each class for 2.5 s, back at rest at the end', () => {
    for (const w of ['ak47', 'awp', 'deagle', 'knife', 'c4', 'he']) {
      const mid = vmPose(anim(w, { inspect: 1.0 }), modelOf(w), freshPose());
      expect(mid.phase).toBe('inspect');
      expect(Math.abs(mid.rx) + Math.abs(mid.ry) + Math.abs(mid.rz)).toBeGreaterThan(0.3);
      const end = vmPose(anim(w, { inspect: INSPECT_SEC - 1e-9 }), modelOf(w), freshPose());
      expect(Math.abs(end.ry) + Math.abs(end.rz) + Math.abs(end.x)).toBeLessThan(1e-3);
      expect(vmPose(anim(w, { inspect: INSPECT_SEC }), modelOf(w), freshPose()).phase).toBe('idle');
    }
  });
  it('a stab thrusts forward; slashes alternate direction', () => {
    const stab = vmPose(anim('knife', { swing: 0.36, swingKind: 'stab' }), modelOf('knife'), freshPose());
    expect(stab.phase).toBe('stab');
    expect(stab.z).toBeLessThan(-8);
    const right = vmPose(anim('knife', { swing: 0.2, swingKind: 'slash', swingLeft: false }), modelOf('knife'), freshPose());
    const left = vmPose(anim('knife', { swing: 0.2, swingKind: 'slash', swingLeft: true }), modelOf('knife'), freshPose());
    expect(Math.sign(right.ry)).toBe(-Math.sign(left.ry));
  });
  it('the tracker cuts the inspect off with a shot, a swing or a weapon switch', () => {
    const pawn = (weapon: string): PawnObs => ({ id: 'cart', team: 'T', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, armor: 0, alive: true, weapon, ammo: { clip: 30, reserve: 90 }, crouching: false, onGround: true, sees: [] });
    const t = new VmTracker();
    const timers = { deployEndTick: 0, reloadEndTick: null, grenadePrimed: false };
    t.ingest(10, pawn('ak47'), timers, false, false);
    t.inspect(10);
    t.ingest(11, pawn('ak47'), timers, false, false);
    expect(t.anim(40, 0.1, 0, 0)?.inspect).toBeCloseTo(30 / 64, 6);
    t.ingest(42, pawn('ak47'), timers, true, false); // a shot
    expect(t.anim(43, 0.1, 0, 0)?.inspect).toBeNull();
    t.inspect(50);
    t.ingest(51, pawn('knife'), timers, false, false); // a switch
    expect(t.anim(52, 0.1, 0, 0)?.inspect).toBeNull();
    t.inspect(60);
    t.swing(61, 'stab');
    expect(t.anim(62, 0.1, 0, 0)?.inspect).toBeNull();
    expect(t.anim(62, 0.1, 0, 0)?.swingKind).toBe('stab');
  });
});
