/** Provided by the single-file build's `embedAssets` plugin (vite.single.config.ts); see assets-embedded.ts. */
declare module 'virtual:cs2-embedded-assets' {
  const assets: {
    /** How `round`, `nav` and `vision` are stored: gzip then base64, or the JSON text itself (CS2_SINGLE_RAW=1). */
    readonly encoding: 'gzip-base64' | 'text';
    /** data/round.json */
    readonly round: string;
    /** data/mirage-nav.json */
    readonly nav: string;
    /** data/mirage-vismask.json (the sight mask) */
    readonly vision: string;
    /** data/mirage-radar.jpg as a `data:image/jpeg;base64,…` URI */
    readonly radar: string;
  };
  export default assets;
}
