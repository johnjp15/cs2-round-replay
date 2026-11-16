/**
 * Node adapter: a demo file → `RawDemo` (src/coach/model/raw.ts) with the native `@laihoe/demoparser2`.
 *
 * Accepts `.dem`, `.dem.bz2`, `.dem.zst`, `.dem.gz` (decompressed in memory; gzip and zstd from node:zlib, bzip2 from
 * the pure-JS seek-bzip). Memory is bounded: demoparser2 hands back plain JS arrays, which cost ~100 bytes a value, so
 * the tick grid is read in tick-range chunks (`CHUNK_TICKS`) and each chunk is converted to typed arrays at once.
 * The final grid is ~75 bytes per player-tick.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import Bunzip from 'seek-bzip';
import {
  CLIP_NONE, FLAG, GAME_FLAG, PATH_NONE, PATH_STEP, RAW_FORMAT, SLOT_NONE, TEAM_CT, TEAM_T, allocTicks,
  emptyEvents, liveRange, PLAYER_COLUMNS, TICK_COLUMNS,
} from '../../src/coach/model/raw';
import type {
  RawBombEvent, RawDemo, RawDetonation, RawEvents, RawHeader, RawInventory, RawPlayer, RawProjectile, RawRoundEvent,
  RawScoreboard, RawTicks,
} from '../../src/coach/model/raw';
import { canonicalItem, itemFromDefIndex } from '../../src/coach/model/items';

type Row = Record<string, unknown>;
type Soa = Record<string, unknown[]>;

interface Demoparser {
  parseHeader(src: string | Buffer): Row;
  parseEvents(src: string | Buffer, names: string[], player?: string[] | null, other?: string[] | null): Row[];
  parseTicks(src: string | Buffer, props: string[], ticks?: number[] | null, players?: string[] | null, soa?: boolean | null): unknown;
  parseGrenades(src: string | Buffer, extra?: string[] | null, grenades?: boolean | null): Row[];
}

const require = createRequire(import.meta.url);
const PARSER_VERSION: string = (require('@laihoe/demoparser2/package.json') as { version: string }).version;
function parser(): Demoparser {
  return require('@laihoe/demoparser2') as Demoparser;
}

/** Ticks per tick-grid chunk: ~4000 ticks × 10 players × 45 fields keeps one chunk's JS arrays under ~300 MB. */
export const CHUNK_TICKS = 4000;
/** Players are discovered on every `DISCOVERY_STEP`-th tick of the live range. */
const DISCOVERY_STEP = 16;

export interface ParseOptions {
  /** Called with a phase name and 0–1 progress. */
  onProgress?: (phase: string, done: number) => void;
}

export interface ParseStats {
  ms: number;
  peakRssMb: number;
  chunks: number;
}

// ------------------------------------------------------------ small readers

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const bool = (v: unknown): boolean => v === true;

/** Read a demo file and decompress by extension (or by magic bytes). */
export function readDemoBytes(path: string): { src: string | Buffer; sha256: string; bytes: number } {
  const file = readFileSync(path);
  const sha256 = createHash('sha256').update(file).digest('hex');
  const bytes = statSync(path).size;
  const b0 = file[0], b1 = file[1], b2 = file[2], b3 = file[3];
  if (b0 === 0x1f && b1 === 0x8b) return { src: gunzipSync(file), sha256, bytes };
  if (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) return { src: zstdDecompressSync(file), sha256, bytes };
  if (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) return { src: Bunzip.decode(file), sha256, bytes };
  // A plain .dem: let the parser read the path (no second copy in JS memory).
  return { src: path, sha256, bytes };
}

function guessSource(server: string, path: string): RawHeader['source'] {
  if (/faceit/i.test(server) || /\.zst$/i.test(path)) return 'faceit';
  if (/^Valve /i.test(server)) return 'valve';
  return 'other';
}

/** Key of a player row or event participant: the Steam ID, or `BOT-<name>` for a bot. */
function playerKey(steamid: unknown, name: unknown): string {
  const s = str(steamid);
  if (s !== '' && s !== '0') return s;
  const n = str(name);
  return n === '' ? '' : `BOT-${n}`;
}

class Interner {
  readonly list: string[] = [''];
  private readonly map = new Map<string, number>([['', 0]]);
  id(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.list.length;
      if (i > 255) return 0; // Uint8 columns: overflow folds to "unknown" (no map has 255 places or weapons).
      this.list.push(s);
      this.map.set(s, i);
    }
    return i;
  }
}

// ------------------------------------------------------------ events

const EVENT_NAMES = [
  'begin_new_match', 'round_announce_match_start', 'cs_pre_restart', 'round_start', 'round_freeze_end', 'round_end',
  'round_officially_ended', 'cs_win_panel_match', 'buytime_ended', 'weapon_fire', 'fire_bullets', 'player_hurt',
  'player_death', 'player_blind', 'hegrenade_detonate', 'flashbang_detonate', 'smokegrenade_detonate',
  'smokegrenade_expired', 'inferno_startburn', 'inferno_expire', 'decoy_started', 'decoy_detonate', 'bomb_beginplant',
  'bomb_abortplant', 'bomb_planted', 'bomb_begindefuse', 'bomb_abortdefuse', 'bomb_defused', 'bomb_exploded',
  'bomb_dropped', 'bomb_pickup', 'player_footstep', 'player_jump', 'weapon_reload', 'weapon_zoom', 'item_pickup',
  'item_equip', 'item_purchase', 'rank_update', 'player_spawn', 'player_disconnect',
];

const ROUND_KIND: Record<string, RawRoundEvent['kind']> = {
  begin_new_match: 'match_start', round_announce_match_start: 'announce_match_start', cs_pre_restart: 'restart',
  round_start: 'start', round_freeze_end: 'freeze_end', round_end: 'end', round_officially_ended: 'officially_ended',
  cs_win_panel_match: 'match_end', buytime_ended: 'buytime_ended',
};
const DET_KIND: Record<string, RawDetonation['kind']> = {
  hegrenade_detonate: 'he', flashbang_detonate: 'flash', smokegrenade_detonate: 'smoke', smokegrenade_expired: 'smoke_end',
  inferno_startburn: 'fire', inferno_expire: 'fire_end', decoy_started: 'decoy', decoy_detonate: 'decoy_end',
};
const BOMB_KIND: Record<string, RawBombEvent['kind']> = {
  bomb_beginplant: 'begin_plant', bomb_abortplant: 'abort_plant', bomb_planted: 'planted', bomb_begindefuse: 'begin_defuse',
  bomb_abortdefuse: 'abort_defuse', bomb_defused: 'defused', bomb_exploded: 'exploded', bomb_dropped: 'dropped', bomb_pickup: 'pickup',
};

function readEvents(rows: Row[], slotOf: (steamid: unknown, name: unknown) => number): RawEvents {
  const ev = emptyEvents();
  // Stable sort by tick (demoparser2 groups by event type).
  const order = rows.map((r, i) => ({ r, i, t: num(r['tick'], -1) }));
  order.sort((a, b) => a.t - b.t || a.i - b.i);
  for (const { r, t: tick } of order) {
    const name = str(r['event_name']);
    const user = (): number => slotOf(r['user_steamid'], r['user_name']);
    const rk = ROUND_KIND[name];
    if (rk !== undefined) {
      ev.rounds.push({
        tick, kind: rk, roundsPlayed: num(r['total_rounds_played']), warmup: bool(r['is_warmup_period']),
        winner: rk === 'end' ? num(r['winner']) : 0, reason: rk === 'end' ? num(r['reason']) : 0,
        message: rk === 'end' ? str(r['message']) : '',
      });
      continue;
    }
    const dk = DET_KIND[name];
    if (dk !== undefined) {
      ev.detonations.push({ tick, kind: dk, p: user(), entity: num(r['entityid'], -1), x: num(r['x']), y: num(r['y']), z: num(r['z']) });
      continue;
    }
    const bk = BOMB_KIND[name];
    if (bk !== undefined) {
      ev.bomb.push({ tick, kind: bk, p: user(), site: num(r['site'], -1), hasKit: bool(r['haskit']) });
      continue;
    }
    switch (name) {
      case 'weapon_fire':
        ev.shots.push({ tick, p: user(), weapon: canonicalItem(str(r['weapon'])), silenced: bool(r['silenced']) });
        break;
      case 'fire_bullets': {
        const defIndex = num(r['item_def_index']);
        ev.bullets.push({
          tick, p: user(), defIndex, weapon: itemFromDefIndex(defIndex),
          x: num(r['origin_x']), y: num(r['origin_y']), z: num(r['origin_z']),
          pitch: num(r['angles_x']), yaw: num(r['angles_y']), inaccuracy: num(r['inaccuracy']), spread: num(r['spread']),
          recoilIndex: num(r['recoil_index']), seed: num(r['seed']), mode: num(r['mode']), clip: num(r['num_bullets_remaining']),
        });
        break;
      }
      case 'player_hurt':
        ev.hurts.push({
          tick, victim: user(), attacker: slotOf(r['attacker_steamid'], r['attacker_name']), weapon: canonicalItem(str(r['weapon'])),
          hitgroup: str(r['hitgroup']), dmgHealth: num(r['dmg_health']), dmgArmor: num(r['dmg_armor']),
          health: num(r['health']), armor: num(r['armor']),
        });
        break;
      case 'player_death':
        ev.kills.push({
          tick, victim: user(), attacker: slotOf(r['attacker_steamid'], r['attacker_name']),
          assister: slotOf(r['assister_steamid'], r['assister_name']), weapon: canonicalItem(str(r['weapon'])),
          headshot: bool(r['headshot']), penetrated: num(r['penetrated']), thruSmoke: bool(r['thrusmoke']),
          attackerBlind: bool(r['attackerblind']), noScope: bool(r['noscope']), assistedFlash: bool(r['assistedflash']),
          distance: num(r['distance']), hitgroup: str(r['hitgroup']),
        });
        break;
      case 'player_blind':
        ev.blinds.push({
          tick, victim: user(), attacker: slotOf(r['attacker_steamid'], r['attacker_name']),
          duration: num(r['blind_duration']), entity: num(r['entityid'], -1),
        });
        break;
      case 'player_footstep': ev.footsteps.push({ tick, p: user() }); break;
      case 'player_jump': ev.jumps.push({ tick, p: user() }); break;
      case 'weapon_reload': ev.reloads.push({ tick, p: user() }); break;
      case 'weapon_zoom': ev.zooms.push({ tick, p: user() }); break;
      case 'item_pickup':
        ev.pickups.push({ tick, p: user(), item: canonicalItem(str(r['item'])), defIndex: num(r['defindex'], -1), silent: bool(r['silent']) });
        break;
      case 'item_equip':
        ev.equips.push({ tick, p: user(), item: canonicalItem(str(r['item'])), defIndex: num(r['defindex'], -1) });
        break;
      case 'item_purchase':
        ev.purchases.push({ tick, p: slotOf(r['steamid'], r['name']), item: canonicalItem(str(r['item_name'])), cost: num(r['cost']), sold: bool(r['was_sold']) });
        break;
      case 'rank_update':
        ev.ranks.push({
          tick, p: user(), rankOld: num(r['rank_old']), rankNew: num(r['rank_new']), rankChange: num(r['rank_change']),
          numWins: num(r['num_wins']), rankType: num(r['rank_type_id']),
        });
        break;
      case 'player_spawn': ev.presence.push({ tick, p: user(), kind: 'spawn', reason: 0 }); break;
      case 'player_disconnect':
        ev.presence.push({ tick, p: slotOf(r['xuid'] ?? r['user_steamid'], r['name']), kind: 'disconnect', reason: num(r['reason']) });
        break;
      default: break;
    }
  }
  return ev;
}

// ------------------------------------------------------------ tick grid

const TICK_FIELDS = [
  'X', 'Y', 'Z', 'pitch', 'yaw', 'velocity_X', 'velocity_Y', 'velocity_Z', 'health', 'armor_value', 'duck_amount',
  'active_weapon_name', 'active_weapon_ammo', 'team_num', 'last_place_name', 'is_alive', 'is_scoped', 'is_walking',
  'is_airborne', 'is_defusing', 'is_in_reload', 'has_helmet', 'has_defuser', 'in_bomb_zone', 'in_buy_zone', 'spotted',
  'is_connected', 'is_controlling_bot', 'buttons', 'approximate_spotted_by', 'flash_duration', 'accuracy_penalty',
  'aim_punch_angle', 'fl_recoil_idx', 'shots_fired', 'balance', 'current_equip_value', 'is_warmup_period',
  'is_freeze_period', 'is_bomb_planted', 'is_match_started', 'total_rounds_played', 'team_rounds_total',
];

const clampU8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const clampU16 = (v: number): number => (v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v));
const f32 = (v: unknown): number => (typeof v === 'number' ? v : NaN);

function buttonsLow32(v: unknown): number {
  if (typeof v === 'string' && v !== '') return Number(BigInt.asUintN(32, BigInt(v)));
  if (typeof v === 'number') return v >>> 0;
  if (typeof v === 'bigint') return Number(BigInt.asUintN(32, v));
  return 0;
}

/** Convert one chunk's struct-of-arrays rows into a RawTicks part. */
function chunkToTicks(soa: Soa, slots: Map<string, number>, P: number, weapons: Interner, places: Interner): RawTicks {
  const ticks = soa['tick'] ?? [];
  const n = ticks.length;
  let T = 0;
  let prev = Number.NaN;
  for (let j = 0; j < n; j++) { const t = num(ticks[j]); if (t !== prev) { T++; prev = t; } }
  const out = allocTicks(T, P);
  const col = (k: string): unknown[] => soa[k] ?? [];
  const X = col('X'), Y = col('Y'), Z = col('Z'), PI = col('pitch'), YA = col('yaw');
  const VX = col('velocity_X'), VY = col('velocity_Y'), VZ = col('velocity_Z');
  const HP = col('health'), AR = col('armor_value'), DU = col('duck_amount'), WN = col('active_weapon_name');
  const AM = col('active_weapon_ammo'), TE = col('team_num'), PL = col('last_place_name');
  const fAlive = col('is_alive'), fScoped = col('is_scoped'), fWalk = col('is_walking'), fAir = col('is_airborne');
  const fDef = col('is_defusing'), fRel = col('is_in_reload'), fHelm = col('has_helmet'), fKit = col('has_defuser');
  const fBomb = col('in_bomb_zone'), fBuy = col('in_buy_zone'), fSpot = col('spotted'), CONN = col('is_connected');
  const fBot = col('is_controlling_bot'), BT = col('buttons'), SB = col('approximate_spotted_by'), FL = col('flash_duration');
  const PEN = col('accuracy_penalty'), PUNCH = col('aim_punch_angle'), REC = col('fl_recoil_idx'), SF = col('shots_fired');
  const BAL = col('balance'), EQ = col('current_equip_value'), gW = col('is_warmup_period'), gF = col('is_freeze_period');
  const gB = col('is_bomb_planted'), gM = col('is_match_started'), RP = col('total_rounds_played'), SC = col('team_rounds_total');
  const SID = col('steamid'), NAME = col('name');
  out.scoreT.fill(255);
  out.scoreCT.fill(255);
  let t = -1;
  prev = Number.NaN;
  for (let j = 0; j < n; j++) {
    const tk = num(ticks[j]);
    if (tk !== prev) {
      t++;
      prev = tk;
      out.tick[t] = tk;
      out.game[t] = (bool(gW[j]) ? GAME_FLAG.warmup : 0) | (bool(gF[j]) ? GAME_FLAG.freeze : 0) |
        (bool(gB[j]) ? GAME_FLAG.bombPlanted : 0) | (bool(gM[j]) ? GAME_FLAG.matchStarted : 0);
      out.roundsPlayed[t] = clampU8(num(RP[j]));
    }
    const p = slots.get(playerKey(SID[j], NAME[j]));
    if (p === undefined) continue;
    const team = num(TE[j]);
    const sc = SC[j];
    if (typeof sc === 'number') {
      if (team === TEAM_T) out.scoreT[t] = clampU8(sc);
      else if (team === TEAM_CT) out.scoreCT[t] = clampU8(sc);
    }
    const connected = num(CONN[j], -1) === 0;
    if ((team !== TEAM_T && team !== TEAM_CT) || typeof X[j] !== 'number') continue;
    const i = t * P + p;
    out.present[i] = 1;
    out.x[i] = f32(X[j]); out.y[i] = f32(Y[j]); out.z[i] = f32(Z[j]);
    out.pitch[i] = f32(PI[j]); out.yaw[i] = f32(YA[j]);
    out.vx[i] = f32(VX[j]); out.vy[i] = f32(VY[j]); out.vz[i] = f32(VZ[j]);
    out.health[i] = clampU8(num(HP[j])); out.armor[i] = clampU8(num(AR[j]));
    out.duck[i] = clampU8(num(DU[j]) * 255);
    out.weapon[i] = weapons.id(canonicalItem(str(WN[j])));
    out.clip[i] = typeof AM[j] === 'number' ? clampU8(num(AM[j])) : CLIP_NONE;
    out.team[i] = team;
    out.place[i] = places.id(str(PL[j]));
    out.flags[i] = (bool(fAlive[j]) ? FLAG.alive : 0) | (bool(fScoped[j]) ? FLAG.scoped : 0) | (bool(fWalk[j]) ? FLAG.walking : 0) |
      (bool(fAir[j]) ? FLAG.airborne : 0) | (bool(fDef[j]) ? FLAG.defusing : 0) | (bool(fRel[j]) ? FLAG.reloading : 0) |
      (bool(fHelm[j]) ? FLAG.helmet : 0) | (bool(fKit[j]) ? FLAG.kit : 0) | (bool(fBomb[j]) ? FLAG.inBombZone : 0) |
      (bool(fBuy[j]) ? FLAG.inBuyZone : 0) | (bool(fSpot[j]) ? FLAG.spotted : 0) | (connected ? FLAG.connected : 0) |
      (bool(fBot[j]) ? FLAG.controllingBot : 0);
    out.buttons[i] = buttonsLow32(BT[j]);
    const sb = SB[j];
    if (Array.isArray(sb)) {
      let mask = 0;
      for (const s of sb) { const q = slots.get(playerKey(s, '')); if (q !== undefined && q < 16) mask |= 1 << q; }
      out.spottedBy[i] = mask;
    }
    out.flash[i] = num(FL[j]);
    out.penalty[i] = num(PEN[j]);
    const punch = PUNCH[j];
    if (Array.isArray(punch)) { out.punchPitch[i] = num(punch[0]); out.punchYaw[i] = num(punch[1]); }
    out.recoilIndex[i] = num(REC[j]);
    out.shotsFired[i] = clampU16(num(SF[j]));
    out.money[i] = clampU16(num(BAL[j]));
    out.equip[i] = clampU16(num(EQ[j]));
  }
  return out;
}

function concatTicks(parts: RawTicks[], P: number): RawTicks {
  const T = parts.reduce((s, x) => s + x.count, 0);
  const out = allocTicks(T, P);
  let off = 0;
  for (const part of parts) {
    for (const k of Object.keys(TICK_COLUMNS) as (keyof typeof TICK_COLUMNS)[]) out[k].set(part[k], off);
    for (const k of Object.keys(PLAYER_COLUMNS) as (keyof typeof PLAYER_COLUMNS)[]) out[k].set(part[k], off * P);
    off += part.count;
  }
  return out;
}

/** Sort a name table (keeping '' at 0) and rewrite the id column to match. */
function sortTable(list: string[], column: Uint8Array): string[] {
  const sorted = ['', ...list.slice(1).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  const remap = new Uint8Array(256);
  list.forEach((s, i) => { remap[i] = sorted.indexOf(s); });
  for (let i = 0; i < column.length; i++) column[i] = remap[column[i] ?? 0] ?? 0;
  return sorted;
}

function rangeTicks(a: number, b: number, step = 1): number[] {
  const out: number[] = [];
  for (let t = a; t <= b; t += step) out.push(t);
  return out;
}

// ------------------------------------------------------------ main

/** Parse a demo into a RawDemo. */
export function parseDemoNode(path: string, opts: ParseOptions = {}): { raw: RawDemo; stats: ParseStats } {
  const t0 = performance.now();
  let peak = 0;
  const sample = (): void => { const r = process.memoryUsage().rss; if (r > peak) peak = r; };
  const progress = (phase: string, done: number): void => { sample(); opts.onProgress?.(phase, done); };
  const dp = parser();
  const { src, sha256, bytes } = readDemoBytes(path);
  progress('read', 1);

  const hdr = dp.parseHeader(src);
  const server = str(hdr['server_name']);
  const patchNum = Number(str(hdr['patch_version']));

  // Events first, without player extras (cheap); slots are resolved once the players are known.
  const evRows = dp.parseEvents(src, EVENT_NAMES, [], ['total_rounds_played', 'is_warmup_period']);
  progress('events', 1);
  let firstTick = Infinity, lastTick = -Infinity;
  for (const r of evRows) { const t = num(r['tick'], -1); if (t >= 0) { if (t < firstTick) firstTick = t; if (t > lastTick) lastTick = t; } }
  const roundsOnly = readEvents(evRows.filter((r) => ROUND_KIND[str(r['event_name'])] !== undefined), () => SLOT_NONE).rounds;
  if (!Number.isFinite(firstTick)) { firstTick = 0; lastTick = 0; }
  const range = liveRange(roundsOnly, firstTick, lastTick);

  // Players: who has team 2/3 and a pawn at sampled ticks of the live range.
  const disc = dp.parseTicks(src, ['team_num', 'X'], rangeTicks(range.start, range.end, DISCOVERY_STEP), null, true) as Soa;
  const firstTeam = new Map<string, { team: number; name: string }>();
  {
    const tk = disc['tick'] ?? [], sid = disc['steamid'] ?? [], nm = disc['name'] ?? [], tm = disc['team_num'] ?? [], xs = disc['X'] ?? [];
    for (let j = 0; j < tk.length; j++) {
      const team = num(tm[j]);
      if ((team !== TEAM_T && team !== TEAM_CT) || typeof xs[j] !== 'number') continue;
      const key = playerKey(sid[j], nm[j]);
      if (key !== '' && !firstTeam.has(key)) firstTeam.set(key, { team, name: str(nm[j]) });
    }
  }
  const keys = [...firstTeam.keys()].sort((a, b) => (firstTeam.get(a)?.team ?? 0) - (firstTeam.get(b)?.team ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const players: RawPlayer[] = keys.map((k) => ({ steamId: k, name: firstTeam.get(k)?.name ?? '', bot: k.startsWith('BOT-') }));
  const slots = new Map<string, number>(keys.map((k, i) => [k, i]));
  const nameSlots = new Map<string, number>(players.map((p, i) => [p.name, i]));
  const P = players.length;
  progress('players', 1);

  const slotOf = (steamid: unknown, name: unknown): number => {
    const key = playerKey(steamid, name);
    const s = slots.get(key);
    if (s !== undefined) return s;
    const n = str(name);
    return n !== '' ? nameSlots.get(n) ?? SLOT_NONE : SLOT_NONE;
  };
  const events = readEvents(evRows, slotOf);
  evRows.length = 0;

  // The tick grid, chunk by chunk.
  const weapons = new Interner();
  const places = new Interner();
  const parts: RawTicks[] = [];
  let chunks = 0;
  for (let a = range.start; a <= range.end; a += CHUNK_TICKS) {
    const b = Math.min(range.end, a + CHUNK_TICKS - 1);
    const soa = dp.parseTicks(src, TICK_FIELDS, rangeTicks(a, b), null, true) as Soa;
    sample();
    parts.push(chunkToTicks(soa, slots, P, weapons, places));
    chunks++;
    progress('ticks', (b - range.start + 1) / (range.end - range.start + 1));
  }
  const ticks = concatTicks(parts, P);
  parts.length = 0;
  // Name tables sorted ('' first) so they do not depend on the order the parser met the names.
  const weaponNames = sortTable(weapons.list, ticks.weapon);
  const placeNames = sortTable(places.list, ticks.place);

  // Inventories at freeze ends, round ends and the tick before each death.
  const invTicks = new Map<number, RawInventory['at']>();
  for (const r of events.rounds) {
    if (r.tick < range.start || r.tick > range.end) continue;
    if (r.kind === 'freeze_end') invTicks.set(r.tick, 'freeze_end');
    else if (r.kind === 'end') invTicks.set(r.tick, 'round_end');
  }
  const deathAt = new Map<number, number[]>();
  for (const k of events.kills) {
    if (k.victim < 0 || k.tick < range.start || k.tick > range.end) continue;
    const t = k.tick - 1;
    const list = deathAt.get(t) ?? [];
    list.push(k.victim);
    deathAt.set(t, list);
  }
  const wanted = [...new Set([...invTicks.keys(), ...deathAt.keys()])].sort((x, y) => x - y);
  const inventories: RawInventory[] = [];
  if (wanted.length > 0) {
    const inv = dp.parseTicks(src, ['inventory', 'team_num'], wanted, null, true) as Soa;
    const tk = inv['tick'] ?? [], sid = inv['steamid'] ?? [], nm = inv['name'] ?? [], items = inv['inventory'] ?? [], tm = inv['team_num'] ?? [];
    for (let j = 0; j < tk.length; j++) {
      const tick = num(tk[j]);
      const p = slots.get(playerKey(sid[j], nm[j]));
      if (p === undefined) continue;
      const team = num(tm[j]);
      const list = Array.isArray(items[j]) ? (items[j] as unknown[]).map((s) => canonicalItem(str(s))).filter((s) => s !== '').sort() : [];
      const at = invTicks.get(tick);
      if (at !== undefined && (team === TEAM_T || team === TEAM_CT)) inventories.push({ tick, p, at, items: list });
      if (deathAt.get(tick)?.includes(p)) inventories.push({ tick: tick + 1, p, at: 'death', items: list });
    }
    inventories.sort((x, y) => x.tick - y.tick || x.p - y.p || (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }
  progress('inventories', 1);

  // The demo's own scoreboard at the last round's end.
  const sbFields = ['kills_total', 'deaths_total', 'assists_total', 'damage_total', 'headshot_kills_total', 'enemies_flashed_total', 'utility_damage_total', 'mvps', 'score'];
  const sbRows = dp.parseTicks(src, sbFields, [range.end], null, false) as Row[];
  const scoreboard: RawScoreboard = { tick: range.end, rows: [] };
  for (const r of sbRows) {
    const p = slots.get(playerKey(r['steamid'], r['name']));
    if (p === undefined) continue;
    scoreboard.rows.push({
      p, kills: num(r['kills_total']), deaths: num(r['deaths_total']), assists: num(r['assists_total']),
      damage: num(r['damage_total']), headshotKills: num(r['headshot_kills_total']), enemiesFlashed: num(r['enemies_flashed_total']),
      utilityDamage: num(r['utility_damage_total']), mvps: num(r['mvps']), score: num(r['score']),
    });
  }
  scoreboard.rows.sort((x, y) => x.p - y.p);

  const projectiles = readProjectiles(dp.parseGrenades(src, null, false), slotOf);
  progress('projectiles', 1);

  const raw: RawDemo = {
    format: RAW_FORMAT,
    header: {
      map: str(hdr['map_name']), server, source: guessSource(server, path), gotv: /SourceTV/i.test(str(hdr['client_name'])),
      patch: Number.isFinite(patchNum) && patchNum > 0 ? patchNum : null, tickRate: 64, demoSha256: sha256, bytes,
      parser: `demoparser2-node@${PARSER_VERSION}`,
    },
    players,
    names: { weapons: weaponNames, places: placeNames },
    ticks,
    events,
    projectiles,
    inventories,
    scoreboard,
  };
  sample();
  return { raw, stats: { ms: performance.now() - t0, peakRssMb: peak / 1048576, chunks } };
}

const GRENADE_TYPE: Record<string, string> = {
  CSmokeGrenadeProjectile: 'smoke', CHEGrenadeProjectile: 'he_grenade', CFlashbangProjectile: 'flashbang',
  CMolotovProjectile: 'molotov', CDecoyProjectile: 'decoy',
};
/** A gap longer than this (ticks) between samples of one entity starts a new projectile (entity ids are reused). */
const PROJECTILE_GAP = 16;

function readProjectiles(rows: Row[], slotOf: (s: unknown, n: unknown) => number): RawProjectile[] {
  interface Track { type: string; thrower: number; entity: number; samples: { tick: number; x: number; y: number; z: number }[] }
  const open = new Map<number, Track>();
  const done: Track[] = [];
  const sorted = rows
    .map((r, i) => ({ r, i, t: num(r['tick']) }))
    .filter(({ r }) => GRENADE_TYPE[str(r['grenade_type'])] !== undefined)
    .sort((a, b) => a.t - b.t || a.i - b.i);
  for (const { r, t } of sorted) {
    const entity = num(r['grenade_entity_id'], -1);
    const type = GRENADE_TYPE[str(r['grenade_type'])] ?? '';
    const thrower = slotOf(r['steamid'], r['name']);
    let tr = open.get(entity);
    const last = tr?.samples[tr.samples.length - 1];
    if (!tr || !last || t - last.tick > PROJECTILE_GAP || tr.type !== type || tr.thrower !== thrower) {
      if (tr) done.push(tr);
      tr = { type, thrower, entity, samples: [] };
      open.set(entity, tr);
    }
    tr.samples.push({ tick: t, x: f32(r['x']), y: f32(r['y']), z: f32(r['z']) });
  }
  for (const tr of open.values()) done.push(tr);
  const out: RawProjectile[] = [];
  for (const tr of done) {
    const first = tr.samples[0], last = tr.samples[tr.samples.length - 1];
    if (!first || !last) continue;
    const t0 = first.tick, t1 = last.tick;
    const n = Math.floor((t1 - t0) / PATH_STEP) + 1;
    const path = new Int16Array(n * 3).fill(PATH_NONE);
    for (const s of tr.samples) {
      if ((s.tick - t0) % PATH_STEP !== 0 || !Number.isFinite(s.x)) continue;
      const k = ((s.tick - t0) / PATH_STEP) * 3;
      path[k] = Math.round(s.x); path[k + 1] = Math.round(s.y); path[k + 2] = Math.round(s.z);
    }
    out.push({ type: tr.type, thrower: tr.thrower, entity: tr.entity, t0, t1, path });
  }
  out.sort((a, b) => a.t0 - b.t0 || a.entity - b.entity);
  return out;
}
