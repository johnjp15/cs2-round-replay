/**
 * H1: the Three.js view (docs/app3d.md "Rendering"). Low fidelity in the right colours, no lighting at run time:
 * every colour is baked per triangle (world-mesh.ts), so the materials are unlit (MeshBasicMaterial) and the GPU
 * cost is one pass over ~73k triangles, culled per 512-unit tile.
 *
 * - World: per tile a radar-textured floor mesh (the CS2 radar image as the texture, UVs from the radar transform,
 *   multiplied by a baked shade) and a vertex-coloured mesh for walls and undersides. Sky colour and distance fog.
 * - Players: capsules in team colours (T yellow-orange, CT blue; the human white-rimmed), a dark visor at eye height
 *   facing the view direction, crouched shorter; dead ones lie flat and grey. Name tags (canvas sprites, constant
 *   size) over the human's teammates (all of them while watching).
 * - Effects: tracers (the 3D bullets of the last ticks, host.shots()), muzzle flash on the viewmodel, smokes (grey
 *   spheres), fires (orange discs), grenades in flight, the bomb (red box, blinking while planted).
 * - First person: the camera at the eye with the view angles; a box viewmodel drawn in a second pass (it never
 *   clips into walls). Frames: src/app3d/coords.ts (Source x, y, z → Three x, z, −y).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Fog,
  Group,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
  WebGLRenderer,
  LinearSRGBColorSpace,
  Vector2,
  ColorManagement,
  DataTexture,
} from 'three';
import type { PlayerId, Team, Vec3, WeaponId } from '../contracts/index';
import type { Effect } from '../app/effects';
import { cameraEuler, toThree } from './coords';
import type { WorldTile } from './world-mesh';

export const TEAM_COLOR: { readonly [K in Team]: number } = { T: 0xe8a33a, CT: 0x4f86d9 };
const SKY = 0xb9cad6;
const MAX_TRACERS = 96;

/** One pawn as drawn this frame (interpolated). */
export interface DrawPawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly alive: boolean;
  readonly human: boolean;
  /** Draw its name tag. */
  readonly tag: boolean;
  /** Not drawn (the pawn whose eyes the camera is at). */
  readonly hidden: boolean;
}

export interface DrawTracer {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly team: Team;
  /** 0 (new) .. 1 (gone). */
  readonly age: number;
}

export interface DrawFrame {
  readonly pawns: readonly DrawPawn[];
  /** Camera position (Source) and angles. */
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  /** Vertical FOVs (degrees) of the world camera and the viewmodel camera (view-cs2.ts verticalFov). */
  readonly fovDeg: number;
  readonly viewmodelFovDeg: number;
  readonly tracers: readonly DrawTracer[];
  readonly effects: readonly Effect[];
  readonly bomb: { readonly pos: Vec3; readonly planted: boolean } | null;
  /** First-person viewmodel: the held weapon and the time since the last shot (s), or null (spectating). */
  readonly viewmodel: { readonly weapon: WeaponId; readonly sinceShot: number } | null;
  readonly nowMs: number;
}

function nameTexture(text: string, color: string): Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx !== null) {
    ctx.font = 'bold 34px "Avenir Next Condensed", "DIN Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 128, 32);
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.minFilter = LinearFilter;
  return t;
}

interface PawnView {
  readonly group: Group;
  readonly body: Mesh;
  readonly visor: Mesh;
  readonly tag: Sprite;
  readonly bodyMat: MeshBasicMaterial;
}

const WEAPON_COLOR: Partial<Record<WeaponId, number>> = { ak47: 0x6b4a2b, m4a4: 0x2e3338, awp: 0x3d4a33, ssg08: 0x3b4a3a, deagle: 0x8a8d90, glock: 0x2b2b2b, knife: 0x9aa3ad, c4: 0x7a2a22, smoke: 0x9aa3ad, flash: 0xd8d8c8, he: 0x4b5d33, molotov: 0xb5651d };

export class Renderer3D {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly vmScene = new Scene();
  private readonly vmCamera = new PerspectiveCamera(60, 1, 0.01, 10);
  private readonly pawns = new Map<PlayerId, PawnView>();
  private readonly tracerGeom = new BufferGeometry();
  private readonly tracerPos = new Float32Array(MAX_TRACERS * 6);
  private readonly tracerCol = new Float32Array(MAX_TRACERS * 6);
  private readonly smokes: Mesh[] = [];
  private readonly fires: Mesh[] = [];
  private readonly nades: Mesh[] = [];
  private readonly bomb: Mesh;
  private readonly vm: Group;
  private readonly vmGun: Mesh;
  private readonly vmGunMat: MeshBasicMaterial;
  private readonly flash: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly size = new Vector2();
  /** Triangles drawn in the last frame (stats). */
  drawnTriangles = 0;

  constructor(canvas: HTMLCanvasElement, tiles: readonly WorldTile[], floorArt: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }, roster: readonly { id: PlayerId; team: Team }[], resolution = 1) {
    this.canvas = canvas;
    // Colours are sRGB values used as they are (baked per vertex, the radar texture, the team colours): no linear workflow.
    ColorManagement.enabled = false;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * resolution);
    this.renderer.autoClear = false;
    this.camera = new PerspectiveCamera(74, 1, 4, 12000);
    this.camera.rotation.order = 'YXZ';
    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 2500, 11000);
    const tex = new DataTexture(floorArt.data, floorArt.width, floorArt.height);
    tex.colorSpace = NoColorSpace;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const floorMat = new MeshBasicMaterial({ map: tex, vertexColors: true, side: DoubleSide });
    const plainMat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
    for (const t of tiles) {
      if (t.floor.triangles > 0) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(t.floor.positions, 3));
        g.setAttribute('uv', new BufferAttribute(t.floor.uvs, 2));
        g.setAttribute('color', new BufferAttribute(t.floor.colors, 3));
        g.computeBoundingSphere();
        this.scene.add(new Mesh(g, floorMat));
      }
      if (t.plain.triangles > 0) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(t.plain.positions, 3));
        g.setAttribute('color', new BufferAttribute(t.plain.colors, 3));
        g.computeBoundingSphere();
        this.scene.add(new Mesh(g, plainMat));
      }
    }
    // Players.
    const capsule = new CapsuleGeometry(13, 72 - 26, 4, 10);
    capsule.translate(0, 36, 0);
    const visorGeom = new BoxGeometry(6, 6, 18);
    for (const r of roster) {
      const group = new Group();
      const bodyMat = new MeshBasicMaterial({ color: TEAM_COLOR[r.team] });
      const body = new Mesh(capsule, bodyMat);
      const visor = new Mesh(visorGeom, new MeshBasicMaterial({ color: 0x1b1d20 }));
      const tag = new Sprite(new SpriteMaterial({ map: nameTexture(r.id, r.team === 'T' ? '#ffd27a' : '#a8cbff'), depthTest: false, transparent: true, sizeAttenuation: false }));
      tag.scale.set(0.16, 0.04, 1);
      tag.renderOrder = 10;
      group.add(body, visor, tag);
      this.scene.add(group);
      this.pawns.set(r.id, { group, body, visor, tag, bodyMat });
    }
    // Tracers.
    this.tracerGeom.setAttribute('position', new BufferAttribute(this.tracerPos, 3));
    this.tracerGeom.setAttribute('color', new BufferAttribute(this.tracerCol, 3));
    const tracers = new LineSegments(this.tracerGeom, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, fog: false }));
    tracers.frustumCulled = false;
    this.scene.add(tracers);
    // Grenade effects (pools, grown on demand).
    this.bomb = new Mesh(new BoxGeometry(12, 6, 8), new MeshBasicMaterial({ color: 0xd8322c }));
    this.bomb.visible = false;
    this.scene.add(this.bomb);
    // Viewmodel: a box gun at the lower right, its muzzle flash, drawn after the world with its own depth.
    this.vm = new Group();
    this.vmGunMat = new MeshBasicMaterial({ color: 0x6b4a2b });
    this.vmGun = new Mesh(new BoxGeometry(0.045, 0.055, 0.42), this.vmGunMat);
    this.vmGun.position.set(0.17, -0.17, -0.42);
    const grip = new Mesh(new BoxGeometry(0.04, 0.1, 0.05), new MeshBasicMaterial({ color: 0x2a2a2a }));
    grip.position.set(0.17, -0.24, -0.32);
    this.flash = new Mesh(new SphereGeometry(0.05, 8, 6), new MeshBasicMaterial({ color: 0xffe9a0 }));
    this.flash.position.set(0.17, -0.15, -0.65);
    this.vm.add(this.vmGun, grip, this.flash);
    this.vmScene.add(this.vm);
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const size = this.renderer.getSize(this.size);
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.vmCamera.aspect = this.camera.aspect;
      this.vmCamera.updateProjectionMatrix();
    }
  }

  render(f: DrawFrame): void {
    this.resize();
    const [cx, cy, cz] = toThree(f.eye.x, f.eye.y, f.eye.z);
    this.camera.position.set(cx, cy, cz);
    const e = cameraEuler(f.yaw, f.pitch);
    this.camera.rotation.set(e.x, e.y, 0);
    if (this.camera.fov !== f.fovDeg) {
      this.camera.fov = f.fovDeg;
      this.camera.updateProjectionMatrix();
    }
    this.drawPawns(f);
    this.drawTracers(f.tracers);
    this.drawEffects(f.effects, f.nowMs);
    if (f.bomb === null) this.bomb.visible = false;
    else {
      this.bomb.visible = true;
      const [bx, by, bz] = toThree(f.bomb.pos.x, f.bomb.pos.y, f.bomb.pos.z + 3);
      this.bomb.position.set(bx, by, bz);
      (this.bomb.material as MeshBasicMaterial).color.setHex(f.bomb.planted && Math.floor(f.nowMs / 400) % 2 === 0 ? 0xff6a5a : 0xb0221c);
    }
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.drawnTriangles = this.renderer.info.render.triangles;
    if (this.vmCamera.fov !== f.viewmodelFovDeg) {
      this.vmCamera.fov = f.viewmodelFovDeg;
      this.vmCamera.updateProjectionMatrix();
    }
    if (f.viewmodel !== null) {
      this.vmGunMat.color.setHex(WEAPON_COLOR[f.viewmodel.weapon] ?? 0x555555);
      const kick = Math.max(0, 1 - f.viewmodel.sinceShot / 0.08);
      this.vm.position.set(0, kick * 0.01, kick * 0.04);
      this.flash.visible = f.viewmodel.sinceShot < 0.035 && f.viewmodel.weapon !== 'knife' && !['c4', 'smoke', 'flash', 'he', 'molotov'].includes(f.viewmodel.weapon);
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }

  /** The viewmodel camera's vertical FOV (degrees). */
  viewmodelFov(): number {
    return this.vmCamera.fov;
  }

  private drawPawns(f: DrawFrame): void {
    for (const p of f.pawns) {
      const v = this.pawns.get(p.id);
      if (v === undefined) continue;
      v.group.visible = !p.hidden;
      if (p.hidden) continue;
      const [x, y, z] = toThree(p.pos.x, p.pos.y, p.pos.z);
      v.group.position.set(x, y, z);
      // Group yaw: local −z (the visor's forward) along the Source yaw.
      v.group.rotation.set(0, ((p.yaw - 90) * Math.PI) / 180, 0);
      if (p.alive) {
        const k = p.crouching ? 54 / 72 : 1;
        v.body.scale.set(1, k, 1);
        v.body.rotation.set(0, 0, 0);
        v.body.position.set(0, 0, 0);
        v.bodyMat.color.setHex(TEAM_COLOR[p.team]);
        if (p.human) v.bodyMat.color.lerp(new Color(0xffffff), 0.25);
        v.visor.visible = true;
        const eye = p.crouching ? 46 : 64;
        v.visor.position.set(0, eye, -9);
        v.visor.rotation.set((-p.pitch * Math.PI) / 180, 0, 0);
        v.tag.visible = p.tag;
        v.tag.position.set(0, (p.crouching ? 54 : 72) + 14, 0);
      } else {
        // Lying flat on the floor, greyed.
        v.body.scale.set(1, 1, 1);
        v.body.rotation.set(-Math.PI / 2, 0, 0);
        v.body.position.set(0, 13, 0);
        v.bodyMat.color.setHex(TEAM_COLOR[p.team]).multiplyScalar(0.45);
        v.visor.visible = false;
        v.tag.visible = false;
      }
    }
  }

  private drawTracers(ts: readonly DrawTracer[]): void {
    const n = Math.min(MAX_TRACERS, ts.length);
    for (let i = 0; i < n; i++) {
      const t = ts[i] as DrawTracer;
      const a = toThree(t.from.x, t.from.y, t.from.z);
      const b = toThree(t.to.x, t.to.y, t.to.z);
      this.tracerPos.set(a, i * 6);
      this.tracerPos.set(b, i * 6 + 3);
      const k = 1 - t.age;
      const c = t.team === 'T' ? [1, 0.86, 0.45] : [0.7, 0.85, 1];
      const sky = [0.73, 0.79, 0.84];
      for (let j = 0; j < 2; j++) for (let q = 0; q < 3; q++) this.tracerCol[i * 6 + j * 3 + q] = (sky[q] as number) + ((c[q] as number) - (sky[q] as number)) * k;
    }
    this.tracerGeom.setDrawRange(0, n * 2);
    (this.tracerGeom.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.tracerGeom.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  private pool(list: Mesh[], make: () => Mesh, n: number): void {
    while (list.length < n) {
      const m = make();
      list.push(m);
      this.scene.add(m);
    }
    for (let i = 0; i < list.length; i++) (list[i] as Mesh).visible = i < n;
  }

  private drawEffects(effects: readonly Effect[], nowMs: number): void {
    const smokes = effects.filter((e) => e.phase === 'smoke');
    const fires = effects.filter((e) => e.phase === 'fire');
    const flying = effects.filter((e) => e.phase === 'flying');
    this.pool(this.smokes, () => new Mesh(new SphereGeometry(1, 16, 10), new MeshBasicMaterial({ color: 0xc9cfd4, transparent: true, opacity: 0.93 })), smokes.length);
    smokes.forEach((e, i) => {
      const m = this.smokes[i] as Mesh;
      const [x, y, z] = toThree(e.pos.x, e.pos.y, e.pos.z);
      m.position.set(x, y + e.radius * 0.45, z);
      m.scale.set(e.radius, e.radius * 0.75, e.radius);
    });
    this.pool(this.fires, () => new Mesh(new CylinderGeometry(1, 1, 6, 20), new MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85 })), fires.length);
    fires.forEach((e, i) => {
      const m = this.fires[i] as Mesh;
      const [x, y, z] = toThree(e.pos.x, e.pos.y, e.pos.z);
      m.position.set(x, y + 3, z);
      const flicker = 1 + 0.06 * Math.sin(nowMs / 60 + i);
      m.scale.set(e.radius * flicker, 1 + 2 * Math.abs(Math.sin(nowMs / 90 + i)), e.radius * flicker);
    });
    this.pool(this.nades, () => new Mesh(new SphereGeometry(3, 8, 6), new MeshBasicMaterial({ color: 0x3a4a2a })), flying.length);
    flying.forEach((e, i) => {
      const m = this.nades[i] as Mesh;
      const [x, y, z] = toThree(e.pos.x, e.pos.y, e.pos.z);
      m.position.set(x, y, z);
    });
  }
}
