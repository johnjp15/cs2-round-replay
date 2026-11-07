/**
 * V1 · grenades in the 3D game vs the CS2 grenade engine (H5, src/engine/grenades).
 *
 *   npx tsx tools/e2e/grenades.ts        (npm run test:e2e:grenades)
 *
 * The 3D host (Sim3DHost) still throws sim2d's grenades (src/sim2d/grenades.ts: a straight 2D flight clamped on the
 * 2D sight mask, a cylinder smoke, a 3 s cone flash, a linear HE; no decoy); H5's engine is not wired in yet (H4).
 * So every check runs twice where it can: the human throws through Sim3DHost on Mirage (what the player gets), and the
 * same throw goes through the engine on the same mesh (what CS2 does, per docs/grenades.md).
 */
import type { Action, PlayerId, Vec3 } from '../../src/contracts/index';
import {
  createGrenadeState,
  simulateThrow,
  smokeBlocks as engineSmokeBlocks,
  stepGrenades,
  throwGrenade as engineThrow,
  type GrenadeEvent,
  type GrenadePawn,
  type GrenadeWorld,
  type HullTrace,
} from '../../src/engine/grenades/index';
import type { MapGeometry } from '../../src/sim2d/geometry';
import { Sim3DHost } from '../../src/sim3d/index';
import { loadHarness3dData, runHarness3d, host3d } from '../harness3d';
import { tickOf } from '../../src/core/index';
import { HUMAN, TARGET, act, f, input, openNav, range, table, tuning } from './common';

const data = loadHarness3dData();
const geo = data.geometry as MapGeometry;
const cs2 = { tuning: tuning.grenades.cs2 };

class MeshWorld implements GrenadeWorld {
  constructor(readonly g: MapGeometry) {}
  traceHull(cx: number, cy: number, cz: number, half: number, dx: number, dy: number, dz: number): HullTrace {
    const r = this.g.traceAabb(cx, cy, cz, half, half, half, dx, dy, dz);
    return { fraction: r.fraction, hit: r.hit, nx: r.normalX, ny: r.normalY, nz: r.normalZ, startSolid: r.startSolid, allSolid: r.allSolid };
  }
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.g.traceLine(ax, ay, az, bx, by, bz);
  }
}
const mirage = new MeshWorld(data.world);

/** cs2util.com lineups (docs/grenades.md; setpos z = eye). */
const LINEUPS = [
  { name: 'Window smoke from Top Mid cart', type: 'smoke' as const, setpos: [360.075439, -691.96875, -100.067307], setang: [-37.951241, 176.761139] },
  { name: 'Tetris molotov from Trash', type: 'molotov' as const, setpos: [-889.295227, -2303.985596, -106.69162], setang: [-20.295094, 46.435417] },
  { name: 'Bench molotov from B Apartments', type: 'molotov' as const, setpos: [-1393.263794, 807.968689, -14.749435], setang: [-7.920142, -148.512177] },
];

function mirageHost(): Sim3DHost {
  const roster = [
    { id: HUMAN, team: 'T' as const },
    { id: TARGET, team: 'CT' as const },
  ];
  return new Sim3DHost(data.nav, data.tuning, roster, null, { mask: data.vision, seed: 1 }, { movement: geo, world: data.world });
}

function giveNade(id: PlayerId, pos: Vec3, yaw: number, kind: string): Action[] {
  return [
    { type: 'teleport', id, pos, yaw },
    { type: 'set_hp', id, hp: 100, armor: 100, helmet: true },
    { type: 'give', id, item: kind as Extract<Action, { type: 'give' }>['item'], clip: 1, reserve: 0 },
    { type: 'set_weapon', id, weapon: kind as Extract<Action, { type: 'set_weapon' }>['weapon'] },
  ];
}

/** The human throws the held grenade at (pitch, yaw) with a left click: where it pops in the 3D host and when. */
function hostThrow(h: Sim3DHost, pitch: number, yaw: number, maxTicks = 64 * 12): { pop: Vec3 | null; popSec: number; untilSec: number; radius: number } {
  let released = -1;
  for (let k = 0; k < 120 + maxTicks; k++) {
    const press = k >= 70 && k < 75;
    h.setHumanInput(input({ pitch, yaw, buttons: press ? ['ATTACK'] : [] }));
    h.tick();
    if (k === 75) released = k;
    if (released >= 0) {
      const e = h.activeEffects().find((x) => x.phase !== 'flying');
      if (e !== undefined) return { pop: e.pos, popSec: (k - released) / 64, untilSec: (e.untilTick - h.observe().tick) / 64 + (k - released) / 64, radius: e.radius };
    }
  }
  return { pop: null, popSec: NaN, untilSec: NaN, radius: 0 };
}

function engineLineup(type: 'smoke' | 'molotov' | 'flash' | 'he', eye: Vec3, pitch: number, yaw: number): { pos: Vec3; sec: number } {
  const r = simulateThrow({ type, thrower: 'p', team: 'T', eye, pitch, yaw, strength: 1, velocity: { x: 0, y: 0, z: 0 } }, mirage, cs2);
  return { pos: r.detonation?.pos ?? { x: NaN, y: NaN, z: NaN }, sec: r.ticks / 64 };
}

const d3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const v = (p: Vec3): string => `(${f(p.x, 0)}, ${f(p.y, 0)}, ${f(p.z, 0)})`;

function lineupReport(): string {
  const rows: (string | number)[][] = [];
  for (const l of LINEUPS) {
    const eye = { x: l.setpos[0] as number, y: l.setpos[1] as number, z: l.setpos[2] as number };
    const e = engineLineup(l.type, eye, l.setang[0] as number, l.setang[1] as number);
    const h = mirageHost();
    h.apply(act([...giveNade(HUMAN, { x: eye.x, y: eye.y, z: eye.z - 64 }, l.setang[1] as number, l.type), ...giveNade(TARGET, { x: 2000, y: 2000, z: -200 }, 0, 'smoke')]));
    h.tick();
    h.setHuman(HUMAN);
    const r = hostThrow(h, l.setang[0] as number, l.setang[1] as number);
    rows.push([l.name, `${v(e.pos)} at ${f(e.sec, 2)} s`, r.pop === null ? 'never popped' : `${v(r.pop)} at ${f(r.popSec, 2)} s`, r.pop === null ? '–' : f(d3(r.pop, e.pos), 0)]);
  }
  return table(['lineup (left click, standing)', 'CS2 engine on the mesh: detonation', '3D host (what the player gets)', 'host vs engine u'], rows);
}

/**
 * Smoke bloom and duration on the flat range: cart throws a smoke (left click, 20° down) toward sp4rtan 1,200 u away;
 * when does the cloud block the eye line (engine smokeBlocks) and when does the host's `sees` (MeshSight + smoke) go false?
 */
function smokeTiming(): string {
  const flatG = range(null);
  const flat = new MeshWorld(flatG);
  const me = { x: 0, y: 0, z: 64 };
  const ct = { x: 1200, y: 0, z: 64 };
  const s = createGrenadeState(1);
  engineThrow(s, { type: 'smoke', thrower: 'p', team: 'T', eye: me, pitch: 20, yaw: 0, strength: 1, velocity: { x: 0, y: 0, z: 0 } }, flat, cs2);
  let pop = -1;
  let popPos: Vec3 | null = null;
  const blockedAt: number[] = [];
  for (let k = 0; k < 64 * 30; k++) {
    for (const e of stepGrenades(s, flat, { pawns: [], friendlyFire: false }, cs2)) if (e.type === 'smoke_start') {
      pop = e.tick;
      popPos = e.pos;
    }
    if (pop >= 0 && k % 4 === 0 && engineSmokeBlocks(s, me, ct, s.tick - 1, cs2.tuning)) blockedAt.push((s.tick - 1 - pop) / 64);
  }
  const h = new Sim3DHost(openNav, tuning, [{ id: HUMAN, team: 'T' }, { id: TARGET, team: 'CT' }], null, { mask: null, seed: 1 }, { movement: flatG, world: flatG });
  h.apply(act([...giveNade(HUMAN, { x: 0, y: 0, z: 0 }, 0, 'smoke'), ...giveNade(TARGET, { x: ct.x, y: 0, z: 0 }, 180, 'smoke')]));
  h.tick();
  h.setHuman(HUMAN);
  let popTick = -1;
  let hostPos: Vec3 | null = null;
  const seesAt: { t: number; sees: boolean }[] = [];
  for (let k = 0; k < 64 * 32; k++) {
    h.setHumanInput(input({ pitch: k < 76 ? 20 : 0, buttons: k >= 70 && k < 75 ? ['ATTACK'] : [] }));
    h.tick();
    const e = h.activeEffects().find((x) => x.phase === 'smoke');
    if (e !== undefined && popTick < 0) {
      popTick = h.observe().tick;
      hostPos = e.pos;
    }
    if (k % 4 === 0) {
      const p = h.observe().pawns.find((q) => q.id === HUMAN);
      seesAt.push({ t: popTick < 0 ? -1 : (h.observe().tick - popTick) / 64, sees: p?.sees.includes(TARGET) ?? false });
    }
  }
  const span = (xs: number[]): string => (xs.length === 0 ? 'never' : `${f(Math.min(...xs), 2)} → ${f(Math.max(...xs), 2)} s after the pop`);
  const hostBlocked = seesAt.filter((x) => x.t >= 0 && !x.sees).map((x) => x.t);
  const preSees = seesAt.filter((x) => x.t < 0).some((x) => x.sees);
  return [
    `Flat range, smoke thrown 20° down toward a CT 1,200 u away. CS2 engine: pops ${f(pop / 64, 2)} s after the throw at ${popPos === null ? '–' : v(popPos)}; the eye line is blocked ${span(blockedAt)} (CS2: ~1 s bloom, ~18 s full, fades to ~20 s; docs/grenades.md S4/S5).`,
    `3D host (the player): pops at ${hostPos === null ? '–' : v(hostPos)}; cart sees sp4rtan before the pop: ${preSees ? 'yes' : '**no**'}; \`sees\` false ${span(hostBlocked)}.`,
  ].join('\n\n');
}

/** Flash blind times at 3 distances and 3 view angles: engine (flat world) vs the 3D host (flat range). */
function flashReport(): string {
  const flat = new MeshWorld(range(null));
  const rows: (string | number)[][] = [];
  for (const dist of [200, 600, 1000]) {
    for (const [label, yawOff] of [
      ['facing it', 0],
      ['90° off', 90],
      ['facing away', 180],
    ] as [string, number][]) {
      // Engine: a flash popping at (0, 0, 64) (thrown straight up from the origin), a CT at (dist, 0) looking back.
      const s = createGrenadeState(1);
      engineThrow(s, { type: 'flash', thrower: 'p', team: 'T', eye: { x: 0, y: 0, z: 64 }, pitch: -89, yaw: 0, strength: 0, velocity: { x: 0, y: 0, z: 0 } }, flat, cs2);
      const ct: GrenadePawn = { id: 'ct', team: 'CT', alive: true, pos: { x: dist, y: 0, z: 0 }, height: 72, eye: { x: dist, y: 0, z: 64 }, yaw: 180 + yawOff, pitch: 0 };
      let blind: Extract<GrenadeEvent, { type: 'blind' }> | null = null;
      let popZ = 0;
      for (let k = 0; k < 64 * 3 && blind === null; k++) {
        for (const e of stepGrenades(s, flat, { pawns: [ct], friendlyFire: false }, cs2)) {
          if (e.type === 'blind') blind = e;
          if (e.type === 'detonate') popZ = e.pos.z;
        }
      }
      // Host: cart throws a flash straight up (right click), sp4rtan at (dist, 0) looking back.
      const h = new Sim3DHost(
        openNav,
        tuning,
        [
          { id: HUMAN, team: 'T' },
          { id: TARGET, team: 'CT' },
        ],
        null,
        { mask: null, seed: 1 },
        { movement: range(null), world: range(null) },
      );
      h.apply(act([...giveNade(HUMAN, { x: 0, y: 0, z: 0 }, 0, 'flash'), ...giveNade(TARGET, { x: dist, y: 0, z: 0 }, 180 + yawOff, 'smoke')]));
      h.tick();
      h.setHuman(HUMAN);
      let until = 0;
      let popTick = -1;
      for (let k = 0; k < 64 * 4; k++) {
        h.setHumanInput(input({ pitch: -89, buttons: k >= 70 && k < 75 ? ['ATTACK'] : [] }));
        h.tick();
        const b = h.blindUntilTick(TARGET);
        if (b > until) {
          until = b;
          popTick = h.observe().tick - 1;
        }
      }
      const eb = blind?.blind;
      rows.push([
        dist,
        label,
        eb === undefined ? '0' : `${f(eb.holdSec, 2)} full + fade to ${f(eb.fadeSec, 2)} s (pop z ${f(popZ, 0)})`,
        popTick < 0 ? '0' : `${f((until - popTick) / 64, 2)} s`,
      ]);
    }
  }
  return table(['distance u', 'view', 'CS2 engine: blind', '3D host: blind'], rows);
}


/** HE: damage on 100 armor at 2 distances; molotov spread and duration; decoy cadence (engine, flat world) vs host. */
function heMolotovDecoy(): string {
  const flatG = range(null);
  const flat = new MeshWorld(flatG);
  const out: string[] = [];
  // HE: thrown underhand from (0,0,64) straight down so it rests at the origin; CTs at 100 and 250 u.
  const heRows: (string | number)[][] = [];
  for (const dist of [100, 250]) {
    const s = createGrenadeState(1);
    engineThrow(s, { type: 'he', thrower: 'p', team: 'T', eye: { x: 0, y: 0, z: 64 }, pitch: 89, yaw: 0, strength: 0, velocity: { x: 0, y: 0, z: 0 } }, flat, cs2);
    const ct: GrenadePawn = { id: 'ct', team: 'CT', alive: true, pos: { x: dist, y: 0, z: 0 }, height: 72, eye: { x: dist, y: 0, z: 64 }, yaw: 180, pitch: 0 };
    let raw = 0;
    let pen = 0;
    for (let k = 0; k < 64 * 3; k++) for (const e of stepGrenades(s, flat, { pawns: [ct], friendlyFire: false }, cs2)) if (e.type === 'hurt') {
      raw = e.damage;
      pen = e.armorPen;
    }
    const eng = Math.trunc(raw * pen);
    const h = new Sim3DHost(openNav, tuning, [{ id: HUMAN, team: 'T' }, { id: TARGET, team: 'CT' }], null, { mask: null, seed: 1 }, { movement: flatG, world: flatG });
    h.apply(act([...giveNade(HUMAN, { x: 0, y: 0, z: 0 }, 0, 'he'), ...giveNade(TARGET, { x: dist, y: 0, z: 0 }, 180, 'smoke')]));
    h.tick();
    h.setHuman(HUMAN);
    let hd = 0;
    for (let k = 0; k < 64 * 4; k++) {
      h.setHumanInput(input({ pitch: 89, buttons: k >= 70 && k < 75 ? ['ATTACK'] : [] }));
      h.tick();
      for (const e of h.observe().events) if (e.type === 'damage' && e.victim === TARGET) hd += e.amount;
    }
    heRows.push([dist, `${f(raw, 1)} raw → ${eng} HP`, `${hd} HP`]);
  }
  out.push(`HE on 100 armor (grenade at rest at the origin, the CT's body centre ${'≈'} the distance away):\n\n${table(['distance u', 'CS2 engine', '3D host'], heRows)}`);

  // Molotov on flat ground: flames, footprint, duration.
  const s = createGrenadeState(1);
  engineThrow(s, { type: 'molotov', thrower: 'p', team: 'T', eye: { x: 0, y: 0, z: 64 }, pitch: 20, yaw: 0, strength: 1, velocity: { x: 0, y: 0, z: 0 } }, flat, cs2);
  let start = -1;
  let end = -1;
  let maxFlames = 0;
  let maxR = 0;
  let centre: Vec3 | null = null;
  let fullAt = -1;
  for (let k = 0; k < 64 * 15; k++) {
    for (const e of stepGrenades(s, flat, { pawns: [], friendlyFire: false }, cs2)) {
      if (e.type === 'fire_start') {
        start = e.tick;
        centre = e.pos;
      }
      if (e.type === 'fire_end') end = e.tick;
    }
    const inf = s.infernos[0];
    if (inf !== undefined && centre !== null) {
      const burning = inf.flames.filter((q) => q.dieTick > s.tick);
      if (burning.length > maxFlames) {
        maxFlames = burning.length;
        fullAt = s.tick;
      }
      for (const q of burning) maxR = Math.max(maxR, Math.hypot(q.pos.x - centre.x, q.pos.y - centre.y));
    }
  }
  const h = new Sim3DHost(openNav, tuning, [{ id: HUMAN, team: 'T' }, { id: TARGET, team: 'CT' }], null, { mask: null, seed: 1 }, { movement: flatG, world: flatG });
  h.apply(act([...giveNade(HUMAN, { x: 0, y: 0, z: 0 }, 0, 'molotov'), ...giveNade(TARGET, { x: 3000, y: 3000, z: 0 }, 180, 'smoke')]));
  h.tick();
  h.setHuman(HUMAN);
  const r = hostThrow(h, 20, 0);
  out.push(
    `Molotov on flat ground (left click, 20° down): CS2 engine ${maxFlames} flames, footprint radius ${f(maxR, 0)} u (+ the 30 u flame contact), full at ${f((fullAt - start) / 64, 2)} s, out ${f((end - start) / 64, 2)} s after the burst (CS2: ~16 cells, ~117–144 radius, ~1.83 s to peak, 6–7 s; S2/S4). ` +
      `3D host: a ${f(r.radius, 0)} u disc at once, burning ${f(r.untilSec - r.popSec, 2)} s.`,
  );

  // Decoy: engine only (the 3D host has no decoy).
  const sd = createGrenadeState(1);
  engineThrow(sd, { type: 'decoy', thrower: 'p', team: 'T', eye: { x: 0, y: 0, z: 64 }, pitch: 20, yaw: 0, strength: 1, velocity: { x: 0, y: 0, z: 0 }, decoyShotIntervalSec: 0.1 }, flat, cs2);
  const shots: number[] = [];
  let boom = -1;
  for (let k = 0; k < 64 * 25; k++) for (const e of stepGrenades(sd, flat, { pawns: [], friendlyFire: false }, cs2)) {
    if (e.type === 'decoy_shot') shots.push(e.tick);
    if (e.type === 'decoy_explode') boom = e.tick;
  }
  const gaps = shots.slice(1).map((t, i) => (t - (shots[i] as number)) / 64);
  const bursts = 1 + gaps.filter((g) => g > 0.2).length;
  out.push(
    `Decoy (engine; **the 3D host has no decoy**: sim2d GRENADE_KINDS = flash, he, molotov, smoke): ${shots.length} fake shots in ${bursts} bursts over ${f(((shots.at(-1) ?? 0) - (shots[0] ?? 0)) / 64, 1)} s, ` +
      `in-burst gap ${f(Math.min(...gaps), 3)} s, burst gaps ${f(Math.min(...gaps.filter((g) => g > 0.2)), 2)}–${f(Math.max(...gaps), 2)} s, explodes ${f((boom - (shots[0] ?? 0)) / 64, 1)} s after the first shot (CS2: ~15 s; S6).`,
  );
  return out.join('\n\n');
}

/** The recorded round's utility in the 3D run: where the host's grenades popped vs data/round.json `utility[].landing`. */
function recordedUtility(): string {
  const run = runHarness3d(data, { human: null, seed: 1, lastTick: tickOf(31), takeover: null, driver: null });
  const effects = host3d(run).activeEffects();
  const u = (JSON.parse(data.sources.round) as { utility: { t: number; thrower: string; kind: string; throwPos: Vec3; landing: (Vec3 & { uncertainty: number }) | null }[] }).utility;
  const rows: (string | number)[][] = [];
  for (const x of u.filter((q) => q.landing !== null)) {
    const l = x.landing as Vec3 & { uncertainty: number };
    const e = effects.find((q) => q.thrower === x.thrower && q.kind === x.kind && q.phase !== 'flying');
    const eng = simulateThrow({ type: 'smoke', thrower: x.thrower, team: 'T', eye: { x: -2059, y: 88, z: -160 + 64 }, pitch: -6.25, yaw: -66.9, strength: 0.5, velocity: { x: 0, y: 0, z: 0 } }, mirage, cs2);
    const engPos = eng.detonation?.pos ?? { x: NaN, y: NaN, z: NaN };
    rows.push([
      x.t,
      x.thrower,
      x.kind,
      `${v(l)} ± ${l.uncertainty}`,
      e === undefined ? 'not active at 31 s' : `${v(e.pos)} (${f(Math.hypot(e.pos.x - l.x, e.pos.y - l.y), 0)} u xy)`,
      `${v(engPos)} (${f(Math.hypot(engPos.x - l.x, engPos.y - l.y), 0)} u xy)`,
    ]);
  }
  return rows.length === 0
    ? 'No utility with a measured landing.'
    : table(['t s', 'thrower', 'type', 'round.json landing', '3D host smoke centre (golden run, 31 s)', 'engine aimAtLanding solution (docs/grenades.md: pitch −6.25°, yaw −66.9°, half strength)'], rows);
}

console.log(`### Lineups\n\n${lineupReport()}\n`);
console.log(`### Smoke timing and sight\n\n${smokeTiming()}\n`);
console.log(`### Flash\n\n${flashReport()}\n`);
console.log(`### HE, molotov, decoy\n\n${heMolotovDecoy()}\n`);
console.log(`### Recorded utility with a measured landing\n\n${recordedUtility()}\n`);
