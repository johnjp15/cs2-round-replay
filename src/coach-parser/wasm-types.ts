/**
 * What the WebAssembly module (`crates/coach-parser/src/wasm.rs`) returns from `Session.parse`: the dense tick
 * grid already in `RawTicks` shape (with demo spellings of weapon names), and every game event as a column table.
 * `convert.ts` turns it into a `RawDemo`. Keep this file in step with wasm.rs.
 */
import type { RawTicks } from '../coach/model/raw';

export interface WasmEventColumn {
  name: string;
  /** num: numbers and booleans (NaN = absent) · str: strings and 64-bit ids (null = absent) · slot: a player slot (-1). */
  kind: 'num' | 'str' | 'slot';
  data: Float64Array | Int16Array | (string | null)[];
}

export interface WasmEventTable {
  /** The game event name, e.g. `player_death`. */
  name: string;
  tick: Int32Array;
  /** Position of each row in the demo's event order. */
  seq: Uint32Array;
  columns: WasmEventColumn[];
}

export interface WasmRaw {
  /** `dem`, `bz2`, `zst` or `gz`. */
  container: string;
  /** SHA-256 of the file as given, lowercase hex. */
  sha256: string;
  fileBytes: number;
  demoBytes: number;
  /** The demo header (map_name, server_name, client_name, patch_version, …). */
  header: Record<string, string>;
  players: { steamid: string; name: string; bot: boolean }[];
  /** Name tables, index 0 = ''; weapons in the demo's display spelling (`AK-47`). */
  weapons: string[];
  places: string[];
  ticks: RawTicks & { players: number };
  events: WasmEventTable[];
  /** `kind` is the entity class (`CSmokeGrenadeProjectile`, …). */
  projectiles: { kind: string; thrower: number; entity: number; t0: number; t1: number; path: Int16Array }[];
  /** at: 0 freeze_end, 1 death, 2 round_end; items in the demo's spelling, unsorted. */
  inventories: { tick: number; p: number; at: number; items: string[] }[];
  scoreTick: number;
  /** v: kills, deaths, assists, damage, headshot kills, enemies flashed, utility damage, MVPs, score. */
  scoreboard: { p: number; v: Float64Array }[];
}
