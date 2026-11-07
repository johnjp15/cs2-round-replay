/**
 * H1 acceptance: true 3D aim in the 3D host (headless). cart is the human from the start and plays his recording
 * (fixtures/scripts/cart-follows-recording.json) into Apartments and to the window over B; then he stops, aims at
 * Lokier's head hitbox (yaw and pitch from his eye to the head's centre) and fires one AK-47 bullet.
 *
 * - Aimed at the head where the line is open: the bullet enters the head hitbox and does the AK-47's headshot damage
 *   for the distance and Lokier's armor (the CS damage math, src/sim2d/weapons.ts bulletDamage).
 * - The same shot 10° off in yaw misses everyone.
 * - Aimed at Lokier's head while the window wall is between them: the wall stops the bullet; no damage.
 *
 * Aiming is exact: the step that fires moves the pawns first, so the test steps once without firing from a snapshot
 * (the human stands still, so his view doesn't change where anyone goes), reads where both are, restores and fires
 * with the angles to the head as it will be.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize, type ObsEvent, type PawnInput, type PlayerId, type Vec3 } from '../src/contracts/index';
import { Session, type SessionSnapshot } from '../src/app/session';
import { HITBOXES, anglesTo, poseHitboxes } from '../src/engine/hitboxes';
import { bulletDamage, gunStats } from '../src/sim2d/index';
import { sim3dHostFactory, type Shot3, type Sim3DHost } from '../src/sim3d/index';
import { ROOT, ScriptDriver, parseHumanScript } from '../tools/harness';
import { loadHarness3dData } from '../tools/harness3d';

const data = loadHarness3dData();
const script = parseHumanScript(JSON.parse(readFileSync(resolve(ROOT, 'fixtures/scripts/cart-follows-recording.json'), 'utf8')) as unknown);

function newSession(): { s: Session; h: Sim3DHost } {
  const s = new Session({ ...data, seed: 1, human: 'cart', host: sim3dHostFactory(data.world) });
  return { s, h: s.host as unknown as Sim3DHost };
}

const pawn = (s: Session, id: PlayerId) => s.observe().pawns.find((p) => p.id === id) as ReturnType<Session['observe']>['pawns'][number];
const eye = (p: { pos: Vec3; crouching: boolean }): Vec3 => ({ x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching ? data.tuning.damage.crouchEyeHeight : data.tuning.damage.eyeHeight) });
const head = (p: { pos: Vec3; yaw: number; crouching: boolean }): Vec3 => (poseHitboxes(p, data.tuning.damage)[0] as { a: Vec3 }).a;

/** cart follows his recording up to tick `until` (exclusive), then gets "stand still" from there. */
function playTo(until: number): { s: Session; h: Sim3DHost } {
  const r = newSession();
  const drv = new ScriptDriver(script, 'cart');
  for (let k = 0; k < until; k++) {
    const c = drv.command(k, r.s);
    if (c.input !== null) r.s.setHumanInput(c.input);
    r.s.step();
  }
  return r;
}

const still = (yaw: number, pitch: number, fire: boolean): PawnInput => canonicalize({ id: 'cart', forward: 0, side: 0, yaw, pitch, buttons: fire ? ['ATTACK'] : [] });

/** Fire one bullet at Lokier's head as it will be on the firing tick (+ `yawOff` degrees). Returns the bullet and the step's events. */
function fireAtHead(s: Session, h: Sim3DHost, yawOff = 0): { shot: Shot3; events: readonly ObsEvent[]; aim: { yaw: number; pitch: number }; snap: SessionSnapshot } {
  const snap = s.snapshot();
  const cart = pawn(s, 'cart');
  s.setHumanInput(still(cart.yaw, cart.pitch, false));
  s.step();
  const c1 = pawn(s, 'cart');
  const l1 = pawn(s, 'lokier');
  s.restore(snap);
  const aim = anglesTo(eye(c1), head(l1));
  s.setHumanInput(still(aim.yaw + yawOff, aim.pitch, true));
  s.step();
  const shots = h.shots().filter((x) => x.shooter === 'cart');
  expect(shots.length).toBe(1);
  return { shot: shots[0] as Shot3, events: s.observe().events, aim, snap };
}

/** First tick at or after `from` where cart's eye sees Lokier's head centre through the mesh (or the last one before `to`). */
function lineToHead(from: number, to: number, open: boolean): number {
  const { s, h } = playTo(from);
  const drv = new ScriptDriver(script, 'cart');
  // Re-drive with the same script from `from` on (ScriptDriver holds the entry for the tick).
  for (let k = from; k < to; k++) {
    const c = pawn(s, 'cart');
    const l = pawn(s, 'lokier');
    if (l.alive && h.world().clear(eye(c), head(l)) === open) return k;
    const cmd = drv.command(k, s);
    if (cmd.input !== null) s.setHumanInput(cmd.input);
    s.step();
  }
  throw new Error(`no tick in [${from}, ${to}) with the line ${open ? 'open' : 'blocked'}`);
}

describe('3D aim (H1)', () => {
  const OPEN = lineToHead(1180, 1400, true);
  const run = playTo(OPEN);

  it('aimed at Lokier’s head through the window: the head hitbox, AK-47 headshot damage', () => {
    const { s, h } = run;
    const lokier = s.pawnState('lokier');
    expect(lokier?.alive).toBe(true);
    const { shot, events, aim } = fireAtHead(s, h);
    console.log(`tick ${OPEN} (${(OPEN / 64).toFixed(2)} s): cart aims yaw ${aim.yaw.toFixed(2)}, pitch ${aim.pitch.toFixed(2)} at Lokier's head ${shot.distance.toFixed(1)} u away -> ${shot.hitbox}`);
    expect(shot.victim).toBe('lokier');
    expect(shot.hitbox).toBe(HITBOXES[0]?.name);
    expect(shot.hitgroup).toBe('head');
    const gun = gunStats('ak47', data.tuning);
    if (gun === null || lokier === null) throw new Error('no ak47 / lokier');
    const want = bulletDamage(gun, shot.distance, 'head', lokier.armor, lokier.helmet, data.tuning.damage);
    const dmg = events.find((e) => e.type === 'damage' && e.attacker === 'cart');
    expect(dmg).toEqual({ type: 'damage', attacker: 'cart', victim: 'lokier', amount: Math.min(lokier.hp, want.health), armor: Math.min(lokier.armor, want.armor), weapon: 'ak47', hitgroup: 'head', scripted: false });
    // An AK-47 headshot kills from full HP (36 × 4, with or without a helmet).
    expect(want.health).toBeGreaterThanOrEqual(100);
    expect(events.some((e) => e.type === 'death' && e.victim === 'lokier' && e.headshot)).toBe(true);
  });

  it('the same shot 10° off misses', () => {
    const { s, h } = playTo(OPEN);
    const before = s.pawnState('lokier');
    const { shot, events } = fireAtHead(s, h, 10);
    expect(shot.victim).toBeNull();
    expect(events.some((e) => e.type === 'damage' && e.attacker === 'cart')).toBe(false);
    expect(s.pawnState('lokier')?.hp).toBe(before?.hp);
  });

  it('a shot at Lokier’s head through the wall does not hit', () => {
    const BLOCKED = lineToHead(1140, 1260, false);
    const { s, h } = playTo(BLOCKED);
    const before = s.pawnState('lokier');
    const { shot, events } = fireAtHead(s, h);
    console.log(`tick ${BLOCKED}: wall at ${shot.distance.toFixed(1)} u, Lokier's head ${Math.hypot(head(pawn(s, 'lokier')).x - shot.from.x, head(pawn(s, 'lokier')).y - shot.from.y).toFixed(1)} u`);
    expect(shot.wall).toBe(true);
    expect(shot.victim).toBeNull();
    expect(events.some((e) => e.type === 'damage' && e.attacker === 'cart')).toBe(false);
    expect(s.pawnState('lokier')?.hp).toBe(before?.hp);
  });
});
