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
    // ISIZE (the trailer) is the exact size for files under 4 GB: inflate straight into a buffer of that size.
    let isize = u32::from_le_bytes([b[b.len() - 4], b[b.len() - 3], b[b.len() - 2], b[b.len() - 1]]) as usize;
    let mut out = vec![0u8; isize];
    let n = miniz_oxide::inflate::decompress_slice_iter_to_slice(&mut out, std::iter::once(&b[p..b.len() - 8]), false, true)
        .map_err(|e| format!("gzip: {e:?}"))?;
    if n != isize {
        return Err("gzip: size mismatch".into());
    }
    Ok(out)
}

/// Frame_Content_Size of the first zstd frame, when the header carries it (RFC 8878, 3.1.1.1).
fn zstd_content_size(b: &[u8]) -> Option<usize> {
    let fhd = *b.get(4)?;
    let fcs_flag = fhd >> 6;
    let single = (fhd >> 5) & 1 == 1;
    let did = [0usize, 1, 2, 4][(fhd & 3) as usize];
    let mut p = 5 + if single { 0 } else { 1 } + did;
    let n = match fcs_flag {
        0 => if single { 1 } else { return None },
        1 => 2,
        2 => 4,
        _ => 8,
    };
    let mut v: u64 = 0;
    for i in 0..n {
        v |= (*b.get(p + i)? as u64) << (8 * i);
    }
    p += n;
    let _ = p;
    if n == 2 {
        v += 256;
    }
    usize::try_from(v).ok()
}

/// Decompresses `input` if needed. Takes ownership so the compressed bytes are freed as soon as
/// the decompressed buffer exists.
pub fn open(input: Vec<u8>) -> Result<(Container, Vec<u8>), String> {
    let c = detect(&input);
    let out = match c {
        Container::Dem => return Ok((c, input)),
        // bzip2 has no size field; CS2 demos compress to about 75-80 %, so reserve 1.35x and grow by quarters
        Container::Bzip2 => read_all(bzip2_rs::DecoderReader::new(&input[..]), input.len() / 20 * 27)?,
        Container::Zstd => {
            let hint = zstd_content_size(&input).unwrap_or(input.len() / 20 * 27);
            let dec = ruzstd::decoding::StreamingDecoder::new(&input[..]).map_err(|e| format!("zstd: {e}"))?;
            read_all(dec, hint)?
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
