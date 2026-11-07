/**
 * A1: a tiny part builder for the low-poly weapon models: boxes, cylinders and wedges in Source units, merged per
 * animated group (body, mag, bolt, ...) into one BufferGeometry each, with a fixed key light baked into the vertex
 * colours (the app's materials are unlit, like the world's). No Valve assets: every model is these primitives.
 *
 * Model space: x right, y up, −z forward (the barrel), origin at the top of the pistol grip (where the right hand
 * holds it), units = Source units (inches).
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';

export type Shape = 'box' | 'cyl' | 'cylx' | 'cylz' | 'sphere' | 'taper';

/**
 * One part: shape, colour, size (box: w, h, l; cyl: radius, length, segments), centre, rotation (radians, XYZ).
 * `cyl` runs along y, `cylx` along x, `cylz` along z. W2 `taper`: a box (w, h, l) whose front face (−z) is
 * `frontW` × `frontH` and shifted `frontY` up: size [w, h, l, frontH, frontW = w, frontY = 0] (a blade's point, 12
 * triangles).
 */
export interface Part {
  readonly s: Shape;
  readonly c: number;
  readonly size: readonly number[];
  readonly at: readonly [number, number, number];
  readonly rot?: readonly [number, number, number];
}

/** Key light (view space): from the upper left, a little in front. */
const LIGHT = new Vector3(-0.45, 0.8, 0.4).normalize();

function primitive(p: Part): BufferGeometry {
  const z = p.size;
  switch (p.s) {
    case 'box':
      return new BoxGeometry(z[0], z[1], z[2]);
    case 'cyl':
      return new CylinderGeometry(z[0], z[3] ?? z[0], z[1], Math.round(z[2] ?? 8));
    case 'cylx':
      return new CylinderGeometry(z[0], z[3] ?? z[0], z[1], Math.round(z[2] ?? 8)).rotateZ(Math.PI / 2);
    case 'cylz':
      return new CylinderGeometry(z[0], z[3] ?? z[0], z[1], Math.round(z[2] ?? 8)).rotateX(Math.PI / 2);
    case 'taper': {
      const g = new BoxGeometry(z[0], z[1], z[2]);
      const w = z[0] as number;
      const h = z[1] as number;
      const fh = (z[3] ?? h) / h;
      const fw = (z[4] ?? w) / w;
      const fy = z[5] ?? 0;
      const a = g.getAttribute('position') as BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        if (a.getZ(i) >= 0) continue;
        a.setX(i, a.getX(i) * fw);
        a.setY(i, a.getY(i) * fh + fy);
      }
      return g;
    }
    case 'sphere': {
      const g = new CylinderGeometry(z[0] as number, z[0] as number, (z[0] as number) * 1.6, 8);
      return g;
    }
  }
}

/** Merge parts into one non-indexed geometry with baked-shade vertex colours. */
export function mergeParts(parts: readonly Part[]): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const n = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const p of parts) {
    const g0 = primitive(p);
    const g = g0.index !== null ? g0.toNonIndexed() : g0;
    const r = p.rot ?? [0, 0, 0];
    e.set(r[0], r[1], r[2]);
    q.setFromEuler(e);
    m.compose(new Vector3(p.at[0], p.at[1], p.at[2]), q, new Vector3(1, 1, 1));
    g.applyMatrix4(m);
    const arr = (g.getAttribute('position') as BufferAttribute).array as Float32Array;
    const cr = ((p.c >> 16) & 255) / 255;
    const cg = ((p.c >> 8) & 255) / 255;
    const cb = (p.c & 255) / 255;
    for (let i = 0; i < arr.length; i += 9) {
      a.set(arr[i] as number, arr[i + 1] as number, arr[i + 2] as number);
      b.set(arr[i + 3] as number, arr[i + 4] as number, arr[i + 5] as number);
      c.set(arr[i + 6] as number, arr[i + 7] as number, arr[i + 8] as number);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      // Wrap lighting: ambient 0.55, diffuse 0.55 (two-sided so inverted windings stay lit).
      const k = 0.55 + 0.55 * Math.abs(n.dot(LIGHT)) * (n.dot(LIGHT) >= 0 ? 1 : 0.55);
      for (let v = 0; v < 3; v++) {
        pos.push(arr[i + v * 3] as number, arr[i + v * 3 + 1] as number, arr[i + v * 3 + 2] as number);
        col.push(Math.min(1, cr * k), Math.min(1, cg * k), Math.min(1, cb * k));
      }
    }
    g.dispose();
    if (g !== g0) g0.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  if (pos.length > 0) out.computeBoundingSphere();
  return out;
}

/** Triangles in a geometry (tests, docs). */
export function triangles(g: BufferGeometry): number {
  return (g.getAttribute('position') as BufferAttribute).count / 3;
}
