/**
 * X1: a small LZMA (LZMA1, the "alone" / LZMA SDK format) decoder for Source's compressed BSP lumps and game lumps
 * (docs/maps.md "Source BSP"), written after the LZMA SDK's reference decoder (`LzmaSpec.cpp`, public domain).
 *
 * Source stores a compressed lump as a 17-byte header (`"LZMA"`, u32 actualSize, u32 lzmaSize, 5 property bytes)
 * followed by the raw LZMA stream (`decodeValveLzma`). `decodeLzmaAlone` reads the standard 13-byte `.lzma` header
 * (5 property bytes, u64 size, -1 = unknown with an end marker), which is what the tests generate with Python's
 * `lzma.FORMAT_ALONE`.
 *
 * Pure, synchronous, no dependencies: speed is not a concern (a whole BSP lump decodes in well under a second).
 */

const K_NUM_STATES = 12;
const K_NUM_POS_BITS_MAX = 4;
const K_NUM_LEN_TO_POS_STATES = 4;
const K_NUM_ALIGN_BITS = 4;
const K_END_POS_MODEL_INDEX = 14;
const K_NUM_FULL_DISTANCES = 1 << (K_END_POS_MODEL_INDEX >> 1);
const K_MATCH_MIN_LEN = 2;
const PROB_INIT = 1024;

export class LzmaError extends Error {
  override readonly name = 'LzmaError';
}

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    this.pos = start;
    if (this.byte() !== 0) throw new LzmaError('lzma: bad range coder start byte');
    for (let i = 0; i < 4; i++) this.code = (this.code * 256 + this.byte()) % 0x100000000;
    if (this.code === this.range) throw new LzmaError('lzma: corrupted stream');
  }

  private byte(): number {
    if (this.pos >= this.buf.length) throw new LzmaError('lzma: unexpected end of input');
    return this.buf[this.pos++] as number;
  }

  get finishedOk(): boolean {
    return this.code === 0;
  }

  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range * 256) % 0x100000000;
      this.code = (this.code * 256 + this.byte()) % 0x100000000;
    }
  }

  direct(numBits: number): number {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      this.range = Math.floor(this.range / 2);
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      res = res * 2 + bit;
      this.normalize();
    }
    return res;
  }

  bit(probs: Uint16Array, i: number): number {
    const p = probs[i] as number;
    const bound = Math.floor(this.range / 2048) * p;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >> 5);
      this.normalize();
      return 0;
    }
    this.range -= bound;
    this.code -= bound;
    probs[i] = p - (p >> 5);
    this.normalize();
    return 1;
  }

  tree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(probs, base + m);
    return m - (1 << numBits);
  }

  reverseTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  private readonly choice = new Uint16Array(2).fill(PROB_INIT);
  private readonly low = new Uint16Array(16 << 3).fill(PROB_INIT);
  private readonly mid = new Uint16Array(16 << 3).fill(PROB_INIT);
  private readonly high = new Uint16Array(256).fill(PROB_INIT);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

/**
 * Decode a raw LZMA stream. `props` are the 5 property bytes (lc/lp/pb, dictionary size); `size` is the
 * uncompressed size, or -1 when unknown (the stream then ends with an end marker).
 */
export function decodeLzmaRaw(props: Uint8Array, data: Uint8Array, start: number, size: number): Uint8Array {
  let d = props[0] as number;
  if (d >= 9 * 5 * 5) throw new LzmaError('lzma: bad properties');
  const lc = d % 9;
  d = Math.floor(d / 9);
  const lp = d % 5;
  const pb = Math.floor(d / 5);
  const known = size >= 0;
  let out = new Uint8Array(known ? size : Math.max(1024, data.length * 4));
  let outPos = 0;
  const put = (b: number): void => {
    if (outPos >= out.length) {
      if (known) throw new LzmaError('lzma: output overrun');
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[outPos++] = b;
  };
  const literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const posSlot = new Uint16Array(K_NUM_LEN_TO_POS_STATES << 6).fill(PROB_INIT);
  const posDecoders = new Uint16Array(1 + K_NUM_FULL_DISTANCES - K_END_POS_MODEL_INDEX).fill(PROB_INIT);
  const align = new Uint16Array(1 << K_NUM_ALIGN_BITS).fill(PROB_INIT);
  const isMatch = new Uint16Array(K_NUM_STATES << K_NUM_POS_BITS_MAX).fill(PROB_INIT);
  const isRep = new Uint16Array(K_NUM_STATES).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(K_NUM_STATES).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(K_NUM_STATES).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(K_NUM_STATES).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(K_NUM_STATES << K_NUM_POS_BITS_MAX).fill(PROB_INIT);
  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();
  const rc = new RangeDecoder(data, start);
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  for (;;) {
    if (known && outPos === size) break;
    const posState = outPos & pbMask;
    if (rc.bit(isMatch, (state << K_NUM_POS_BITS_MAX) + posState) === 0) {
      const prev = outPos > 0 ? (out[outPos - 1] as number) : 0;
      const litState = ((outPos & lpMask) << lc) + (prev >> (8 - lc));
      const base = 0x300 * litState;
      let symbol = 1;
      if (state >= 7) {
        if (rep0 + 1 > outPos) throw new LzmaError('lzma: distance beyond output');
        let matchByte = out[outPos - rep0 - 1] as number;
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
      put(symbol - 0x100);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      if (outPos === 0) throw new LzmaError('lzma: rep match at start');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << K_NUM_POS_BITS_MAX) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          put(out[outPos - rep0 - 1] as number);
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) dist = rep2;
          else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      // The distance.
      const lenState = Math.min(len, K_NUM_LEN_TO_POS_STATES - 1);
      const slot = rc.tree(posSlot, lenState << 6, 6);
      let dist: number;
      if (slot < 4) dist = slot;
      else {
        const numDirectBits = (slot >> 1) - 1;
        dist = (2 | (slot & 1)) * 2 ** numDirectBits;
        if (slot < K_END_POS_MODEL_INDEX) dist += rc.reverseTree(posDecoders, dist - slot, numDirectBits);
        else {
          dist += rc.direct(numDirectBits - K_NUM_ALIGN_BITS) * 16;
          dist += rc.reverseTree(align, 0, K_NUM_ALIGN_BITS);
        }
      }
      if (dist === 0xffffffff) {
        if (known && outPos !== size) throw new LzmaError('lzma: end marker before the declared size');
        break;
      }
      rep0 = dist;
      if (rep0 >= outPos) throw new LzmaError('lzma: distance beyond output');
    }
    len += K_MATCH_MIN_LEN;
    if (known && outPos + len > size) throw new LzmaError('lzma: match past the declared size');
    for (let i = 0; i < len; i++) put(out[outPos - rep0 - 1] as number);
  }
  return known ? out : out.slice(0, outPos);
}

/** The standard `.lzma` (LZMA alone) container: 5 property bytes, u64 LE size (all ones = unknown), the stream. */
export function decodeLzmaAlone(file: Uint8Array): Uint8Array {
  if (file.length < 13) throw new LzmaError('lzma: file too short');
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const lo = dv.getUint32(5, true);
  const hi = dv.getUint32(9, true);
  const size = lo === 0xffffffff && hi === 0xffffffff ? -1 : hi * 0x100000000 + lo;
  return decodeLzmaRaw(file.subarray(0, 5), file, 13, size);
}

/** Valve's compressed-lump header magic, "LZMA" little-endian. */
export const VALVE_LZMA_ID = 0x414d5a4c;

/** True if the bytes start with Valve's LZMA lump header. */
export function isValveLzma(bytes: Uint8Array): boolean {
  return bytes.length >= 17 && bytes[0] === 0x4c && bytes[1] === 0x5a && bytes[2] === 0x4d && bytes[3] === 0x41;
}

/** Decode a Valve LZMA lump: "LZMA", u32 actualSize, u32 lzmaSize, 5 property bytes, then lzmaSize stream bytes. */
export function decodeValveLzma(bytes: Uint8Array): Uint8Array {
  if (!isValveLzma(bytes)) throw new LzmaError('lzma: not a Valve LZMA lump');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const actual = dv.getUint32(4, true);
  const lzmaSize = dv.getUint32(8, true);
  if (17 + lzmaSize > bytes.length) throw new LzmaError('lzma: lump shorter than its header says');
  return decodeLzmaRaw(bytes.subarray(12, 17), bytes.subarray(0, 17 + lzmaSize), 17, actual);
}
