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

const SLEEVE: Readonly<Record<Team, number>> = { CT: 0x34465a, T: 0x705d3c };
const GLOVE = 0x2b2826;

function armParts(m: WeaponModel, sleeve: number): { right: Part[]; left: Part[] } {
  const right: Part[] = [
    { s: 'box', c: GLOVE, size: [2.0, 2.6, 2.4], at: [0.3, -1.6, 0.9], rot: [0.25, 0, 0] },
    { s: 'box', c: sleeve, size: [3.0, 3.0, 13], at: [1.8, -4.6, 8.2], rot: [0.42, -0.18, 0] },
  ];
  const lh = m.leftHand;
  const left: Part[] =
    lh === null
      ? [
          { s: 'box', c: GLOVE, size: [1.8, 2.4, 2.2], at: [-1.1, -2.2, 0.9], rot: [0.25, 0, 0.2] },
          { s: 'box', c: sleeve, size: [2.8, 2.8, 12], at: [-3.8, -5.2, 7.6], rot: [0.45, 0.35, 0] },
        ]
      : [
          { s: 'box', c: GLOVE, size: [2.6, 2.0, 2.8], at: [lh[0], lh[1] - 0.6, lh[2]] },
          { s: 'box', c: sleeve, size: [2.8, 2.8, 13], at: [lh[0] - 3.2, lh[1] - 4.2, lh[2] + 6.4], rot: [0.5, 0.42, 0] },
        ];
  return { right, left };
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
    b.group.rotation.set(p.rx, TOE_IN + p.ry, p.rz);
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
