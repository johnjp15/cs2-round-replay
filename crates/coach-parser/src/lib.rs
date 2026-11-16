//! coach-parser: CS2 demo bytes -> typed-array columns (see docs/coach/parser.md).
pub mod container;
pub mod extract;
#[cfg(target_arch = "wasm32")]
mod wasm;
