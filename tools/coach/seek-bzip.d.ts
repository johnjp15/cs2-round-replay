declare module 'seek-bzip' {
  /** Decompress a whole .bz2 buffer. */
  export function decode(input: Buffer, output?: Buffer): Buffer;
  const Bunzip: { decode: typeof decode };
  export default Bunzip;
}
