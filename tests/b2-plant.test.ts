/** B2: planting like CS2 in the 3D host: time from the first press, frozen while planting, site bounds. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bombsiteAt, type MapInfo } from "../src/contracts/map-info";
import type { Button, PlayerId, Vec3 } from "../src/contracts/index";
import { MapGeometry } from "../src/sim2d/geometry";
import { LEGACY_PLANT_ZONES } from "../src/sim2d/ai";
import { Sim3DHost } from "../src/sim3d/index";
import { BOMB_POS, nav } from "./bomb-fixtures";
import { act, tuning } from "./combat-fixtures";

const E = 3000;
const Z = BOMB_POS.z;
const floor = [
  [-E, -E, Z, E, -E, Z, E, E, Z],
  [-E, -E, Z, E, E, Z, -E, E, Z],
];
function meshOf(tris: number[][]): MapGeometry {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(
        Math.round((t[k * 3] as number) * 8),
        Math.round((t[k * 3 + 1] as number) * 8),
        Math.round((t[k * 3 + 2] as number) * 8),
      );
    }
  }
  return new MapGeometry({
    quant: 8,
    verts: Int32Array.from(verts),
    tris: Int32Array.from(idx),
  });
}
const g = meshOf(floor);
const roster = [
  { id: "cart" as PlayerId, team: "T" as const },
  { id: "sp4rtan" as PlayerId, team: "CT" as const },
];

/** The human (T, cart) at `pos` holding an AK with the c4 in the bag. */
function human(pos: Vec3): Sim3DHost {
  const h = new Sim3DHost(
    nav,
    tuning,
    roster,
    null,
    { mask: null, seed: 1 },
    { movement: g, world: g },
  );
  h.apply(
    act([
      { type: "teleport", id: "cart", pos, yaw: 0 },
      { type: "set_hp", id: "cart", hp: 100, armor: 100, helmet: true },
      { type: "give", id: "cart", item: "ak47", clip: 30, reserve: 90 },
      { type: "give", id: "cart", item: "c4", clip: 0, reserve: 0 },
      { type: "set_weapon", id: "cart", weapon: "ak47" },
      {
        type: "teleport",
        id: "sp4rtan",
        pos: { x: 2500, y: 2500, z: Z },
        yaw: 0,
      },
    ]),
  );
  h.tick();
  h.setHuman("cart");
  return h;
}
const press = (h: Sim3DHost, buttons: Button[], forward = 0, yaw = 0): void => {
  h.setHumanInput({ id: "cart", forward, side: 0, yaw, pitch: 0, buttons });
  h.tick();
};
const planted = (h: Sim3DHost): boolean =>
  h.observe().round.bomb.state === "planted";

/** weapons.json c4 deployTime = weapon_c4 m_flDeployDuration 1.233333 in GameTracking-CS2 weapons.vdata. */
const DEPLOY = Math.ceil(1.233333 * 64);
/** 3.2 s x 64 = 204.8 ticks: the arm completes on the first whole tick after it. */
const ARM = 205;

/** Ticks after the c4 is selected (a set_weapon like slot 5) until `planted`, holding `buttons` all the way. */
function ticksToPlant(buttons: Button[], pos: Vec3 = BOMB_POS): number {
  const h = human(pos);
  for (let i = 0; i < 100; i++) press(h, []);
  h.apply(act([{ type: "set_weapon", id: "cart", weapon: "c4" }]));
  let n = 0;
  while (!planted(h) && n < 2000) {
    press(h, buttons);
    n++;
  }
  return n;
}

describe("B2 plant time (CS2: draw the c4, then 3.2 s of arming)", () => {
  it("USE or ATTACK held from the moment the c4 is selected: plants after its draw plus 3.2 s, not 3.2 s", () => {
    for (const b of [["USE"], ["ATTACK"]] as Button[][]) {
      const n = ticksToPlant(b);
      expect(n).toBeGreaterThanOrEqual(DEPLOY + ARM);
      expect(n).toBeLessThanOrEqual(DEPLOY + ARM + 2);
    }
  });

  it("with the c4 already drawn, the first press to planted is 3.2 s (205 ticks)", () => {
    const h = human(BOMB_POS);
    h.apply(act([{ type: "set_weapon", id: "cart", weapon: "c4" }]));
    for (let i = 0; i < 100; i++) press(h, []);
    let n = 0;
    while (!planted(h)) {
      press(h, ["ATTACK"]);
      n++;
    }
    expect(n).toBe(ARM + 1);
  });

  it("releasing cancels, and the next press starts again from zero", () => {
    const h = human(BOMB_POS);
    h.apply(act([{ type: "set_weapon", id: "cart", weapon: "c4" }]));
    for (let i = 0; i < 100; i++) press(h, []);
    for (let i = 0; i < 150; i++) press(h, ["USE"]);
    expect(h.plantHud("cart").progress).toBeGreaterThan(0.7);
    press(h, []);
    expect(h.plantHud("cart").progress).toBeNull();
    let n = 0;
    while (!planted(h)) {
      press(h, ["USE"]);
      n++;
    }
    expect(n).toBe(ARM + 1);
  });
});

describe("B2 frozen while planting", () => {
  it("walking, jumping and ducking keys do not move the planter; looking around is allowed", () => {
    const h = human(BOMB_POS);
    h.apply(act([{ type: "set_weapon", id: "cart", weapon: "c4" }]));
    for (let i = 0; i < 100; i++) press(h, []);
    const at = h.pawnState("cart")?.move.pos as Vec3;
    for (let i = 0; i < 100; i++) {
      h.setHumanInput({
        id: "cart",
        forward: 1,
        side: 1,
        yaw: i * 0.02,
        pitch: 0,
        buttons: ["USE", i % 20 === 0 ? "JUMP" : "DUCK"],
      });
      h.tick();
      const m = h.pawnState("cart")?.move;
      expect(m?.pos).toEqual(at);
      expect(Math.hypot(m?.vel.x ?? 1, m?.vel.y ?? 1)).toBe(0);
    }
    expect(planted(h)).toBe(false);
    expect(h.plantHud("cart").progress).toBeGreaterThan(0.4);
    for (let i = 0; i < 120 && !planted(h); i++) press(h, ["USE", "DUCK"], 1);
    expect(planted(h)).toBe(true);
    expect(h.pawnState("cart")?.move.pos).toEqual(at);
    press(h, [], 1);
    press(h, [], 1);
    expect(h.pawnState("cart")?.move.pos).not.toEqual(at);
  });
});

describe("B2 site bounds", () => {
  const info = JSON.parse(
    readFileSync(
      new URL("../data/maps/mirage-cs2/map.json", import.meta.url),
      "utf8",
    ),
  ) as MapInfo;
  const dust = JSON.parse(
    readFileSync(
      new URL("../data/maps/de_dust2/map.json", import.meta.url),
      "utf8",
    ),
  ) as MapInfo;
  const at = (i: MapInfo, x: number, y: number, z: number): string | null =>
    bombsiteAt(i, { x, y, z })?.name ?? null;

  it("Mirage: every planter spot is in its site; Apartments, Market window, Short, palace and the ramp are not", () => {
    const planters = {
      A: [
        [-321, -2036, -175],
        [-555, -2104, -180],
        [-254, -2134, -173],
      ],
      B: [
        [-1969, 450, -160],
        [-1892, 242, -160],
        [-2199, 89, -160],
      ],
    };
    for (const [name, ps] of Object.entries(planters))
      for (const [x, y, z] of ps as number[][])
        expect(at(info, x ?? 0, y ?? 0, z ?? 0)).toBe(name);
    // B: Apartments (x > -1700 at the site's y), the Market window / Short side (x < -2400), the cat/connector side (y < -100)
    for (const [x, y] of [
      [-1500, 400],
      [-1300, 350],
      [-1100, 450],
      [-2500, 300],
      [-2000, -300],
      [-2000, 700],
    ])
      expect(at(info, x ?? 0, y ?? 0, -160)).toBeNull();
    // A: the palace (x > 0), the ramp / Tetris side (y > -1850), Jungle / connector (y < -2300)
    for (const [x, y] of [
      [100, -1900],
      [175, -1650],
      [-400, -1700],
      [-300, -2350],
      [-800, -2100],
    ])
      expect(at(info, x ?? 0, y ?? 0, -175)).toBeNull();
  });

  it("Dust II: the plant spots are in A and B and just outside them is not", () => {
    for (const [x, y, z, n] of [
      [1235, 2348, 99, "A"],
      [1069, 2348, 99, "A"],
      [-1684, 2546, 7, "B"],
      [-1364, 2755, 17, "B"],
    ] as [number, number, number, string][])
      expect(at(dust, x, y, z)).toBe(n);
    for (const [x, y, z] of [
      [1235, 2100, 99],
      [1500, 2400, 99],
      [-1366, 2300, 4],
      [-1100, 2700, 4],
      [0, 0, 0],
    ] as [number, number, number][])
      expect(at(dust, x, y, z)).toBeNull();
  });

  it("the 2020 nav (the recorded round) uses the same two zones as map.json", () => {
    for (const z of LEGACY_PLANT_ZONES)
      expect(info.bombsites.find((b) => b.name === z.name)?.rects).toEqual([
        { x1: z.x1, y1: z.y1, x2: z.x2, y2: z.y2 },
      ]);
  });

  it("the human cannot plant outside a site: no progress, the hint shows; inside it plants", () => {
    const outside: Vec3 = { x: -1500, y: 400, z: BOMB_POS.z };
    const h = human(outside);
    h.apply(act([{ type: "set_weapon", id: "cart", weapon: "c4" }]));
    for (let i = 0; i < 100; i++) press(h, []);
    expect(h.plantHud("cart").needZone).toBe(false);
    for (let i = 0; i < 300; i++) press(h, ["USE"]);
    expect(planted(h)).toBe(false);
    expect(h.plantHud("cart")).toEqual({ progress: null, needZone: true });
  });
});
