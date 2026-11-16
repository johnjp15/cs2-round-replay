/**
 * WebAssembly output (`WasmRaw`) → `RawDemo`. The field-by-field rules mirror the Node adapter
 * (`tools/coach/parse-node.ts`) so both parsers deliver the same `RawDemo`; the conformance test checks it.
 * Runs in the worker (and in Node for tests). Pure: no DOM, no clock.
 */
import { canonicalItem, itemFromDefIndex } from '../coach/model/items';
import { RAW_FORMAT, emptyEvents } from '../coach/model/raw';
import type {
  RawBombEvent, RawDemo, RawDetonation, RawEvents, RawHeader, RawInventory, RawProjectile, RawRoundEvent, RawScoreboard,
  RawTicks,
} from '../coach/model/raw';
import type { WasmEventTable, WasmRaw } from './wasm-types';

/** The parser tag written to `RawHeader.parser`; bumped with the crate. */
export const PARSER_TAG = 'coach-parser-wasm@0.1.0+demoparser2.8035c3d';

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
const PLAYER_TICK: Record<string, 'footsteps' | 'jumps' | 'reloads' | 'zooms'> = {
  player_footstep: 'footsteps', player_jump: 'jumps', weapon_reload: 'reloads', weapon_zoom: 'zooms',
};
const GRENADE_TYPE: Record<string, string> = {
  CSmokeGrenadeProjectile: 'smoke', CHEGrenadeProjectile: 'he_grenade', CFlashbangProjectile: 'flashbang',
  CMolotovProjectile: 'molotov', CDecoyProjectile: 'decoy',
};
const INV_AT: readonly RawInventory['at'][] = ['freeze_end', 'death', 'round_end'];

/** One row of an event table, read by field name. */
class EventRow {
  i = 0;
  constructor(private readonly t: WasmEventTable, private readonly cols: Map<string, WasmEventTable['columns'][number]>) {}
  /** A number (NaN → d; booleans are 0/1). */
  num(name: string, d = 0): number {
    const c = this.cols.get(name);
    if (!c) return d;
    if (c.kind === 'str') {
      const s = (c.data as (string | null)[])[this.i];
      const v = s === null || s === undefined ? NaN : Number(s);
      return Number.isFinite(v) ? v : d;
    }
    const v = (c.data as Float64Array | Int16Array)[this.i] ?? NaN;
    return Number.isFinite(v) ? v : d;
  }
  bool(name: string): boolean {
    const c = this.cols.get(name);
    return c !== undefined && c.kind === 'num' && (c.data as Float64Array)[this.i] === 1;
  }
  str(name: string): string {
    const c = this.cols.get(name);
    if (!c) return '';
    if (c.kind === 'str') return (c.data as (string | null)[])[this.i] ?? '';
    const v = (c.data as Float64Array)[this.i];
    return v === undefined || Number.isNaN(v) ? '' : String(v);
  }
  slot(name: string): number {
    const c = this.cols.get(name);
    return c !== undefined && c.kind === 'slot' ? ((c.data as Int16Array)[this.i] ?? -1) : -1;
  }
  get tick(): number { return this.t.tick[this.i] ?? 0; }
}

function readEvents(tables: WasmEventTable[]): RawEvents {
  const ev = emptyEvents();
  // all rows of the tables we use, in (tick, demo order)
  const rows: { t: WasmEventTable; i: number; tick: number; seq: number; r: EventRow }[] = [];
  for (const t of tables) {
    const name = t.name;
    if (ROUND_KIND[name] === undefined && DET_KIND[name] === undefined && BOMB_KIND[name] === undefined &&
      PLAYER_TICK[name] === undefined && !SIMPLE.has(name)) continue;
    const r = new EventRow(t, new Map(t.columns.map((c) => [c.name, c])));
    for (let i = 0; i < t.tick.length; i++) rows.push({ t, i, tick: t.tick[i] ?? 0, seq: t.seq[i] ?? 0, r });
  }
  rows.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  for (const { t, i, r } of rows) {
    r.i = i;
    const name = t.name;
    const tick = r.tick;
    const rk = ROUND_KIND[name];
    if (rk !== undefined) {
      ev.rounds.push({
        tick, kind: rk, roundsPlayed: r.num('total_rounds_played'), warmup: r.bool('is_warmup_period'),
        winner: rk === 'end' ? r.num('winner') : 0, reason: rk === 'end' ? r.num('reason') : 0,
        message: rk === 'end' ? r.str('message') : '',
      });
      continue;
    }
    const dk = DET_KIND[name];
    if (dk !== undefined) {
      ev.detonations.push({ tick, kind: dk, p: r.slot('user_steamid'), entity: r.num('entityid', -1), x: r.num('x'), y: r.num('y'), z: r.num('z') });
      continue;
    }
    const bk = BOMB_KIND[name];
    if (bk !== undefined) {
      ev.bomb.push({ tick, kind: bk, p: r.slot('user_steamid'), site: r.num('site', -1), hasKit: r.bool('haskit') });
      continue;
    }
    const pt = PLAYER_TICK[name];
    if (pt !== undefined) {
      ev[pt].push({ tick, p: r.slot('user_steamid') });
      continue;
    }
    switch (name) {
      case 'weapon_fire':
        ev.shots.push({ tick, p: r.slot('user_steamid'), weapon: canonicalItem(r.str('weapon')), silenced: r.bool('silenced') });
        break;
      case 'fire_bullets': {
        const defIndex = r.num('item_def_index');
        ev.bullets.push({
          tick, p: r.slot('user_steamid'), defIndex, weapon: itemFromDefIndex(defIndex),
          x: r.num('origin_x'), y: r.num('origin_y'), z: r.num('origin_z'), pitch: r.num('angles_x'), yaw: r.num('angles_y'),
          inaccuracy: r.num('inaccuracy'), spread: r.num('spread'), recoilIndex: r.num('recoil_index'), seed: r.num('seed'),
          mode: r.num('mode'), clip: r.num('num_bullets_remaining'),
        });
        break;
      }
      case 'player_hurt':
        ev.hurts.push({
          tick, victim: r.slot('user_steamid'), attacker: r.slot('attacker_steamid'), weapon: canonicalItem(r.str('weapon')),
          hitgroup: r.str('hitgroup'), dmgHealth: r.num('dmg_health'), dmgArmor: r.num('dmg_armor'), health: r.num('health'),
          armor: r.num('armor'),
        });
        break;
      case 'player_death':
        ev.kills.push({
          tick, victim: r.slot('user_steamid'), attacker: r.slot('attacker_steamid'), assister: r.slot('assister_steamid'),
          weapon: canonicalItem(r.str('weapon')), headshot: r.bool('headshot'), penetrated: r.num('penetrated'),
          thruSmoke: r.bool('thrusmoke'), attackerBlind: r.bool('attackerblind'), noScope: r.bool('noscope'),
          assistedFlash: r.bool('assistedflash'), distance: r.num('distance'), hitgroup: r.str('hitgroup'),
        });
        break;
      case 'player_blind':
        ev.blinds.push({
          tick, victim: r.slot('user_steamid'), attacker: r.slot('attacker_steamid'), duration: r.num('blind_duration'),
          entity: r.num('entityid', -1),
        });
        break;
      case 'item_pickup':
        ev.pickups.push({ tick, p: r.slot('user_steamid'), item: canonicalItem(r.str('item')), defIndex: r.num('defindex', -1), silent: r.bool('silent') });
        break;
      case 'item_equip':
        ev.equips.push({ tick, p: r.slot('user_steamid'), item: canonicalItem(r.str('item')), defIndex: r.num('defindex', -1) });
        break;
      case 'item_purchase':
        ev.purchases.push({ tick, p: r.slot('steamid'), item: canonicalItem(r.str('item_name')), cost: r.num('cost'), sold: r.bool('was_sold') });
        break;
      case 'rank_update':
        ev.ranks.push({
          tick, p: r.slot('user_steamid'), rankOld: r.num('rank_old'), rankNew: r.num('rank_new'), rankChange: r.num('rank_change'),
          numWins: r.num('num_wins'), rankType: r.num('rank_type_id'),
        });
        break;
      case 'player_spawn': ev.presence.push({ tick, p: r.slot('user_steamid'), kind: 'spawn', reason: 0 }); break;
      case 'player_disconnect': ev.presence.push({ tick, p: r.slot('xuid'), kind: 'disconnect', reason: r.num('reason') }); break;
      default: break;
    }
  }
  return ev;
}
const SIMPLE = new Set([
  'weapon_fire', 'fire_bullets', 'player_hurt', 'player_death', 'player_blind', 'item_pickup', 'item_equip', 'item_purchase',
  'rank_update', 'player_spawn', 'player_disconnect',
]);

/** Canonical weapon names: rename the table, merge duplicates (every knife is `knife`), sort, rewrite the column. */
function canonicalWeapons(display: string[], column: Uint8Array): string[] {
  const canon = display.map((s, i) => (i === 0 ? '' : canonicalItem(s)));
  const sorted = ['', ...[...new Set(canon.slice(1).filter((s) => s !== ''))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  const remap = new Uint8Array(256);
  canon.forEach((s, i) => { remap[i] = s === '' ? 0 : sorted.indexOf(s); });
  for (let i = 0; i < column.length; i++) column[i] = remap[column[i] ?? 0] ?? 0;
  return sorted;
}

function guessSource(server: string, fileName: string): RawHeader['source'] {
  if (/faceit/i.test(server) || /\.zst$/i.test(fileName)) return 'faceit';
  if (/^Valve /i.test(server)) return 'valve';
  return 'other';
}

export interface ConvertOptions {
  /** The file name as given (only used to guess the source). */
  fileName?: string;
}

/** Turn the WebAssembly output into a `RawDemo`. Reuses (and mutates) the typed arrays of `w`. */
export function toRawDemo(w: WasmRaw, opts: ConvertOptions = {}): RawDemo {
  const t = w.ticks;
  const ticks: RawTicks = {
    count: t.count, tick: t.tick, game: t.game, roundsPlayed: t.roundsPlayed, scoreT: t.scoreT, scoreCT: t.scoreCT,
    present: t.present, x: t.x, y: t.y, z: t.z, pitch: t.pitch, yaw: t.yaw, vx: t.vx, vy: t.vy, vz: t.vz,
    health: t.health, armor: t.armor, duck: t.duck, weapon: t.weapon, clip: t.clip, team: t.team, place: t.place,
    flags: t.flags, buttons: t.buttons, spottedBy: t.spottedBy, flash: t.flash, penalty: t.penalty,
    punchPitch: t.punchPitch, punchYaw: t.punchYaw, recoilIndex: t.recoilIndex, shotsFired: t.shotsFired,
    money: t.money, equip: t.equip,
  };
  const weapons = canonicalWeapons(w.weapons, ticks.weapon);

  const projectiles: RawProjectile[] = [];
  for (const p of w.projectiles) {
    const type = GRENADE_TYPE[p.kind];
    if (type !== undefined) projectiles.push({ type, thrower: p.thrower, entity: p.entity, t0: p.t0, t1: p.t1, path: p.path });
  }

  const inventories: RawInventory[] = w.inventories.map((v) => ({
    tick: v.tick, p: v.p, at: INV_AT[v.at] ?? 'freeze_end',
    items: v.items.map((s) => canonicalItem(s)).filter((s) => s !== '').sort(),
  }));
  inventories.sort((a, b) => a.tick - b.tick || a.p - b.p || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const scoreboard: RawScoreboard = {
    tick: w.scoreTick,
    rows: w.scoreboard.map((s) => {
      const v = (k: number): number => s.v[k] ?? 0;
      return {
        p: s.p, kills: v(0), deaths: v(1), assists: v(2), damage: v(3), headshotKills: v(4), enemiesFlashed: v(5),
        utilityDamage: v(6), mvps: v(7), score: v(8),
      };
    }).sort((a, b) => a.p - b.p),
  };

  const server = w.header['server_name'] ?? '';
  const patchNum = Number(w.header['patch_version'] ?? '');
  return {
    format: RAW_FORMAT,
    header: {
      map: w.header['map_name'] ?? '', server, source: guessSource(server, opts.fileName ?? ''),
      gotv: /SourceTV/i.test(w.header['client_name'] ?? ''),
      patch: Number.isFinite(patchNum) && patchNum > 0 ? patchNum : null, tickRate: 64, demoSha256: w.sha256,
      bytes: w.fileBytes, parser: PARSER_TAG,
    },
    players: w.players.map((p) => ({ steamId: p.bot ? `BOT-${p.name}` : p.steamid, name: p.name, bot: p.bot })),
    names: { weapons, places: w.places },
    ticks,
    events: readEvents(w.events),
    projectiles,
    inventories,
    scoreboard,
  };
}

/** Every typed array buffer of a RawDemo (for a zero-copy postMessage transfer list). */
export function transferables(raw: RawDemo): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const v of Object.values(raw.ticks)) if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  for (const p of raw.projectiles) out.add(p.path.buffer as ArrayBuffer);
  return [...out];
}
