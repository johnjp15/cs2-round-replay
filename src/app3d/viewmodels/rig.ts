/**
 * A1: the first-person viewmodel and the world models (docs/app3d.md "Viewmodels").
 *
 * ViewmodelRig: every weapon's model with gloved hands and sleeves in the team's colour, built once (a few hundred
 * triangles each), the held one shown, posed per frame from vmPose (pose.ts). It sits where CS2 holds it: the model
 * origin (the grip) at the weapon class's hold point in view space plus CS2's `viewmodel_offset_x 1`, `_y 1`,
 * `_z −1` (defaults, CS2 convar dump), drawn by the renderer's viewmodel camera at `viewmodel_fov` 60. The hold
 * points are fitted by eye to CS2's default screen composition (**assumed**). Muzzle flash at the model's muzzle.
 *
 * WorldWeapons: each pawn's held weapon (body, mag and bolt merged: one mesh) in its right hand, swapped when the
 * weapon changes; on death it lies on the floor beside the body (the dropped weapon). Geometry shared per weapon,
 * meshes pooled per pawn: nothing allocated per frame.
 */
import { AdditiveBlending, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Object3D } from 'three';
import type { Team } from '../../contracts/index';
import { mergeParts, type Part } from './parts';
import { WEAPON_MODELS, modelOf, type WeaponModel } from './models';
import { freshPose, vmPose, type VmAnim, type VmPose } from './pose';

/** [CVARS] viewmodel_offset_x / _y / _z defaults (units: right, forward, up). */
export const VIEWMODEL_OFFSET = { x: 1, y: 1, z: -1 } as const;
/** View-space scale of the viewmodel scene (the renderer's viewmodel camera has near 0.01): 1 unit = 0.01. */
export const VM_SCALE = 0.01;

/** Where each class's grip sits in view space (units: right, up, back; −z is forward). **Assumed**, fitted by eye. */
const HOLD: Readonly<Record<WeaponModel['kind'], readonly [number, number, number]>> = {
  // Rifle: with viewmodel_fov 60 (vertical 46.8°) the grip lands near 77 % across and 80 % down a 16:9 screen and the
  // muzzle near 62 % / 60 %, the stock off the right edge: CS2's default AK-47 composition.
  rifle: [8.2, -5.0, -21],
  sniper: [8.2, -5.4, -21.5],
  pistol: [5.6, -4.9, -16.5],
  knife: [6.6, -5.6, -15],
  c4: [3.0, -4.6, -15],
  grenade: [6.2, -5.0, -16.5],
};
/** The barrel turned this much toward the screen centre (radians, yaw left), like CS2's composition. */
const TOE_IN = 0.045;
/**
 * W2: the rest attitude per class on top of TOE_IN (radians: x pitch up, y yaw left, z roll left). The knife: CS2's
 * default idle, held low on the right with the point up and in toward the crosshair, the edge turned down-left.
 */
const REST: Readonly<Record<WeaponModel['kind'], readonly [number, number, number]>> = {
  rifle: [0, 0, 0],
  sniper: [0, 0, 0],
  pistol: [0, 0, 0],
  knife: [0.3, 0.62, 0.5],
  c4: [0, 0, 0],
  grenade: [0, 0, 0],
};

const SLEEVE: Readonly<Record<Team, number>> = { CT: 0x34465a, T: 0x705d3c };
const GLOVE = 0x2b2826;

type V3 = readonly [number, number, number];

/**
 * W2: a forearm from the wrist `a` to the elbow `b` (model space): a glove cuff at the wrist, then the sleeve, each a
 * box along the segment. Euler XYZ (three.js: Rx · Ry) that turns +z onto the direction d: yaw asin(dx), pitch
 * atan2(−dy, dz).
 */
export function forearm(a: V3, b: V3, sleeve: number, cuff = 1.8, wrist = 2.3, arm = 3.1): Part[] {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const u: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const rot: V3 = [Math.atan2(-u[1], u[2]), Math.asin(u[0]), 0];
  const at = (t: number): V3 => [a[0] + u[0] * t, a[1] + u[1] * t, a[2] + u[2] * t];
  return [
    { s: 'box', c: GLOVE, size: [wrist, wrist, cuff], at: at(cuff / 2), rot },
    { s: 'box', c: sleeve, size: [arm, arm, len - cuff + 0.6], at: at(cuff + (len - cuff) / 2 - 0.3), rot },
  ];
}

/**
 * W2: the hands and forearms per weapon class (model space, origin at the top of the grip). The right hand wraps the
 * grip (thumb over the top on the left, index finger on the trigger) with its forearm running back and down to the
 * lower right, out of the view; the left hand cups the handguard from below (rifles, snipers; it follows the mag in a
 * reload) or wraps the right hand (pistols), its forearm to the lower left. Knife and grenades: the right hand only
 * (CS2's one-handed idle). The C4: both hands under the brick.
 */
function armParts(m: WeaponModel, sleeve: number): { right: Part[]; left: Part[] } {
  const lh = m.leftHand;
  switch (m.kind) {
    case 'knife':
      return {
        right: [
          { s: 'box', c: GLOVE, size: [1.6, 1.8, 3.4], at: [0.1, -0.15, 0.15] },
          { s: 'box', c: GLOVE, size: [0.6, 0.6, 1.6], at: [-0.6, 0.72, -0.7] },
          ...forearm([0.4, -0.5, 1.9], [3.4, -6.5, 12.5], sleeve),
        ],
        left: [],
      };
    case 'grenade':
      return {
        right: [
          { s: 'box', c: GLOVE, size: [2.2, 1.4, 1.8], at: [0.5, -0.95, 0.3] },
          { s: 'box', c: GLOVE, size: [0.6, 1.8, 1.8], at: [1.55, 0.1, -1.2] },
          { s: 'box', c: GLOVE, size: [0.6, 0.6, 1.6], at: [-1.0, 0.9, -0.6] },
          ...forearm([0.8, -1.2, 1.0], [3.8, -7.5, 11.5], sleeve),
        ],
        left: [],
      };
    case 'c4': {
      const l = lh ?? [-1.6, -1.2, -4.5];
      return {
        right: [{ s: 'box', c: GLOVE, size: [2.0, 1.0, 2.6], at: [1.4, -1.7, -1.4] }, ...forearm([1.6, -2.2, 0.0], [4.5, -8, 10.5], sleeve)],
        left: [{ s: 'box', c: GLOVE, size: [2.0, 1.0, 2.6], at: [l[0], l[1] - 0.5, l[2]] }, ...forearm([l[0] - 0.4, l[1] - 1.0, l[2] + 1.4], [l[0] - 4, l[1] - 7.5, l[2] + 11], sleeve)],
      };
    }
    case 'pistol':
      return {
        right: [
          { s: 'box', c: GLOVE, size: [2.2, 3.2, 2.4], at: [0.2, -1.8, 0.75], rot: [0.22, 0, 0] },
          { s: 'box', c: GLOVE, size: [0.5, 0.5, 1.4], at: [0.0, -0.75, -0.75] },
          ...forearm([0.45, -3.3, 1.9], [3.4, -8.8, 12.5], sleeve),
        ],
        left: [
          { s: 'box', c: GLOVE, size: [1.9, 2.6, 2.4], at: [-1.35, -2.3, 0.45], rot: [0.22, 0, 0] },
          { s: 'box', c: GLOVE, size: [0.6, 0.6, 2.0], at: [-0.8, -0.35, -0.8] },
          ...forearm([-1.7, -3.5, 1.6], [-6.5, -9, 11.5], sleeve),
        ],
      };
    default: {
      // Rifles and snipers.
      const l = lh ?? [0, -0.4, -12];
      return {
        right: [
          { s: 'box', c: GLOVE, size: [2.2, 3.0, 2.6], at: [0.25, -1.75, 0.95], rot: [0.25, 0, 0] },
          { s: 'box', c: GLOVE, size: [0.7, 0.7, 1.8], at: [-0.85, -0.55, 0.3] },
          { s: 'box', c: GLOVE, size: [0.5, 0.5, 1.5], at: [0.0, -1.1, -0.85] },
          ...forearm([0.5, -3.0, 2.4], [3.2, -8.5, 12.5], sleeve),
        ],
        left: [
          { s: 'box', c: GLOVE, size: [2.2, 1.0, 3.2], at: [l[0] - 0.2, l[1] - 0.95, l[2]] },
          { s: 'box', c: GLOVE, size: [0.6, 1.8, 3.0], at: [l[0] - 1.35, l[1] + 0.05, l[2]] },
          { s: 'box', c: GLOVE, size: [0.6, 0.9, 2.2], at: [l[0] + 1.35, l[1] - 0.25, l[2] + 0.2] },
          ...forearm([l[0] - 0.6, l[1] - 1.6, l[2] + 1.2], [l[0] - 7, l[1] - 8, l[2] + 10], sleeve),
        ],
      };
    }
  }
}

interface Built {
  readonly model: WeaponModel;
  readonly group: Group;
  readonly gun: Group;
  readonly mag: Mesh | null;
  readonly bolt: Mesh | null;
  readonly pin: Mesh | null;
  readonly leftArm: Record<Team, Mesh>;
  readonly rightArm: Record<Team, Mesh>;
  readonly flash: Mesh;
}

export class ViewmodelRig {
  readonly root = new Group();
  private readonly mat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, fog: false });
  private readonly flashMat = new MeshBasicMaterial({ color: 0xffc865, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
  private readonly flashGeom: BufferGeometry;
  private readonly built = new Map<string, Built>();
  private current: Built | null = null;
  private readonly pose: VmPose = freshPose();
  /** The last pose (tests, the browser check). */
  last: { weapon: string; phase: VmPose['phase']; progress: number; visible: boolean } | null = null;

  constructor() {
    this.root.scale.setScalar(VM_SCALE);
    this.root.visible = false;
    // A three-blade star: two crossed planes along the barrel and one facing the camera.
    const g = new PlaneGeometry(1, 1);
    this.flashGeom = g;
  }

  private build(weapon: string): Built {
    const m = modelOf(weapon);
    const group = new Group();
    const gun = new Group();
    group.add(gun);
    gun.add(new Mesh(mergeParts(m.body), this.mat));
    const part = (parts: readonly Part[] | undefined): Mesh | null => {
      if (parts === undefined) return null;
      const mesh = new Mesh(mergeParts(parts), this.mat);
      gun.add(mesh);
      return mesh;
    };
    const mag = part(m.mag);
    const bolt = part(m.bolt);
    const pin = part(m.pin);
    const arms = (team: Team): { l: Mesh; r: Mesh } => {
      const a = armParts(m, SLEEVE[team]);
      const r = new Mesh(mergeParts(a.right), this.mat);
      const l = new Mesh(mergeParts(a.left), this.mat);
      gun.add(r);
      (m.leftHand === null ? gun : group).add(l);
      return { l, r };
    };
    const ct = arms('CT');
    const t = arms('T');
    const flash = new Group();
    const sizes: [number, number, number][] = [
      [0, 0, 0],
      [0, Math.PI / 2, 0],
      [Math.PI / 2, 0, 0],
    ];
    for (const r of sizes) {
      const f = new Mesh(this.flashGeom, this.flashMat);
      f.rotation.set(r[0], r[1], r[2]);
      flash.add(f);
    }
    const flashMesh = new Mesh();
    flashMesh.add(flash);
    flashMesh.position.set(m.muzzle[0], m.muzzle[1], m.muzzle[2] - (m.silenced === true ? 0.5 : 2));
    flashMesh.scale.set(m.silenced === true ? 1.6 : 3.4, m.silenced === true ? 1.6 : 3.4, m.silenced === true ? 2 : 6);
    flashMesh.visible = false;
    gun.add(flashMesh);
    group.visible = false;
    this.root.add(group);
    const b: Built = { model: m, group, gun, mag, bolt, pin, leftArm: { CT: ct.l, T: t.l }, rightArm: { CT: ct.r, T: t.r }, flash: flashMesh };
    this.built.set(weapon, b);
    return b;
  }

  /** Pose the held weapon (null: nothing in first person). */
  update(a: VmAnim | null, team: Team): void {
    if (a === null) {
      this.root.visible = false;
      this.last = null;
      return;
    }
    const key = WEAPON_MODELS[a.weapon] === undefined ? 'knife' : a.weapon;
    const b = this.built.get(key) ?? this.build(key);
    if (this.current !== b) {
      if (this.current !== null) this.current.group.visible = false;
      this.current = b;
    }
    const p = vmPose(a, b.model, this.pose);
    this.root.visible = p.visible;
    b.group.visible = true;
    const h = HOLD[b.model.kind];
    b.group.position.set(h[0] + VIEWMODEL_OFFSET.x + p.x, h[1] + VIEWMODEL_OFFSET.z + p.y, h[2] - VIEWMODEL_OFFSET.y + p.z);
    const rest = REST[b.model.kind];
    b.group.rotation.set(rest[0] + p.rx, TOE_IN + rest[1] + p.ry, rest[2] + p.rz);
    if (b.mag !== null) {
      b.mag.position.set(0, p.magY, p.magZ);
      b.mag.visible = p.magVisible;
    }
    if (b.bolt !== null) {
      if (b.model.kind === 'c4') b.bolt.position.set(0, -p.bolt * 0.2, 0);
      else b.bolt.position.set(0, 0, p.bolt);
    }
    if (b.pin !== null) b.pin.visible = p.pinVisible;
    for (const t of ['CT', 'T'] as const) {
      b.leftArm[t].visible = t === team;
      b.rightArm[t].visible = t === team;
    }
    // Rifles: the left hand follows the mag during the reload.
    const la = b.leftArm[team];
    if (b.model.leftHand !== null) {
      la.position.set(0, p.phase === 'reload' ? p.magY * 0.8 : 0, p.phase === 'reload' ? p.magZ : 0);
      la.rotation.set(0, 0, 0);
    }
    b.flash.visible = p.flash;
    if (p.flash) b.flash.rotation.z = (a.sinceShot * 9000) % Math.PI;
    this.last = { weapon: a.weapon, phase: p.phase, progress: p.progress, visible: p.visible };
  }
}

/** Each pawn's weapon in its hand, and dropped beside it on death. */
export class WorldWeapons {
  private readonly mat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
  private readonly geoms = new Map<string, BufferGeometry>();
  private readonly meshes = new Map<string, Mesh>();
  private readonly held = new Map<string, string>();

  private geom(weapon: string): BufferGeometry {
    let g = this.geoms.get(weapon);
    if (g === undefined) {
      const m = modelOf(weapon);
      g = mergeParts([...m.body, ...(m.mag ?? []), ...(m.bolt ?? []), ...(m.pin ?? [])]);
      this.geoms.set(weapon, g);
    }
    return g;
  }

  /**
   * Pose `id`'s weapon in its pawn group (local frame: x right, y up, −z along the view yaw; Three units = Source
   * units): in the right hand at chest height, tilted with the pitch; dead: flat on the floor beside the body.
   */
  update(id: string, group: Object3D, weapon: string, alive: boolean, crouching: boolean, pitchDeg: number): void {
    let mesh = this.meshes.get(id);
    if (mesh === undefined) {
      mesh = new Mesh(this.geom(weapon), this.mat);
      group.add(mesh);
      this.meshes.set(id, mesh);
      this.held.set(id, weapon);
    }
    if (this.held.get(id) !== weapon) {
      mesh.geometry = this.geom(weapon);
      this.held.set(id, weapon);
    }
    const kind = modelOf(weapon).kind;
    if (alive) {
      const k = crouching ? 54 / 72 : 1;
      const small = kind === 'pistol' || kind === 'knife' || kind === 'grenade';
      mesh.position.set(7, (small ? 46 : 44) * k, small ? -14 : -10);
      mesh.rotation.set((-pitchDeg * Math.PI) / 180, 0, 0);
    }
    // W2: a dead pawn's gun is a world item (WorldItemMeshes); the rest of its kit stays with the body, unseen.
    mesh.visible = alive;
  }
}

/** W2: one gun lying in (or flying through) the world, as the renderer draws it. */
export interface DrawItem {
  readonly seq: number;
  readonly item: string;
  /** Centre (Source units). */
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
  /** Degrees CCW from +x. */
  readonly yaw: number;
}

/**
 * W2: the guns lying in the world: the viewmodel geometry at world scale (1 model unit = 1 Source unit, as on the
 * players), on its side, centred on the item, along its yaw. Meshes pooled by seq; geometry shared per weapon.
 */
export class WorldItemMeshes {
  readonly root = new Group();
  private readonly mat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
  private readonly geoms = new Map<string, BufferGeometry>();
  private readonly live = new Map<number, Group>();
  private readonly spare: Group[] = [];

  private geom(weapon: string): BufferGeometry {
    let g = this.geoms.get(weapon);
    if (g === undefined) {
      const m = modelOf(weapon);
      g = mergeParts([...m.body, ...(m.mag ?? []), ...(m.bolt ?? []), ...(m.pin ?? [])]);
      g.computeBoundingBox();
      const b = g.boundingBox;
      // Centre it (the model origin is the grip), so it lies around the item's position.
      if (b !== null) g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
      this.geoms.set(weapon, g);
    }
    return g;
  }

  /** Number of items drawn (tests). */
  get count(): number {
    return this.live.size;
  }

  update(items: readonly DrawItem[]): void {
    const seen = new Set<number>();
    for (const it of items) {
      seen.add(it.seq);
      let g = this.live.get(it.seq);
      if (g === undefined) {
        g = this.spare.pop() ?? new Group();
        if (g.children.length === 0) g.add(new Mesh(this.geom(it.item), this.mat));
        else (g.children[0] as Mesh).geometry = this.geom(it.item);
        // On its side: the gun's up (+y) turned to lie along the floor.
        (g.children[0] as Mesh).rotation.set(0, 0, Math.PI / 2);
        g.visible = true;
        this.root.add(g);
        this.live.set(it.seq, g);
      }
      g.position.set(it.pos.x, it.pos.z, -it.pos.y);
      // The model's barrel is −z; −z along the Source yaw (the pawn groups' convention).
      g.rotation.set(0, ((it.yaw - 90) * Math.PI) / 180, 0);
    }
    for (const [seq, g] of this.live) {
      if (seen.has(seq)) continue;
      g.visible = false;
      this.root.remove(g);
      this.live.delete(seq);
      this.spare.push(g);
    }
  }
}
