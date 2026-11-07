/**
 * V1 · the other guns through the 3D host: can the human fire them, first-shot accuracy, cycle time, damage on
 * 100 armor + helmet at 0 / 500 / 1,000 u to head / chest / stomach / legs, and tagging on hit.
 *
 *   npx tsx tools/e2e/weapons.ts [--seeds 300]        (npm run test:e2e:weapons)
 */
import { parseWeaponTable, bulletDamage as engineDamage, weaponDef } from '../../src/engine/weapons/index';
import type { Action, Hitgroup, PlayerId } from '../../src/contracts/index';
import { HUMAN, TARGET, f, input, mean, quantile, rangeHost, shotAngles, table, tuning, unitsAt, weaponsJson, DEG } from './common';

const args = process.argv.slice(2);
const SEEDS = Number(args[args.indexOf('--seeds') + 1] ?? 300) || 300;
const wt = parseWeaponTable(weaponsJson);
const GUNS = ['ak47', 'm4a4', 'm4a1s', 'deagle', 'awp', 'usps', 'glock', 'ssg08'];

/** Hold or tap ATTACK for 3 s; the shot ticks. Semi-autos: press on alternate ticks (a perfect tapper). */
function cadence(weapon: string, scoped: boolean): { shots: number[]; fires: boolean } {
  const h = rangeHost(1, { weapon, wall: 2000 });
  for (let t = 0; t < 150; t++) {
    h.setHumanInput(input({ buttons: scoped && t === 120 ? ['ATTACK2'] : [] }));
    h.tick();
  }
  const auto = wt.weapons[weapon]?.fullAuto ?? false;
  const shots: number[] = [];
  let release = false;
  for (let t = 0; t < 64 * 3; t++) {
    const press = auto || !release;
    h.setHumanInput(input({ buttons: press ? ['ATTACK'] : [] }));
    h.tick();
    release = false;
    if (h.shots().some((s) => s.shooter === HUMAN)) {
      shots.push(t);
      release = true;
    }
    // re-scope after each AWP / SSG shot once the bolt is back (the engine re-zooms itself: resumeZoom)
  }
  return { shots, fires: shots.length > 0 };
}

function firstShotCone(weapon: string, scoped: boolean): { mean: number; max: number; p95: number } {
  const r: number[] = [];
  for (let k = 0; k < SEEDS; k++) {
    const h = rangeHost(40_000 + k, { weapon, wall: 4000 });
    for (let t = 0; t < 150; t++) {
      h.setHumanInput(input({ buttons: scoped && t === 120 ? ['ATTACK2'] : [] }));
      h.tick();
    }
    for (let t = 0; t < 5; t++) {
      h.setHumanInput(input({ buttons: ['ATTACK'] }));
      h.tick();
      const s = h.shots().find((x) => x.shooter === HUMAN);
      if (s !== undefined) {
        const a = shotAngles(s.from, s.to);
        r.push(Math.hypot(a.pitch, a.yaw));
        break;
      }
    }
  }
  return { mean: mean(r), max: r.length === 0 ? NaN : Math.max(...r), p95: quantile(r, 0.95) };
}

/** Hitgroup centre heights (standing, from docs/sim3d.md's hitboxes) to aim at. */
const AIM_Z: Partial<Record<Hitgroup, number>> = { head: 63, chest: 48.5, stomach: 35.5, leg: 18 };

/** Fire one (crouched, scoped where it helps) shot at the CT `dist` away aimed at a hitgroup; the damage events. */
function hostDamage(weapon: string, dist: number, group: Hitgroup): { hp: number; group: string; distance: number } | null {
  for (let k = 0; k < 40; k++) {
    const h = rangeHost(50_000 + k, { weapon, wall: null, target: { x: dist, y: 0, yaw: 180, armor: 100, helmet: true, hp: 1000 } });
    const scoped = weapon === 'awp' || weapon === 'ssg08';
    for (let t = 0; t < 150; t++) {
      h.setHumanInput(input({ buttons: scoped && t === 120 ? ['ATTACK2'] : [] }));
      h.tick();
    }
    const dz = (AIM_Z[group] ?? 48) - 64;
    const pitch = -Math.atan2(dz, Math.max(dist, 1)) * DEG;
    for (let t = 0; t < 5; t++) {
      h.setHumanInput(input({ pitch, buttons: ['ATTACK'] }));
      h.tick();
      const s = h.shots().find((x) => x.shooter === HUMAN);
      if (s === undefined) continue;
      const d = h.observe().events.find((e) => e.type === 'damage');
      if (s.hitgroup === group && d !== undefined && d.type === 'damage') return { hp: d.amount, group: s.hitgroup, distance: s.distance };
      break;
    }
  }
  return null;
}

/** Published CS2 damage on 100 armor + helmet at point blank (head / chest / stomach / legs), see the audit doc. */
const PUBLISHED: Record<string, string> = {
  ak47: '111 / 27 / 34 / 27',
  m4a4: '92 / 23 / 28 / 24',
  m4a1s: '92 / 26 / 33 / 28',
  deagle: '192 / 49 / 61 / 39',
  awp: '448 / 112 / 140 / 86',
  usps: '70 / 17 / 22 / 26',
  glock: '56 / 14 / 17 / 22',
  ssg08: '299 / 74 / 93 / 66',
};

function main(): void {
  const rows: (string | number)[][] = [];
  const dmgRows: (string | number)[][] = [];
  for (const g of GUNS) {
    const w = weaponDef(wt, g);
    const scoped = g === 'awp' || g === 'ssg08';
    const c = cadence(g, false);
    const gaps = c.shots.slice(1).map((t, i) => (t - (c.shots[i] as number)) / 64);
    const cone = c.fires ? firstShotCone(g, false) : { mean: NaN, max: NaN, p95: NaN };
    const coneS = c.fires && scoped ? firstShotCone(g, true) : null;
    const vI = w.inaccuracy.stand[0] + w.spread[0];
    rows.push([
      g,
      c.fires ? 'yes' : '**no** (no 2D gun stats)',
      w.cycleTime[0],
      c.fires ? f(mean(gaps), 4) : '–',
      c.fires ? `${c.shots.length} in 3 s` : '–',
      f(Math.atan(vI) * DEG, 3),
      f(cone.max, 3),
      f(cone.mean, 3),
      f(unitsAt(cone.max, 500), 1),
      coneS === null ? '' : `${f(coneS.max, 3)}° (${f(Math.atan(w.inaccuracy.stand[1] + w.spread[1]) * DEG, 3)}°)`,
    ]);
    const cells: string[] = [];
    for (const d of [0, 500, 1000]) {
      const parts: string[] = [];
      for (const grp of ['head', 'chest', 'stomach', 'leg'] as Hitgroup[]) {
        const e = engineDamage(w, Math.max(d, 1), grp, 100, true, tuning.damage).health;
        const hd = c.fires ? hostDamage(g, Math.max(d, 32), grp) : null;
        // The host's distance is eye → hitbox entry (and ≥ 32 u at "0"): compare with the formula at that distance.
        const atHost = hd === null ? null : engineDamage(w, hd.distance, grp, 100, true, tuning.damage).health;
        parts.push(hd === null ? `${e}/–` : hd.hp === atHost ? `${e} ✓` : `${e}/**${hd.hp}** (formula ${atHost} at ${f(hd.distance, 0)} u)`);
      }
      cells.push(parts.join(' · '));
    }
    dmgRows.push([g, PUBLISHED[g] ?? '', ...cells]);
  }
  console.log('### Fire, cycle and first shot through Sim3DHost (human, standing still)\n');
  console.log(
    table(['gun', 'fires in 3D host', 'CS2 cycle s (vdata)', 'host mean gap s', 'shots', 'CS2 max cone ° (stand + spread)', 'host max °', 'host mean °', 'host max u @500', 'scoped max ° (CS2)'], rows),
  );
  console.log('\n### Damage to 100 armor + helmet, head · chest · stomach · legs (the CS2 formula at the distance; ✓ = the 3D host damage event equals the formula at its own eye-to-hitbox distance; – = the host cannot fire it)\n');
  console.log(table(['gun', 'published CS2 @ 0 u', '0 u', '500 u', '1,000 u'], dmgRows));
  console.log(`\n${tagging()}`);
}

/** cart (human) runs along +y; sp4rtan (fed an input) shoots him in the chest once; cart's speed after. */
function tagging(): string {
  const h = rangeHost(7, { weapon: 'ak47', wall: null, target: { x: 400, y: 0, yaw: 180, armor: 100, helmet: true } });
  const speeds: number[] = [];
  let hitTick = -1;
  for (let t = 0; t < 64 * 4; t++) {
    h.setHumanInput(input({ side: -1, buttons: [] }));
    const me = h.observe().pawns.find((p) => p.id === HUMAN);
    const fire = t === 80 && me !== undefined;
    const inputs =
      fire && me !== undefined
        ? [{ id: TARGET as PlayerId, forward: 0, side: 0, yaw: (Math.atan2(me.pos.y, me.pos.x - 400) * 180) / Math.PI, pitch: (Math.atan2(64 - 48, Math.hypot(me.pos.x - 400, me.pos.y)) * 180) / Math.PI, buttons: ['ATTACK' as const] }]
        : [{ id: TARGET as PlayerId, forward: 0, side: 0, yaw: 180, pitch: 0, buttons: [] }];
    h.apply({ inputs, actions: [] as Action[], status: [] });
    h.tick();
    const o = h.observe();
    if (o.events.some((e) => e.type === 'damage' && e.victim === HUMAN) && hitTick < 0) hitTick = t;
    const p = o.pawns.find((q) => q.id === HUMAN);
    speeds.push(p === undefined ? 0 : Math.hypot(p.vel.x, p.vel.y));
  }
  if (hitTick < 0) return 'Tagging: the shot missed (no hit to measure).';
  const at = (dt: number): string => f(speeds[hitTick + dt] ?? NaN, 1);
  return [
    `### Tagging: cart runs at 215 u/s, an AK chest hit at 400 u (tick ${hitTick})`,
    '',
    table(['after', '1 tick', '8 ticks (125 ms)', '16 (250 ms)', '32 (0.5 s)', '64 (1 s)', '128 (2 s)'], [['speed u/s', at(1), at(8), at(16), at(32), at(64), at(128)]]),
  ].join('\n');
}

main();
