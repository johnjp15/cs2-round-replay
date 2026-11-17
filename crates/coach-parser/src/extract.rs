//! Drives upstream's parser and turns its row tables into the dense per-(tick, player) columns of
//! `RawDemo` (src/coach/model/raw.ts). Plain Rust, no JS types: the same code runs natively for
//! development and inside the WebAssembly module. Item names, event records and the header are
//! finished on the TypeScript side (src/coach-parser/convert.ts), where `items.ts` lives.
//!
//! Passes over the demo (upstream's parser fills either events or entity rows in one pass):
//!   1. events, with `total_rounds_played` / `is_warmup_period` on each, and the header;
//!   2. per-tick player props for every tick, converted column by column;
//!   3. inventories and scoreboard totals, restricted to the few ticks that need them;
//!   4. grenade projectiles.

use ahash::AHashMap;
use parser::first_pass::parser_settings::{rm_user_friendly_names, FirstPassParser, ParserInputs};
use parser::first_pass::prop_controller::{
    ENTITY_ID_ID, GRENADE_TYPE_ID, GRENADE_X, GRENADE_Y, GRENADE_Z, NAME_ID, STEAMID_ID, TICK_ID,
};
use parser::parse_demo::{DemoOutput, Parser, ParsingMode};
use parser::second_pass::game_events::GameEvent;
use parser::second_pass::parser_settings::{create_huffman_lookup_table, SecondPassParser};
use parser::second_pass::variants::{PropColumn, VarVec, Variant};
use std::collections::BTreeMap;

/// Per-tick props (demoparser2 friendly names).
pub const TICK_PROPS: &[&str] = &[
    "X", "Y", "Z", "pitch", "yaw", "velocity_X", "velocity_Y", "velocity_Z", "health", "armor_value",
    "duck_amount", "active_weapon_name", "active_weapon_ammo", "team_num", "last_place_name", "is_alive",
    "is_scoped", "is_walking", "is_airborne", "is_defusing", "is_in_reload", "has_helmet", "has_defuser",
    "in_bomb_zone", "in_buy_zone", "spotted", "is_connected", "is_controlling_bot", "buttons", "flash_duration",
    "accuracy_penalty", "aim_punch_angle", "fl_recoil_idx", "shots_fired", "balance", "current_equip_value",
    "approximate_spotted_by", "is_warmup_period", "is_freeze_period", "is_bomb_planted", "is_match_started",
    "total_rounds_played", "team_rounds_total",
];

/// `FLAG` bits of raw.ts, in bit order, with the prop each comes from (connected is special).
const FLAG_PROPS: &[&str] = &[
    "is_alive", "is_scoped", "is_walking", "is_airborne", "is_defusing", "is_in_reload", "has_helmet", "has_defuser",
    "in_bomb_zone", "in_buy_zone", "spotted", "is_connected", "is_controlling_bot",
];
const FLAG_CONNECTED: usize = 11;
/// `GAME_FLAG` bits of raw.ts, in bit order.
const GAME_PROPS: &[&str] = &["is_warmup_period", "is_freeze_period", "is_bomb_planted", "is_match_started"];
/// Scoreboard totals, in the order of `ScoreRow::v`.
pub const SCORE_PROPS: &[&str] = &[
    "kills_total", "deaths_total", "assists_total", "damage_total", "headshot_kills_total", "enemies_flashed_total",
    "utility_damage_total", "mvps", "score",
];
pub const CLIP_NONE: u8 = 255;
pub const PATH_STEP: i32 = 4;
pub const PATH_NONE: i16 = -32768;

pub struct Player {
    /// 0 for bots.
    pub steamid: u64,
    pub name: String,
    pub bot: bool,
}

#[derive(Default)]
pub struct TickCols {
    pub count: usize,
    pub players: usize,
    pub tick: Vec<i32>,
    pub game: Vec<u8>,
    pub rounds_played: Vec<u8>,
    pub score_t: Vec<u8>,
    pub score_ct: Vec<u8>,
    pub present: Vec<u8>,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    pub pitch: Vec<f32>,
    pub yaw: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub vz: Vec<f32>,
    pub health: Vec<u8>,
    pub armor: Vec<u8>,
    pub duck: Vec<u8>,
    pub weapon: Vec<u8>,
    pub clip: Vec<u8>,
    pub team: Vec<u8>,
    pub place: Vec<u8>,
    pub flags: Vec<u16>,
    pub buttons: Vec<u32>,
    pub spotted_by: Vec<u16>,
    pub flash: Vec<f32>,
    pub penalty: Vec<f32>,
    pub punch_pitch: Vec<f32>,
    pub punch_yaw: Vec<f32>,
    pub recoil_index: Vec<f32>,
    pub shots_fired: Vec<u16>,
    pub money: Vec<u16>,
    pub equip: Vec<u16>,
}

pub enum EventData {
    /// Numbers and booleans (NaN where absent).
    Num(Vec<f64>),
    /// Strings and 64-bit integers (None where absent).
    Str(Vec<Option<String>>),
    /// A `<role>_steamid` / `steamid` field resolved to a player slot (-1 where absent or not a player).
    Slot(Vec<i16>),
}

pub struct EventColumn {
    pub name: String,
    pub data: EventData,
}

/// All events of one name, as columns. Rows are in demo order.
pub struct EventTable {
    pub name: String,
    pub tick: Vec<i32>,
    /// Position of each row in the demo's event order (for stable merging across tables).
    pub seq: Vec<u32>,
    pub columns: Vec<EventColumn>,
}

pub struct Projectile {
    /// upstream's grenade type (`flashbang`, `smoke`, `he_grenade`, `molotov`, `decoy`, ...).
    pub kind: String,
    pub thrower: i16,
    pub entity: i32,
    pub t0: i32,
    pub t1: i32,
    /// x, y, z every `PATH_STEP` ticks from t0, `PATH_NONE` where missing.
    pub path: Vec<i16>,
}

pub struct Inventory {
    pub tick: i32,
    pub p: i16,
    /// 0 freeze_end, 1 death, 2 round_end
    pub at: u8,
    /// Names as upstream reports them (canonicalized on the TS side).
    pub items: Vec<String>,
}

pub struct ScoreRow {
    pub p: i16,
    pub v: [f64; 9],
}

pub struct Output {
    pub header: BTreeMap<String, String>,
    pub players: Vec<Player>,
    /// Lookup tables; index 0 = ''. Names as in the demo (canonicalized on the TS side).
    pub weapons: Vec<String>,
    pub places: Vec<String>,
    pub ticks: TickCols,
    pub events: Vec<EventTable>,
    pub projectiles: Vec<Projectile>,
    pub inventories: Vec<Inventory>,
    pub score_tick: i32,
    pub scoreboard: Vec<ScoreRow>,
}

fn settings<'a>(huf: &'a Vec<(u8, u8)>, props: &[&str], other: &[&str], events: Vec<String>, projectiles: bool) -> ParserInputs<'a> {
    let og: Vec<String> = props.iter().map(|s| s.to_string()).collect();
    let real = rm_user_friendly_names(&og).unwrap_or_else(|_| og.clone());
    let og_other: Vec<String> = other.iter().map(|s| s.to_string()).collect();
    let real_other = rm_user_friendly_names(&og_other).unwrap_or_else(|_| og_other.clone());
    let mut real_name_to_og_name = AHashMap::default();
    for (r, o) in real.iter().zip(&og).chain(real_other.iter().zip(&og_other)) {
        real_name_to_og_name.insert(r.clone(), o.clone());
    }
    ParserInputs {
        real_name_to_og_name,
        wanted_players: vec![],
        wanted_player_props: real,
        wanted_other_props: real_other,
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: vec![],
        wanted_events: events,
        parse_ents: true,
        parse_projectiles: projectiles,
        parse_grenades: false,
        parse_weapons: false,
        vector_props_as_lists: false,
        only_header: projectiles, // as upstream's parse_grenades
        only_convars: false,
        huffman_lookup_table: huf,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    }
}

fn run(bytes: &[u8], s: ParserInputs) -> Result<DemoOutput, String> {
    let mut p = Parser::new(s, ParsingMode::ForceSingleThreaded);
    p.parse_demo(bytes).map_err(|e| format!("parse: {e}"))
}

// ---- column access -------------------------------------------------------------------------

fn col_f32(c: Option<&PropColumn>, row: usize) -> Option<f32> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::F32(v) => v.get(row).copied().flatten(),
        VarVec::U32(v) => v.get(row).copied().flatten().map(|x| x as f32),
        VarVec::I32(v) => v.get(row).copied().flatten().map(|x| x as f32),
        VarVec::U64(v) => v.get(row).copied().flatten().map(|x| x as f32),
        VarVec::Bool(v) => v.get(row).copied().flatten().map(|x| x as u8 as f32),
        _ => None,
    }
}
fn col_f64(c: Option<&PropColumn>, row: usize) -> Option<f64> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::F32(v) => v.get(row).copied().flatten().map(|x| x as f64),
        VarVec::U32(v) => v.get(row).copied().flatten().map(|x| x as f64),
        VarVec::I32(v) => v.get(row).copied().flatten().map(|x| x as f64),
        VarVec::U64(v) => v.get(row).copied().flatten().map(|x| x as f64),
        VarVec::Bool(v) => v.get(row).copied().flatten().map(|x| x as u8 as f64),
        _ => None,
    }
}
fn col_i32(c: Option<&PropColumn>, row: usize) -> Option<i32> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::I32(v) => v.get(row).copied().flatten(),
        VarVec::U32(v) => v.get(row).copied().flatten().map(|x| x as i32),
        VarVec::U64(v) => v.get(row).copied().flatten().map(|x| x as i32),
        VarVec::F32(v) => v.get(row).copied().flatten().map(|x| x as i32),
        VarVec::Bool(v) => v.get(row).copied().flatten().map(|x| x as i32),
        _ => None,
    }
}
fn col_u64(c: Option<&PropColumn>, row: usize) -> Option<u64> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::U64(v) => v.get(row).copied().flatten(),
        VarVec::U32(v) => v.get(row).copied().flatten().map(|x| x as u64),
        VarVec::I32(v) => v.get(row).copied().flatten().map(|x| x as u64),
        VarVec::String(v) => v.get(row).and_then(|s| s.as_ref()).and_then(|s| s.parse().ok()),
        VarVec::StrDict(d) => d.get(row).and_then(|s| s.parse().ok()),
        _ => None,
    }
}
fn col_bool(c: Option<&PropColumn>, row: usize) -> bool {
    match c.and_then(|c| c.data.as_ref()) {
        Some(VarVec::Bool(v)) => v.get(row).copied().flatten().unwrap_or(false),
        Some(_) => col_f64(c, row).map(|x| x != 0.0).unwrap_or(false),
        None => false,
    }
}
fn col_str(c: Option<&PropColumn>, row: usize) -> Option<&str> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::String(v) => v.get(row).and_then(|s| s.as_deref()),
        VarVec::StrDict(d) => d.get(row),
        _ => None,
    }
}
fn col_xyz(c: Option<&PropColumn>, row: usize) -> Option<[f32; 3]> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::XYZVec(v) => v.get(row).copied().flatten(),
        VarVec::XYVec(v) => v.get(row).copied().flatten().map(|a| [a[0], a[1], 0.0]),
        _ => None,
    }
}
fn col_u64s(c: Option<&PropColumn>, row: usize) -> Option<&[u64]> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::U64Vec(v) => v.get(row).map(|x| &x[..]),
        _ => None,
    }
}
fn col_strs(c: Option<&PropColumn>, row: usize) -> Option<&[String]> {
    match c.and_then(|c| c.data.as_ref())? {
        VarVec::StringVec(v) => v.get(row).map(|x| &x[..]),
        _ => None,
    }
}
fn col_len(c: Option<&PropColumn>) -> usize {
    c.map(|c| c.len()).unwrap_or(0)
}

/// Lookup table of strings; id 0 is ''. Sorted at the end so ids do not depend on row order.
struct Names {
    list: Vec<String>,
    idx: AHashMap<String, u8>,
}
impl Names {
    fn new() -> Self {
        Names { list: vec![String::new()], idx: AHashMap::default() }
    }
    fn id(&mut self, s: Option<&str>) -> u8 {
        let Some(s) = s else { return 0 };
        if s.is_empty() {
            return 0;
        }
        if let Some(&i) = self.idx.get(s) {
            return i;
        }
        if self.list.len() >= 255 {
            return 0;
        }
        let i = self.list.len() as u8;
        self.list.push(s.to_string());
        self.idx.insert(s.to_string(), i);
        i
    }
    fn sorted(self) -> (Vec<String>, Vec<u8>) {
        let mut order: Vec<usize> = (1..self.list.len()).collect();
        order.sort_by(|&a, &b| self.list[a].cmp(&self.list[b]));
        let mut remap = vec![0u8; 256];
        let mut list = vec![String::new()];
        for (new, &old) in order.iter().enumerate() {
            remap[old] = (new + 1) as u8;
            list.push(self.list[old].clone());
        }
        (list, remap)
    }
}

fn clamp_u8(v: Option<f32>) -> u8 {
    v.map(|x| x.round().clamp(0.0, 255.0) as u8).unwrap_or(0)
}
fn clamp_u16(v: Option<f32>) -> u16 {
    v.map(|x| x.round().clamp(0.0, 65535.0) as u16).unwrap_or(0)
}

/// Slot key: the SteamID, or for bots (SteamID 0) the name.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Key(u64, String);
fn key(steamid: u64, name: &str) -> Key {
    if steamid == 0 {
        Key(0, name.to_string())
    } else {
        Key(steamid, String::new())
    }
}
/// The key the contract sorts by: the Steam ID as a decimal string, `BOT-<name>` for bots.
fn sort_id(k: &Key) -> String {
    if k.0 == 0 {
        format!("BOT-{}", k.1)
    } else {
        k.0.to_string()
    }
}

struct Slots {
    by_key: AHashMap<Key, u16>,
    by_sid: AHashMap<u64, u16>,
    /// player name -> slot (the last slot with that name), the fallback of event fields
    by_name: AHashMap<String, u16>,
}
impl Slots {
    fn of(&self, sid: u64, name: Option<&str>) -> Option<u16> {
        if sid != 0 {
            self.by_sid.get(&sid).copied()
        } else {
            self.by_key.get(&key(0, name.unwrap_or(""))).copied()
        }
    }
    /// As the Node adapter's `slotOf`: by Steam ID (or bot name), else by player name.
    fn of_event(&self, sid: Option<u64>, name: Option<&str>) -> Option<u16> {
        sid.and_then(|s| self.of(s, name))
            .or_else(|| name.filter(|n| !n.is_empty()).and_then(|n| self.by_name.get(n).copied()))
    }
}

// ---- events helpers --------------------------------------------------------------------------

fn ev_field<'a>(e: &'a GameEvent, name: &str) -> Option<&'a Variant> {
    e.fields.iter().find(|f| f.name == name).and_then(|f| f.data.as_ref())
}
fn variant_u64(v: Option<&Variant>) -> Option<u64> {
    match v? {
        Variant::U64(x) => Some(*x),
        Variant::U32(x) => Some(*x as u64),
        Variant::I32(x) => Some(*x as u64),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}
fn variant_num(v: &Variant) -> Option<f64> {
    match v {
        Variant::Bool(b) => Some(*b as u8 as f64),
        Variant::U32(x) => Some(*x as f64),
        Variant::I32(x) => Some(*x as f64),
        Variant::F32(x) => Some(*x as f64),
        _ => None,
    }
}
fn ev_bool(e: &GameEvent, name: &str) -> bool {
    match ev_field(e, name) {
        Some(Variant::Bool(b)) => *b,
        Some(v) => variant_num(v).map(|x| x != 0.0).unwrap_or(false),
        None => false,
    }
}

/// `liveRange` of raw.ts, on the demo's own events.
fn live_range(events: &[GameEvent], first: i32, last: i32) -> (i32, i32) {
    let mut start = -1;
    for e in events {
        if e.name == "begin_new_match" {
            start = e.tick;
        }
    }
    if start < 0 {
        for e in events {
            if e.name == "round_start" && !ev_bool(e, "is_warmup_period") {
                start = e.tick;
                break;
            }
        }
    }
    if start < 0 {
        start = first;
    }
    let mut end = -1;
    for e in events {
        if e.name == "round_end" && e.tick >= start {
            end = e.tick;
        }
    }
    if end < 0 {
        end = last;
    }
    (start, end)
}

// ---- the parse -----------------------------------------------------------------------------

pub type Progress<'a> = &'a mut dyn FnMut(&str, f64);

pub fn parse(bytes: &[u8], progress: Progress) -> Result<Output, String> {
    let huf = create_huffman_lookup_table();

    // Pass 1: events and the header.
    progress("events", 0.0);
    let ev_out = run(bytes, settings(&huf, &[], &["total_rounds_played", "is_warmup_period"], vec!["all".to_string()], false))?;
    let header: BTreeMap<String, String> = ev_out.header.clone().unwrap_or_default().into_iter().collect();
    let game_events = ev_out.game_events;

    // Pass 2: the tick grid, one full-packet segment at a time (see `tick_grid`).
    let g = tick_grid(bytes, &huf, &game_events, progress)?;
    let TickGrid { players, slots, ticks, weapons, places, start, end } = g;

    // Pass 3: inventories and scoreboard totals on the ticks that need them.
    progress("inventories", 0.8);
    let (inventories, scoreboard) = inventories(bytes, &huf, &game_events, &slots, (start, end), end)?;

    // Pass 4: projectiles.
    progress("projectiles", 0.88);
    let pr = run(bytes, settings(&huf, &[], &[], vec![], true))?;
    let projectiles = projectiles(&pr, &slots);
    drop(pr);

    progress("tables", 0.97);
    let events = event_tables(&game_events, &slots);
    progress("done", 1.0);
    Ok(Output { header, players, weapons, places, ticks, events, projectiles, inventories, score_tick: end, scoreboard })
}

// ---- pass 2: the tick grid -------------------------------------------------------------------

/// Player rows kept from the segments, compact (about 80 bytes a row) until the player set is known.
#[derive(Default)]
struct Rows {
    tick: Vec<i32>,
    key: Vec<u16>,
    present: Vec<u8>,
    /// team_num (0 when null)
    team: Vec<u8>,
    game: Vec<u8>,
    rounds_played: Vec<u8>,
    /// team_rounds_total, 255 when null
    score: Vec<u8>,
    x: Vec<f32>,
    y: Vec<f32>,
    z: Vec<f32>,
    pitch: Vec<f32>,
    yaw: Vec<f32>,
    vx: Vec<f32>,
    vy: Vec<f32>,
    vz: Vec<f32>,
    health: Vec<u8>,
    armor: Vec<u8>,
    duck: Vec<u8>,
    weapon: Vec<u8>,
    clip: Vec<u8>,
    place: Vec<u8>,
    flags: Vec<u16>,
    buttons: Vec<u32>,
    /// bit k = key k (k < 64) is in approximate_spotted_by
    spotted_by: Vec<u64>,
    flash: Vec<f32>,
    penalty: Vec<f32>,
    punch_pitch: Vec<f32>,
    punch_yaw: Vec<f32>,
    recoil_index: Vec<f32>,
    shots_fired: Vec<u16>,
    money: Vec<u16>,
    equip: Vec<u16>,
}

struct TickGrid {
    players: Vec<Player>,
    slots: Slots,
    ticks: TickCols,
    weapons: Vec<String>,
    places: Vec<String>,
    start: i32,
    end: i32,
}

/// Keys (SteamID or bot name) in first-seen order.
#[derive(Default)]
struct Keys {
    list: Vec<(Key, String)>,
    idx: AHashMap<Key, u16>,
    by_sid: AHashMap<u64, u16>,
}
impl Keys {
    fn id(&mut self, sid: u64, name: &str) -> u16 {
        if sid != 0 {
            if let Some(&k) = self.by_sid.get(&sid) {
                return k;
            }
        }
        let k = key(sid, name);
        if let Some(&i) = self.idx.get(&k) {
            return i;
        }
        let i = self.list.len() as u16;
        self.list.push((k.clone(), name.to_string()));
        self.idx.insert(k, i);
        if sid != 0 {
            self.by_sid.insert(sid, i);
        }
        i
    }
}

/// Upstream's multi-threaded mode parses the demo in segments that start at each full packet (every 3840 ticks in
/// Valve demos); we run the same segments one after another, so only one segment's row table exists at a time, the
/// rows are kept compact, and progress can be reported per segment. Same rows as the native adapter (which runs
/// upstream multi-threaded): velocity, derived from the previous ticks of a segment, starts NaN in each segment as
/// there.
fn tick_grid(bytes: &[u8], huf: &Vec<(u8, u8)>, events: &[GameEvent], progress: Progress) -> Result<TickGrid, String> {
    let s = settings(huf, TICK_PROPS, &[], vec![], false);
    let mut fp = FirstPassParser::new(&s);
    let fpo = fp.parse_demo(bytes, false).map_err(|e| format!("parse: {e}"))?;
    let id_of: AHashMap<String, u32> =
        fpo.prop_controller.prop_infos.iter().map(|p| (p.prop_friendly_name.clone(), p.id)).collect();
    let (start, end) = live_range(events, i32::MIN, i32::MAX);
    let in_range = |t: i32| t != i32::MIN && t >= start && t <= end;
    let mut rows = Rows::default();
    let mut keys = Keys::default();
    let mut weapon_names = Names::new();
    let mut place_names = Names::new();
    let offsets = fpo.fullpacket_offsets.clone();
    let nseg = offsets.len().max(1);
    for (si, off) in offsets.iter().enumerate() {
        let mut sp = SecondPassParser::new(fpo.clone(), *off, false, None).map_err(|e| format!("parse: {e}"))?;
        sp.start(bytes).map_err(|e| format!("parse: {e}"))?;
        let df = sp.create_output().df;
        append_rows(&df, &id_of, &in_range, &mut rows, &mut keys, &mut weapon_names, &mut place_names);
        drop(df);
        progress("ticks", 0.12 + 0.66 * (si + 1) as f64 / nseg as f64);
    }
    drop(fpo);
    progress("columns", 0.78);

    let n_rows = rows.tick.len();
    let first = rows.tick.iter().copied().min().unwrap_or(0);
    let last = rows.tick.iter().copied().max().unwrap_or(-1);
    let (start, end) = (start.max(first), end.min(last));

    // Players: present at some tick of the live range; sorted by the team of their first present row (T first),
    // then by Steam ID (bots: BOT-<name>); the name is the one of that first row.
    let mut first_row: AHashMap<u16, (i32, usize)> = AHashMap::default();
    for r in 0..n_rows {
        if rows.present[r] == 0 {
            continue;
        }
        let k = rows.key[r];
        let t = rows.tick[r];
        match first_row.get(&k) {
            Some(&(t0, _)) if t0 <= t => {}
            _ => {
                first_row.insert(k, (t, r));
            }
        }
    }
    let mut order: Vec<(u8, String, u16, usize)> = first_row
        .iter()
        .map(|(&k, &(_, r))| (rows.team[r], sort_id(&keys.list[k as usize].0), k, r))
        .collect();
    order.sort();
    let mut players = Vec::new();
    let mut slots = Slots { by_key: AHashMap::default(), by_sid: AHashMap::default(), by_name: AHashMap::default() };
    let mut slot_of_key = vec![u16::MAX; keys.list.len()];
    for (i, (_, _, k, _)) in order.iter().enumerate() {
        let (key, _) = &keys.list[*k as usize];
        slots.by_key.insert(key.clone(), i as u16);
        if key.0 != 0 {
            slots.by_sid.insert(key.0, i as u16);
        }
        slot_of_key[*k as usize] = i as u16;
    }
    for (_, _, k, _) in &order {
        let (key, name) = &keys.list[*k as usize];
        players.push(Player { steamid: key.0, name: name.clone(), bot: key.0 == 0 });
    }
    for (i, p) in players.iter().enumerate() {
        slots.by_name.insert(p.name.clone(), i as u16);
    }
    let np = players.len();
    if np > 16 {
        return Err(format!("{np} players in the demo; the columns hold at most 16"));
    }

    // Tick list and the dense index of each row (u32::MAX = not a present player row).
    let mut tick_list: Vec<i32> = rows.tick.clone();
    tick_list.sort_unstable();
    tick_list.dedup();
    let tc = tick_list.len();
    let n = tc * np;
    let row_ti: Vec<u32> = rows.tick.iter().map(|t| tick_list.binary_search(t).map(|i| i as u32).unwrap_or(u32::MAX)).collect();
    let dense: Vec<u32> = (0..n_rows)
        .map(|r| {
            let p = slot_of_key[rows.key[r] as usize];
            if rows.present[r] == 0 || p == u16::MAX {
                u32::MAX
            } else {
                row_ti[r] * np as u32 + p as u32
            }
        })
        .collect();

    // [T] columns: the first row of a tick sets game/roundsPlayed; scores come from player rows by team.
    let mut game = vec![0u8; tc];
    let mut rounds_played = vec![0u8; tc];
    let mut score_t = vec![255u8; tc];
    let mut score_ct = vec![255u8; tc];
    let mut seen = vec![false; tc];
    for r in 0..n_rows {
        let ti = row_ti[r] as usize;
        if !seen[ti] {
            seen[ti] = true;
            game[ti] = rows.game[r];
            rounds_played[ti] = rows.rounds_played[r];
        }
        if slot_of_key[rows.key[r] as usize] != u16::MAX && rows.score[r] != 255 {
            match rows.team[r] {
                2 => score_t[ti] = rows.score[r],
                3 => score_ct[ti] = rows.score[r],
                _ => {}
            }
        }
    }
    drop(seen);
    drop(row_ti);

    // scatter each row column into its dense column, freeing the row column right away
    fn scatter<T: Copy>(n: usize, dense: &[u32], src: Vec<T>, zero: T) -> Vec<T> {
        let mut v = vec![zero; n];
        for (r, &i) in dense.iter().enumerate() {
            if i != u32::MAX {
                v[i as usize] = src[r];
            }
        }
        v
    }
    let mut present = vec![0u8; n];
    for &i in &dense {
        if i != u32::MAX {
            present[i as usize] = 1;
        }
    }
    let Rows {
        x, y, z, pitch, yaw, vx, vy, vz, health, armor, duck, weapon, clip, team, place, flags, buttons, spotted_by,
        flash, penalty, punch_pitch, punch_yaw, recoil_index, shots_fired, money, equip, ..
    } = rows;
    let x = scatter(n, &dense, x, 0.0);
    let y = scatter(n, &dense, y, 0.0);
    let z = scatter(n, &dense, z, 0.0);
    let pitch = scatter(n, &dense, pitch, 0.0);
    let yaw = scatter(n, &dense, yaw, 0.0);
    let vx = scatter(n, &dense, vx, 0.0);
    let vy = scatter(n, &dense, vy, 0.0);
    let vz = scatter(n, &dense, vz, 0.0);
    let health = scatter(n, &dense, health, 0);
    let armor = scatter(n, &dense, armor, 0);
    let duck = scatter(n, &dense, duck, 0);
    let mut weapon = scatter(n, &dense, weapon, 0);
    let clip = scatter(n, &dense, clip, 0);
    let team = scatter(n, &dense, team, 0);
    let mut place = scatter(n, &dense, place, 0);
    let flags = scatter(n, &dense, flags, 0);
    let buttons = scatter(n, &dense, buttons, 0);
    // key bit masks -> slot bit masks
    let spotted_by: Vec<u16> = {
        let raw = scatter(n, &dense, spotted_by, 0u64);
        raw.iter()
            .map(|&m| {
                let mut out = 0u16;
                let mut b = m;
                while b != 0 {
                    let k = b.trailing_zeros() as usize;
                    b &= b - 1;
                    if let Some(&s) = slot_of_key.get(k) {
                        if s != u16::MAX && s < 16 {
                            out |= 1 << s;
                        }
                    }
                }
                out
            })
            .collect()
    };
    let flash = scatter(n, &dense, flash, 0.0);
    let penalty = scatter(n, &dense, penalty, 0.0);
    let punch_pitch = scatter(n, &dense, punch_pitch, 0.0);
    let punch_yaw = scatter(n, &dense, punch_yaw, 0.0);
    let recoil_index = scatter(n, &dense, recoil_index, 0.0);
    let shots_fired = scatter(n, &dense, shots_fired, 0);
    let money = scatter(n, &dense, money, 0);
    let equip = scatter(n, &dense, equip, 0);
    drop(dense);
    let (weapons, wmap) = weapon_names.sorted();
    let (places, pmap) = place_names.sorted();
    for w in weapon.iter_mut() {
        *w = wmap[*w as usize];
    }
    for w in place.iter_mut() {
        *w = pmap[*w as usize];
    }
    let ticks = TickCols {
        count: tc, players: np, tick: tick_list, game, rounds_played, score_t, score_ct, present, x, y, z, pitch,
        yaw, vx, vy, vz, health, armor, duck, weapon, clip, team, place, flags, buttons, spotted_by, flash, penalty,
        punch_pitch, punch_yaw, recoil_index, shots_fired, money, equip,
    };
    Ok(TickGrid { players, slots, ticks, weapons, places, start, end })
}

/// Appends one segment's rows (inside the live range) to `rows`.
fn append_rows(
    df: &AHashMap<u32, PropColumn>,
    id_of: &AHashMap<String, u32>,
    in_range: &dyn Fn(i32) -> bool,
    rows: &mut Rows,
    keys: &mut Keys,
    weapons: &mut Names,
    places: &mut Names,
) {
    let c = |name: &str| id_of.get(name).and_then(|id| df.get(id));
    let (ct, cs, cn) = (df.get(&TICK_ID), df.get(&STEAMID_ID), df.get(&NAME_ID));
    let n = col_len(ct);
    let (cx, cy, cz, cpi, cya) = (c("X"), c("Y"), c("Z"), c("pitch"), c("yaw"));
    let (cvx, cvy, cvz) = (c("velocity_X"), c("velocity_Y"), c("velocity_Z"));
    let (chp, car, cdu, cwe, ccl) = (c("health"), c("armor_value"), c("duck_amount"), c("active_weapon_name"), c("active_weapon_ammo"));
    let (cte, cpl, cbu, csb, cfl) = (c("team_num"), c("last_place_name"), c("buttons"), c("approximate_spotted_by"), c("flash_duration"));
    let (cpe, cpu, cre, csf, cmo, ceq) =
        (c("accuracy_penalty"), c("aim_punch_angle"), c("fl_recoil_idx"), c("shots_fired"), c("balance"), c("current_equip_value"));
    let (crp, csc) = (c("total_rounds_played"), c("team_rounds_total"));
    let gcols: Vec<Option<&PropColumn>> = GAME_PROPS.iter().map(|p| c(p)).collect();
    let fcols: Vec<Option<&PropColumn>> = FLAG_PROPS.iter().map(|p| c(p)).collect();
    // Non-finite -> 0 where the Node adapter reads with num(); NaN kept where it reads with f32().
    let fz = |col: Option<&PropColumn>, r: usize| col_f32(col, r).filter(|v| v.is_finite()).unwrap_or(0.0);
    let fnan = |col: Option<&PropColumn>, r: usize| col_f32(col, r).unwrap_or(f32::NAN);
    for r in 0..n {
        let Some(t) = col_i32(ct, r) else { continue };
        if !in_range(t) {
            continue;
        }
        let sid = col_u64(cs, r).unwrap_or(0);
        let name = col_str(cn, r).unwrap_or("");
        let k = keys.id(sid, name);
        let team = col_i32(cte, r);
        let xv = col_f32(cx, r);
        let present = xv.is_some() && matches!(team, Some(2) | Some(3));
        rows.tick.push(t);
        rows.key.push(k);
        rows.present.push(present as u8);
        rows.team.push(team.map(|v| v.clamp(0, 255) as u8).unwrap_or(0));
        let mut g = 0u8;
        for (b, gc) in gcols.iter().enumerate() {
            if col_bool(*gc, r) {
                g |= 1 << b;
            }
        }
        rows.game.push(g);
        rows.rounds_played.push(clamp_u8(col_f32(crp, r)));
        rows.score.push(col_f32(csc, r).map(|v| clamp_u8(Some(v))).unwrap_or(255));
        if !present {
            // only the tick, key, team and game columns matter for a row that is not a present player
            rows.x.push(0.0);
            rows.y.push(0.0);
            rows.z.push(0.0);
            rows.pitch.push(0.0);
            rows.yaw.push(0.0);
            rows.vx.push(0.0);
            rows.vy.push(0.0);
            rows.vz.push(0.0);
            rows.health.push(0);
            rows.armor.push(0);
            rows.duck.push(0);
            rows.weapon.push(0);
            rows.clip.push(0);
            rows.place.push(0);
            rows.flags.push(0);
            rows.buttons.push(0);
            rows.spotted_by.push(0);
            rows.flash.push(0.0);
            rows.penalty.push(0.0);
            rows.punch_pitch.push(0.0);
            rows.punch_yaw.push(0.0);
            rows.recoil_index.push(0.0);
            rows.shots_fired.push(0);
            rows.money.push(0);
            rows.equip.push(0);
            continue;
        }
        rows.x.push(xv.unwrap_or(f32::NAN));
        rows.y.push(fnan(cy, r));
        rows.z.push(fnan(cz, r));
        rows.pitch.push(fnan(cpi, r));
        rows.yaw.push(fnan(cya, r));
        rows.vx.push(fnan(cvx, r));
        rows.vy.push(fnan(cvy, r));
        rows.vz.push(fnan(cvz, r));
        rows.health.push(clamp_u8(col_f32(chp, r)));
        rows.armor.push(clamp_u8(col_f32(car, r)));
        rows.duck.push(clamp_u8(col_f32(cdu, r).map(|d| d * 255.0)));
        rows.weapon.push(weapons.id(col_str(cwe, r)));
        rows.clip.push(col_f32(ccl, r).map(|v| clamp_u8(Some(v))).unwrap_or(CLIP_NONE));
        rows.place.push(places.id(col_str(cpl, r)));
        let mut f = 0u16;
        for (b, fc) in fcols.iter().enumerate() {
            let on = if b == FLAG_CONNECTED { col_i32(*fc, r) == Some(0) } else { col_bool(*fc, r) };
            if on {
                f |= 1 << b;
            }
        }
        rows.flags.push(f);
        rows.buttons.push(col_u64(cbu, r).unwrap_or(0) as u32);
        let mut m = 0u64;
        for s in col_u64s(csb, r).unwrap_or(&[]) {
            let q = keys.id(*s, "");
            if q < 64 {
                m |= 1 << q;
            }
        }
        rows.spotted_by.push(m);
        rows.flash.push(fz(cfl, r));
        rows.penalty.push(fz(cpe, r));
        let (pp, py) = match col_xyz(cpu, r) {
            Some(v) => (if v[0].is_finite() { v[0] } else { 0.0 }, if v[1].is_finite() { v[1] } else { 0.0 }),
            None => (0.0, 0.0),
        };
        rows.punch_pitch.push(pp);
        rows.punch_yaw.push(py);
        rows.recoil_index.push(fz(cre, r));
        rows.shots_fired.push(clamp_u16(col_f32(csf, r)));
        rows.money.push(clamp_u16(col_f32(cmo, r)));
        rows.equip.push(clamp_u16(col_f32(ceq, r)));
    }
}

// ---- pass 3 ---------------------------------------------------------------------------------

fn inventories(
    bytes: &[u8],
    huf: &Vec<(u8, u8)>,
    events: &[GameEvent],
    slots: &Slots,
    range: (i32, i32),
    score_tick: i32,
) -> Result<(Vec<Inventory>, Vec<ScoreRow>), String> {
    // tick -> (kind, victim SteamID for deaths): freeze ends and round ends inside the live range,
    // and the tick before each death.
    let mut want: BTreeMap<i32, Vec<(u8, u64)>> = BTreeMap::new();
    for e in events {
        if e.tick < range.0 || e.tick > range.1 {
            continue;
        }
        match e.name.as_str() {
            "round_freeze_end" | "round_end" => {
                let at = if e.name == "round_end" { 2 } else { 0 };
                let w = want.entry(e.tick).or_default();
                w.retain(|x| x.0 == 1);
                w.push((at, 0));
            }
            "player_death" => {
                if let Some(s) = variant_u64(ev_field(e, "user_steamid")) {
                    want.entry(e.tick - 1).or_default().push((1, s));
                }
            }
            _ => {}
        }
    }
    want.entry(score_tick).or_default();
    let mut props: Vec<&str> = vec!["inventory", "X", "team_num"];
    props.extend_from_slice(SCORE_PROPS);
    let mut s = settings(huf, &props, &[], vec![], false);
    s.wanted_ticks = want.keys().copied().collect();
    let out = run(bytes, s)?;
    let id = |name: &str| out.prop_controller.prop_infos.iter().find(|p| p.prop_friendly_name == name).map(|p| p.id);
    let df = &out.df;
    let colp = |name: &str| id(name).and_then(|i| df.get(&i));
    let (ct, cs, cn) = (df.get(&TICK_ID), df.get(&STEAMID_ID), df.get(&NAME_ID));
    let (ci, cx, cteam) = (colp("inventory"), colp("X"), colp("team_num"));
    let score_cols: Vec<Option<&PropColumn>> = SCORE_PROPS.iter().map(|p| colp(p)).collect();
    let mut inv = Vec::new();
    let mut score: BTreeMap<i16, ScoreRow> = BTreeMap::new();
    for r in 0..col_len(ct) {
        let Some(t) = col_i32(ct, r) else { continue };
        let sid = col_u64(cs, r).unwrap_or(0);
        let Some(p) = slots.of(sid, col_str(cn, r)) else { continue };
        let p = p as i16;
        if t == score_tick {
            let mut v = [0.0f64; 9];
            for (j, c) in score_cols.iter().enumerate() {
                v[j] = col_f64(*c, r).unwrap_or(0.0);
            }
            score.insert(p, ScoreRow { p, v });
        }
        let Some(w) = want.get(&t) else { continue };
        let _ = cx;
        let on_team = matches!(col_i32(cteam, r), Some(2) | Some(3));
        for &(at, victim) in w {
            let ok = if at == 1 { slots.of(victim, None) == Some(p as u16) } else { on_team };
            if !ok {
                continue;
            }
            let items: Vec<String> = col_strs(ci, r).map(|x| x.to_vec()).unwrap_or_default();
            // a death's inventory is read on the tick before and filed at the death tick
            inv.push(Inventory { tick: if at == 1 { t + 1 } else { t }, p, at, items });
        }
    }
    inv.sort_by(|a, b| (a.tick, a.at, a.p).cmp(&(b.tick, b.at, b.p)));
    Ok((inv, score.into_values().collect()))
}

// ---- events ---------------------------------------------------------------------------------

fn event_tables(events: &[GameEvent], slots: &Slots) -> Vec<EventTable> {
    let mut by: BTreeMap<&str, Vec<(u32, &GameEvent)>> = BTreeMap::new();
    for (i, e) in events.iter().enumerate() {
        by.entry(e.name.as_str()).or_default().push((i as u32, e));
    }
    let mut out = Vec::new();
    for (name, list) in by {
        // field -> kind (0 num, 1 str, 2 slot); sorted by name for a stable layout
        let mut kinds: BTreeMap<&str, u8> = BTreeMap::new();
        for (_, e) in &list {
            for f in &e.fields {
                if f.name == "tick" || f.name == "event_name" {
                    continue;
                }
                let k = if f.name.ends_with("_steamid") || f.name == "steamid" || f.name == "xuid" {
                    2
                } else {
                    match &f.data {
                        Some(Variant::String(_)) | Some(Variant::U64(_)) => 1,
                        _ => 0,
                    }
                };
                let e = kinds.entry(f.name.as_str()).or_insert(k);
                if *e == 0 && k == 1 {
                    *e = 1;
                }
            }
        }
        // `<role>_name` duplicates the slot of `<role>_steamid`: dropped
        let roles: Vec<String> = kinds.keys().filter_map(|k| k.strip_suffix("_steamid").map(|r| format!("{r}_name"))).collect();
        kinds.retain(|k, _| !roles.iter().any(|r| r == k));
        let tick: Vec<i32> = list.iter().map(|(_, e)| e.tick).collect();
        let seq: Vec<u32> = list.iter().map(|(i, _)| *i).collect();
        let mut columns = Vec::new();
        for (fname, k) in kinds {
            let data = match k {
                2 => {
                    let role = fname.strip_suffix("_steamid").unwrap_or("");
                    let name_field = if role.is_empty() { "name".to_string() } else { format!("{role}_name") };
                    // `xuid` (player_disconnect) falls back to `user_steamid` when absent
                    let fallback = if fname == "xuid" { Some("user_steamid") } else { None };
                    EventData::Slot(
                        list.iter()
                            .map(|(_, e)| {
                                let sid = variant_u64(ev_field(e, fname)).or_else(|| fallback.and_then(|f| variant_u64(ev_field(e, f))));
                                let nm = match ev_field(e, &name_field) {
                                    Some(Variant::String(s)) => Some(s.as_str()),
                                    _ => None,
                                };
                                slots.of_event(sid, nm).map(|q| q as i16).unwrap_or(-1)
                            })
                            .collect(),
                    )
                }
                1 => EventData::Str(
                    list.iter()
                        .map(|(_, e)| match ev_field(e, fname) {
                            Some(Variant::String(s)) => Some(s.clone()),
                            Some(Variant::U64(x)) => Some(x.to_string()),
                            Some(v) => variant_num(v).map(|x| x.to_string()),
                            None => None,
                        })
                        .collect(),
                ),
                _ => EventData::Num(
                    list.iter().map(|(_, e)| ev_field(e, fname).and_then(variant_num).unwrap_or(f64::NAN)).collect(),
                ),
            };
            columns.push(EventColumn { name: fname.to_string(), data });
        }
        out.push(EventTable { name: name.to_string(), tick, seq, columns });
    }
    out
}

// ---- pass 4 ---------------------------------------------------------------------------------

fn projectiles(pr: &DemoOutput, slots: &Slots) -> Vec<Projectile> {
    let df = &pr.df;
    let (ct, cty, cent, csid, cname) =
        (df.get(&TICK_ID), df.get(&GRENADE_TYPE_ID), df.get(&ENTITY_ID_ID), df.get(&STEAMID_ID), df.get(&NAME_ID));
    let (cx, cy, cz) = (df.get(&GRENADE_X), df.get(&GRENADE_Y), df.get(&GRENADE_Z));
    struct Acc {
        kind: String,
        thrower: i16,
        entity: i32,
        first: i32,
        last: i32,
        samples: Vec<(i32, [f32; 3])>,
    }
    // Rows come in tick order. An entity id is reused once a projectile is gone, so a new flight
    // starts when the type changes or the entity was absent for more than a few ticks.
    let mut open: AHashMap<i32, Acc> = AHashMap::default();
    let mut done: Vec<Acc> = Vec::new();
    for r in 0..col_len(ct) {
        let Some(t) = col_i32(ct, r) else { continue };
        let ent = col_i32(cent, r).unwrap_or(-1);
        let kind = col_str(cty, r).unwrap_or("");
        let thrower = slots.of(col_u64(csid, r).unwrap_or(0), col_str(cname, r)).map(|q| q as i16).unwrap_or(-1);
        let restart = match open.get(&ent) {
            Some(a) => a.kind != kind || a.thrower != thrower || t - a.last > PROJECTILE_GAP,
            None => true,
        };
        if restart {
            if let Some(a) = open.remove(&ent) {
                done.push(a);
            }
            open.insert(ent, Acc { kind: kind.to_string(), thrower, entity: ent, first: t, last: t, samples: Vec::new() });
        }
        let a = open.get_mut(&ent).unwrap();
        a.last = t;
        if let (Some(x), Some(y), Some(z)) = (col_f32(cx, r), col_f32(cy, r), col_f32(cz, r)) {
            a.samples.push((t, [x, y, z]));
        }
    }
    done.extend(open.into_values());
    let mut out: Vec<Projectile> = done
        .into_iter()
        .map(|a| {
            let (t0, t1) = (a.first, a.last);
            let steps = ((t1 - t0) / PATH_STEP + 1) as usize;
            let mut path = vec![PATH_NONE; steps * 3];
            for (t, p) in &a.samples {
                if (t - t0) % PATH_STEP != 0 {
                    continue;
                }
                let k = ((t - t0) / PATH_STEP) as usize;
                for d in 0..3 {
                    // JS Math.round (half up), as the Node adapter
                    path[k * 3 + d] = (p[d] + 0.5).floor().clamp(-32767.0, 32767.0) as i16;
                }
            }
            Projectile { kind: a.kind, thrower: a.thrower, entity: a.entity, t0, t1, path }
        })
        .collect();
    out.sort_by(|a, b| (a.t0, a.entity).cmp(&(b.t0, b.entity)));
    out
}

/// A gap longer than this (ticks) between rows of one entity starts a new projectile (ids are reused).
const PROJECTILE_GAP: i32 = 16;
