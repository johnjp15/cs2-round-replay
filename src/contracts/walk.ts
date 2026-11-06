/**
 * WalkQuery: the one map question the Core asks the engine. The puppet controller
 * (src/core/puppet.ts) needs to know whether a straight line is walkable so it can
 * steer around corners instead of into walls. The Core cannot import an engine, so
 * the engine passes an implementation to ReplayCore's constructor:
 *
 * - 2D sim: `NavWalkQuery` (src/sim2d/walk-query.ts) over `NavMesh.segmentWalkable`.
 * - CS2: a nav-mesh raycast or a player-hull trace (docs/port-notes.md "WalkQuery").
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
}
