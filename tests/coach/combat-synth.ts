/**
 * K2 test helpers: small synthetic RawDemos with a tick row every tick, positions, view angles, weapons, bullets,
 * hurts, reloads and kills, on top of `synth.ts`. Positions are feet; bullets leave from the eye (feet + 64).
 */
import { FLAG, TEAM_CT, TEAM_T, rowAtOrAfter } from '../../src/coach/model/raw';
import type { RawDemo } from '../../src/coach/model/raw';
import { synthDemo, roundsFrom } from './synth';

export const WEAPONS = ['', 'ak47', 'glock', 'hegrenade', 'knife'];
export const EYE = 64;

/** `players` per side (slots 0..n−1 T, n..2n−1 CT), `rounds` rounds of 1,000 ticks from tick 100, one row per tick. */
export function combatDemo(perSide = 2, rounds = 1): RawDemo {
  const players = Array.from({ length: perSide * 2 }, (_, p) => ({ name: `${p < perSide ? 'a' : 'b'}${(p % perSide) + 1}` }));
  const raw = synthDemo({ players, team: (_r, p) => (p < perSide ? TEAM_T : TEAM_CT), matchStart: 100, rounds: roundsFrom(100, rounds), step: 1 });
  raw.names.weapons = [...WEAPONS];
  const T = raw.ticks;
  for (let i = 0; i < T.count * players.length; i++) {
    T.weapon[i] = 1;
    T.clip[i] = 30;
    T.penalty[i] = 0.00641;
  }
  return raw;
}

function rows(raw: RawDemo, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = rowAtOrAfter(raw.ticks, from); t < raw.ticks.count && (raw.ticks.tick[t] ?? 0) <= to; t++) out.push(t);
  return out;
}

export function setPos(raw: RawDemo, p: number, from: number, to: number, x: number, y: number, z = 0): void {
  const P = raw.players.length;
  for (const t of rows(raw, from, to)) {
    raw.ticks.x[t * P + p] = x;
    raw.ticks.y[t * P + p] = y;
    raw.ticks.z[t * P + p] = z;
  }
}

/** Velocity (and the matching motion of x) over [from, to]. */
export function setVel(raw: RawDemo, p: number, from: number, to: number, vx: number, vy = 0): void {
  const P = raw.players.length;
  for (const t of rows(raw, from, to)) {
    raw.ticks.vx[t * P + p] = vx;
    raw.ticks.vy[t * P + p] = vy;
  }
}

export function setButtons(raw: RawDemo, p: number, from: number, to: number, buttons: number): void {
  const P = raw.players.length;
  for (const t of rows(raw, from, to)) raw.ticks.buttons[t * P + p] = buttons;
}

export function setView(raw: RawDemo, p: number, from: number, to: number, pitch: number, yaw: number): void {
  const P = raw.players.length;
  for (const t of rows(raw, from, to)) {
    raw.ticks.pitch[t * P + p] = pitch;
    raw.ticks.yaw[t * P + p] = yaw;
  }
}

export function setWeapon(raw: RawDemo, p: number, from: number, to: number, item: string, clip = 30): void {
  const P = raw.players.length;
  const id = WEAPONS.indexOf(item);
  for (const t of rows(raw, from, to)) {
    raw.ticks.weapon[t * P + p] = id;
    raw.ticks.clip[t * P + p] = clip;
  }
}

export function setFlag(raw: RawDemo, p: number, from: number, to: number, flag: number, on: boolean): void {
  const P = raw.players.length;
  for (const t of rows(raw, from, to)) {
    const i = t * P + p;
    raw.ticks.flags[i] = on ? (raw.ticks.flags[i] ?? 0) | flag : (raw.ticks.flags[i] ?? 0) & ~flag;
  }
}

/** Dead (not alive, health 0) from `from` to the round's end. */
export function kill(raw: RawDemo, victim: number, attacker: number, tick: number, weapon = 'ak47', until = tick + 200): void {
  setFlag(raw, victim, tick, until, FLAG.alive, false);
  raw.events.kills.push({ tick, victim, attacker, assister: -1, weapon, headshot: false, penetrated: 0, thruSmoke: false, attackerBlind: false, noScope: false, assistedFlash: false, distance: 10, hitgroup: 'chest' });
}

/** The pitch / yaw from p's eye at `tick` to q's chest (48.5 above the feet), plus offsets (degrees: + up = aim above, + right). */
export function aimAt(raw: RawDemo, p: number, q: number, tick: number, up = 0, right = 0): { pitch: number; yaw: number } {
  const P = raw.players.length;
  const t = rowAtOrAfter(raw.ticks, tick);
  const i = t * P + p;
  const j = t * P + q;
  const dx = (raw.ticks.x[j] ?? 0) - (raw.ticks.x[i] ?? 0);
  const dy = (raw.ticks.y[j] ?? 0) - (raw.ticks.y[i] ?? 0);
  const dz = (raw.ticks.z[j] ?? 0) + 48.5 - ((raw.ticks.z[i] ?? 0) + EYE);
  const pitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { pitch: pitch - up, yaw: yaw - right };
}

export interface BulletSpec {
  tick: number;
  p: number;
  pitch: number;
  yaw: number;
  weapon?: string;
  inaccuracy?: number;
  recoilIndex?: number;
  /** The accuracy penalty before the shot (default the AK's standing 0.00641). */
  penalty?: number;
  /** A hurt on this slot at the bullet's tick. */
  hurt?: { victim: number; healthAfter: number; dmg?: number };
}

/** A gun shot: weapon_fire + fire_bullets (+ a player_hurt). The shot's row gets the penalty + the AK's fire penalty. */
export function addBullet(raw: RawDemo, b: BulletSpec): void {
  const P = raw.players.length;
  const t = rowAtOrAfter(raw.ticks, b.tick);
  const i = t * P + b.p;
  const weapon = b.weapon ?? 'ak47';
  raw.events.shots.push({ tick: b.tick, p: b.p, weapon, silenced: false });
  raw.events.bullets.push({
    tick: b.tick, p: b.p, defIndex: 7, weapon, x: raw.ticks.x[i] ?? 0, y: raw.ticks.y[i] ?? 0, z: (raw.ticks.z[i] ?? 0) + EYE,
    pitch: b.pitch, yaw: b.yaw, inaccuracy: b.inaccuracy ?? 0.00641, spread: 0.0006, recoilIndex: b.recoilIndex ?? 0, seed: 1, mode: 0, clip: 29,
  });
  raw.ticks.penalty[i] = (b.penalty ?? 0.00641) + 0.0078;
  if (b.hurt) {
    raw.events.hurts.push({ tick: b.tick, victim: b.hurt.victim, attacker: b.p, weapon, hitgroup: 'chest', dmgHealth: b.hurt.dmg ?? 100 - b.hurt.healthAfter, dmgArmor: 0, health: b.hurt.healthAfter, armor: 100 });
  }
}

/** Sort every event list by tick (stable), as the contract requires. */
export function finish(raw: RawDemo): RawDemo {
  const ev = raw.events as unknown as Record<string, { tick: number }[]>;
  for (const k of Object.keys(ev).sort()) ev[k]?.sort((a, b) => a.tick - b.tick);
  return raw;
}
