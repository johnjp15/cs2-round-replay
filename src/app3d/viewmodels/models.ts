/**
 * A1: the low-poly weapon models (docs/app3d.md "Viewmodels"): recognizable silhouettes in the right colours,
 * built from boxes and cylinders (parts.ts), in Source units at real size (AK-47 ≈ 35 in long). One spec per weapon:
 * the static body and the parts the animations move (mag, bolt / slide, pin), the muzzle point (flash, tracers), and
 * where the left hand holds it. The same spec gives the first-person viewmodel (with hands) and the world model on
 * the other players (body + mag + bolt merged, no hands).
 *
 * Model space (parts.ts): x right, y up, −z forward, origin at the top of the pistol grip.
 */
import type { Part } from './parts';

export interface WeaponModel {
  readonly body: readonly Part[];
  readonly mag?: readonly Part[];
  /** Bolt handle / charging handle / pistol slide: kicks back on a shot and during the reload's bolt stage. */
  readonly bolt?: readonly Part[];
  /** Grenade pin (pulled off when primed). */
  readonly pin?: readonly Part[];
  readonly muzzle: readonly [number, number, number];
  /** Left hand on the handguard (rifles), or null: both hands on the grip (pistols, knife, grenades). */
  readonly leftHand: readonly [number, number, number] | null;
  /** How far the bolt / slide travels back (units). */
  readonly boltTravel: number;
  readonly kind: 'rifle' | 'sniper' | 'pistol' | 'knife' | 'c4' | 'grenade';
  readonly silenced?: boolean;
}

const STEEL = 0x34363a;
const STEEL_LIGHT = 0x55595e;
const BLACK = 0x232426;
const WOOD = 0x8d5a2b;
const WOOD_DARK = 0x62401f;

const ak47: WeaponModel = {
  kind: 'rifle',
  body: [
    { s: 'box', c: STEEL, size: [1.9, 2.4, 11], at: [0, 0.6, -3.2] },
    { s: 'box', c: STEEL_LIGHT, size: [1.7, 0.9, 9.5], at: [0, 2.15, -2.6] },
    { s: 'box', c: WOOD, size: [2.3, 2.0, 6.5], at: [0, 0.3, -12] },
    { s: 'cylz', c: STEEL, size: [0.55, 7, 8], at: [0, 2.0, -12] },
    { s: 'box', c: WOOD, size: [1.9, 1.0, 6], at: [0, 2.2, -12.2] },
    { s: 'cylz', c: STEEL, size: [0.42, 9.5, 8], at: [0, 0.9, -19.7] },
    { s: 'box', c: STEEL, size: [0.4, 1.9, 0.5], at: [0, 2.2, -21.5] },
    { s: 'cylz', c: STEEL_LIGHT, size: [0.62, 1.4, 8], at: [0, 0.9, -24.8] },
    { s: 'box', c: STEEL, size: [1.2, 0.5, 1.2], at: [0, 2.0, -16.2] },
    { s: 'box', c: WOOD, size: [1.7, 2.6, 10], at: [0, -0.3, 7.3], rot: [0.12, 0, 0] },
    { s: 'box', c: WOOD_DARK, size: [1.8, 3.3, 0.8], at: [0, -0.9, 12.3], rot: [0.12, 0, 0] },
    { s: 'box', c: WOOD_DARK, size: [1.3, 3.4, 1.5], at: [0, -2.1, 1.1], rot: [0.3, 0, 0] },
    { s: 'box', c: STEEL, size: [0.3, 1.0, 2.2], at: [0, -1.0, -0.6] },
  ],
  mag: [
    { s: 'box', c: 0x2f3033, size: [1.3, 3.6, 2.3], at: [0, -1.9, -4.6], rot: [-0.18, 0, 0] },
    { s: 'box', c: 0x2f3033, size: [1.3, 3.6, 2.3], at: [0, -4.9, -5.6], rot: [-0.5, 0, 0] },
  ],
  bolt: [{ s: 'cylx', c: STEEL_LIGHT, size: [0.35, 1.6, 6], at: [1.4, 1.3, -5.4] }],
  muzzle: [0, 0.9, -25.6],
  leftHand: [0, -0.4, -12.5],
  boltTravel: 2.6,
};

const m4Body = (len: number): Part[] => [
  { s: 'box', c: BLACK, size: [1.8, 2.3, 9], at: [0, 0.6, -2.6] },
  { s: 'box', c: 0x2b2d31, size: [1.4, 1.1, 9], at: [0, 2.25, -2.8] },
  { s: 'box', c: BLACK, size: [0.9, 1.6, 2.2], at: [0, 3.4, 0.8] },
  { s: 'box', c: 0x2b2d31, size: [2.4, 2.4, 7], at: [0, 0.9, -11.2] },
  { s: 'cylz', c: BLACK, size: [0.42, len, 8], at: [0, 0.9, -14.6 - len / 2] },
  { s: 'box', c: BLACK, size: [0.4, 2.0, 0.5], at: [0, 2.0, -17.4] },
  { s: 'box', c: BLACK, size: [1.6, 2.2, 7.5], at: [0, 0.2, 6.5] },
  { s: 'box', c: 0x2b2d31, size: [1.7, 3.6, 1.0], at: [0, -0.2, 10.6] },
  { s: 'cylz', c: BLACK, size: [0.45, 4, 6], at: [0, 1.0, 3.4] },
  { s: 'box', c: BLACK, size: [1.3, 3.2, 1.4], at: [0, -2.0, 1.0], rot: [0.3, 0, 0] },
];

const m4Mag: Part[] = [{ s: 'box', c: 0x3a3c40, size: [1.2, 4.8, 2.3], at: [0, -2.6, -4.3], rot: [-0.12, 0, 0] }];
const m4Bolt: Part[] = [{ s: 'box', c: 0x4a4d52, size: [1.0, 0.5, 1.2], at: [0, 2.3, 2.6] }];

const m4a4: WeaponModel = {
  kind: 'rifle',
  body: [...m4Body(5.5), { s: 'cylz', c: BLACK, size: [0.6, 1.6, 8], at: [0, 0.9, -21] }],
  mag: m4Mag,
  bolt: m4Bolt,
  muzzle: [0, 0.9, -21.9],
  leftHand: [0, -0.4, -11.5],
  boltTravel: 2.2,
};

const m4a1s: WeaponModel = {
  kind: 'rifle',
  silenced: true,
  body: [...m4Body(4.5), { s: 'cylz', c: 0x1c1d1f, size: [0.85, 8.5, 10], at: [0, 0.9, -23.4] }],
  mag: [{ s: 'box', c: 0x3a3c40, size: [1.2, 3.8, 2.3], at: [0, -2.1, -4.3], rot: [-0.12, 0, 0] }],
  bolt: m4Bolt,
  muzzle: [0, 0.9, -27.8],
  leftHand: [0, -0.4, -11.5],
  boltTravel: 2.2,
};

const AWP_GREEN = 0x56633e;
const awp: WeaponModel = {
  kind: 'sniper',
  body: [
    { s: 'box', c: AWP_GREEN, size: [2.4, 3.0, 14], at: [0, 0.2, -3] },
    { s: 'box', c: AWP_GREEN, size: [2.2, 3.6, 9], at: [0, -0.6, 8.5] },
    { s: 'box', c: AWP_GREEN, size: [1.6, 2.4, 3.2], at: [0, 0.6, 4.0] },
    { s: 'box', c: BLACK, size: [2.3, 4.2, 1.0], at: [0, -0.9, 13.4] },
    { s: 'box', c: STEEL, size: [1.6, 1.6, 9], at: [0, 1.8, -1.4] },
    { s: 'cylz', c: 0x2a2c2f, size: [0.55, 22, 8], at: [0, 1.4, -20.5] },
    { s: 'cylz', c: STEEL, size: [0.75, 2.2, 8], at: [0, 1.4, -32] },
    { s: 'cylz', c: 0x1e1f21, size: [0.9, 11, 10], at: [0, 4.1, -2] },
    { s: 'cylz', c: 0x1e1f21, size: [1.25, 2.6, 10], at: [0, 4.1, -8.6] },
    { s: 'cylz', c: 0x1e1f21, size: [1.05, 2.0, 10], at: [0, 4.1, 3.6] },
    { s: 'box', c: 0x1e1f21, size: [0.8, 1.6, 1.2], at: [0, 2.9, -4] },
    { s: 'box', c: 0x1e1f21, size: [0.8, 1.6, 1.2], at: [0, 2.9, 1.5] },
    { s: 'box', c: AWP_GREEN, size: [1.4, 3.0, 1.6], at: [0, -2.0, 0.9], rot: [0.25, 0, 0] },
  ],
  mag: [{ s: 'box', c: 0x2a2c2f, size: [1.4, 2.2, 3.0], at: [0, -1.9, -3.8] }],
  bolt: [
    { s: 'cylx', c: STEEL_LIGHT, size: [0.32, 2.2, 6], at: [1.6, 1.9, 1.2] },
    { s: 'sphere', c: STEEL_LIGHT, size: [0.55], at: [2.8, 1.9, 1.2] },
  ],
  muzzle: [0, 1.4, -33.2],
  leftHand: [0, -0.8, -9],
  boltTravel: 4,
};

const SSG = 0x3d4448;
const ssg08: WeaponModel = {
  kind: 'sniper',
  body: [
    { s: 'box', c: SSG, size: [2.0, 2.4, 13], at: [0, 0.1, -3.5] },
    { s: 'box', c: SSG, size: [1.6, 2.8, 8.5], at: [0, -0.9, 8], rot: [0.08, 0, 0] },
    { s: 'box', c: SSG, size: [1.4, 1.6, 3.5], at: [0, 0.4, 3.4] },
    { s: 'box', c: STEEL, size: [1.4, 1.3, 8], at: [0, 1.6, -1.4] },
    { s: 'cylz', c: 0x2b2e31, size: [0.42, 20, 8], at: [0, 1.2, -19.4] },
    { s: 'cylz', c: 0x1e1f21, size: [0.8, 10, 10], at: [0, 3.6, -2] },
    { s: 'cylz', c: 0x1e1f21, size: [1.05, 2.4, 10], at: [0, 3.6, -8] },
    { s: 'cylz', c: 0x1e1f21, size: [0.95, 1.6, 10], at: [0, 3.6, 3.4] },
    { s: 'box', c: SSG, size: [1.3, 2.8, 1.4], at: [0, -1.8, 0.9], rot: [0.25, 0, 0] },
  ],
  mag: [{ s: 'box', c: 0x2a2c2f, size: [1.2, 2.0, 2.4], at: [0, -1.6, -3.6] }],
  bolt: [
    { s: 'cylx', c: STEEL_LIGHT, size: [0.28, 2.0, 6], at: [1.4, 1.7, 1.0] },
    { s: 'sphere', c: STEEL_LIGHT, size: [0.45], at: [2.4, 1.7, 1.0] },
  ],
  muzzle: [0, 1.2, -29.6],
  leftHand: [0, -0.6, -9.5],
  boltTravel: 3.5,
};

const pistol = (frame: number, slide: number, len: number, h: number, extra: Part[] = [], silenced = false, muzzleExtra = 0): WeaponModel => ({
  kind: 'pistol',
  silenced,
  body: [
    { s: 'box', c: frame, size: [1.1, 1.1, len * 0.85], at: [0, 0.1, -len * 0.38] },
    { s: 'box', c: frame, size: [1.1, h, 1.7], at: [0, -h / 2 + 0.2, 0.2], rot: [0.22, 0, 0] },
    { s: 'box', c: frame, size: [0.25, 0.7, 1.6], at: [0, -0.7, -1.3] },
    ...extra,
  ],
  bolt: [
    { s: 'box', c: slide, size: [1.2, 1.15, len], at: [0, 1.15, -len * 0.42] },
    { s: 'box', c: slide, size: [0.3, 0.35, 0.3], at: [0, 1.85, -len * 0.9] },
  ],
  mag: [{ s: 'box', c: frame, size: [0.9, 1.0, 1.4], at: [0, -h + 0.25, 0.55], rot: [0.22, 0, 0] }],
  muzzle: [0, 1.1, -len * 0.95 - muzzleExtra],
  leftHand: null,
  boltTravel: 1.2,
});

const deagle = pistol(0xa9acb0, 0xb9bcc0, 10, 4.4, [{ s: 'box', c: 0x2a2a2a, size: [1.25, 3.4, 1.5], at: [0, -2.1, 0.35], rot: [0.22, 0, 0] }]);
const glock = pistol(0x2a2b2d, 0x3b3d40, 7.4, 3.8);
const p2000 = pistol(0x2c2e31, 0x36383c, 7.2, 3.9);
const usps = pistol(0x26272a, 0x2f3033, 7.6, 3.9, [{ s: 'cylz', c: 0x1c1d1f, size: [0.65, 6.2, 10], at: [0, 1.1, -9.9] }], true, 6);

const knife: WeaponModel = {
  kind: 'knife',
  body: [
    { s: 'box', c: 0x1f1f20, size: [0.9, 1.1, 4.4], at: [0, 0, 0.4] },
    { s: 'box', c: 0x4d5054, size: [1.6, 1.3, 0.4], at: [0, 0.15, -1.9] },
    { s: 'box', c: 0xc9ced3, size: [0.18, 1.4, 6.2], at: [0, 0.35, -5.2] },
    { s: 'box', c: 0xe2e5e8, size: [0.16, 0.6, 2.4], at: [0, 0.55, -8.6], rot: [-0.35, 0, 0] },
  ],
  muzzle: [0, 0.4, -9.5],
  leftHand: null,
  boltTravel: 0,
};

const c4: WeaponModel = {
  kind: 'c4',
  body: [
    { s: 'box', c: 0x77704f, size: [4.4, 2.6, 6.4], at: [0, 0, -3] },
    { s: 'cylz', c: 0x8a8462, size: [1.0, 6.4, 8], at: [-1.4, 1.4, -3] },
    { s: 'cylz', c: 0x8a8462, size: [1.0, 6.4, 8], at: [1.4, 1.4, -3] },
    { s: 'box', c: 0x2c2c2c, size: [2.6, 0.6, 3.0], at: [0, 1.9, -2.2] },
    { s: 'box', c: 0x7fd06a, size: [1.6, 0.1, 0.8], at: [0, 2.25, -3.2] },
    { s: 'box', c: 0xb02a22, size: [0.2, 0.2, 5.0], at: [1.9, 1.0, -3] },
    { s: 'box', c: 0x3a3a3a, size: [4.6, 0.3, 0.5], at: [0, 0, -0.6] },
  ],
  bolt: [{ s: 'box', c: 0xd0d0c8, size: [1.8, 0.2, 1.4], at: [0, 2.3, -1.6] }],
  muzzle: [0, 2.2, -3.0],
  leftHand: [-1.6, -1.2, -4.5],
  boltTravel: 0.3,
};

const nade = (bodyColor: number, h: number, r: number, band: number): WeaponModel => ({
  kind: 'grenade',
  body: [
    { s: 'cyl', c: bodyColor, size: [r, h, 10], at: [0, 0.4, -1.2] },
    { s: 'cyl', c: band, size: [r * 1.02, 0.5, 10], at: [0, 0.4 + h * 0.2, -1.2] },
    { s: 'cyl', c: 0x8e9398, size: [r * 0.45, 0.9, 8], at: [0, 0.8 + h / 2, -1.2] },
    { s: 'box', c: 0x9aa0a6, size: [0.5, h * 0.8, 0.25], at: [r + 0.1, 0.6, -1.2] },
  ],
  pin: [{ s: 'cylz', c: 0xc0c4c8, size: [0.45, 0.15, 10, 0.45], at: [-r * 0.2, 1.1 + h / 2, -1.2], rot: [0, Math.PI / 2, 0] }],
  muzzle: [0, 0.4, -1.2],
  leftHand: null,
  boltTravel: 0,
});

const he: WeaponModel = { ...nade(0x55613a, 2.6, 1.3, 0x3f4a2a), body: [{ s: 'sphere', c: 0x55613a, size: [1.45], at: [0, 0.3, -1.2] }, { s: 'cyl', c: 0x8e9398, size: [0.55, 1.0, 8], at: [0, 1.9, -1.2] }, { s: 'box', c: 0x9aa0a6, size: [0.5, 2.0, 0.25], at: [1.4, 0.7, -1.2] }] };
const flash = nade(0xb7bbbf, 3.6, 0.9, 0x5c6066);
const smoke = nade(0x80868c, 3.8, 1.0, 0x6d8a55);
const decoy = nade(0x5d6c5d, 3.2, 0.95, 0x3c463c);
const incgrenade = nade(0x9a4a2a, 3.4, 0.95, 0x5c2a18);
const molotov: WeaponModel = {
  kind: 'grenade',
  body: [
    { s: 'cyl', c: 0x6a4a1e, size: [1.15, 3.6, 10], at: [0, 0.2, -1.2] },
    { s: 'cyl', c: 0x6a4a1e, size: [0.42, 1.8, 8, 1.0], at: [0, 2.8, -1.2] },
    { s: 'box', c: 0xd7c8a3, size: [0.9, 1.8, 0.9], at: [0, 4.2, -1.2], rot: [0.3, 0.4, 0.2] },
  ],
  pin: [{ s: 'sphere', c: 0xff9a2a, size: [0.4], at: [0.2, 5.0, -1.2] }],
  muzzle: [0, 4.6, -1.2],
  leftHand: null,
  boltTravel: 0,
};

/** Every model by weapon-table id (WeaponId plus the weapon-table ids the 3D app may hold later). */
export const WEAPON_MODELS: Readonly<Record<string, WeaponModel>> = {
  ak47,
  m4a4,
  m4a1s,
  awp,
  ssg08,
  deagle,
  glock,
  usps,
  p2000,
  knife,
  c4,
  he,
  flash,
  smoke,
  molotov,
  incgrenade,
  decoy,
};

export function modelOf(weapon: string): WeaponModel {
  return WEAPON_MODELS[weapon] ?? (WEAPON_MODELS['knife'] as WeaponModel);
}
