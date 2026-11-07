/**
 * P1: what calls the 3D page's frame, and how often (docs/app3d.md "Performance"; John: "don't limit fps … allow for
 * uncapped fps"). The sim's 64 Hz ticks don't depend on any of this: every frame runs the ticks the elapsed time owes
 * (src/app/loop.ts FixedLoop).
 *
 * - `uncapped` (default): frames back to back, each in its own task (MessageChannel: no 4 ms timer clamp, input and
 *   rendering still run between tasks), as fast as the main thread allows. The canvas is still presented at the
 *   display's refresh (the compositor shows the newest frame each vsync; the rest are drawn and dropped), but every
 *   presented frame was drawn from the newest mouse input, so input-to-photon latency is lowest. It keeps one CPU
 *   core busy, like an uncapped game.
 * - a number (60, 120, 144, 240, 360, 500, or any 20–1000): paced to that rate: the driver sleeps (setTimeout) until
 *   about 1 ms before the frame is due and spins on tasks for the last bit, and drops the pacing debt if it falls more
 *   than a frame behind (no catch-up bursts).
 * - `vsync`: requestAnimationFrame (the browser's pacing: one frame per display refresh, the least power).
 *
 * A hidden tab always falls back to requestAnimationFrame (which the browser stops), so an uncapped page in a
 * background tab doesn't burn a core. `paceDelay` (pure, tests/app3d-perf.test.ts) is the limiter's arithmetic.
 */

export type FpsLimit = 'uncapped' | 'vsync' | number;

/** The presets of the settings menu. */
export const FPS_PRESETS: readonly number[] = [60, 120, 144, 240, 360, 500];
export const FPS_MIN = 20;
export const FPS_MAX = 1000;

/** A setting value from storage or the menu ('uncapped', 'vsync' or a number), clamped; junk is the default. */
export function parseFpsLimit(v: unknown): FpsLimit {
  if (v === 'vsync' || v === 'uncapped') return v;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 'uncapped';
  return Math.round(Math.min(FPS_MAX, Math.max(FPS_MIN, n)));
}

export function fpsLimitLabel(l: FpsLimit): string {
  return l === 'uncapped' ? 'uncapped' : l === 'vsync' ? 'vsync' : `${l} fps cap`;
}

/**
 * The limiter: given the next frame's due time and now, what to do. `run` when due (and the next due time), else
 * wait `ms` (sleep when ≥ 2 ms; the caller spins on tasks below that). Falling more than one interval behind restarts
 * the schedule from now (no burst of catch-up frames).
 */
export function paceDelay(due: number, now: number, intervalMs: number): { readonly run: boolean; readonly ms: number; readonly nextDue: number } {
  if (now < due) return { run: false, ms: due - now, nextDue: due };
  const next = now - due > intervalMs ? now + intervalMs : due + intervalMs;
  return { run: true, ms: 0, nextDue: next };
}

/** Calls `frame(now)` per the limit (see the file comment). */
export class FrameDriver {
  private limitValue: FpsLimit;
  private running = false;
  /** Bumped on every (re)start so stale callbacks from the previous mode stop. */
  private gen = 0;
  private due = 0;
  private readonly channel: MessageChannel | null;
  private readonly frame: (now: number) => void;

  constructor(frame: (now: number) => void, limit: FpsLimit = 'uncapped') {
    this.frame = frame;
    this.limitValue = limit;
    this.channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    if (this.channel !== null) this.channel.port1.onmessage = (e: MessageEvent<number>): void => this.onTask(e.data);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.running && this.restart());
  }

  get limit(): FpsLimit {
    return this.limitValue;
  }

  set limit(l: FpsLimit) {
    this.limitValue = l;
    if (this.running) this.restart();
  }

  /** The loop actually in use ('vsync' while the tab is hidden or without MessageChannel). */
  get mode(): 'uncapped' | 'vsync' | 'paced' {
    if (this.channel === null || (typeof document !== 'undefined' && document.hidden) || this.limitValue === 'vsync') return 'vsync';
    return this.limitValue === 'uncapped' ? 'uncapped' : 'paced';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.restart();
  }

  /** Stop calling the frame (the bench drives frames itself). */
  stop(): void {
    this.running = false;
    this.gen++;
  }

  private restart(): void {
    const g = ++this.gen;
    this.due = performance.now();
    if (this.mode === 'vsync') requestAnimationFrame((t) => this.onRaf(g, t));
    else this.post(g);
  }

  private post(g: number): void {
    this.channel?.port2.postMessage(g);
  }

  private onRaf(g: number, now: number): void {
    if (g !== this.gen) return;
    this.frame(now);
    if (g !== this.gen) return;
    requestAnimationFrame((t) => this.onRaf(g, t));
  }

  private onTask(g: number): void {
    if (g !== this.gen) return;
    const now = performance.now();
    const l = this.limitValue;
    if (typeof l === 'number') {
      const p = paceDelay(this.due, now, 1000 / l);
      if (!p.run) {
        // Sleep most of the wait, spin on tasks for the last ~2 ms (timers are only ~1 ms precise).
        if (p.ms >= 2) setTimeout(() => this.post(g), p.ms - 1.5);
        else this.post(g);
        return;
      }
      this.due = p.nextDue;
    }
    this.frame(now);
    if (g === this.gen) this.post(g);
  }
}
