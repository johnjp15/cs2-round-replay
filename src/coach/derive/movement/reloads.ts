/**
 * Movement tables: reloads (`weapon_reload`) with what was around the player, and deaths with what was in hand.
 *
 * - A reload's clip and weapon are read on the event's row (the tick row still shows the clip before the reload; the
 *   reloading flag is set from that row on). Nearest living enemy by 3D distance from the eye; with a map pack,
 *   `nearVisible` says whether any body point of an enemy within nearUnits was in sight of the eye.
 * - A death's weapon in hand and reloading flag are read on the row before the death. A death counts as "while
 *   reloading" only while the magazine is not refilled yet: the clip jumps to full about a second before the
 *   reloading flag clears (test demo: AK-47 refilled 1.4 s into a 2.47 s reload), and a death after that is not one.
 */
import type { TableDef } from '../../analyze/context';
import { FLAG, rowAtOrAfter } from '../../model/raw';
import { defaultLosTuning } from '../los';
import { MOVEMENT_TUNING } from './tuning';

export interface ReloadRow {
  readonly tick: number;
  readonly p: number;
  readonly round: number;
  readonly weapon: string;
  readonly clip: number;
  readonly clipSize: number;
  /** Nearest living enemy (slot, -1 none) and the eye-to-eye distance. */
  readonly nearest: number;
  readonly nearestDist: number;
  /** An enemy within nearUnits (visible from the eye when a map pack is loaded). */
  readonly enemyNear: boolean;
  /** More than fullShare of the magazine left. */
  readonly halfFull: boolean;
  readonly exposed: boolean;
  /** The player died before the reload finished (reloading flag still on at the death). */
  readonly diedReloading: boolean;
}

export interface DeathInHand {
  /** Index into raw.events.kills. */
  readonly k: number;
  readonly tick: number;
  readonly victim: number;
  readonly attacker: number;
  readonly round: number;
  readonly weapon: string;
  readonly reloading: boolean;
  readonly clip: number;
  /** A grenade the victim threw at his killer just before (excluded from caught-out). */
  readonly throwingAtKiller: boolean;
}

const roundAt = (rounds: { startTick: number; endTick: number; number: number }[], tick: number): number => {
  for (const r of rounds) if (tick >= r.startTick && tick <= r.endTick) return r.number;
  return 0;
};

export const DEATHS_IN_HAND: TableDef<DeathInHand[]> = {
  id: 'movement.deaths_in_hand',
  build(ctx) {
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const rate = raw.header.tickRate || 64;
    const co = MOVEMENT_TUNING.caughtOut;
    const grace = (co.throwGraceMs * rate) / 1000;
    const out: DeathInHand[] = [];
    raw.events.kills.forEach((k, idx) => {
      if (k.victim < 0) return;
      const round = roundAt(ctx.match.rounds, k.tick);
      if (round === 0) return;
      const t = Math.max(0, rowAtOrAfter(T, k.tick) - 1);
      const i = t * P + k.victim;
      const weapon = raw.names.weapons[T.weapon[i] ?? 0] ?? '';
      let throwing = false;
      if (k.attacker >= 0 && k.attacker !== k.victim) {
        for (const s of raw.events.shots) {
          if (s.p !== k.victim || s.tick > k.tick || s.tick < k.tick - grace) continue;
          if (!['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incgrenade', 'decoy'].includes(s.weapon)) continue;
          const ts = Math.min(rowAtOrAfter(T, s.tick), T.count - 1);
          const iv = ts * P + k.victim;
          const ia = ts * P + k.attacker;
          const yawTo = (Math.atan2((T.y[ia] ?? 0) - (T.y[iv] ?? 0), (T.x[ia] ?? 0) - (T.x[iv] ?? 0)) * 180) / Math.PI;
          let d = Math.abs(((yawTo - (T.yaw[iv] ?? 0)) % 360 + 540) % 360 - 180);
          if (!Number.isFinite(d)) d = 180;
          if (d <= co.throwAimDeg) throwing = true;
        }
      }
      // Reloading = the flag is on and the magazine is not refilled yet (the clip jumps to full well before the flag clears).
      const clip = T.clip[i] ?? 255;
      const size = ctx.weapon(weapon)?.clip ?? 0;
      const reloading = ((T.flags[i] ?? 0) & FLAG.reloading) !== 0 && clip !== 255 && clip < size;
      out.push({
        k: idx, tick: k.tick, victim: k.victim, attacker: k.attacker, round, weapon, reloading, clip, throwingAtKiller: throwing,
      });
    });
    return out;
  },
};

export const RELOADS: TableDef<ReloadRow[]> = {
  id: 'movement.reloads',
  build(ctx) {
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const rt = MOVEMENT_TUNING.reload;
    const deaths = ctx.table(DEATHS_IN_HAND);
    const lt = defaultLosTuning();
    const eyeZ = (i: number): number => (T.z[i] ?? 0) + lt.eyeHeight - ((T.duck[i] ?? 0) / 255) * (lt.eyeHeight - lt.crouchEyeHeight);
    const out: ReloadRow[] = [];
    for (const r of raw.events.reloads) {
      const round = roundAt(ctx.match.rounds, r.tick);
      if (round === 0 || r.p < 0) continue;
      const t = Math.min(rowAtOrAfter(T, r.tick), T.count - 1);
      const i = t * P + r.p;
      if (T.present[i] !== 1 || ((T.flags[i] ?? 0) & FLAG.alive) === 0) continue;
      const weapon = raw.names.weapons[T.weapon[i] ?? 0] ?? '';
      const w = ctx.weapon(weapon);
      const clipSize = w?.clip ?? 0;
      const clip = T.clip[i] ?? 255;
      const team = ctx.teamOf(r.p);
      const eye = { x: T.x[i] ?? 0, y: T.y[i] ?? 0, z: eyeZ(i) };
      let nearest = -1;
      let nearestDist = Infinity;
      let enemyNear = false;
      for (let q = 0; q < P; q++) {
        const j = t * P + q;
        if (q === r.p || T.present[j] !== 1 || ((T.flags[j] ?? 0) & FLAG.alive) === 0) continue;
        const tq = ctx.teamOf(q);
        if (tq === null || tq === team) continue;
        const d = Math.hypot((T.x[j] ?? 0) - eye.x, (T.y[j] ?? 0) - eye.y, eyeZ(j) - eye.z);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = q;
        }
        if (d <= rt.nearUnits) {
          if (ctx.los === null) enemyNear = true;
          else if (ctx.los.visible(eye, { x: T.x[j] ?? 0, y: T.y[j] ?? 0, z: T.z[j] ?? 0, yaw: T.yaw[j] ?? 0, duck: (T.duck[j] ?? 0) / 255 }, null, r.tick, undefined, true).any) enemyNear = true;
        }
      }
      const halfFull = clipSize > 0 && clip !== 255 && clip > rt.fullShare * clipSize;
      const died = deaths.some((d) => d.victim === r.p && d.reloading && d.tick >= r.tick && d.tick - r.tick <= (w?.reloadTime ?? 3) * (raw.header.tickRate || 64) + 2);
      out.push({ tick: r.tick, p: r.p, round, weapon, clip, clipSize, nearest, nearestDist, enemyNear, halfFull, exposed: enemyNear || halfFull, diedReloading: died });
    }
    return out;
  },
};
