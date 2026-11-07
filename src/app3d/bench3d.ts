/**
 * P1: the in-page benchmark of the 3D app (`?bench=1`; docs/app3d.md "Performance"; tools/bench-app3d.ts runs it in
 * headless Chromium). Open the page with `?bench=1` on any machine and it runs the scenarios below by itself, then
 * shows a table over the view (and leaves the results in `window.__cs2bench`).
 *
 * Each scenario runs N frames and reports the main-thread time per frame by phase (perf.ts), p50 / p95 / p99, the
 * fps-equivalent (1000 / p50 frame ms), the sim's ms per tick, the Three.js draw calls and the JS heap allocated per
 * frame (Chrome: `performance.memory`, exact with --enable-precise-memory-info; the sum of the frame-to-frame
 * increases, so a frame that collected garbage counts 0).
 *
 * Two drivers: `raf` is the page's own requestAnimationFrame loop (the presented rate: capped by the display), and
 * `uncapped` runs frames back to back from MessageChannel tasks without waiting for vsync, so the frame rate is the
 * page's real capability (the canvas is still presented at the display's rate; the extra frames are drawn and
 * dropped by the compositor, which is what a 500-fps game on a 120 Hz display does too).
 *
 * URL: `?bench=1` (all scenarios), `?bench=watch-1x-uncapped,fp-1x-uncapped` (some), `&frames=<n>` (uncapped
 * frames per scenario, default 600; rAF ones run n / 5).
 */
import type { PlayerId } from '../contracts/index';
import type { PerfReport } from './perf';

interface MemoryInfo {
  readonly usedJSHeapSize: number;
}

export interface BenchScenarioResult {
  readonly name: string;
  readonly driver: 'raf' | 'uncapped' | 'loop';
  readonly report: PerfReport;
  readonly wallMs: number;
  /** Frames per second the driver actually ran (frames / wall time). */
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  /** JS heap bytes allocated per frame (sum of increases / frames), null where the browser doesn't tell. */
  readonly heapBytesPerFrame: number | null;
  /** Frames in which the heap shrank (a GC ran). */
  readonly gcFrames: number | null;
}

export interface BenchResult {
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number; readonly canvas: { readonly width: number; readonly height: number } };
  readonly renderer: string;
  readonly scenarios: BenchScenarioResult[];
}

declare global {
  interface Window {
    __cs2bench?: { done: boolean; result: BenchResult | null; error: string | null };
  }
}

interface Scenario {
  readonly name: string;
  readonly driver: 'raf' | 'uncapped' | 'loop';
  /** Set up (seek, camera, speed) before the frames. */
  setup(api: Api): void;
  /** Before each frame (e.g. mouse movement). */
  perFrame?(api: Api, i: number): void;
  /** Warm-up lasts until this holds too (e.g. the round has ended). */
  ready?(api: Api): boolean;
  /**
   * A synthetic display rate (Hz): the manual driver steps the page's clock by 1000 / hz per frame instead of reading
   * the wall clock, so a scenario covers a fixed span of round time (`frames` / hz seconds) however slow the frames
   * are, and the sim runs the ticks that span owes (64 per round second at 1×).
   */
  readonly hz?: number;
  /** Fixed frame count (overrides `&frames=`). */
  readonly frames?: number;
}

type Api = NonNullable<Window['__cs2sim3d']>;

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'watch-1x-raf',
    driver: 'raf',
    setup: (a) => watch(a, 1),
  },
  {
    name: 'watch-1x-uncapped',
    driver: 'uncapped',
    setup: (a) => watch(a, 1),
  },
  {
    name: 'watch-1x-loop',
    driver: 'loop',
    setup: (a) => watch(a, 1),
  },
  {
    name: 'watch-4x-uncapped',
    driver: 'uncapped',
    setup: (a) => watch(a, 4),
  },
  {
    name: 'fp-1x-uncapped',
    driver: 'uncapped',
    setup: (a) => {
      a.test.seekTick(Math.round(18.2 * 64));
      a.perf.start();
      a.takeControl();
    },
    // A steady mouse sweep: the view turns every frame (the latency path).
    perFrame: (a, i) => a.mouse(i % 200 < 100 ? 3 : -3, i % 50 < 25 ? 1 : -1),
  },
  // The round-end regression (John: "when the round ends, the game gets super laggy"): 5 s of round time at a
  // synthetic 120 Hz, watching, just before the round end and just after it (summary line, post-round AI, effects).
  {
    name: 'inround-5s-120hz',
    driver: 'uncapped',
    hz: 120,
    frames: 600,
    setup: (a) => watchFrom(a, endTick(a) - 7 * 64),
  },
  {
    name: 'postend-5s-120hz',
    driver: 'uncapped',
    hz: 120,
    frames: 600,
    setup: (a) => watchFrom(a, endTick(a) - 64),
    ready: (a) => a.session().observe().round.phase === 'over',
  },
];

/** The recorded round's end tick (the no-human run ends on it or a tick or two off). */
function endTick(a: Api): number {
  return a.session().model.meta.roundEndTick;
}

function watchFrom(a: Api, tick: number): void {
  a.test.seekTick(Math.max(0, tick));
  a.camera('follow', 'cart' as PlayerId);
  a.perf.start();
  a.perf.speed(1);
}

function watch(a: Api, speed: number): void {
  a.test.seekTick(10 * 64);
  a.camera('follow', 'cart' as PlayerId);
  a.perf.start();
  a.perf.speed(speed);
}

function heap(): number | null {
  const m = (performance as Performance & { memory?: MemoryInfo }).memory;
  return m === undefined ? null : m.usedJSHeapSize;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (): void => resolve();
    ch.port2.postMessage(0);
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function runScenario(api: Api, sc: Scenario, frames: number): Promise<BenchScenarioResult> {
  // A fresh page state per scenario: watching from the restart button's state.
  document.getElementById('restart')?.click();
  sc.setup(api);
  const perf = api.perf;
  const n = sc.frames ?? (sc.driver === 'raf' ? Math.max(30, Math.round(frames / 5)) : frames);
  let warm = Math.min(120, Math.round(n / 5));
  let grown = 0;
  let gcs = 0;
  let last = heap();
  let i = 0;
  perf.onFrame = (): void => {
    const h = heap();
    if (h !== null && last !== null) {
      if (h >= last) grown += h - last;
      else gcs++;
    }
    last = h;
  };
  const record = (): void => {
    i++;
    // Hold the warm-up until the scenario is ready (bounded: 20 s of frames).
    if (i === warm && sc.ready !== undefined && !sc.ready(api) && warm < 2400) warm++;
    if (i === warm) {
      perf.probe.reset();
      grown = 0;
      gcs = 0;
    }
  };
  let t0 = 0;
  if (sc.driver === 'raf') {
    perf.driver('vsync');
    while (i < warm + n) {
      if (i === warm) t0 = performance.now();
      sc.perFrame?.(api, i);
      await nextFrame();
      record();
    }
    perf.driver('page');
  } else if (sc.driver === 'loop') {
    // The page's own uncapped loop (frame-driver.ts): what "Uncapped" in the settings runs.
    const counted = perf.onFrame;
    await new Promise<void>((resolve) => {
      perf.onFrame = (): void => {
        counted?.();
        if (i === warm) t0 = performance.now();
        record();
        if (i >= warm + n) resolve();
        else sc.perFrame?.(api, i);
      };
      perf.driver('uncapped');
    });
    perf.driver('page');
  } else {
    perf.driver('manual');
    let clock = performance.now();
    while (i < warm + n) {
      if (i === warm) t0 = performance.now();
      sc.perFrame?.(api, i);
      clock = sc.hz === undefined ? performance.now() : clock + 1000 / sc.hz;
      perf.step(clock);
      record();
      await nextTask();
    }
    perf.driver('page');
  }
  const wallMs = performance.now() - t0;
  const info = perf.info();
  perf.onFrame = null;
  const report = perf.probe.report();
  const h = heap();
  return { name: sc.name, driver: sc.driver, report, wallMs, fps: (n * 1000) / wallMs, drawCalls: info.calls, triangles: info.triangles, heapBytesPerFrame: h === null ? null : grown / Math.max(1, report.frames), gcFrames: h === null ? null : gcs };
}

function glRenderer(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  const e = gl?.getExtension('WEBGL_debug_renderer_info');
  return gl !== null && gl !== undefined && e !== null && e !== undefined ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
}

const f2 = (x: number): string => x.toFixed(x < 10 ? 3 : 1);

/** A plain-text table of the results (the overlay; the tool prints its own). */
export function benchTable(r: BenchResult): string {
  const rows = [`${r.renderer} · ${r.viewport.width}×${r.viewport.height} @${r.viewport.dpr} (canvas ${r.viewport.canvas.width}×${r.viewport.canvas.height})`, ''];
  rows.push('scenario            frame p50 / p95 / p99 ms   fps-eq  ran fps | input   sim  scene render   hud (p50 ms) | sim/tick | calls | KB/frame');
  for (const s of r.scenarios) {
    const p = s.report.phases;
    rows.push(
      `${s.name.padEnd(19)} ${f2(s.report.frame.p50).padStart(7)} / ${f2(s.report.frame.p95).padStart(6)} / ${f2(s.report.frame.p99).padStart(6)}   ${s.report.fpsEquivalent.toFixed(0).padStart(6)}  ${s.fps.toFixed(0).padStart(7)} | ` +
        `${f2(p.input.p50)} ${f2(p.sim.p50)} ${f2(p.scene.p50)} ${f2(p.render.p50)} ${f2(p.hud.p50)} | ${f2(s.report.simPerTick.p50).padStart(8)} | ${String(s.drawCalls).padStart(5)} | ${s.heapBytesPerFrame === null ? '–' : (s.heapBytesPerFrame / 1024).toFixed(1)}`,
    );
  }
  return rows.join('\n');
}

export async function runBench(params: URLSearchParams): Promise<void> {
  window.__cs2bench = { done: false, result: null, error: null };
  try {
    const api = window.__cs2sim3d;
    if (api === undefined) throw new Error('no 3D app');
    const which = params.get('bench') ?? '1';
    const pick = which === '1' || which === '' ? SCENARIOS : SCENARIOS.filter((s) => which.split(',').includes(s.name));
    const frames = Number(params.get('frames') ?? '600');
    // Let the page settle (first frames compile the shaders).
    for (let k = 0; k < 30; k++) await nextFrame();
    const scenarios: BenchScenarioResult[] = [];
    for (const sc of pick) scenarios.push(await runScenario(api, sc, Number.isFinite(frames) && frames > 0 ? frames : 600));
    const canvas = document.getElementById('view') as HTMLCanvasElement;
    const result: BenchResult = { userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, canvas: { width: canvas.width, height: canvas.height } }, renderer: glRenderer(), scenarios };
    window.__cs2bench = { done: true, result, error: null };
    const pre = document.createElement('pre');
    pre.id = 'bench';
    pre.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;margin:0;padding:8px;background:rgba(0,0,0,0.82);color:#ece2cc;font:11px ui-monospace,Menlo,monospace;white-space:pre;overflow:auto;z-index:5;pointer-events:auto';
    pre.textContent = benchTable(result);
    document.getElementById('stage')?.appendChild(pre);
  } catch (err) {
    window.__cs2bench = { done: true, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}
