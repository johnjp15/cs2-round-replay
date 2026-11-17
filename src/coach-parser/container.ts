/** The demo containers the parser reads, by magic bytes (the same rule as crates/coach-parser/src/container.rs). */
export type Container = 'dem' | 'bz2' | 'zst' | 'gz' | 'unknown';

export function detectContainer(b: Uint8Array): Container {
  const at = (i: number): number => b[i] ?? -1;
  if (b.length >= 8 && String.fromCharCode(...b.subarray(0, 7)) === 'PBDEMS2' && at(7) === 0) return 'dem';
  if (at(0) === 0x42 && at(1) === 0x5a && at(2) === 0x68) return 'bz2';
  if (at(0) === 0x28 && at(1) === 0xb5 && at(2) === 0x2f && at(3) === 0xfd) return 'zst';
  if (at(0) === 0x1f && at(1) === 0x8b) return 'gz';
  return 'unknown';
}
