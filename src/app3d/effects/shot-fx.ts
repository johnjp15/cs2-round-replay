/**
 * W3: bullet tracers and impacts in the 3D view (docs/app3d.md "Tracers and impacts"). Three draw calls in all, each
 * an instanced quad with a small shader; the instance buffers are rewritten only while something is alive.
 *
 * - **Tracers** (CS2: `CCSPlayer::CreateWeaponTracer`): only the bullets the host marks (`Shot3.tracer`: 1 in the
 *   weapon's TracerFrequency, weapons.vdata `m_nTracerFrequency`: AK-47 1 in 3). A thin glowing streak ~2 pixels
 *   wide (constant in screen space), a white-hot core in a warm glow, bright at its head and fading to its tail, that flies from the muzzle to the
 *   impact in 1–3 frames (`TRACER_SPEED`, at least `TRACER_MIN_TRAVEL_MS`) and is gone `TRACER_FADE_MS` after it
 *   arrives. The shooter's own tracers in first person (the human, or the player watched through his eyes) start at
 *   the viewmodel's muzzle (CS2 uses the viewmodel's muzzle attachment for the local player and for the in-eye
 *   observer) re-projected into the world camera, so the streak runs from the gun toward the crosshair; everyone
 *   else's start at the muzzle of the weapon in their hands.
 * - **Impacts** (from the host's shot results: the mesh hit point and surface normal, entry and exit of every wall
 *   a bullet went through, the hitbox it hit): on walls a small dark bullet hole along the surface (≤ `MAX_DECALS`,
 *   the oldest reused first; it fades out from `DECAL_FADE_START_MS` to `DECAL_LIFE_MS`), a dust puff pushed out
 *   along the normal and a spark flash; on players a brief blood puff (no decal).
 *
 * Time is the round's (render tick × 15.625 ms): effects freeze with a paused round and replay identically in the
 * test API's exact frames; anything born after "now" (a rewind) is dropped.
 */
import {
  CustomBlending,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { PlayerId, Vec3 } from '../../contracts/index';

/** One bullet as the renderer needs it (from Sim3DHost.shots(), in Source coordinates). */
export interface ShotFx {
  readonly shooter: PlayerId;
  /** The tick the shot was fired on. */
  readonly tick: number;
  /** Where the tracer starts when not in first person: the muzzle of the shooter's world weapon. */
  readonly muzzle: Vec3;
  /** Where the bullet ended (the last impact, else the end of its range). */
  readonly to: Vec3;
  readonly tracer: boolean;
  readonly impacts: readonly { readonly kind: 'wall' | 'exit' | 'flesh'; readonly pos: Vec3; readonly normal: Vec3 }[];
}

export const MAX_TRACERS = 48;
export const MAX_DECALS = 128;
export const MAX_PUFFS = 96;
/** Tracer head speed (units/s): ~1,000 u in 40 ms, 1–3 frames at 60 Hz (CS2's tracer particles look about this fast; assumed). */
export const TRACER_SPEED = 25_000;
export const TRACER_MIN_TRAVEL_MS = 16;
/** The streak's length: this fraction of the flight, at least TRACER_MIN_STREAK units, at most TRACER_MAX_STREAK. */
const TRACER_STREAK_FRACTION = 0.3;
const TRACER_MIN_STREAK = 60;
const TRACER_MAX_STREAK = 360;
/** After the head arrives the tail catches up and the streak fades out over this (ms). */
export const TRACER_FADE_MS = 70;
/** Core width in pixels at 720 lines (scaled with the drawing buffer's height). */
const TRACER_WIDTH_PX = 2.4;
const TRACER_COLOR = [1, 0.62, 0.22] as const;
/** First-person tracer start: this far in front of the eye along the ray through the viewmodel's muzzle (units). */
const FP_MUZZLE_DEPTH = 26;
/**
 * Bullet holes: radius (units; the hole is the inner 40 %, the rest a scorch ring), scaled up with distance as CS2's
 * r_decals_distance_scale (1.35 at 1,536 u); lifetime (ms): CS2 fades decals from r_decals_default_start_fade 30 s
 * over _fade_duration 3 s, shortened here to 18 + 2 s to keep ≤ 128 live.
 */
const DECAL_RADIUS = 2.6;
export const DECAL_FADE_START_MS = 18_000;
export const DECAL_LIFE_MS = 20_000;
/** Puffs: dust on walls, a spark flash, blood on players. */
const DUST_MS = 380;
const SPARK_MS = 70;
const BLOOD_MS = 260;

const TICK_MS = 1000 / 64;

interface Tracer {
  shooter: PlayerId;
  bornMs: number;
  a: Vec3;
  b: Vec3;
}

const TRACER_VS = /* glsl */ `
attribute vec2 corner;
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iT;
uniform vec2 uHalfRes;
uniform float uWidth;
uniform float uNear;
varying vec2 vC;
varying float vAlpha;
void main() {
  // iT.xy: tail and head as fractions of the streak's path ON SCREEN (perspective-corrected into the world here), so a
  // first-person tracer sweeps evenly from the muzzle to the crosshair instead of leaving the gun in one frame.
  vec4 vA = modelViewMatrix * vec4(iA, 1.0);
  vec4 vB = modelViewMatrix * vec4(iB, 1.0);
  float dA = max(-vA.z, uNear);
  float dB = max(-vB.z, uNear);
  float fT = iT.x * dA / ((1.0 - iT.x) * dB + iT.x * dA);
  float fH = iT.y * dA / ((1.0 - iT.y) * dB + iT.y * dA);
  vec4 v0 = mix(vA, vB, fT);
  vec4 v1 = mix(vA, vB, fH);
  float nz = -uNear * 1.02;
  vAlpha = iT.z;
  vC = corner;
  if (v0.z > nz && v1.z > nz) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (v0.z > nz) v0 = mix(v0, v1, (v0.z - nz) / (v0.z - v1.z));
  if (v1.z > nz) v1 = mix(v1, v0, (v1.z - nz) / (v1.z - v0.z));
  vec4 c0 = projectionMatrix * v0;
  vec4 c1 = projectionMatrix * v1;
  vec2 s0 = c0.xy / c0.w * uHalfRes;
  vec2 s1 = c1.xy / c1.w * uHalfRes;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 c = corner.x < 0.5 ? c0 : c1;
  vec2 off = n * corner.y * uWidth + dir * (corner.x * 2.0 - 1.0) * uWidth;
  c.xy += off / uHalfRes * c.w;
  gl_Position = c;
}`;

const TRACER_FS = /* glsl */ `
uniform vec3 uColor;
varying vec2 vC;
varying float vAlpha;
void main() {
  float y = abs(vC.y);
  float glow = pow(max(0.0, 1.0 - y), 1.5);
  float core = 1.0 - smoothstep(0.0, 0.5, y);
  float along = clamp(vC.x, 0.0, 1.0);
  float k = (0.1 + 0.9 * along * along) * glow * vAlpha;
  // A white-hot core in a warm glow, hotter at the head. Premultiplied, mostly over (so it reads on Mirage's bright
  // sand, where a purely additive streak washes out), a little additive.
  vec3 col = mix(uColor, vec3(1.0, 0.97, 0.9), core * (0.5 + 0.5 * along));
  gl_FragColor = vec4(col * k, k * 0.9);
}`;

const DECAL_VS = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iNormal;
attribute vec2 iAge;
varying vec2 vC;
varying float vAlpha;
varying float vSeed;
void main() {
  vec3 n = normalize(iNormal);
  vec3 t = normalize(abs(n.y) < 0.95 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  // CS2 r_decals_distance_scale 1.35 from r_decals_distance_scale_start 256 to _end 1536 u from the viewer.
  float r = iAge.y * (1.0 + 0.35 * clamp((distance(cameraPosition, iPos) - 256.0) / 1280.0, 0.0, 1.0));
  vec3 p = iPos + n * 0.2 + (t * corner.x + b * corner.y) * r;
  vC = corner;
  vAlpha = iAge.x;
  vSeed = fract(dot(iPos, vec3(0.13, 0.71, 0.37)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const DECAL_FS = /* glsl */ `
varying vec2 vC;
varying float vAlpha;
varying float vSeed;
void main() {
  float r = length(vC);
  if (r > 1.0) discard;
  float ang = atan(vC.y, vC.x);
  float ragged = 0.82 + 0.18 * sin(ang * 5.0 + vSeed * 40.0);
  float hole = 1.0 - smoothstep(0.32, 0.42, r);
  float scorch = (1.0 - smoothstep(0.45 * ragged, 1.0 * ragged, r)) * 0.55;
  float a = max(hole * 0.92, scorch) * vAlpha;
  vec3 col = mix(vec3(0.16, 0.14, 0.12), vec3(0.03, 0.03, 0.03), hole);
  gl_FragColor = vec4(col * a, a);
}`;

const PUFF_VS = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec2 iSize;
varying vec2 vC;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += corner * iSize.x;
  vC = corner;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}`;

/** Premultiplied: rgb × a for the blended puffs; alpha 0 makes a spark purely additive. */
const PUFF_FS = /* glsl */ `
varying vec2 vC;
varying vec4 vColor;
void main() {
  float r = length(vC);
  if (r > 1.0) discard;
  float f = (1.0 - r * r);
  f = f * f;
  gl_FragColor = vec4(vColor.rgb * f, vColor.a * f);
}`;

function quad(): { corner: Float32BufferAttribute; index: number[] } {
  return { corner: new Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2), index: [0, 1, 2, 0, 2, 3] };
}

function centredQuad(): { corner: Float32BufferAttribute; index: number[] } {
  return { corner: new Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2), index: [0, 1, 2, 0, 2, 3] };
}

function instanced(base: { corner: Float32BufferAttribute; index: number[] }, attrs: Record<string, [number, number]>, max: number): { geom: InstancedBufferGeometry; arrays: Record<string, Float32Array> } {
  const geom = new InstancedBufferGeometry();
  geom.setAttribute('corner', base.corner);
  geom.setIndex(base.index);
  const arrays: Record<string, Float32Array> = {};
  for (const [name, [size]] of Object.entries(attrs)) {
    const a = new Float32Array(max * size);
    const attr = new InstancedBufferAttribute(a, size);
    attr.setUsage(DynamicDrawUsage);
    geom.setAttribute(name, attr);
    arrays[name] = a;
  }
  geom.instanceCount = 0;
  return { geom, arrays };
}

function touch(geom: InstancedBufferGeometry, names: readonly string[], n: number): void {
  geom.instanceCount = n;
  for (const name of names) (geom.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true;
}

/** Source (x, y, z) → Three (x, z, −y) into `out` at `o`. */
function put3(out: Float32Array, o: number, v: Vec3): void {
  out[o] = v.x;
  out[o + 1] = v.z;
  out[o + 2] = -v.y;
}

interface Decal {
  pos: Vec3;
  normal: Vec3;
  bornMs: number;
}

interface Puff {
  kind: 'dust' | 'spark' | 'blood';
  pos: Vec3;
  normal: Vec3;
  bornMs: number;
}

export interface ShotFxFrame {
  /** Round time now (ms): render tick × 15.625. */
  readonly nowMs: number;
  /** Whose viewmodel is on screen (first person: the human or the player watched in-eye), or null. */
  readonly fpShooter: PlayerId | null;
  /** The viewmodel muzzle in the viewmodel camera's space, or null (no viewmodel / scoped). */
  readonly vmMuzzle: Vector3 | null;
  readonly vmCamera: PerspectiveCamera;
  readonly camera: PerspectiveCamera;
  /** Drawing buffer size (px). */
  readonly bufferW: number;
  readonly bufferH: number;
}

export class ShotEffects {
  private readonly tracers: Tracer[] = [];
  private readonly decals: Decal[] = [];
  private decalNext = 0;
  /** A decal was added or removed since the last upload (the decal buffer is otherwise only rewritten while one fades). */
  private decalsDirty = true;
  private readonly puffs: Puff[] = [];
  private puffNext = 0;
  private readonly tracer: { geom: InstancedBufferGeometry; arrays: Record<string, Float32Array>; mat: ShaderMaterial };
  private readonly decal: { geom: InstancedBufferGeometry; arrays: Record<string, Float32Array> };
  private readonly puff: { geom: InstancedBufferGeometry; arrays: Record<string, Float32Array> };
  /** The three meshes (tracers, decals, puffs): hidden while empty, so an idle frame draws nothing for them. */
  private readonly meshes: { t: Mesh; d: Mesh; p: Mesh };
  private readonly fpStart = new Vector3();
  private readonly tmp = new Vector3();
  private readonly halfRes = new Vector2(640, 360);
  private drawn = { t: -1, d: -1, p: -1 };
  /** Tracers / decals / puffs drawn in the last frame (tests, stats). */
  readonly stats = { tracers: 0, decals: 0, puffs: 0, fpMuzzle: false };

  constructor(scene: Scene) {
    const t = instanced(quad(), { iA: [3, 0], iB: [3, 0], iT: [4, 0] }, MAX_TRACERS);
    const tmat = new ShaderMaterial({
      vertexShader: TRACER_VS,
      fragmentShader: TRACER_FS,
      uniforms: { uHalfRes: { value: this.halfRes }, uWidth: { value: TRACER_WIDTH_PX }, uNear: { value: 4 }, uColor: { value: new Vector3(...TRACER_COLOR) } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.tracer = { ...t, mat: tmat };
    const tm = new Mesh(t.geom, tmat);
    tm.frustumCulled = false;
    tm.renderOrder = 6;
    const d = instanced(centredQuad(), { iPos: [3, 0], iNormal: [3, 0], iAge: [2, 0] }, MAX_DECALS);
    this.decal = d;
    const dm = new Mesh(
      d.geom,
      new ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_FS,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    dm.frustumCulled = false;
    dm.renderOrder = 4;
    const p = instanced(centredQuad(), { iPos: [3, 0], iColor: [4, 0], iSize: [2, 0] }, MAX_PUFFS);
    this.puff = p;
    const pm = new Mesh(
      p.geom,
      new ShaderMaterial({
        vertexShader: PUFF_VS,
        fragmentShader: PUFF_FS,
        transparent: true,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    pm.frustumCulled = false;
    pm.renderOrder = 5;
    tm.visible = dm.visible = pm.visible = false;
    this.meshes = { t: tm, d: dm, p: pm };
    scene.add(dm, pm, tm);
  }

  /** A bullet the host fired (call once per shot, in tick order). */
  add(s: ShotFx): void {
    const bornMs = s.tick * TICK_MS;
    if (s.tracer) {
      if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
      this.tracers.push({ shooter: s.shooter, bornMs, a: s.muzzle, b: s.to });
    }
    for (const im of s.impacts) {
      if (im.kind === 'flesh') this.addPuff('blood', im.pos, im.normal, bornMs);
      else {
        this.addDecal(im.pos, im.normal, bornMs);
        this.addPuff('dust', im.pos, im.normal, bornMs);
        if (im.kind === 'wall') this.addPuff('spark', im.pos, im.normal, bornMs);
      }
    }
  }

  /** The round time (ms) of `shooter`'s newest tracer still kept, or −Infinity (tests: catch one in flight). */
  newestTracerMs(shooter: PlayerId): number {
    let t = -Infinity;
    for (const x of this.tracers) if (x.shooter === shooter && x.bornMs > t) t = x.bornMs;
    return t;
  }

  /** Forget everything (seek, restart). */
  clear(): void {
    this.tracers.length = 0;
    this.decals.length = 0;
    this.decalNext = 0;
    this.decalsDirty = true;
    this.puffs.length = 0;
    this.puffNext = 0;
  }

  private addDecal(pos: Vec3, normal: Vec3, bornMs: number): void {
    this.decalsDirty = true;
    const d = { pos, normal, bornMs };
    if (this.decals.length < MAX_DECALS) this.decals.push(d);
    else {
      this.decals[this.decalNext] = d;
      this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    }
  }

  private addPuff(kind: Puff['kind'], pos: Vec3, normal: Vec3, bornMs: number): void {
    const p = { kind, pos, normal, bornMs };
    if (this.puffs.length < MAX_PUFFS) this.puffs.push(p);
    else {
      this.puffs[this.puffNext] = p;
      this.puffNext = (this.puffNext + 1) % MAX_PUFFS;
    }
  }

  /** Before the world is rendered: fill the instance buffers for this frame. */
  update(f: ShotFxFrame): void {
    const now = f.nowMs;
    this.halfRes.set(f.bufferW / 2, f.bufferH / 2);
    (this.tracer.mat.uniforms['uWidth'] as { value: number }).value = Math.max(1.1, (TRACER_WIDTH_PX * f.bufferH) / 720);
    (this.tracer.mat.uniforms['uNear'] as { value: number }).value = f.camera.near;
    this.updateTracers(f, now);
    this.updateDecals(now);
    this.updatePuffs(now);
    this.meshes.t.visible = this.stats.tracers > 0;
    this.meshes.d.visible = this.stats.decals > 0;
    this.meshes.p.visible = this.stats.puffs > 0;
  }

  /** The first-person tracer start: the world point FP_MUZZLE_DEPTH in front of the eye on the ray through the viewmodel's muzzle on screen. */
  private fpMuzzle(f: ShotFxFrame): Vec3 | null {
    if (f.vmMuzzle === null) return null;
    const ndc = this.tmp.copy(f.vmMuzzle).applyMatrix4(f.vmCamera.projectionMatrix);
    f.camera.updateMatrixWorld();
    const p = this.fpStart.set(ndc.x, ndc.y, 0.5).unproject(f.camera).sub(f.camera.position).normalize().multiplyScalar(FP_MUZZLE_DEPTH).add(f.camera.position);
    // Three → Source.
    return { x: p.x, y: -p.z, z: p.y };
  }

  private updateTracers(f: ShotFxFrame, now: number): void {
    const ts = this.tracers;
    // Drop the finished and anything from the future (a rewind).
    let w = 0;
    for (const t of ts) {
      const age = now - t.bornMs;
      const len = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y, t.b.z - t.a.z);
      const travel = Math.max(TRACER_MIN_TRAVEL_MS, (len / TRACER_SPEED) * 1000);
      if (age < -TICK_MS || age > travel + TRACER_FADE_MS) continue;
      ts[w++] = t;
    }
    ts.length = w;
    const fp = f.fpShooter === null ? null : this.fpMuzzle(f);
    this.stats.fpMuzzle = fp !== null;
    const A = this.tracer.arrays['iA'] as Float32Array;
    const B = this.tracer.arrays['iB'] as Float32Array;
    const T = this.tracer.arrays['iT'] as Float32Array;
    let n = 0;
    for (const t of ts) {
      const a = fp !== null && t.shooter === f.fpShooter ? fp : t.a;
      const len = Math.hypot(t.b.x - a.x, t.b.y - a.y, t.b.z - a.z);
      if (len < 1) continue;
      const travel = Math.max(TRACER_MIN_TRAVEL_MS, (len / TRACER_SPEED) * 1000);
      const age = Math.max(0, now - t.bornMs);
      const streak = Math.min(1, Math.max(TRACER_MIN_STREAK, Math.min(TRACER_MAX_STREAK, len * TRACER_STREAK_FRACTION)) / len);
      // The head flies from the muzzle; it starts a streak's length out (CS2's tracer is already a streak on its first frame).
      const head = Math.min(1, streak + (age / travel) * (1 - streak));
      // After it arrives the tail catches up with the head as it fades.
      const catchUp = Math.min(1, Math.max(0, age - travel) / TRACER_FADE_MS);
      const tail = Math.max(0, head - streak * (1 - catchUp));
      const alpha = age <= travel ? 1 : Math.max(0, 1 - (age - travel) / TRACER_FADE_MS);
      if (alpha <= 0 || head <= tail) continue;
      put3(A, n * 3, a);
      put3(B, n * 3, t.b);
      T[n * 4] = tail;
      T[n * 4 + 1] = head;
      T[n * 4 + 2] = alpha;
      T[n * 4 + 3] = 0;
      n++;
    }
    this.stats.tracers = n;
    if (n === 0 && this.drawn.t === 0) return;
    this.drawn.t = n;
    touch(this.tracer.geom, ['iA', 'iB', 'iT'], n);
  }

  private updateDecals(now: number): void {
    const P = this.decal.arrays['iPos'] as Float32Array;
    const N = this.decal.arrays['iNormal'] as Float32Array;
    const G = this.decal.arrays['iAge'] as Float32Array;
    let n = 0;
    let fading = false;
    for (const d of this.decals) {
      const age = now - d.bornMs;
      if (age < -TICK_MS || age > DECAL_LIFE_MS) continue;
      if (age > DECAL_FADE_START_MS) fading = true;
      put3(P, n * 3, d.pos);
      put3(N, n * 3, d.normal);
      G[n * 2] = age <= DECAL_FADE_START_MS ? 1 : 1 - (age - DECAL_FADE_START_MS) / (DECAL_LIFE_MS - DECAL_FADE_START_MS);
      G[n * 2 + 1] = DECAL_RADIUS;
      n++;
    }
    this.stats.decals = n;
    // Decals only change when one is added, fades or expires: upload then, not every frame.
    if (!this.decalsDirty && !fading && n === this.drawn.d) return;
    this.decalsDirty = false;
    this.drawn.d = n;
    touch(this.decal.geom, ['iPos', 'iNormal', 'iAge'], n);
  }

  private updatePuffs(now: number): void {
    const P = this.puff.arrays['iPos'] as Float32Array;
    const C = this.puff.arrays['iColor'] as Float32Array;
    const S = this.puff.arrays['iSize'] as Float32Array;
    let n = 0;
    for (const p of this.puffs) {
      const age = now - p.bornMs;
      const life = p.kind === 'dust' ? DUST_MS : p.kind === 'spark' ? SPARK_MS : BLOOD_MS;
      if (age < -TICK_MS || age > life) continue;
      const k = Math.max(0, age) / life;
      const fade = 1 - k;
      let size: number;
      let push: number;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (p.kind === 'dust') {
        size = 3 + 11 * Math.sqrt(k);
        push = 2 + 18 * Math.sqrt(k);
        a = 0.55 * fade * fade;
        r = 0.62 * a;
        g = 0.56 * a;
        b = 0.47 * a;
      } else if (p.kind === 'spark') {
        size = 2.4 * (1 - k * 0.5);
        push = 1;
        const e = fade * 1.4;
        r = 1 * e;
        g = 0.8 * e;
        b = 0.45 * e;
        a = 0;
      } else {
        size = 4 + 8 * Math.sqrt(k);
        push = 1 + 6 * k;
        a = 0.75 * fade;
        r = 0.45 * a;
        g = 0.03 * a;
        b = 0.03 * a;
      }
      const pos = { x: p.pos.x + p.normal.x * push, y: p.pos.y + p.normal.y * push, z: p.pos.z + p.normal.z * push - (p.kind === 'blood' ? 6 * k * k : 0) };
      put3(P, n * 3, pos);
      C[n * 4] = r;
      C[n * 4 + 1] = g;
      C[n * 4 + 2] = b;
      C[n * 4 + 3] = a;
      S[n * 2] = size;
      S[n * 2 + 1] = 0;
      n++;
    }
    this.stats.puffs = n;
    if (n === 0 && this.drawn.p === 0) return;
    this.drawn.p = n;
    touch(this.puff.geom, ['iPos', 'iColor', 'iSize'], n);
  }
}

/**
 * The muzzle of a player's world weapon (Source): the right hand (7 u right of and 10 u ahead of the body, 44 u up
 * standing, 33 crouched: the world-weapon placement of src/app3d/viewmodels/rig.ts) plus 28 u along the shot.
 */
export function worldMuzzle(eye: Vec3, to: Vec3, yawDeg: number, crouching: boolean): Vec3 {
  const y = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(y);
  const fy = Math.sin(y);
  const rx = Math.sin(y);
  const ry = -Math.cos(y);
  const drop = crouching ? 13 : 20;
  const hx = eye.x + rx * 7 + fx * 10;
  const hy = eye.y + ry * 7 + fy * 10;
  const hz = eye.z - drop;
  const dx = to.x - hx;
  const dy = to.y - hy;
  const dz = to.z - hz;
  const l = Math.hypot(dx, dy, dz);
  if (l < 40) return { x: hx, y: hy, z: hz };
  return { x: hx + (dx / l) * 28, y: hy + (dy / l) * 28, z: hz + (dz / l) * 28 };
}
