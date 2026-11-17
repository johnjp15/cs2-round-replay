/**
 * Combat tables, part 3: sprays with one target each, and every bullet's offset from that target.
 *
 * A spray's target is the enemy most of its bullets were assigned to (`TARGETS`; hits count double, ties go to the
 * lower slot). Every bullet of the spray, assigned or not, is then measured against that target at its own tick: up /
 * right offsets of the recoil-compensated aim (the bullet's zero-spread direction) from the chest, and whether the aim
 * ray crossed the silhouette. Sprays whose bullets were assigned to nobody have no target and are left out.
 */
import type { TableDef } from '../../analyze/context';
import { aimOffset, type V3 } from './geom';
import { SHOTS } from './shots';
import { TARGETS } from './targets';
import { AIM_TUNING } from './tuning';

export interface SprayBullet {
  readonly shot: number;
  /** Bullet number in the spray, 1-based. */
  readonly n: number;
  readonly tick: number;
  readonly up: number;
  readonly right: number;
  readonly onTarget: boolean;
  readonly hit: boolean;
  readonly dist: number;
  /** The target's feet at this bullet. */
  readonly at: V3;
}

export interface SprayRow {
  readonly burst: number;
  readonly p: number;
  readonly weapon: string;
  readonly kind: string;
  readonly round: number;
  readonly target: number;
  /** Distance at the first bullet. */
  readonly dist: number;
  readonly bullets: readonly SprayBullet[];
  readonly hits: number;
}

export const SPRAYS: TableDef<SprayRow[]> = {
  id: 'aim.sprays',
  build(ctx) {
    const { shots, bursts } = ctx.table(SHOTS);
    const { rows: targets } = ctx.table(TARGETS);
    const T = ctx.raw.ticks;
    const P = ctx.P;
    const out: SprayRow[] = [];
    for (const b of bursts) {
      if (!b.spray) continue;
      const votes = new Map<number, number>();
      for (const si of b.shots) {
        const tr = targets[si];
        if (tr === undefined || tr.target < 0) continue;
        votes.set(tr.target, (votes.get(tr.target) ?? 0) + (tr.how === 'hit' ? 2 : 1));
      }
      let target = -1;
      let best = 0;
      for (const [q, v] of [...votes.entries()].sort((x, y) => x[0] - y[0])) if (v > best) { best = v; target = q; }
      if (target < 0) continue;
      const bullets: SprayBullet[] = [];
      let hits = 0;
      b.shots.forEach((si, k) => {
        const s = shots[si];
        if (s === undefined) return;
        const i = s.row * P + target;
        if (T.present[i] !== 1) return;
        const feet: V3 = [T.x[i] ?? 0, T.y[i] ?? 0, T.z[i] ?? 0];
        const off = aimOffset(s.eye, s.pitch, s.yaw, feet, (T.duck[i] ?? 0) / 255, AIM_TUNING.body);
        const hit = s.hits.some((h) => ctx.raw.events.hurts[h]?.victim === target);
        if (hit) hits++;
        bullets.push({ shot: si, n: k + 1, tick: s.tick, up: off.up, right: off.right, onTarget: off.onTarget || hit, hit, dist: off.dist, at: feet });
      });
      const first = bullets[0];
      if (first === undefined) continue;
      const s0 = shots[b.shots[0] as number];
      out.push({ burst: b.id, p: b.p, weapon: b.weapon, kind: s0?.kind ?? '', round: b.round, target, dist: first.dist, bullets, hits });
    }
    return out;
  },
};
