/**
 * H3: what the LIVE AI and the hosts ask of a map's nav (docs/ai.md "Map knowledge"). Two implementations:
 *
 * - the Mirage 2020 nav grid (`NavMesh`, docs/nav.md) through `legacyMapNav` (src/sim2d/ai.ts): bomb sites and spawns
 *   from its place names ("Bombsite A/B", "T Spawn", "CT Spawn"), exactly what the AI always did there (the recorded
 *   round's scenarios and golden digests depend on it);
 * - CS2's own nav of any map (`Cs2Nav`, src/engine/nav/cs2-nav.ts, structurally), with the map package's facts.
 */
import type { Team, Vec3 } from '../contracts/index';
import type { NavPoint } from './nav';

export interface MapNav {
  isWalkable(p: NavPoint): boolean;
  zAt(p: NavPoint): number;
  /** `p` if walkable, else its projection onto the nearest area (with that floor's z). */
  snap(p: NavPoint): Vec3;
  /** Walking route (first point = the start, last = the goal), or null. */
  path(a: NavPoint, b: NavPoint): Vec3[] | null;
  segmentWalkable(a: NavPoint, b: NavPoint): boolean;
  /** Standing in a bomb site (a T with the c4 may plant). */
  inBombsite(p: Vec3): boolean;
  /** The plant spot of the bomb site nearest to `p`, or null without sites. */
  bombsitePoint(p: NavPoint): Vec3 | null;
  /** Where a team spawns (the centre), or null. */
  spawnCentre(team: Team): Vec3 | null;
  /** The nearest way out of the bomb's blast (docs/ai.md), or null. */
  escapeSpot(from: Vec3, bomb: Vec3, clear: number): Vec3 | null;
  /** 2D sight and floors (Sight's fallback without a mask, grenade throws). */
  lineOfSight(a: NavPoint, b: NavPoint): boolean;
  floorsAt(x: number, y: number): number[];
  /** CS2 nav: a path point that is the landing of a jump link (the AI jumps toward it). Absent: never. */
  isJumpPoint?(p: NavPoint): boolean;
  /** CS2 nav: the area at `p` needs a crouch. Absent: never. */
  isCrouchAt?(p: NavPoint): boolean;
}
