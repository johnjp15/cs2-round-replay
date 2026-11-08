// Extracts data/round.json and data/mirage-radar.jpg from the web-apps replay page.
//
//   npx tsx tools/extract-round.ts <web-apps>/cs2/mirage-round-replay/index.html [shots.csv] [--out <dir>]
//
// The shots CSV defaults to <dir of index.html>/source/shots/mirage-round-sp4rtan-1v3-shots.csv.
// A copy of the CSV is written to <out>/source/ so tests can check against it without web-apps.
// Output is deterministic: same inputs give byte-identical files. See docs/round-data.md.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLAYER_IDS,
  toTick,
  type Bomb,
  type Chat,
  type Confidence,
  type Damage,
  type GrenadeId,
  type GrenadeLanding,
  type Kill,
  type Kit,
  type LastKnown,
  type Player,
  type PlayerId,
  type PovSegment,
  type Radio,
  type RoundData,
  type RoundEvent,
  type Shot,
  type ShotKind,
  type Sighting,
  type ViewSample,
  type ViewSource,
  type Team,
  type TimelinePoint,
  type Track,
  type TrackSample,
  type Utility,
  type Vec3,
  type WeaponId,
  type WeaponTimelinePoint,
  type YawSample,
} from '../src/contracts/index';

/**
 * V0: grenade landings measured from the recording (the page has none), keyed "<t> <thrower> <kind>"; a recorded throw
 * whose landing the video never shows gets null. Sources and frames: docs/round-data.md "Grenade landings".
 */
const MEASURED_LANDINGS: Readonly<Record<string, GrenadeLanding>> = {
  // cart's B-site smoke (S1, backlog 45, re-measured): thrown from the B side through the Market window, it comes to
  // rest deep inside Shop, beside the white freezer counter ~320 u south of the window, and blooms there (first puff
  // 28.1 s). The point is where cart's trajectory-line end (his POV 29.5 and 30.0 s) and the freezer (44.5 s) meet on
  // the CS2 mesh from V2's fitted cameras: three rays cross within 2 u at (-1882...-1901, -581...-585, -129). The window
  // stays clear (cart climbs in through it at 28.2-28.5 s with no cloud in it). docs/round-data.md "Grenade landings".
  '25.8 cart smoke': { x: -1890, y: -585, z: -166, uncertainty: 40 },
};

/**
 * V4 (second video review, docs/parity/review-2-2026-11-07.md): HUD facts the page's data has wrong, read off the
 * recording's own HUD frame by frame. Weapon draws the page times late, keyed by the page's point: the draw moves to
 * the video's first frame of the new weapon.
 */
const WEAPON_DRAWS: readonly { readonly id: PlayerId; readonly pageT: number; readonly t: number; readonly weapon: WeaponId; readonly why: string }[] = [
  // cart's knife -> AK-47 (V3 finding 7, backlog 60): his ammo HUD shows 24/90 from the frame at 61.40 s (the knife,
  // with no counter, until 61.35 s) and the AK's draw animation plays at 61.4-61.6 s; the page has 63.5 s.
  { id: 'cart', pageT: 63.5, t: 61.4, weapon: 'ak47', why: 'ammo HUD 24/90 from 61.40 s (V4)' },
];

/**
 * V4: armor a recorded hit took, keyed "<t> <attacker> <victim>" like the page's damage list, where the shots CSV has
 * no armor figure. donk's HUD through sp4rtan's spray (60 fps): armor 100 -> 96 at 49.90 s (27 HP: a chest hit at
 * ~525 u, CS2/CS:GO armor rule (damage - damage x 0.775) / 2 = 4) -> 91 at 50.00 s (34 HP: the stomach, 5) -> 91 at
 * 50.10 s (26 HP: a leg, which armor doesn't cover, 0).
 */
const HIT_ARMOR: Readonly<Record<string, number>> = {
  '49.9 sp4rtan donk': 4,
  '50 sp4rtan donk': 5,
  '50.1 sp4rtan donk': 0,
};

// ---------- source shapes (the web-apps page's embedded JSON) ----------

type Arr3 = [number, number, number];

interface SrcPlayer {
  id: string;
  name: string;
  team: Team;
  color?: string;
  chev: string;
  weapon: string;
  hp?: number;
  money?: number;
  note: string;
  death: number | null;
}

interface SrcData {
  meta: {
    video: string;
    duration: number;
    clock0: number;
    plant: number;
    defuse: number;
    bombTime: number;
    roundEnd: number;
    map: { posx: number; posy: number; scale: number; size: number };
    score: { ct: [number, number]; t: [number, number] };
    teams: { CT: string; T: string };
    hudRound: string;
  };
  players: SrcPlayer[];
  tracks: Record<string, number[][]>;
  yaw: [number, string, number][];
  pov: [number, number, string, string][];
  hp: Record<string, [number, number][]>;
  money: Record<string, [number, number][]>;
  weapons: Record<string, [number, string][]>;
  kills: {
    t: number;
    killer: string;
    victim: string;
    weapon: string;
    hs: boolean;
    assist: string | null;
    postround?: boolean;
    kpos: Arr3;
    vpos: Arr3;
    kplace: string;
    vplace: string;
  }[];
  damage: { t: number; attacker: string; victim: string; amount: number; weapon: string; note: string; apos: Arr3; vpos: Arr3 }[];
  util: { t: number; who: string; kind: string; radio: string; place: string; pos: Arr3 }[];
  lastknown: { who: string; t0: number; t1: number; pos: [number, number] }[];
  sightings: { who: string; t0: number; t1: number; place: string; by: string }[];
  events: { t: number; kind: string; text: string; who?: string; victim?: string; util?: string }[];
  bomb: { carrier: string; plantT: number; pos: Arr3; defuseStart: number; defuseT: number };
}

interface WeaponStats {
  clip: number;
  reserve: number;
}

// ---------- hand-entered facts (project doc: cs2-bot-movement-options.md) ----------

interface KitSpec {
  primary: WeaponId | null;
  secondary: WeaponId | null;
  grenades: GrenadeId[];
  c4: boolean;
  kit: boolean;
  assumed: boolean;
  hp: number;
  armor: number;
  helmet: boolean;
  roles: string[];
  pickups: { t: number; weapon: WeaponId }[];
}

function spec(p: Partial<KitSpec> & { roles: string[] }): KitSpec {
  return {
    primary: p.primary ?? null,
    secondary: p.secondary ?? null,
    grenades: p.grenades ?? [],
    c4: p.c4 ?? false,
    kit: p.kit ?? false,
    assumed: p.assumed ?? false,
    hp: p.hp ?? 100,
    armor: p.armor ?? 100,
    helmet: p.helmet ?? true,
    roles: p.roles,
    pickups: p.pickups ?? [],
  };
}

const KITS: Record<PlayerId, KitSpec> = {
  barely: spec({ primary: 'ak47', grenades: ['he', 'smoke'], c4: true, roles: ['take_b', 'planter'] }),
  cart: spec({ primary: 'ak47', grenades: ['smoke', 'smoke'], roles: ['take_b'] }),
  // donk's Glock is seen on his HUD at 49.93 s (shots CSV).
  donk: spec({ primary: 'awp', secondary: 'glock', grenades: ['flash', 'molotov'], roles: ['take_b'] }),
  // V4: eradicate starts on 89 armor (his own HUD reads 100 HP / 89 armor from 0.0 s to his death; a kept vest).
  eradicate: spec({ primary: 'ak47', armor: 89, roles: ['take_b'] }),
  incredibad: spec({ primary: 'm4a4', assumed: true, roles: ['hold_a'] }),
  lokier: spec({ primary: 'ssg08', roles: ['hold_b'] }),
  snakelore: spec({ primary: 'm4a4', assumed: true, roles: ['hold_a'] }),
  snarlbot: spec({ primary: 'ak47', grenades: ['smoke', 'flash'], hp: 44, roles: ['take_b'] }),
  sp4rtan: spec({ secondary: 'deagle', kit: true, roles: ['flank_then_retake'], pickups: [{ t: 19.6, weapon: 'ak47' }] }),
  zwomp: spec({ primary: 'm4a4', assumed: true, roles: ['rotate_b'] }),
};

/** CT colours are not in the source; use the CS2 teammate colour of the chevron colour the source gives. */
const CHEV_COLORS: Record<string, string> = {
  yellow: '#ffd83d',
  green: '#3ad27a',
  orange: '#ff9230',
  blue: '#4ea6ff',
  purple: '#b65ff2',
};

const HUMAN_DEFAULT: PlayerId = 'cart';

// ---------- normalisers ----------

function pid(raw: string): PlayerId {
  const id = raw.toLowerCase() as PlayerId;
  if (!PLAYER_IDS.includes(id)) throw new Error(`unknown player id: ${raw}`);
  return id;
}

function pidOrNull(raw: string | null | undefined): PlayerId | null {
  return raw === null || raw === undefined ? null : pid(raw);
}

const WEAPON_NAMES: Record<string, WeaponId> = {
  'AK-47': 'ak47',
  AWP: 'awp',
  'SSG 08': 'ssg08',
  'Desert Eagle': 'deagle',
  M4A4: 'm4a4',
  'Glock-18': 'glock',
  Knife: 'knife',
  C4: 'c4',
};

/** Maps a display weapon name ("AK-47 (picked up)", "AK-47 · C4") to an id; null for "—". */
function weaponOrNull(raw: string): WeaponId | null {
  const first = (raw.split(' · ')[0] ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (first === '—' || first === '' || first === '?') return null;
  const id = WEAPON_NAMES[first];
  if (id === undefined) throw new Error(`unknown weapon: ${raw}`);
  return id;
}

function weapon(raw: string, owner: PlayerId): WeaponId {
  const id = weaponOrNull(raw);
  if (id === null) throw new Error(`missing weapon: ${raw}`);
  // Lokier carried a scout. Guard against any "AWP" attributed to him.
  if (owner === 'lokier' && id === 'awp') return 'ssg08';
  return id;
}

const GRENADES: readonly GrenadeId[] = ['smoke', 'flash', 'he', 'molotov'];

function grenade(raw: string): GrenadeId {
  if (!(GRENADES as readonly string[]).includes(raw)) throw new Error(`unknown grenade: ${raw}`);
  return raw as GrenadeId;
}

function vec3(a: Arr3): Vec3 {
  return { x: a[0], y: a[1], z: a[2] };
}

const FLAG_CONFIDENCE: readonly Confidence[] = ['observed', 'estimated', 'inferred'];
const CONF_RANK: Record<Confidence, number> = { observed: 0, estimated: 1, inferred: 2 };

function flagConfidence(flag: number): Confidence {
  const c = FLAG_CONFIDENCE[flag];
  if (c === undefined) throw new Error(`unknown track flag: ${flag}`);
  return c;
}

/** Sorts ids/records by key so output never depends on source key order. */
function byId<T>(rec: Record<string, T>): [PlayerId, T][] {
  return Object.keys(rec)
    .map((k): [PlayerId, T] => [pid(k), rec[k] as T])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sortedRecord<T>(entries: [PlayerId, T][]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

// ---------- tracks ----------

function rowToSample(r: number[]): TrackSample {
  const [t, x, y, z, flag] = r as [number, number, number, number, number];
  const confidence = flagConfidence(flag);
  const s: TrackSample = { t, tick: toTick(t), x, y, z, confidence };
  const unc = r[5];
  return unc !== undefined && confidence !== 'observed' ? { ...s, uncertainty: unc } : s;
}

function onGrid(t: number): boolean {
  return Math.abs(t * 10 - Math.round(t * 10)) < 1e-6;
}

function buildTrack(rows: number[][], yaw: YawSample[]): Track {
  const src = rows.map(rowToSample);
  for (let i = 1; i < src.length; i++) {
    if ((src[i] as TrackSample).t <= (src[i - 1] as TrackSample).t) throw new Error('source track not increasing');
  }
  const last = src[src.length - 1] as TrackSample;
  const kMax = Math.floor(last.t * 10 + 1e-6);
  const samples: TrackSample[] = [];
  let j = 0; // index of the last source sample with t <= grid t
  for (let k = 0; k <= kMax; k++) {
    const t = k / 10;
    while (j + 1 < src.length && (src[j + 1] as TrackSample).t <= t + 1e-6) j++;
    const a = src[j] as TrackSample;
    if (Math.abs(a.t - t) < 1e-6) {
      samples.push({ ...a, t, tick: toTick(t) });
      continue;
    }
    const b = src[j + 1];
    if (b === undefined) throw new Error(`grid time ${t} past the track end`);
    const f = (t - a.t) / (b.t - a.t);
    const lerp = (p: number, q: number): number => Math.round(p + (q - p) * f);
    const worse = CONF_RANK[b.confidence] > CONF_RANK[a.confidence] ? b : a;
    const s: TrackSample = {
      t,
      tick: toTick(t),
      x: lerp(a.x, b.x),
      y: lerp(a.y, b.y),
      z: lerp(a.z, b.z),
      confidence: worse.confidence,
    };
    const unc = Math.max(a.uncertainty ?? -1, b.uncertainty ?? -1);
    samples.push(unc >= 0 && s.confidence !== 'observed' ? { ...s, uncertainty: unc, resampled: true } : { ...s, resampled: true });
  }
  return {
    samples,
    offGridSamples: src.filter((s) => !onGrid(s.t)),
    yaw,
    view: [],
    endT: last.t,
    endTick: last.tick,
  };
}

// ---------- shots CSV ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function shotKind(event: string): { kind: ShotKind; count: number } {
  const m = /^(\d+) shots? \(count only\)$/.exec(event);
  if (m) return { kind: 'shot_count', count: Number(m[1]) };
  if (event === 'kill') return { kind: 'kill', count: 0 };
  if (event === 'hit') return { kind: 'hit', count: 1 };
  if (event === 'switch') return { kind: 'switch', count: 0 };
  if (event.startsWith('shot → kill')) return { kind: 'shot_kill', count: 1 };
  if (event.startsWith('shot')) return { kind: 'shot', count: 1 };
  throw new Error(`unknown shot event: ${event}`);
}

function shotConfidence(raw: string): Confidence {
  if (raw.includes('inferred')) return 'inferred';
  if (raw.includes('time unknown')) return 'estimated';
  return 'observed';
}

/**
 * A switch row's note can name the switch back (donk, 49.93 s: "AWP quick-switch after his 49.85 shot;
 * back to AWP at 50.083"). Returns the weapon and time, or null when the note doesn't say.
 */
export function switchBack(note: string, owner: PlayerId): { t: number; weapon: WeaponId; name: string } | null {
  const m = /\bback to (.+?) at (\d+(?:\.\d+)?)\b/.exec(note);
  if (!m) return null;
  const name = (m[1] as string).trim();
  const t = Number(m[2]);
  if (!Number.isFinite(t)) throw new Error(`bad switch-back time in note: ${note}`);
  return { t, weapon: weapon(name, owner), name };
}

/**
 * The page's weapon timeline plus the weapon switches only the shots CSV knows: every `switch` row (raw
 * `"<CSV weapon> (shots CSV)"`) and the switch back named in its note (raw `"<weapon> (shots CSV note)"`).
 * Points are sorted by time; on a tie the page's point comes first. A CSV point that repeats the page's
 * (same tick and weapon) is not added.
 */
function weaponTimeline(id: PlayerId, rows: [number, string][], shots: readonly Shot[]): WeaponTimelinePoint[] {
  const page = rows.map(([pageT, raw]): WeaponTimelinePoint => {
    const w = weaponOrNull(raw);
    const fix = WEAPON_DRAWS.find((f) => f.id === id && f.pageT === pageT && f.weapon === w);
    const t = fix?.t ?? pageT;
    return { t, tick: toTick(t), weapon: id === 'lokier' && w === 'awp' ? 'ssg08' : w, raw: fix === undefined ? raw : `${raw} (${fix.why}; page ${pageT})` };
  });
  const extra: WeaponTimelinePoint[] = [];
  for (const s of shots) {
    if (s.kind !== 'switch' || s.shooter !== id || s.t === null) continue;
    extra.push({ t: s.t, tick: toTick(s.t), weapon: s.weapon, raw: `${s.raw['weapon'] ?? s.weapon} (shots CSV)` });
    const back = switchBack(s.raw['note'] ?? '', id);
    if (back !== null) extra.push({ t: back.t, tick: toTick(back.t), weapon: back.weapon, raw: `${back.name} (shots CSV note)` });
  }
  const out = [...page];
  for (const p of extra) if (!out.some((q) => q.tick === p.tick && q.weapon === p.weapon)) out.push(p);
  return out.map((p, i) => ({ p, i })).sort((a, b) => a.p.t - b.p.t || a.i - b.i).map((x) => x.p);
}

function buildShots(csv: string): Shot[] {
  const rows = parseCsv(csv);
  const header = rows[0];
  if (header === undefined) throw new Error('empty shots CSV');
  return rows.slice(1).map((cells): Shot => {
    if (cells.length !== header.length) throw new Error(`CSV row has ${cells.length} cells: ${cells.join(',')}`);
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = cells[i] as string));
    const col = (h: string): string => raw[h] ?? '';
    const shooter = pid(col('shooter'));
    const { kind, count } = shotKind(col('event'));
    const tCell = col('t_video_s');
    const range = /^([\d.]+)–([\d.]+)$/.exec(tCell);
    let t: number | null = null;
    let window: Shot['window'] = null;
    if (range) {
      const t0 = Number(range[1]);
      const t1 = Number(range[2]);
      window = { t0, tick0: toTick(t0), t1, tick1: toTick(t1) };
    } else {
      t = Number(tCell);
      if (!Number.isFinite(t)) throw new Error(`bad shot time: ${tCell}`);
    }
    const targetName = col('target').replace(/\s*\(.*\)\s*$/, '').trim();
    const target = targetName === '' || targetName === 'unknown' ? null : pid(targetName);
    const dmg = /^(\d+)(?: HP)?(?: \/ (\d+) armor)?$/.exec(col('damage'));
    return {
      t,
      tick: t === null ? null : toTick(t),
      window,
      count,
      shooter,
      weapon: weapon(col('weapon'), shooter),
      kind,
      target,
      damage: dmg ? Number(dmg[1]) : null,
      armorDamage: dmg && dmg[2] !== undefined ? Number(dmg[2]) : null,
      headshot: col('headshot') === 'yes',
      confidence: shotConfidence(col('confidence')),
      raw,
    };
  });
}

// ---------- events ----------

const RADIO_RE = /^(?:WMD\.|sk8ers)?(\S+) @ (.+?)( \(RADIO\))?: (.*)$/;
const CHAT_RE = /^(\*DEAD\* )?(?:WMD\.|sk8ers)(\S+): (.*)$/;

function buildRadioChat(src: SrcData): { radio: Radio[]; chat: Chat[] } {
  const radio: Radio[] = [];
  const chat: Chat[] = [];
  for (const e of src.events) {
    const r = RADIO_RE.exec(e.text);
    if (r && (e.kind === 'util' || e.kind === 'bomb' || e.kind === 'chat')) {
      radio.push({
        t: e.t,
        tick: toTick(e.t),
        who: pid(r[1] as string),
        place: r[2] as string,
        text: (r[4] as string).replace(/^"(.*)"$/, '$1'),
        kind: r[3] === undefined ? 'callout' : 'radio',
      });
      continue;
    }
    if (e.kind === 'chat') {
      const c = CHAT_RE.exec(e.text);
      if (!c) throw new Error(`unparsed chat: ${e.text}`);
      chat.push({ t: e.t, tick: toTick(e.t), who: pid(c[2] as string), dead: c[1] !== undefined, text: c[3] as string });
    }
  }
  return { radio, chat };
}

// ---------- build ----------

export interface ExtractInputs {
  html: string;
  csv: string;
  tuningWeapons: Record<string, WeaponStats>;
  htmlName: string;
  csvName: string;
  /** V2: the text of data/source/view-fit.json (tools/fit-view-angles.ts), or null to leave the views empty. */
  viewFit?: string | null;
}

/** V2: data/source/view-fit.json, written by tools/fit-view-angles.ts (docs/viewfit.md). */
export const VIEW_FIT_FORMAT = 'cs2-round-replay/view-fit@1';
export const VIEW_FIT_PATH = 'data/source/view-fit.json';

export interface ViewFitFile {
  readonly format: string;
  /** Per player, by time: the fitted (or radar fallback) view of every fitted frame. */
  readonly views: Record<string, readonly { t: number; yaw: number; pitch: number | null; source: ViewSource; confidence: Confidence }[]>;
  /** Track samples moved to where the video frames put the player. `from` must match the source sample. */
  readonly positions: readonly { player: string; t: number; from: Vec3; to: Vec3 }[];
}

/** Apply a view fit to the tracks (in place on fresh objects): views, and the refined positions. */
function applyViewFit(tracks: Record<PlayerId, Track>, fit: ViewFitFile): Record<PlayerId, Track> {
  if (fit.format !== VIEW_FIT_FORMAT) throw new Error(`view fit: format ${fit.format}, expected ${VIEW_FIT_FORMAT}`);
  const out = { ...tracks };
  for (const id of Object.keys(out) as PlayerId[]) {
    const tr = out[id];
    const views = fit.views[id] ?? [];
    const view: ViewSample[] = views.map((v) => ({ t: v.t, tick: toTick(v.t), yaw: v.yaw, pitch: v.pitch, source: v.source, confidence: v.confidence }));
    for (let i = 1; i < view.length; i++) if ((view[i] as ViewSample).t <= (view[i - 1] as ViewSample).t) throw new Error(`view fit: ${id} views not increasing`);
    const moves = fit.positions.filter((m) => m.player === id);
    const samples = moves.length === 0 ? tr.samples : tr.samples.map((s) => {
      const m = moves.find((q) => Math.abs(q.t - s.t) < 1e-6);
      if (m === undefined) return s;
      if (m.from.x !== s.x || m.from.y !== s.y || m.from.z !== s.z) {
        throw new Error(`view fit: ${id} at ${s.t}: from (${m.from.x}, ${m.from.y}, ${m.from.z}) is not the source sample (${s.x}, ${s.y}, ${s.z}); re-run tools/fit-view-angles.ts`);
      }
      return { ...s, x: m.to.x, y: m.to.y, z: m.to.z, refined: 'viewfit' as const };
    });
    for (const m of moves) {
      if (!tr.samples.some((s) => Math.abs(s.t - m.t) < 1e-6)) throw new Error(`view fit: ${id} has no grid sample at ${m.t}`);
    }
    out[id] = { samples, offGridSamples: tr.offGridSamples, yaw: tr.yaw, view, endT: tr.endT, endTick: tr.endTick };
  }
  return out;
}

export interface ExtractOutputs {
  round: RoundData;
  json: string;
  radar: Buffer;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function extractEmbedded(html: string): { data: SrcData; radar: Buffer } {
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no <script id="data"> block');
  const img = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(html);
  if (!img) throw new Error('no inline JPEG');
  return { data: JSON.parse(m[1] as string) as SrcData, radar: Buffer.from(img[1] as string, 'base64') };
}

export function buildRound(inp: ExtractInputs): ExtractOutputs {
  const { data: src, radar } = extractEmbedded(inp.html);
  const shots = buildShots(inp.csv);

  // yaw by player
  const yawBy = new Map<PlayerId, YawSample[]>();
  for (const [t, who, deg] of src.yaw) {
    const id = pid(who);
    const list = yawBy.get(id) ?? [];
    list.push({ t, tick: toTick(t), deg });
    yawBy.set(id, list);
  }
  for (const list of yawBy.values()) list.sort((a, b) => a.t - b.t);

  const builtTracks = sortedRecord(byId(src.tracks).map(([id, rows]): [PlayerId, Track] => [id, buildTrack(rows, yawBy.get(id) ?? [])]));
  const viewFit = inp.viewFit === undefined || inp.viewFit === null ? null : (JSON.parse(inp.viewFit) as ViewFitFile);
  const tracks = viewFit === null ? builtTracks : applyViewFit(builtTracks, viewFit);

  const players = src.players
    .map((p): Player => {
      const id = pid(p.id);
      const k = KITS[id];
      const track = tracks[id];
      if (track === undefined) throw new Error(`no track for ${id}`);
      const s0 = track.samples[0] as TrackSample;
      const y0 = track.yaw.find((y) => y.t === 0);
      const drawn = k.primary ?? k.secondary;
      const stats = drawn === null ? undefined : inp.tuningWeapons[drawn];
      const kit: Kit = {
        primary: k.primary,
        secondary: k.secondary,
        grenades: k.grenades,
        c4: k.c4,
        kit: k.kit,
        clip: stats?.clip ?? 0,
        reserve: stats?.reserve ?? 0,
        assumed: k.assumed,
      };
      if (p.hp !== undefined && p.hp !== k.hp) throw new Error(`${id}: source hp ${p.hp} != kit hp ${k.hp}`);
      return {
        id,
        name: p.name,
        team: p.team,
        color: p.color ?? CHEV_COLORS[p.chev] ?? '#ffffff',
        chev: p.chev,
        start: { pos: { x: s0.x, y: s0.y, z: s0.z }, yaw: y0 === undefined ? null : y0.deg, confidence: s0.confidence },
        startHp: k.hp,
        startArmor: k.armor,
        startHelmet: k.helmet,
        startMoney: p.money ?? null,
        kit,
        pickups: k.pickups.map((pk) => ({ t: pk.t, tick: toTick(pk.t), weapon: pk.weapon })),
        role: k.roles[0] as string,
        roles: k.roles,
        isHumanDefault: id === HUMAN_DEFAULT,
        deathT: p.death,
        deathTick: p.death === null ? null : toTick(p.death),
        note: p.note,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // V2: an event position of a player whose sample at that time was refined from the video (`refined: 'viewfit'`)
  // moves with it (x, y; z stays the page's), so events and tracks agree.
  const refinedAt = (id: PlayerId, t: number, p: Vec3): Vec3 => {
    const s = tracks[id]?.samples.find((q) => Math.abs(q.t - t) < 1e-6 && q.refined === 'viewfit');
    return s === undefined ? p : { x: s.x, y: s.y, z: p.z };
  };
  const kills = src.kills.map((k): Kill => {
    const killer = pid(k.killer);
    return {
      t: k.t,
      tick: toTick(k.t),
      killer,
      victim: pid(k.victim),
      weapon: weapon(k.weapon, killer),
      hs: k.hs,
      assist: pidOrNull(k.assist),
      postRound: k.postround === true,
      kpos: refinedAt(killer, k.t, vec3(k.kpos)),
      vpos: refinedAt(pid(k.victim), k.t, vec3(k.vpos)),
      kplace: k.kplace,
      vplace: k.vplace,
    };
  });

  // Damage: the page's damage list, plus CSV hits/kill shots with a damage figure it doesn't have.
  const damage: Damage[] = src.damage.map((d): Damage => {
    const attacker = pid(d.attacker);
    const victim = pid(d.victim);
    const csvRow = shots.find((s) => s.t !== null && Math.abs(s.t - d.t) < 1e-6 && s.shooter === attacker && s.target === victim);
    return {
      t: d.t,
      tick: toTick(d.t),
      attacker,
      victim,
      amount: d.amount,
      armor: csvRow?.armorDamage ?? HIT_ARMOR[`${d.t} ${attacker} ${victim}`] ?? null,
      weapon: weapon(d.weapon, attacker),
      note: d.note,
      apos: refinedAt(attacker, d.t, vec3(d.apos)),
      vpos: refinedAt(victim, d.t, vec3(d.vpos)),
      source: 'damage',
    };
  });
  for (const s of shots) {
    if (s.t === null || s.damage === null || s.target === null) continue;
    const st = s.t;
    if (damage.some((d) => Math.abs(d.t - st) < 1e-6 && d.attacker === s.shooter && d.victim === s.target)) continue;
    damage.push({
      t: st,
      tick: toTick(st),
      attacker: s.shooter,
      victim: s.target,
      amount: s.damage,
      armor: s.armorDamage,
      weapon: s.weapon,
      note: s.raw['note'] || s.raw['source'] || '',
      apos: null,
      vpos: null,
      source: 'shots_csv',
    });
  }
  damage.sort((a, b) => a.t - b.t);

  const utility = src.util.map(
    (u): Utility => ({
      t: u.t,
      tick: toTick(u.t),
      thrower: pid(u.who),
      kind: grenade(u.kind),
      place: u.place,
      throwPos: vec3(u.pos),
      landing: MEASURED_LANDINGS[`${u.t} ${pid(u.who)} ${grenade(u.kind)}`] ?? null,
      radio: u.radio,
    }),
  );

  const { radio, chat } = buildRadioChat(src);

  const sightings = src.sightings.map(
    (s): Sighting => ({ who: pid(s.who), t0: s.t0, tick0: toTick(s.t0), t1: s.t1, tick1: toTick(s.t1), place: s.place, by: s.by }),
  );
  const lastKnown = src.lastknown.map(
    (l): LastKnown => ({
      who: pid(l.who),
      t0: l.t0,
      tick0: toTick(l.t0),
      t1: l.t1,
      tick1: toTick(l.t1),
      pos: { x: l.pos[0], y: l.pos[1] },
    }),
  );
  const pov = src.pov.map(
    ([t0, t1, who, note]): PovSegment => ({ t0, tick0: toTick(t0), t1, tick1: toTick(t1), target: pid(who), note }),
  );

  const bomb: Bomb = {
    carrier: pid(src.bomb.carrier),
    plantT: src.bomb.plantT,
    plantTick: toTick(src.bomb.plantT),
    pos: vec3(src.bomb.pos),
    defuseStartT: src.bomb.defuseStart,
    defuseStartTick: toTick(src.bomb.defuseStart),
    defuseT: src.bomb.defuseT,
    defuseTick: toTick(src.bomb.defuseT),
  };

  const points = (rows: [number, number][]): TimelinePoint[] => rows.map(([t, value]) => ({ t, tick: toTick(t), value }));
  const timelines: RoundData['timelines'] = {
    hp: sortedRecord(byId(src.hp).map(([id, rows]): [PlayerId, TimelinePoint[]] => [id, points(rows)])),
    money: sortedRecord(byId(src.money).map(([id, rows]): [PlayerId, TimelinePoint[]] => [id, points(rows)])),
    weapon: sortedRecord(byId(src.weapons).map(([id, rows]): [PlayerId, WeaponTimelinePoint[]] => [id, weaponTimeline(id, rows, shots)])),
  };
  for (const f of WEAPON_DRAWS) {
    if (!(timelines.weapon[f.id] ?? []).some((p) => p.t === f.t && p.weapon === f.weapon)) throw new Error(`WEAPON_DRAWS: ${f.id} has no ${f.weapon} at ${f.pageT} s in the page`);
  }
  for (const k of Object.keys(HIT_ARMOR)) {
    if (!damage.some((d) => `${d.t} ${d.attacker} ${d.victim}` === k)) throw new Error(`HIT_ARMOR: no recorded hit "${k}"`);
  }

  const events = src.events.map(
    (e): RoundEvent => ({
      t: e.t,
      tick: toTick(e.t),
      kind: e.kind,
      text: e.text,
      who: pidOrNull(e.who),
      victim: pidOrNull(e.victim),
      util: e.util === undefined ? null : grenade(e.util),
    }),
  );

  const m = src.meta;
  const round: RoundData = {
    meta: {
      clock0: m.clock0,
      bombTimerSec: m.bombTime,
      score: { ct: m.score.ct[0], t: m.score.t[0] },
      scoreAfter: { ct: m.score.ct[1], t: m.score.t[1] },
      teams: { CT: m.teams.CT, T: m.teams.T },
      map: { posx: m.map.posx, posy: m.map.posy, scale: m.map.scale, size: m.map.size },
      video: m.video,
      durationSec: m.duration,
      roundEndT: m.roundEnd,
      roundEndTick: toTick(m.roundEnd),
      hudRound: m.hudRound,
      ticksPerSec: 64,
      sources: {
        html: { file: inp.htmlName, sha256: sha256(inp.html) },
        shotsCsv: { file: inp.csvName, sha256: sha256(inp.csv), rows: shots.length },
        ...(inp.viewFit === undefined || inp.viewFit === null ? {} : { viewFit: { file: VIEW_FIT_PATH, sha256: sha256(inp.viewFit) } }),
      },
    },
    players,
    tracks,
    shots,
    kills,
    damage,
    utility,
    radio,
    chat,
    sightings,
    lastKnown,
    pov,
    bomb,
    timelines,
    events,
  };
  return { round, json: JSON.stringify(round, null, 2) + '\n', radar };
}

// ---------- CLI ----------

function main(argv: string[]): void {
  const args = argv.slice(2);
  let outDir = 'data';
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outDir = args[++i] ?? outDir;
    else pos.push(args[i] as string);
  }
  const htmlPath = pos[0];
  if (htmlPath === undefined) {
    console.error('usage: npx tsx tools/extract-round.ts <mirage-round-replay/index.html> [shots.csv] [--out data]');
    process.exit(2);
  }
  const csvPath = pos[1] ?? join(dirname(htmlPath), 'source', 'shots', 'mirage-round-sp4rtan-1v3-shots.csv');
  const here = dirname(new URL(import.meta.url).pathname);
  const tuning = JSON.parse(readFileSync(join(here, '..', 'data', 'tuning.json'), 'utf8')) as {
    weapons: Record<string, WeaponStats>;
  };
  const html = readFileSync(htmlPath, 'utf8');
  const csv = readFileSync(csvPath, 'utf8');
  const viewFitPath = join(here, '..', VIEW_FIT_PATH);
  const out = buildRound({
    html,
    csv,
    viewFit: existsSync(viewFitPath) ? readFileSync(viewFitPath, 'utf8') : null,
    tuningWeapons: tuning.weapons,
    htmlName: 'web-apps/cs2/mirage-round-replay/index.html',
    csvName: `web-apps/cs2/mirage-round-replay/source/shots/${basename(csvPath)}`,
  });
  mkdirSync(join(outDir, 'source'), { recursive: true });
  writeFileSync(join(outDir, 'round.json'), out.json);
  writeFileSync(join(outDir, 'mirage-radar.jpg'), out.radar);
  writeFileSync(join(outDir, 'source', basename(csvPath)), csv);
  const r = out.round;
  console.log(
    `wrote ${join(outDir, 'round.json')} (${out.json.length} bytes; ${r.players.length} players, ` +
      `${Object.values(r.tracks).reduce((n, t) => n + t.samples.length, 0)} samples, ${r.shots.length} shots, ` +
      `${r.kills.length} kills) and ${join(outDir, 'mirage-radar.jpg')} (${out.radar.length} bytes)`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
