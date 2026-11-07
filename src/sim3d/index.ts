/** Sim3D (H1): the 3D engine/host (IHost); may import src/contracts, src/engine and src/sim2d. docs/sim3d.md. */
import type { Tuning } from '../contracts/index';
import { MapGeometry, decodeGeometry, type NavMesh, type RosterEntry, type Sim2DOptions, type Sim2DVision } from '../sim2d/index';
import { Sim3DHost } from './host';

export { Sim3DHost } from './host';
export type { Sim3DWorld } from './host';
export { traceShot3, eyeOf } from './hitscan';
export type { Shot3, ShotPawn } from './hitscan';

/** What the Session's host factory passes (src/app/session.ts `HostParts`, structurally). */
export interface Sim3DHostParts {
  readonly nav: NavMesh;
  readonly tuning: Tuning;
  readonly roster: readonly RosterEntry[];
  readonly options: Sim2DOptions;
  readonly vision: Sim2DVision;
  readonly geometry: MapGeometry | null;
}

/** The world mesh alone (data/geometry/mirage-geometry.bin, no player clips): what sight and bullets trace. */
export function worldMesh(geometryBin: Uint8Array): MapGeometry {
  return new MapGeometry(decodeGeometry(geometryBin));
}

/**
 * A Session host factory for the 3D engine: the Session's movement mesh (world + clips, `SessionData.geometry`) for
 * movement and `world` (worldMesh) for sight and bullets. Throws without a movement mesh (the 3D host is 3D only).
 */
export function sim3dHostFactory(world: MapGeometry): (p: Sim3DHostParts) => Sim3DHost {
  return (p) => {
    if (p.geometry === null) throw new Error('Sim3DHost: needs the movement mesh (parseSessionData with the 3D world)');
    return new Sim3DHost(p.nav, p.tuning, p.roster, p.options, p.vision, { movement: p.geometry, world });
  };
}
