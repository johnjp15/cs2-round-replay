/**
 * H1: the Three.js view (docs/app3d.md "Rendering"). Low fidelity in the right colours, no lighting at run time:
 * every colour is baked per triangle (world-mesh.ts), so the materials are unlit (MeshBasicMaterial) and the GPU
 * cost is one pass over ~73k triangles in two draw calls (P1: the tiles joined).
 *
 * - World: per tile a radar-textured floor mesh (the CS2 radar image as the texture, UVs from the radar transform,
 *   multiplied by a baked shade) and a vertex-coloured mesh for walls and undersides. Sky colour and distance fog.
 * - Players: capsules in team colours (T yellow-orange, CT blue; the human white-rimmed), a dark visor at eye height
 *   facing the view direction, crouched shorter; dead ones lie flat and grey. Name tags (canvas sprites, constant
 *   size) over the human's teammates (all of them while watching).
 * - Effects: tracers (the 3D bullets of the last ticks, host.shots()), muzzle flash on the viewmodel, smokes (grey
 *   spheres), fires (orange discs), grenades in flight, the bomb (red box, blinking while planted).
 * - First person: the camera at the eye with the view angles; the weapon's viewmodel (A1, src/app3d/viewmodels)
 *   drawn in a second pass (it never clips into walls); the other players' weapons in their hands. Frames: src/app3d/coords.ts (Source x, y, z → Three x, z, −y).
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
import type { WorldTile } from './world-mesh';
import { ViewmodelRig, WorldWeapons } from './viewmodels/rig';
import type { VmAnim } from './viewmodels/pose';

export const TEAM_COLOR: { readonly [K in Team]: number } = { T: 0xe8a33a, CT: 0x4f86d9 };
const SKY = 0xb9cad6;
const MAX_TRACERS = 96;
const TRACER_T = [1, 0.86, 0.45] as const;
const TRACER_CT = [0.7, 0.85, 1] as const;
const TRACER_SKY = [0.73, 0.79, 0.84] as const;

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
  /** A1: the held weapon (its world model in the right hand; dropped beside the body when dead). */
  readonly weapon?: WeaponId;
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
  readonly viewmodel: { readonly weapon: WeaponId; readonly sinceShot: number; readonly anim?: VmAnim | null; readonly team?: Team } | null;
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

/** P1: how the renderer is made (docs/app3d.md "Performance"). */
export interface RendererOptions {
  /** Render scale × the device pixel ratio (capped at 1.5): 0.25–2. */
  readonly resolution?: number;
  /**
   * A low-latency (`desynchronized`) WebGL context: Chrome can show the canvas without waiting for the compositor
   * (lower latency, may tear); browsers without it ignore the flag.
   */
  readonly desynchronized?: boolean;
}

/** Device pixel ratios above this are not rendered (the canvas would cost 4× the pixels at DPR 2 for little gain). */
export const MAX_DPR = 1.5;


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
  /** A1: the procedural viewmodels (src/app3d/viewmodels) and the world models on the players. */
  readonly viewmodels = new ViewmodelRig();
  private readonly worldWeapons = new WorldWeapons();
  private readonly canvas: HTMLCanvasElement;
  private readonly size = new Vector2();
  /** Triangles drawn in the last frame (stats). */
  drawnTriangles = 0;
  /** Whether the context is really `desynchronized` (the browser may not support it). */
  readonly desynchronized: boolean;
  private readonly humanTint = new Color();
  private tracersDrawn = -1;

  constructor(canvas: HTMLCanvasElement, tiles: readonly WorldTile[], floorArt: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }, roster: readonly { id: PlayerId; team: Team }[], options: RendererOptions = {}) {
    this.canvas = canvas;
    // Colours are sRGB values used as they are (baked per vertex, the radar texture, the team colours): no linear workflow.
    ColorManagement.enabled = false;
    // P1: our own context so it can be `desynchronized`; opaque (the sky fills it), no MSAA, no stencil.
    const attrs: WebGLContextAttributes & { desynchronized?: boolean } = { alpha: false, antialias: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: options.desynchronized === true };
    const context = canvas.getContext('webgl2', attrs);
    this.desynchronized = context !== null && (context.getContextAttributes() as (WebGLContextAttributes & { desynchronized?: boolean }) | null)?.desynchronized === true;
    this.renderer = context === null ? new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }) : new WebGLRenderer({ canvas, context, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.setResolution(options.resolution ?? 1);
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
    // P1: the static world in two draw calls (radar-textured floors, vertex-coloured rest): the tiles' arrays joined
    // once here. ~73k triangles are nothing for a GPU; 40 culled draw calls cost more CPU than they save.
    const join = (parts: readonly Float32Array[]): Float32Array => {
      const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
      let o = 0;
      for (const a of parts) {
        out.set(a, o);
        o += a.length;
      }
      return out;
    };
    const floors = tiles.filter((t) => t.floor.triangles > 0);
    const plains = tiles.filter((t) => t.plain.triangles > 0);
    if (floors.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(join(floors.map((t) => t.floor.positions)), 3));
      g.setAttribute('uv', new BufferAttribute(join(floors.map((t) => t.floor.uvs)), 2));
      g.setAttribute('color', new BufferAttribute(join(floors.map((t) => t.floor.colors)), 3));
      g.computeBoundingSphere();
      const m = new Mesh(g, floorMat);
      m.matrixAutoUpdate = false;
      this.scene.add(m);
    }
    if (plains.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(join(plains.map((t) => t.plain.positions)), 3));
      g.setAttribute('color', new BufferAttribute(join(plains.map((t) => t.plain.colors)), 3));
      g.computeBoundingSphere();
      const m = new Mesh(g, plainMat);
      m.matrixAutoUpdate = false;
      this.scene.add(m);
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
    // Viewmodel (A1): the held weapon with hands, drawn after the world with its own depth.
    this.vmScene.add(this.viewmodels.root);
  }

  /** Render scale (0.25–2) × the device pixel ratio capped at MAX_DPR. */
  setResolution(scale: number): void {
    const k = Math.min(2, Math.max(0.25, Number.isFinite(scale) ? scale : 1));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR) * k);
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
    // toThree / cameraEuler inline (coords.ts): no per-frame arrays.
    this.camera.position.set(f.eye.x, f.eye.z, -f.eye.y);
    this.camera.rotation.set((-f.pitch * Math.PI) / 180, ((f.yaw - 90) * Math.PI) / 180, 0);
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
      this.bomb.position.set(f.bomb.pos.x, f.bomb.pos.z + 3, -f.bomb.pos.y);
      (this.bomb.material as MeshBasicMaterial).color.setHex(f.bomb.planted && Math.floor(f.nowMs / 400) % 2 === 0 ? 0xff6a5a : 0xb0221c);
    }
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.drawnTriangles = this.renderer.info.render.triangles;
    if (this.vmCamera.fov !== f.viewmodelFovDeg) {
      this.vmCamera.fov = f.viewmodelFovDeg;
      this.vmCamera.updateProjectionMatrix();
    }
    const vm = f.viewmodel;
    this.viewmodels.update(vm === null ? null : (vm.anim ?? { weapon: vm.weapon, sinceShot: vm.sinceShot, cycle: 0.1, reload: null, deploy: null, swing: null, plant: null, primed: false, thrown: null, speed: 0, time: 0 }), vm?.team ?? 'CT');
    if (vm !== null && this.viewmodels.root.visible) {
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
      if (p.weapon !== undefined) this.worldWeapons.update(p.id, v.group, p.weapon, p.alive, p.crouching, p.pitch);
      v.group.position.set(p.pos.x, p.pos.z, -p.pos.y);
      // Group yaw: local −z (the visor's forward) along the Source yaw.
      v.group.rotation.set(0, ((p.yaw - 90) * Math.PI) / 180, 0);
      if (p.alive) {
        const k = p.crouching ? 54 / 72 : 1;
        v.body.scale.set(1, k, 1);
        v.body.rotation.set(0, 0, 0);
        v.body.position.set(0, 0, 0);
        v.bodyMat.color.setHex(TEAM_COLOR[p.team]);
        if (p.human) v.bodyMat.color.lerp(this.humanTint.setHex(0xffffff), 0.25);
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
    const P = this.tracerPos;
    const C = this.tracerCol;
    for (let i = 0; i < n; i++) {
      const t = ts[i] as DrawTracer;
      const o = i * 6;
      P[o] = t.from.x;
      P[o + 1] = t.from.z;
      P[o + 2] = -t.from.y;
      P[o + 3] = t.to.x;
      P[o + 4] = t.to.z;
      P[o + 5] = -t.to.y;
      const k = 1 - t.age;
      const c = t.team === 'T' ? TRACER_T : TRACER_CT;
      for (let q = 0; q < 3; q++) C[o + q] = C[o + 3 + q] = (TRACER_SKY[q] as number) + ((c[q] as number) - (TRACER_SKY[q] as number)) * k;
    }
    // Upload only when something is (or was) drawn: an idle frame touches no buffers.
    if (n === 0 && this.tracersDrawn === 0) return;
    this.tracersDrawn = n;
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
    // One pass, no per-frame arrays: count by phase, grow the pools, place.
    let ns = 0;
    let nf = 0;
    let nn = 0;
    for (const e of effects) {
      if (e.phase === 'smoke') ns++;
      else if (e.phase === 'fire') nf++;
      else if (e.phase === 'flying') nn++;
    }
    this.pool(this.smokes, () => new Mesh(new SphereGeometry(1, 16, 10), new MeshBasicMaterial({ color: 0xc9cfd4, transparent: true, opacity: 0.93 })), ns);
    this.pool(this.fires, () => new Mesh(new CylinderGeometry(1, 1, 6, 20), new MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85 })), nf);
    this.pool(this.nades, () => new Mesh(new SphereGeometry(3, 8, 6), new MeshBasicMaterial({ color: 0x3a4a2a })), nn);
    let is = 0;
    let fi = 0;
    let ni = 0;
    for (const e of effects) {
      if (e.phase === 'smoke') {
        const m = this.smokes[is++] as Mesh;
        m.position.set(e.pos.x, e.pos.z + e.radius * 0.45, -e.pos.y);
        m.scale.set(e.radius, e.radius * 0.75, e.radius);
      } else if (e.phase === 'fire') {
        const i = fi++;
        const m = this.fires[i] as Mesh;
        m.position.set(e.pos.x, e.pos.z + 3, -e.pos.y);
        const flicker = 1 + 0.06 * Math.sin(nowMs / 60 + i);
        m.scale.set(e.radius * flicker, 1 + 2 * Math.abs(Math.sin(nowMs / 90 + i)), e.radius * flicker);
      } else if (e.phase === 'flying') {
        (this.nades[ni++] as Mesh).position.set(e.pos.x, e.pos.z, -e.pos.y);
      }
    }
  }
}
