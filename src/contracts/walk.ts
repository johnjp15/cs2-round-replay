/**
 * WalkQuery: the map questions the Core asks the engine. The puppet controller
 * (src/core/puppet.ts) needs to know whether a straight line is walkable so it can
 * steer around corners instead of into walls, and the rejoin planner (G1,
 * src/core/rejoin.ts) how far a LIVE pawn has to walk to get back to its track. The
 * Core cannot import an engine, so the engine passes an implementation to
 * ReplayCore's constructor:
 *
 * - 2D sim: `NavWalkQuery` (src/sim2d/walk-query.ts) over `NavMesh.segmentWalkable` and `NavMesh.path`.
 * - CS2: a nav-mesh raycast or a player-hull trace, and a nav-mesh path (docs/port-notes.md "WalkQuery").
 *
 * Must be a pure function of its arguments (deterministic, no side effects): the Core
 * branches on it, and a replay of a session log must take the same branches.
 */
import type { Vec3 } from './types';

export interface WalkQuery {
  /**
   * True if a pawn standing at `a` can walk in a straight line to `b`: every point of
   * the segment is in walkable space. Height is the engine's business (the 2D sim
   * ignores z; CS2 should reject lines that need a jump or cross a level).
   */
  isWalkableLine(a: Vec3, b: Vec3): boolean;
  /**
   * G1: the length (units, 2D, rounded to 6 decimals) of the walking route the engine's nav would take from `a` to
   * `b`, or null when there is none. Only the rejoin planner asks it (a LIVE pawn heading back to its recording), so
   * a run nobody leaves the tape in never calls it.
   */
  pathLength(a: Vec3, b: Vec3): number | null;
}
