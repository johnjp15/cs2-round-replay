//! Development entry: parse a demo natively and print counts, timings and peak RSS.
//! `cargo run --release --bin coach-parser-native -- <demo>`
use coach_parser::{container, extract};
use std::time::Instant;

fn vm_hwm() -> String {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.to_string()))
        .unwrap_or_default()
}

fn main() {
    let path = std::env::args().nth(1).expect("demo path");
    let t = Instant::now();
    let raw = std::fs::read(&path).expect("read");
    let (c, bytes) = container::open(raw).expect("open");
    eprintln!("open {:?} {} bytes {:.2}s {}", c, bytes.len(), t.elapsed().as_secs_f64(), vm_hwm());
    let mut last = Instant::now();
    let mut prog = |stage: &str, f: f64| {
        eprintln!("  {stage:12} {f:.2} +{:.2}s {}", last.elapsed().as_secs_f64(), vm_hwm());
        last = Instant::now();
    };
    let out = extract::parse(&bytes, &mut prog).expect("parse");
    eprintln!("total {:.2}s {}", t.elapsed().as_secs_f64(), vm_hwm());
    println!("players {} ticks {} rows {}", out.players.len(), out.ticks.count, out.ticks.count * out.players.len());
    println!("weapons {:?}", out.weapons);
    println!("places {:?}", out.places);
    for e in &out.events {
        let cols: Vec<&str> = e.columns.iter().map(|c| c.name.as_str()).collect();
        println!("event {} {} {:?}", e.name, e.tick.len(), cols);
    }
    println!("projectiles {} inventories {} scoreboard {}", out.projectiles.len(), out.inventories.len(), out.scoreboard.len());
    let mut kinds: Vec<&str> = out.projectiles.iter().map(|p| p.kind.as_str()).collect(); kinds.sort(); kinds.dedup();
    println!("projectile kinds {:?}", kinds);
    println!("first tick {} last {}", out.ticks.tick.first().unwrap_or(&0), out.ticks.tick.last().unwrap_or(&0));
    for p in &out.players { println!("player bot={} len(name)={}", p.bot, p.name.len()); }
    if let Some(i) = out.inventories.get(5) { println!("inv {} {} {} {:?}", i.tick, i.p, i.at, i.items); }
    if let Some(s) = out.scoreboard.get(0) { println!("score {:?}", s.v); }
    println!("header {:?}", out.header);
}
