/** Provided by the 3D single-file build's `embedAssets3d` plugin (vite.single.3d.config.ts); see assets3d-embedded.ts. */
declare module 'virtual:cs2-embedded-assets-3d' {
  const assets: {
    /** data/round.json, mirage-nav.json, mirage-vismask.json, maps/mirage-2020/tracks.json: gzip then base64 */
    readonly round: string;
    readonly nav: string;
    readonly vision: string;
    readonly tracks: string;
    /** X1c: the default package's data/maps/mirage-2020/geometry.bin, clips.bin and render.bin (G2RM): gzip then base64 */
    readonly geometry: string;
    readonly clips: string;
    readonly render: string;
    /** data/source/cs2/de_mirage.png as a `data:image/png;base64,…` URI */
    readonly radar: string;
  };
  export default assets;
}
