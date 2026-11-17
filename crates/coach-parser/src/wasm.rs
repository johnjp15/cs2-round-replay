//! The WebAssembly entry (wasm-bindgen). One `Session` per demo:
//!   const s = new Session(file.size); for (chunk of file) s.push(chunk); const raw = s.parse(onProgress);
//! The file is streamed into WebAssembly memory chunk by chunk (hashed on the way), so JavaScript never
//! holds the whole file. `parse` decompresses if needed (freeing the compressed bytes), runs the
//! passes and returns plain objects whose columns are fresh typed arrays (copied out of WebAssembly
//! memory one at a time, each Rust column freed right after), ready to be transferred.

use crate::container;
use crate::extract::{self, EventData};
use js_sys::{Array, Float32Array, Float64Array, Function, Int16Array, Int32Array, Object, Reflect, Uint16Array, Uint32Array, Uint8Array};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Session {
    buf: Vec<u8>,
    sha: Sha256,
}

fn set(o: &Object, k: &str, v: impl Into<JsValue>) {
    let _ = Reflect::set(o, &JsValue::from_str(k), &v.into());
}

#[wasm_bindgen]
impl Session {
    /// `size`: the file size in bytes (the buffer is reserved once, exactly).
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> Session {
        Session { buf: Vec::with_capacity(size), sha: Sha256::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.sha.update(chunk);
        self.buf.extend_from_slice(chunk);
    }

    /// Parses the pushed bytes. `progress(stage: string, fraction: number)` is called between passes.
    pub fn parse(&mut self, progress: &Function) -> Result<JsValue, JsError> {
        let sha = format!("{:x}", std::mem::take(&mut self.sha).finalize());
        let file_bytes = self.buf.len();
        let input = std::mem::take(&mut self.buf);
        let mut prog = |stage: &str, f: f64| {
            let _ = progress.call2(&JsValue::NULL, &JsValue::from_str(stage), &JsValue::from_f64(f));
        };
        prog("decompress", 0.0);
        let (c, bytes) = container::open(input).map_err(|e| JsError::new(&e))?;
        let demo_bytes = bytes.len();
        let out = extract::parse(&bytes, &mut prog).map_err(|e| JsError::new(&e))?;
        drop(bytes);
        Ok(to_js(out, c.name(), sha, file_bytes, demo_bytes).into())
    }
}

/// Bytes of WebAssembly memory right now (the high-water mark: wasm memory never shrinks).
#[wasm_bindgen(js_name = wasmMemoryBytes)]
pub fn wasm_memory_bytes() -> f64 {
    (core::arch::wasm32::memory_size(0) * 65536) as f64
}

#[wasm_bindgen(js_name = parserVersion)]
pub fn parser_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn to_js(o: extract::Output, container: &str, sha: String, file_bytes: usize, demo_bytes: usize) -> Object {
    let r = Object::new();
    set(&r, "container", container);
    set(&r, "sha256", sha);
    set(&r, "fileBytes", file_bytes as f64);
    set(&r, "demoBytes", demo_bytes as f64);
    let h = Object::new();
    for (k, v) in &o.header {
        set(&h, k, v.as_str());
    }
    set(&r, "header", h);
    let players = Array::new();
    for p in &o.players {
        let x = Object::new();
        set(&x, "steamid", p.steamid.to_string());
        set(&x, "name", p.name.as_str());
        set(&x, "bot", p.bot);
        players.push(&x);
    }
    set(&r, "players", players);
    set(&r, "weapons", strs(&o.weapons));
    set(&r, "places", strs(&o.places));

    let t = o.ticks;
    let tk = Object::new();
    set(&tk, "count", t.count as f64);
    set(&tk, "players", t.players as f64);
    // each column: copy out, then free the Rust vector before the next one
    macro_rules! col {
        ($name:literal, $field:expr, $ty:ident) => {{
            let v = $field;
            set(&tk, $name, $ty::from(&v[..]));
            drop(v);
        }};
    }
    col!("tick", t.tick, Int32Array);
    col!("game", t.game, Uint8Array);
    col!("roundsPlayed", t.rounds_played, Uint8Array);
    col!("scoreT", t.score_t, Uint8Array);
    col!("scoreCT", t.score_ct, Uint8Array);
    col!("present", t.present, Uint8Array);
    col!("x", t.x, Float32Array);
    col!("y", t.y, Float32Array);
    col!("z", t.z, Float32Array);
    col!("pitch", t.pitch, Float32Array);
    col!("yaw", t.yaw, Float32Array);
    col!("vx", t.vx, Float32Array);
    col!("vy", t.vy, Float32Array);
    col!("vz", t.vz, Float32Array);
    col!("health", t.health, Uint8Array);
    col!("armor", t.armor, Uint8Array);
    col!("duck", t.duck, Uint8Array);
    col!("weapon", t.weapon, Uint8Array);
    col!("clip", t.clip, Uint8Array);
    col!("team", t.team, Uint8Array);
    col!("place", t.place, Uint8Array);
    col!("flags", t.flags, Uint16Array);
    col!("buttons", t.buttons, Uint32Array);
    col!("spottedBy", t.spotted_by, Uint16Array);
    col!("flash", t.flash, Float32Array);
    col!("penalty", t.penalty, Float32Array);
    col!("punchPitch", t.punch_pitch, Float32Array);
    col!("punchYaw", t.punch_yaw, Float32Array);
    col!("recoilIndex", t.recoil_index, Float32Array);
    col!("shotsFired", t.shots_fired, Uint16Array);
    col!("money", t.money, Uint16Array);
    col!("equip", t.equip, Uint16Array);
    set(&r, "ticks", tk);

    let evs = Array::new();
    for e in o.events {
        let x = Object::new();
        set(&x, "name", e.name.as_str());
        set(&x, "tick", Int32Array::from(&e.tick[..]));
        set(&x, "seq", Uint32Array::from(&e.seq[..]));
        let cols = Array::new();
        for c in e.columns {
            let y = Object::new();
            set(&y, "name", c.name.as_str());
            match c.data {
                EventData::Num(v) => {
                    set(&y, "kind", "num");
                    set(&y, "data", Float64Array::from(&v[..]));
                }
                EventData::Slot(v) => {
                    set(&y, "kind", "slot");
                    set(&y, "data", Int16Array::from(&v[..]));
                }
                EventData::Str(v) => {
                    set(&y, "kind", "str");
                    let a = Array::new();
                    for s in &v {
                        a.push(&match s {
                            Some(s) => JsValue::from_str(s),
                            None => JsValue::NULL,
                        });
                    }
                    set(&y, "data", a);
                }
            }
            cols.push(&y);
        }
        set(&x, "columns", cols);
        evs.push(&x);
    }
    set(&r, "events", evs);

    let prs = Array::new();
    for p in &o.projectiles {
        let x = Object::new();
        set(&x, "kind", p.kind.as_str());
        set(&x, "thrower", p.thrower as f64);
        set(&x, "entity", p.entity as f64);
        set(&x, "t0", p.t0 as f64);
        set(&x, "t1", p.t1 as f64);
        set(&x, "path", Int16Array::from(&p.path[..]));
        prs.push(&x);
    }
    set(&r, "projectiles", prs);
    let inv = Array::new();
    for i in &o.inventories {
        let x = Object::new();
        set(&x, "tick", i.tick as f64);
        set(&x, "p", i.p as f64);
        set(&x, "at", i.at as f64);
        set(&x, "items", strs(&i.items));
        inv.push(&x);
    }
    set(&r, "inventories", inv);
    set(&r, "scoreTick", o.score_tick as f64);
    let sb = Array::new();
    for s in &o.scoreboard {
        let x = Object::new();
        set(&x, "p", s.p as f64);
        set(&x, "v", Float64Array::from(&s.v[..]));
        sb.push(&x);
    }
    set(&r, "scoreboard", sb);
    r
}

fn strs(v: &[String]) -> Array {
    let a = Array::new();
    for s in v {
        a.push(&JsValue::from_str(s));
    }
    a
}
