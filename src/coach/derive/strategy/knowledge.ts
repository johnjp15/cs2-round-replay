/**
 * K8: map knowledge (`data/coach/knowledge/<map>.json`, `coach-knowledge@1`; docs/coach/strategy.md "Knowledge
 * files"). A typed loader and validator, the committed maps, and the place → zone lookup the strategy tables use.
 *
 * Rules the validator enforces: every place name belongs to exactly one zone; zone, site and lane ids are unique;
 * every lane place is a place of some zone; a lane's and a zone's `site` is a listed site; a site's zones exist;
 * `defends` names listed sites. Unknown place names (seen in a demo, absent from the file) are never guessed: the
 * lookup returns null and the tables count them as unclassified.
 */
import mirageJson from '../../../../data/coach/knowledge/de_mirage.json';
import dust2Json from '../../../../data/coach/knowledge/de_dust2.json';

export const KNOWLEDGE_FORMAT = 'coach-knowledge@1';

export type SiteId = 'A' | 'B';
/** What a zone is used for in setup labels: a site's side of the map, mid, or a spawn. */
export type ZoneGroup = 'A' | 'B' | 'mid' | 'T' | 'CT';
export type ZoneKind = 'site' | 'lane' | 'connector' | 'mid' | 'spawn';

export interface KnowledgeZone {
  id: string;
  name: string;
  kind: ZoneKind;
  group: ZoneGroup;
  /** The bomb site this zone is part of (site area), if any. */
  site: SiteId | null;
  /** Sites a CT standing here also defends (Mirage's CT spawn sits behind A). */
  defends: SiteId[];
  places: string[];
}

export interface KnowledgeSite {
  id: SiteId;
  name: string;
  /** The zones that make up the site area (where a T "is on the site"). */
  zones: string[];
}

export interface KnowledgeLane {
  id: string;
  name: string;
  /** Places the lane covers (a T in one of them is in the lane). */
  places: string[];
  /** The site the lane leads to (null: it leads to both, like Dust II mid). */
  site: SiteId | null;
  /** Which side normally fights for the lane early in the round. */
  earlyFight: 'T' | 'CT' | 'both';
  /** One or two short sentences each, quoted by the advice text. */
  counters: string[];
}

export interface KnowledgeCheck {
  demoSha256: string;
  places: number;
  unknown: number;
  /** The demo's bomb-site entity id (the plant event's `site`) → site, from where the plants happened. */
  siteIds: Record<string, SiteId>;
}

export interface MapKnowledge {
  format: typeof KNOWLEDGE_FORMAT;
  map: string;
  verified: boolean;
  checkedAgainst: KnowledgeCheck[];
  zones: KnowledgeZone[];
  sites: KnowledgeSite[];
  lanes: KnowledgeLane[];
}

const SITES: readonly string[] = ['A', 'B'];
const GROUPS: readonly string[] = ['A', 'B', 'mid', 'T', 'CT'];
const KINDS: readonly string[] = ['site', 'lane', 'connector', 'mid', 'spawn'];
const EARLY: readonly string[] = ['T', 'CT', 'both'];

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`knowledge: ${what} must be an object`);
  return v as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') throw new Error(`knowledge: ${what}.${k} must be a non-empty string`);
  return v;
}
function strs(o: Record<string, unknown>, k: string, what: string, optional = false): string[] {
  const v = o[k];
  if (v === undefined && optional) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw new Error(`knowledge: ${what}.${k} must be a list of strings`);
  return [...(v as string[])];
}
function oneOf<T extends string>(v: unknown, allowed: readonly string[], what: string): T {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error(`knowledge: ${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}
function arr(o: Record<string, unknown>, k: string, what: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new Error(`knowledge: ${what}.${k} must be a list`);
  return v;
}

/** Parse and check a knowledge file (throws with the first problem found). `_`-prefixed keys are notes. */
export function loadKnowledge(json: unknown): MapKnowledge {
  const o = obj(json, 'file');
  if (o.format !== KNOWLEDGE_FORMAT) throw new Error(`knowledge: format must be ${KNOWLEDGE_FORMAT}`);
  const map = str(o, 'map', 'file');
  if (typeof o.verified !== 'boolean') throw new Error(`knowledge ${map}: verified must be true or false`);
  const checkedAgainst = arr(o, 'checkedAgainst', map).map((c, k): KnowledgeCheck => {
    const co = obj(c, `${map}.checkedAgainst[${k}]`);
    const ids = obj(co.siteIds ?? {}, `${map}.checkedAgainst[${k}].siteIds`);
    const siteIds: Record<string, SiteId> = {};
    for (const key of Object.keys(ids).sort()) siteIds[key] = oneOf<SiteId>(ids[key], SITES, `${map} siteIds.${key}`);
    return { demoSha256: str(co, 'demoSha256', map), places: Number(co.places ?? 0), unknown: Number(co.unknown ?? 0), siteIds };
  });
  if (o.verified === true && checkedAgainst.length === 0) throw new Error(`knowledge ${map}: verified needs at least one checkedAgainst demo`);
  const zoneIds = new Set<string>();
  const placeZone = new Map<string, string>();
  const zones = arr(o, 'zones', map).map((z, k): KnowledgeZone => {
    const zo = obj(z, `${map}.zones[${k}]`);
    const id = str(zo, 'id', `${map}.zones[${k}]`);
    if (zoneIds.has(id)) throw new Error(`knowledge ${map}: zone ${id} defined twice`);
    zoneIds.add(id);
    const places = strs(zo, 'places', `${map}.zones.${id}`);
    if (places.length === 0) throw new Error(`knowledge ${map}: zone ${id} has no places`);
    for (const p of places) {
      const prev = placeZone.get(p);
      if (prev !== undefined) throw new Error(`knowledge ${map}: place ${p} is in zones ${prev} and ${id}`);
      placeZone.set(p, id);
    }
    return {
      id, name: str(zo, 'name', `${map}.zones.${id}`), kind: oneOf<ZoneKind>(zo.kind, KINDS, `${map}.zones.${id}.kind`),
      group: oneOf<ZoneGroup>(zo.group, GROUPS, `${map}.zones.${id}.group`),
      site: zo.site === undefined || zo.site === null ? null : oneOf<SiteId>(zo.site, SITES, `${map}.zones.${id}.site`),
      defends: strs(zo, 'defends', `${map}.zones.${id}`, true).map((s) => oneOf<SiteId>(s, SITES, `${map}.zones.${id}.defends`)),
      places,
    };
  });
  const sites = arr(o, 'sites', map).map((s, k): KnowledgeSite => {
    const so = obj(s, `${map}.sites[${k}]`);
    const id = oneOf<SiteId>(so.id, SITES, `${map}.sites[${k}].id`);
    const zs = strs(so, 'zones', `${map}.sites.${id}`);
    for (const z of zs) if (!zoneIds.has(z)) throw new Error(`knowledge ${map}: site ${id} names unknown zone ${z}`);
    return { id, name: str(so, 'name', `${map}.sites.${id}`), zones: zs };
  });
  const siteIds = new Set(sites.map((s) => s.id));
  if (siteIds.size !== sites.length) throw new Error(`knowledge ${map}: a site is defined twice`);
  for (const z of zones) {
    if (z.site !== null && !siteIds.has(z.site)) throw new Error(`knowledge ${map}: zone ${z.id} names unlisted site ${z.site}`);
    for (const d of z.defends) if (!siteIds.has(d)) throw new Error(`knowledge ${map}: zone ${z.id} defends unlisted site ${d}`);
  }
  const laneIds = new Set<string>();
  const lanes = arr(o, 'lanes', map).map((l, k): KnowledgeLane => {
    const lo = obj(l, `${map}.lanes[${k}]`);
    const id = str(lo, 'id', `${map}.lanes[${k}]`);
    if (laneIds.has(id)) throw new Error(`knowledge ${map}: lane ${id} defined twice`);
    laneIds.add(id);
    const places = strs(lo, 'places', `${map}.lanes.${id}`);
    if (places.length === 0) throw new Error(`knowledge ${map}: lane ${id} has no places`);
    for (const p of places) if (!placeZone.has(p)) throw new Error(`knowledge ${map}: lane ${id} place ${p} is in no zone`);
    const site = lo.site === null || lo.site === undefined ? null : oneOf<SiteId>(lo.site, SITES, `${map}.lanes.${id}.site`);
    if (site !== null && !siteIds.has(site)) throw new Error(`knowledge ${map}: lane ${id} leads to unlisted site ${site}`);
    const counters = strs(lo, 'counters', `${map}.lanes.${id}`);
    if (counters.length === 0) throw new Error(`knowledge ${map}: lane ${id} has no counters`);
    return { id, name: str(lo, 'name', `${map}.lanes.${id}`), places, site, earlyFight: oneOf<'T' | 'CT' | 'both'>(lo.earlyFight, EARLY, `${map}.lanes.${id}.earlyFight`), counters };
  });
  // A place in two lanes would make "first T in the lane" ambiguous.
  const lanePlace = new Map<string, string>();
  for (const l of lanes) for (const p of l.places) {
    const prev = lanePlace.get(p);
    if (prev !== undefined) throw new Error(`knowledge ${map}: place ${p} is in lanes ${prev} and ${l.id}`);
    lanePlace.set(p, l.id);
  }
  return { format: KNOWLEDGE_FORMAT, map, verified: o.verified, checkedAgainst, zones, sites, lanes };
}

/** The committed knowledge files, by map name. */
export const KNOWLEDGE: Readonly<Record<string, MapKnowledge>> = {
  de_dust2: loadKnowledge(dust2Json),
  de_mirage: loadKnowledge(mirageJson),
};

export function knowledgeFor(map: string): MapKnowledge | null {
  return KNOWLEDGE[map] ?? null;
}

/**
 * Lookups over one map's knowledge for one demo's place-name table (`RawDemo.names.places`): place id → zone
 * index (−1: the empty name; −2: a name the file does not know, i.e. unclassified) and → lane index (−1: none).
 */
export class PlaceLookup {
  readonly k: MapKnowledge;
  readonly zoneOfPlace: Int16Array;
  readonly laneOfPlace: Int16Array;
  /** Place names of the demo the file does not classify (sorted). */
  readonly unknown: string[];
  private readonly zoneIndex = new Map<string, number>();

  constructor(k: MapKnowledge, places: readonly string[]) {
    this.k = k;
    k.zones.forEach((z, i) => this.zoneIndex.set(z.id, i));
    const zoneByPlace = new Map<string, number>();
    k.zones.forEach((z, i) => { for (const p of z.places) zoneByPlace.set(p, i); });
    const laneByPlace = new Map<string, number>();
    k.lanes.forEach((l, i) => { for (const p of l.places) laneByPlace.set(p, i); });
    this.zoneOfPlace = new Int16Array(places.length);
    this.laneOfPlace = new Int16Array(places.length);
    const unknown: string[] = [];
    places.forEach((name, id) => {
      if (name === '') { this.zoneOfPlace[id] = -1; this.laneOfPlace[id] = -1; return; }
      const z = zoneByPlace.get(name);
      if (z === undefined) unknown.push(name);
      this.zoneOfPlace[id] = z ?? -2;
      this.laneOfPlace[id] = laneByPlace.get(name) ?? -1;
    });
    this.unknown = unknown.sort();
  }

  zone(i: number): KnowledgeZone | null {
    return this.k.zones[i] ?? null;
  }

  zoneById(id: string): number {
    return this.zoneIndex.get(id) ?? -1;
  }

  /** The site whose area contains zone `z` (null when none). */
  siteOfZone(z: number): SiteId | null {
    const zone = this.k.zones[z];
    if (zone === undefined) return null;
    for (const s of this.k.sites) if (s.zones.includes(zone.id)) return s.id;
    return null;
  }

  /** A CT in zone `z` defends site `s`: the zone is on that side (group), in its area, or lists it in `defends`. */
  defends(z: number, s: SiteId): boolean {
    const zone = this.k.zones[z];
    if (zone === undefined) return false;
    return zone.group === s || zone.site === s || zone.defends.includes(s);
  }
}

/** Every place name the file knows, sorted. */
export function knownPlaces(k: MapKnowledge): string[] {
  return k.zones.flatMap((z) => z.places).sort();
}

/**
 * A place-name report for one demo against the file: names the demo uses that the file lacks (`unknown`), and names
 * the file lists that the demo never used (`unused`).
 */
export function checkPlaces(k: MapKnowledge, demoPlaces: readonly string[]): { unknown: string[]; unused: string[]; classified: number } {
  const known = new Set(knownPlaces(k));
  const seen = new Set(demoPlaces.filter((p) => p !== ''));
  const unknown = [...seen].filter((p) => !known.has(p)).sort();
  const unused = [...known].filter((p) => !seen.has(p)).sort();
  return { unknown, unused, classified: seen.size - unknown.length };
}
