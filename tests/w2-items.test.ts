/**
 * W2: pistols in every loadout, world items (death drop, G drop, E and touch pickup) in the 3D host, and items in
 * snapshots (checkpoints / rewind). docs/sim3d.md "World items".
 */
import { describe, expect, it } from 'vitest';
import { canonicalize, type Button, type PawnInput, type PlayerId } from '../src/contracts/index';
import { Session } from '../src/app/session';
import { sim3dHostFactory, type Sim3DHost } from '../src/sim3d/index';
import { deathDropGun, gunSlot, useTarget, viewDir, type WorldItem } from '../src/sim3d/items';
import { loadHarness3dData } from '../tools/harness3d';

const data = loadHarness3dData();

function newSession(human: PlayerId | null): { s: Session; h: Sim3DHost } {
  const s = new Session({ ...data, seed: 1, human, host: sim3dHostFactory(data.world) });
  return { s, h: s.host as unknown as Sim3DHost };
}

const input = (yaw: number, pitch: number, buttons: Button[] = []): PawnInput => canonicalize({ id: 'cart', forward: 0, side: 0, yaw, pitch, buttons });
const cart = (s: Session) => s.observe().pawns.find((p) => p.id === 'cart') as ReturnType<Session['observe']>['pawns'][number];
const items = (h: Sim3DHost, id: PlayerId) => (h.pawnState(id)?.inventory ?? []).map((q) => q.item);

/** cart stands still looking straight down for `n` ticks, with `buttons` on the first. */
function stand(s: Session, n: number, buttons: Button[] = []): void {
  for (let k = 0; k < n; k++) {
    s.setHumanInput(input(cart(s).yaw, 89, k === 0 ? buttons : []));
    s.step();
  }
}

/** A gun placed at rest at cart's feet (through a host snapshot, as a checkpoint would carry it). */
function placeAtFeet(h: Sim3DHost, s: Session, item: WorldItem['item']): void {
  const snap = h.snapshot();
  const d = snap.data as unknown as { items?: WorldItem[]; nextItemSeq?: number };
  const p = cart(s).pos;
  const it: WorldItem = { seq: 900, item, clip: 30, reserve: 90, pos: { x: p.x + 4, y: p.y, z: p.z + 2 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, resting: true, dropper: null, dropTick: 0 };
  h.restore({ kind: 'host', data: { ...(snap.data as object), items: [...(d.items ?? []), it], nextItemSeq: 901 } as never });
}

describe('W2 loadouts', () => {
  it('every pawn carries a pistol from the start; the held weapon is the tape one', () => {
    const { s, h } = newSession(null);
    s.step();
    s.step();
    const want: Record<string, [string, string]> = {
      barely: ['glock', 'ak47'],
      cart: ['glock', 'ak47'],
      donk: ['glock', 'awp'],
      eradicate: ['glock', 'ak47'],
      incredibad: ['usps', 'm4a4'],
      lokier: ['usps', 'ssg08'],
      snakelore: ['usps', 'm4a4'],
      snarlbot: ['glock', 'ak47'],
      sp4rtan: ['deagle', 'deagle'],
      zwomp: ['usps', 'm4a4'],
    };
    for (const [id, [pistol, held]] of Object.entries(want)) {
      expect(items(h, id as PlayerId), id).toContain(pistol);
      expect(h.pawnState(id as PlayerId)?.weapon, id).toBe(held);
    }
    const usp = h.pawnState('zwomp')?.inventory.find((q) => q.item === 'usps');
    expect([usp?.clip, usp?.reserve]).toEqual([12, 24]);
  });
});

describe('W2 world items', () => {
  it('death drops the most valuable gun (mp_death_drop_gun 1)', () => {
    const price = (w: string) => ({ ak47: 2700, glock: 200, deagle: 700, usps: 200, ssg08: 1700 })[w] ?? 0;
    expect(deathDropGun(['ak47', 'glock', 'knife'], price)).toBe('ak47');
    expect(deathDropGun(['deagle', 'knife'], price)).toBe('deagle');
    expect(deathDropGun(['knife', 'smoke'], price)).toBeNull();
    expect(gunSlot('usps')).toBe(2);
    expect(gunSlot('awp')).toBe(1);
    expect(gunSlot('knife')).toBeNull();
  });

  it('G drops the active gun, which lands; walking over it with that slot empty picks it up, undrawn', () => {
    const { s, h } = newSession('cart');
    stand(s, 4);
    expect(cart(s).weapon).toBe('ak47');
    stand(s, 1, ['DROP']);
    expect(cart(s).weapon).toBe('glock');
    expect(items(h, 'cart')).not.toContain('ak47');
    const dropped = h.worldItems().find((x) => x.dropper === 'cart');
    expect(dropped?.item).toBe('ak47');
    expect([dropped?.clip, dropped?.reserve]).toEqual([30, 90]);
    // Holding G doesn't drop the glock too (it acts on the press).
    for (let k = 0; k < 20; k++) {
      s.setHumanInput(input(cart(s).yaw, 89, ['DROP']));
      s.step();
    }
    expect(cart(s).weapon).toBe('glock');
    expect(h.worldItems().find((x) => x.dropper === 'cart')?.resting).toBe(true);
    // The dropper can't touch it back for a second; then he does (empty primary), and keeps holding the glock.
    stand(s, 30);
    expect(items(h, 'cart')).not.toContain('ak47');
    stand(s, 30);
    expect(items(h, 'cart')).toContain('ak47');
    expect(cart(s).weapon).toBe('glock');
    expect(h.worldItems().some((x) => x.dropper === 'cart')).toBe(false);
  });

  it('with a primary already, walking over a rifle picks nothing; E swaps it in and drops the old one', () => {
    const { s, h } = newSession('cart');
    stand(s, 4);
    placeAtFeet(h, s, 'm4a4');
    stand(s, 10);
    expect(items(h, 'cart')).not.toContain('m4a4');
    expect(h.worldItems().map((x) => x.item)).toEqual(['m4a4']);
    stand(s, 1, ['USE']);
    expect(cart(s).weapon).toBe('m4a4');
    expect(items(h, 'cart')).not.toContain('ak47');
    expect(h.worldItems().map((x) => x.item)).toEqual(['ak47']);
  });

  it('E reaches only what is looked at within 80 units (Source FindUseEntity)', () => {
    const it = (x: number): WorldItem => ({ seq: 1, item: 'ak47', clip: 30, reserve: 90, pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, resting: true, dropper: null, dropTick: 0 });
    const world = data.world;
    // Far above the map: nothing to block the line.
    const eye = { x: 0, y: 0, z: 0 };
    const up = (x: number) => ({ ...it(x), pos: { x, y: 0, z: 20000 } });
    const e = { ...eye, z: 20000 };
    expect(useTarget([up(70)], e, viewDir(0, 0), world)).toBe(0);
    expect(useTarget([up(90)], e, viewDir(0, 0), world)).toBe(-1);
    expect(useTarget([up(70)], e, viewDir(90, 0), world)).toBe(-1);
  });

  it('items are in the host snapshot: a rewind puts a dropped gun back in the hand', () => {
    const { s, h } = newSession('cart');
    stand(s, 4);
    const snap = s.snapshot();
    stand(s, 1, ['DROP']);
    expect(h.worldItems().length).toBe(1);
    s.restore(snap);
    expect(h.worldItems().length).toBe(0);
    expect(cart(s).weapon).toBe('ak47');
    stand(s, 1, ['DROP']);
    expect(h.worldItems().length).toBe(1);
  });

  it('the no-human run: eradicate drops his AK-47; Sp4rtaN takes snarlbot\'s off the floor', { timeout: 240_000 }, () => {
    const { s, h } = newSession(null);
    while (s.observe().tick < 1260) s.step();
    const drops = h.worldItems();
    const by = (id: PlayerId) => drops.filter((x) => x.dropper === id).map((x) => x.item);
    expect(by('incredibad')).toEqual(['m4a4']);
    expect(by('eradicate')).toEqual(['ak47']);
    expect(by('snakelore')).toEqual(['m4a4']);
    expect(by('lokier')).toEqual(['ssg08']);
    // snarlbot's AK-47: Sp4rtaN's recorded pickup at 19.6 s took it.
    expect(by('snarlbot')).toEqual([]);
    expect(items(h, 'sp4rtan')).toContain('ak47');
    for (const d of drops) expect(d.resting, d.dropper ?? '').toBe(true);
  });
});

describe('W2 drawing', () => {
  it('world items are pooled meshes keyed by seq', async () => {
    const { WorldItemMeshes } = await import('../src/app3d/viewmodels/rig');
    const w = new WorldItemMeshes();
    const at = { x: 10, y: 20, z: 30 };
    w.update([{ seq: 1, item: 'ak47', pos: at, yaw: 0 }, { seq: 2, item: 'usps', pos: at, yaw: 90 }]);
    expect(w.count).toBe(2);
    expect(w.root.children.length).toBe(2);
    w.update([{ seq: 2, item: 'usps', pos: at, yaw: 90 }]);
    expect(w.count).toBe(1);
    expect(w.root.children[0]?.position.toArray()).toEqual([10, 30, -20]);
  });

  it('the HUD slot list: slot order, the held one marked', async () => {
    const { slotsHtml } = await import('../src/app3d/hud3d');
    const html = slotsHtml(['ak47', 'c4', 'glock', 'he', 'knife', 'smoke'], 'glock');
    expect(html).toBe('<div>AK-47<b>1</b></div><div class="on">Glock-18<b>2</b></div><div>Knife<b>3</b></div><div>HE grenade<b>4</b></div><div>Smoke<b>4</b></div><div>C4<b>5</b></div>');
  });
});

describe('W2 knife model', () => {
  it('is cheap (< 500 triangles with the hand) and about 30 cm (11.8 in) long', async () => {
    const { modelOf } = await import('../src/app3d/viewmodels/models');
    const { mergeParts, triangles } = await import('../src/app3d/viewmodels/parts');
    const g = mergeParts(modelOf('knife').body);
    expect(triangles(g)).toBeLessThan(500);
    g.computeBoundingBox();
    const b = g.boundingBox;
    expect(b === null ? 0 : b.max.z - b.min.z).toBeGreaterThan(11);
    expect(b === null ? 0 : b.max.z - b.min.z).toBeLessThan(12.6);
  });

  it('plays W1\'s stab and inspect on the W2 knife', async () => {
    const { vmPose, freshPose, INSPECT_SEC } = await import('../src/app3d/viewmodels/pose');
    const { modelOf } = await import('../src/app3d/viewmodels/models');
    const a = { weapon: 'knife', sinceShot: 1e6, cycle: 0.4, reload: null, deploy: null, swing: null, plant: null, primed: false, thrown: null, speed: 0, time: 1 };
    expect(vmPose({ ...a, swing: 0.3, swingKind: 'stab' }, modelOf('knife'), freshPose()).phase).toBe('stab');
    expect(vmPose({ ...a, inspect: INSPECT_SEC / 2 }, modelOf('knife'), freshPose()).phase).toBe('inspect');
    expect(vmPose(a, modelOf('knife'), freshPose()).phase).toBe('idle');
  });
});
