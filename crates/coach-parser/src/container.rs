//! Container detection by magic bytes and decompression: `.dem` (PBDEMS2), `.bz2`, `.zst`, `.gz`.
//! All decoders are pure Rust so the crate builds for wasm32 without a C toolchain.

use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Dem,
    Bzip2,
    Zstd,
    Gzip,
    Unknown,
}

impl Container {
    pub fn name(self) -> &'static str {
        match self {
            Container::Dem => "dem",
            Container::Bzip2 => "bz2",
            Container::Zstd => "zst",
            Container::Gzip => "gz",
            Container::Unknown => "unknown",
        }
    }
}

pub fn detect(b: &[u8]) -> Container {
    if b.len() >= 8 && &b[0..8] == b"PBDEMS2\0" {
        Container::Dem
    } else if b.len() >= 3 && &b[0..3] == b"BZh" {
        Container::Bzip2
    } else if b.len() >= 4 && b[0..4] == [0x28, 0xB5, 0x2F, 0xFD] {
        Container::Zstd
    } else if b.len() >= 2 && b[0] == 0x1F && b[1] == 0x8B {
        Container::Gzip
    } else {
        Container::Unknown
    }
}

/// Reads a decoder to the end into a buffer that grows by a bounded step, so the last growth
/// does not double the capacity (a 250 MB demo would otherwise reserve 512 MB).
fn read_all<R: Read>(mut r: R, size_hint: usize) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(size_hint.max(1 << 20));
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let n = r.read(&mut chunk).map_err(|e| format!("decompress: {e}"))?;
        if n == 0 {
            break;
        }
        if out.len() + n > out.capacity() {
            // grow by a quarter (at least 16 MB): bounded slack, few reallocations
            let add = (out.capacity() / 4).max(16 << 20);
            out.reserve_exact(add);
        }
        out.extend_from_slice(&chunk[..n]);
    }
    out.shrink_to_fit();
    Ok(out)
}

/// Gzip member: skip the header (RFC 1952), inflate the raw deflate stream.
fn gunzip(b: &[u8]) -> Result<Vec<u8>, String> {
    if b.len() < 18 || b[2] != 8 {
        return Err("gzip: not deflate".into());
    }
    let flg = b[3];
    let mut p = 10usize;
    if flg & 4 != 0 {
        let xlen = u16::from_le_bytes([b[p], b[p + 1]]) as usize;
        p += 2 + xlen;
    }
    if flg & 8 != 0 {
        while p < b.len() && b[p] != 0 {
            p += 1;
        }
        p += 1;
    }
    if flg & 16 != 0 {
        while p < b.len() && b[p] != 0 {
            p += 1;
        }
        p += 1;
    }
    if flg & 2 != 0 {
        p += 2;
    }
    if p >= b.len() {
        return Err("gzip: truncated header".into());
    }
    let isize = u32::from_le_bytes([b[b.len() - 4], b[b.len() - 3], b[b.len() - 2], b[b.len() - 1]]) as usize;
    let mut out = miniz_oxide::inflate::decompress_to_vec_with_limit(&b[p..], usize::MAX)
        .map_err(|e| format!("gzip: {e:?}"))?;
    if isize != 0 && (out.len() as u64 % (1u64 << 32)) as usize != isize {
        return Err("gzip: size mismatch".into());
    }
    out.shrink_to_fit();
    Ok(out)
}

/// Decompresses `input` if needed. Takes ownership so the compressed bytes are freed as soon as
/// the decompressed buffer exists.
pub fn open(input: Vec<u8>) -> Result<(Container, Vec<u8>), String> {
    let c = detect(&input);
    let out = match c {
        Container::Dem => return Ok((c, input)),
        Container::Bzip2 => read_all(bzip2_rs::DecoderReader::new(&input[..]), input.len() * 3)?,
        Container::Zstd => {
            let dec = ruzstd::decoding::StreamingDecoder::new(&input[..]).map_err(|e| format!("zstd: {e}"))?;
            read_all(dec, input.len() * 3)?
        }
        Container::Gzip => gunzip(&input)?,
        Container::Unknown => return Err("not a CS2 demo (no PBDEMS2, bz2, zstd or gzip magic)".into()),
    };
    drop(input);
    if detect(&out) != Container::Dem {
        return Err(format!("{} container does not hold a CS2 demo", c.name()));
    }
    Ok((c, out))
}
