/** Provided by the 3D single-file build's `embedAssets3d` plugin (vite.single.3d.config.ts); see assets3d-embedded.ts. */
declare module 'virtual:cs2-embedded-assets-3d' {
  const assets: {
    /** data/round.json, mirage-nav.json, mirage-vismask.json, geometry/mirage-tracks.json: gzip then base64 */
    readonly round: string;
    readonly nav: string;
    readonly vision: string;
    readonly tracks: string;
    /** data/geometry/mirage-geometry.bin and mirage-clips.bin: gzip then base64 */
    readonly geometry: string;
    readonly clips: string;
    /** data/source/cs2/de_mirage.png as a `data:image/png;base64,…` URI */
    readonly radar: string;
  };
  export default assets;
}
