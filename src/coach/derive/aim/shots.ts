/**
 * Combat tables, part 1: every bullet joined to its shot, the shooter's tick row, the hits it caused, and its burst.
 *
 * - `weapon_fire` and `fire_bullets` share the tick and the player for every gun shot (the test demo: 1,242 of 1,242
 *   bullets; `weapon_fire` also has knives and grenade throws, which have no bullet). One row per bullet.
 * - The tick row at the bullet's tick holds the state **after** the shot (penalty + the fire penalty, recoil index + 1,
 *   the new aim punch); the view angles the shot left from are those of the row before. The shooter's speed is the
 *   velocity column one row later (it lags a tick: `speedAt`). docs/coach/mechanics.md, "Physics check".
 * - Hits: each `player_hurt` by a gun at the bullet's tick from the same attacker (all 205 gun hurts of the test demo
 *   share a bullet's tick); damage is health before minus after (`HURTS`).
 * - Bursts: consecutive bullets of one player and weapon within one round, gaps ≤ burstGapCycles × the weapon's cycle
 *   time in the mode fired. A spray is a burst of sprayMin bullets or more.
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { HURTS } from '../hurts';
import { BUTTON, FLAG, rowAtOrAfter } from '../../model/raw';
import { speedAt, velocityDirAt } from '../movement/speed';
import { AIM_TUNING } from './tuning';

export type StopTechnique = 'standing' | 'opposite' | 'coast' | 'holding' | 'crouch';

export interface ShotRow {
  /** Index into `raw.events.bullets` (and into every per-shot table). */
  readonly i: number;
  readonly tick: number;
  readonly p: number;
  /** Row of the shot's tick in `raw.ticks`. */
  readonly row: number;
  /** Round number, 0 outside a round. */
  readonly round: number;
  /** Coach item name (`ak47`, `m4a1_silencer`, …) and the weapon table id (`ak47`, `m4a1s`, …). */
  readonly weapon: string;
  readonly wid: string;
  readonly kind: string;
  readonly mode: 0 | 1;
  /** The eye (the bullet's origin). */
  readonly eye: [number, number, number];
  /** The bullet's zero-spread direction: view + aim punch × 2, i.e. the recoil-compensated aim. */
  readonly pitch: number;
  readonly yaw: number;
  /** View angles (row before the shot) and aim punch (row of the shot). */
  readonly viewPitch: number;
  readonly viewYaw: number;
  readonly punchPitch: number;
  readonly punchYaw: number;
  /** The game's own numbers for this bullet. */
  readonly inaccuracy: number;
  readonly spread: number;
  readonly recoilIndex: number;
  readonly clip: number;
  /** Speed (units/s), the weapon's max speed in this mode, and speed above moveFraction × max. */
  readonly speed: number;
  readonly maxSpeed: number;
  readonly moving: boolean;
  readonly airborne: boolean;
  /** Duck amount 0–1. */
  readonly duck: number;
  readonly scoped: boolean;
  readonly walking: boolean;
  /** The inaccuracy the same shot would have had standing still: the accuracy penalty before the shot's fire penalty. */
  readonly stillInaccuracy: number;
  /** OR of the buttons over the window before the shot, and how the shooter stopped (see `stopTechnique`). */
  readonly keys: number;
  readonly stop: StopTechnique;
  /** Ms from the shot until the speed fell under the threshold (0 when not moving; lateCapMs when it did not within that). */
  readonly msToStop: number;
  /** `HURTS` rows this bullet caused (every victim), enemy health removed, and whether it hurt an enemy. */
  readonly hits: readonly number[];
  readonly damage: number;
  readonly hitEnemy: boolean;
  /** Burst id (index into `BURSTS`), bullet number in it (1 = first) and its length. */
  readonly burst: number;
  readonly n: number;
  readonly burstLen: number;
}

export interface BurstRow {
  readonly id: number;
  readonly p: number;
  readonly weapon: string;
  readonly round: number;
  /** Shot indices, in order. */
  readonly shots: readonly number[];
  readonly spray: boolean;
}

export interface ShotTables {
  shots: ShotRow[];
  bursts: BurstRow[];
  /** `weapon_fire` records without a bullet (knife swings, grenade throws). */
  nonBulletShots: number;
}

/** Wish direction (x, y) of the movement keys at a row, from the view yaw; [0, 0] with none held. */
export function wishDir(buttons: number, yawDeg: number): [number, number] {
  const f = ((buttons & BUTTON.forward) !== 0 ? 1 : 0) - ((buttons & BUTTON.back) !== 0 ? 1 : 0);
  const s = ((buttons & BUTTON.right) !== 0 ? 1 : 0) - ((buttons & BUTTON.left) !== 0 ? 1 : 0);
  const y = (yawDeg * Math.PI) / 180;
  // forward (cos y, sin y), right (sin y, −cos y)
  return [f * Math.cos(y) + s * Math.sin(y), f * Math.sin(y) - s * Math.cos(y)];
}

/**
 * How the shooter stopped before a shot, from the rows [r0, t]: `standing` (never above the threshold in the
 * window), `holding` (at the shot a key still pushed along the velocity), `opposite` (after the window's peak speed a
 * key pushed against the velocity: a counter-strafe), `crouch` (ducked after the peak, no opposite key), `coast`
 * (released the keys and let friction stop him).
 */
export function stopTechnique(ctx: AnalysisContext, p: number, r0: number, t: number, threshold: number): StopTechnique {
  const T = ctx.raw.ticks;
  const P = ctx.P;
  let peak = -1;
  let peakSpeed = 0;
  for (let r = r0; r <= t; r++) {
    const s = speedAt(ctx.raw, r, p);
    if (s > peakSpeed) {
      peakSpeed = s;
      peak = r;
    }
  }
  if (peak < 0 || peakSpeed <= threshold) return 'standing';
  const v = velocityDirAt(ctx.raw, peak, p);
  if (v === null) return 'standing';
  const along = (r: number): number => {
    const w = wishDir(T.buttons[r * P + p] ?? 0, T.yaw[r * P + p] ?? 0);
    return w[0] * v[0] + w[1] * v[1];
  };
  if (along(t) > 0.3) return 'holding';
  let opposite = false;
  let crouch = false;
  for (let r = peak; r <= t; r++) {
    if (along(r) < -0.3) opposite = true;
    if (((T.buttons[r * P + p] ?? 0) & BUTTON.duck) !== 0) crouch = true;
  }
  return opposite ? 'opposite' : crouch ? 'crouch' : 'coast';
}

export const SHOTS: TableDef<ShotTables> = {
  id: 'aim.shots',
  build(ctx) {
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const m = ctx.weaponModel;
    const tun = AIM_TUNING;
    const rate = raw.header.tickRate || 64;
    const hurts = ctx.table(HURTS);
    const hurtsByKey = new Map<number, number[]>();
    for (const h of hurts) {
      if (h.hurt.attacker < 0) continue;
      const k = h.hurt.tick * 64 + h.hurt.attacker;
      const l = hurtsByKey.get(k);
      if (l === undefined) hurtsByKey.set(k, [h.i]);
      else l.push(h.i);
    }
    const bulletKeys = new Set<number>();
    for (const b of raw.events.bullets) bulletKeys.add(b.tick * 64 + b.p);
    let nonBulletShots = 0;
    for (const s of raw.events.shots) if (!bulletKeys.has(s.tick * 64 + s.p)) nonBulletShots++;

    const rounds = ctx.match.rounds;
    const roundOf = (tick: number): number => {
      for (const r of rounds) if (tick >= r.startTick && tick <= r.endTick) return r.number;
      return 0;
    };
    const windowTicks = Math.round((tun.shots.buttonWindowMs * rate) / 1000);
    const capTicks = Math.round((tun.counterStrafe.lateCapMs * rate) / 1000);
    const shots: ShotRow[] = [];
    raw.events.bullets.forEach((b, i) => {
      const w = ctx.weapon(b.weapon);
      const t = Math.min(rowAtOrAfter(T, b.tick), T.count - 1);
      const ic = t * P + b.p;
      const ip = Math.max(0, t - 1) * P + b.p;
      const mode: 0 | 1 = b.mode === 1 ? 1 : 0;
      const flags = T.flags[ic] ?? 0;
      const maxSpeed = w === null ? 250 : w.maxSpeed[mode];
      const threshold = maxSpeed * m.moveStartFraction;
      const speed = speedAt(raw, t, b.p);
      const moving = speed > threshold;
      const fire = w === null ? 0 : w.inaccuracy.fire[mode];
      const still = Math.max(0, Math.min(b.inaccuracy, (T.penalty[ic] ?? 0) - fire));
      const r0 = Math.max(0, rowAtOrAfter(T, b.tick - windowTicks));
      let keys = 0;
      for (let r = r0; r <= t; r++) keys |= T.buttons[r * P + b.p] ?? 0;
      let msToStop = 0;
      if (moving) {
        msToStop = tun.counterStrafe.lateCapMs;
        for (let r = t + 1; r < T.count && (T.tick[r] ?? 0) - b.tick <= capTicks; r++) {
          if (speedAt(raw, r, b.p) <= threshold) {
            msToStop = (((T.tick[r] ?? 0) - b.tick) * 1000) / rate;
            break;
          }
        }
      }
      const hits = hurtsByKey.get(b.tick * 64 + b.p) ?? [];
      let damage = 0;
      let hitEnemy = false;
      for (const h of hits) {
        const row = hurts[h];
        if (row !== undefined && row.enemy) {
          damage += row.damage;
          hitEnemy = true;
        }
      }
      shots.push({
        i, tick: b.tick, p: b.p, row: t, round: roundOf(b.tick), weapon: b.weapon, wid: w?.id ?? '', kind: w?.kind ?? '', mode,
        eye: [b.x, b.y, b.z], pitch: b.pitch, yaw: b.yaw,
        viewPitch: T.pitch[ip] ?? 0, viewYaw: T.yaw[ip] ?? 0, punchPitch: T.punchPitch[ic] ?? 0, punchYaw: T.punchYaw[ic] ?? 0,
        inaccuracy: b.inaccuracy, spread: b.spread, recoilIndex: b.recoilIndex, clip: b.clip,
        speed, maxSpeed, moving, airborne: (flags & FLAG.airborne) !== 0, duck: (T.duck[ic] ?? 0) / 255,
        scoped: (flags & FLAG.scoped) !== 0, walking: (flags & FLAG.walking) !== 0, stillInaccuracy: still,
        keys, stop: stopTechnique(ctx, b.p, r0, t, threshold), msToStop, hits, damage, hitEnemy, burst: -1, n: 0, burstLen: 0,
      });
    });

    // Bursts, per player in tick order.
    const bursts: BurstRow[] = [];
    const last = new Map<number, number>();
    const lastBurst = new Map<number, BurstRow>();
    const mut = shots as unknown as { burst: number; n: number; burstLen: number }[];
    for (const s of shots) {
      const prevI = last.get(s.p);
      const prev = prevI === undefined ? undefined : shots[prevI];
      const w = ctx.weapon(s.weapon);
      const gap = w === null ? 0 : tun.shots.burstGapCycles * w.cycleTime[s.mode] * rate;
      const cur = lastBurst.get(s.p);
      if (prev !== undefined && cur !== undefined && prev.weapon === s.weapon && prev.round === s.round && s.tick - prev.tick <= gap) {
        (cur.shots as number[]).push(s.i);
      } else {
        const b: BurstRow = { id: bursts.length, p: s.p, weapon: s.weapon, round: s.round, shots: [s.i], spray: false };
        bursts.push(b);
        lastBurst.set(s.p, b);
      }
      last.set(s.p, s.i);
    }
    for (const b of bursts) {
      (b as { spray: boolean }).spray = b.shots.length >= tun.shots.sprayMin;
      b.shots.forEach((si, k) => {
        const r = mut[si] as { burst: number; n: number; burstLen: number };
        r.burst = b.id;
        r.n = k + 1;
        r.burstLen = b.shots.length;
      });
    }
    return { shots, bursts, nonBulletShots };
  },
};
