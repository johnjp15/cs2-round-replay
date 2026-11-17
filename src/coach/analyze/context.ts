/**
 * Contract 3 of the demo coach (docs/coach-plan.md): the analysis context every derived table, metric and detector
 * reads. One context per analysis; derived tables are built once, on first use, and memoized by id.
 *
 * - `raw`, `match`: the demo and its ingest (`src/coach/model`).
 * - `tuning`: data/coach/tuning.json (ingest's). Each area has its own file under data/coach/tuning/ with a loader in
 *   the area's folder; detectors import those directly.
 * - `weapons`: CS2's weapon table (data/weapons.json through `src/engine/weapons/table.ts`); `weapon(item)` maps a
 *   coach item name (`ak47`, `m4a1_silencer`, `galilar`) to its `WeaponDef` by class name.
 * - `weaponModel`: the engine's weapon-model constants (data/tuning.json `weapons._engine`: the 34 % movement
 *   threshold, the recoil scale, …).
 * - `los`: line of sight on the map pack's sight mesh, or null when no pack is loaded. Tables and detectors that need
 *   it say so (`Detector.needs`) and fall back or skip when it is null.
 */
import { parseTuning, type WeaponModelTuning } from '../../contracts/index';
import { parseWeaponTable, type WeaponDef, type WeaponTable } from '../../engine/weapons/table';
import weaponsJson from '../../../data/weapons.json';
import engineTuningJson from '../../../data/tuning.json';
import type { LosWorld } from '../derive/los';
import type { Match, TeamId } from '../model/match';
import type { RawDemo } from '../model/raw';
import { COACH_TUNING, type CoachTuning } from '../tuning';

/** A derived table: built from the context once, on first use. `id` must be unique (convention: `<area>.<name>`). */
export interface TableDef<T> {
  readonly id: string;
  build(ctx: AnalysisContext): T;
}

export interface AnalysisContext {
  readonly raw: RawDemo;
  readonly match: Match;
  readonly tuning: CoachTuning;
  readonly weapons: WeaponTable;
  readonly weaponModel: WeaponModelTuning;
  readonly los: LosWorld | null;
  /** Player count (`raw.players.length`). */
  readonly P: number;
  /** The table, built on first use (memoized by `def.id`). */
  table<T>(def: TableDef<T>): T;
  /** The weapon definition of a coach item name, or null (knife, grenades, c4 and unknown names have none or no gun). */
  weapon(item: string): WeaponDef | null;
  /** The team of a slot (`Match.players`). */
  teamOf(slot: number): TeamId | null;
}

let sharedWeapons: WeaponTable | null = null;
let sharedModel: WeaponModelTuning | null = null;

/** The committed weapon table (parsed once per process). */
export function defaultWeaponTable(): WeaponTable {
  if (sharedWeapons === null) sharedWeapons = parseWeaponTable(weaponsJson);
  return sharedWeapons;
}

/** The committed weapon-model constants. */
export function defaultWeaponModel(): WeaponModelTuning {
  if (sharedModel === null) {
    const m = parseTuning(engineTuningJson).weaponModel;
    if (m === undefined) throw new Error('data/tuning.json: weapons._engine missing');
    sharedModel = m;
  }
  return sharedModel;
}

export interface ContextOptions {
  los?: LosWorld | null;
  tuning?: CoachTuning;
  weapons?: WeaponTable;
  weaponModel?: WeaponModelTuning;
}

class Context implements AnalysisContext {
  readonly raw: RawDemo;
  readonly match: Match;
  readonly tuning: CoachTuning;
  readonly weapons: WeaponTable;
  readonly weaponModel: WeaponModelTuning;
  readonly los: LosWorld | null;
  readonly P: number;
  private readonly tables = new Map<string, unknown>();
  private readonly building = new Set<string>();
  private readonly byClass = new Map<string, WeaponDef>();

  constructor(raw: RawDemo, match: Match, o: ContextOptions) {
    this.raw = raw;
    this.match = match;
    this.tuning = o.tuning ?? COACH_TUNING;
    this.weapons = o.weapons ?? defaultWeaponTable();
    this.weaponModel = o.weaponModel ?? defaultWeaponModel();
    this.los = o.los ?? null;
    this.P = raw.players.length;
    for (const id of this.weapons.ids) {
      const w = this.weapons.weapons[id] as WeaponDef;
      this.byClass.set(w.className, w);
    }
  }

  table<T>(def: TableDef<T>): T {
    if (this.tables.has(def.id)) return this.tables.get(def.id) as T;
    if (this.building.has(def.id)) throw new Error(`analysis: table ${def.id} depends on itself`);
    this.building.add(def.id);
    const v = def.build(this);
    this.building.delete(def.id);
    this.tables.set(def.id, v);
    return v;
  }

  weapon(item: string): WeaponDef | null {
    if (item === '') return null;
    return this.byClass.get(`weapon_${item}`) ?? null;
  }

  teamOf(slot: number): TeamId | null {
    return this.match.players[slot]?.team ?? null;
  }
}

export function createContext(raw: RawDemo, match: Match, o: ContextOptions = {}): AnalysisContext {
  return new Context(raw, match, o);
}
