/**
 * A2: the sound in a real browser (headless Chromium, playwright-core): the 3D page plays the recorded round with
 * nobody playing from 15 s to 20 s, and the check measures what comes out (docs/audio.md "Browser check").
 *
 *   npm run build:3d && npx tsx tools/audio-check.ts [--dir dist-3d] [--from 15] [--to 35] [--tag after] [--port 4186]
 *
 *  1. starts the audio with a click, seeks to `--from`, plays at 1× until `--to`;
 *  2. taps the AudioContext's output with an AudioWorklet (an init script hooks every connect() to the destination,
 *     so it works on any build, A1's too) and records it: peak, samples beyond ±1 (clipping), RMS; the A2 engine also
 *     reports the mix before its limiter (`__cs2a1.meter`);
 *  3. counts the director's cues in the window (A2 builds): one `fire.*` per shot event and one `step.*` per footstep
 *     event of the same ticks in the headless harness (tools/harness3d.ts, the same deterministic round), and the
 *     cue timing (each cue's lead over its arrival; consecutive shots of one shooter one tick apart in audio time);
 *  4. writes `logs/audio/check-<tag>.json` and the recording `logs/audio/mix-<from>-<to>-<tag>.wav` (gitignored).
 *  5. voice accounting (any build: an init script hooks AudioBufferSourceNode start / stop): sources started per
 *     second, sources playing at once per 100 ms; A2 builds also log every voice with its event, source, distance
 *     and gain after the CS2 curve and occlusion (`logs/audio/voices-<tag>.csv`): audible voices at once (gain >
 *     −60 dB), footsteps per pawn per second, voices culled beyond their curve;
 *  6. left / right: a sound 200 u right of the listener is louder in the right channel (OfflineAudioContext with the
 *     engine's listener math, facing yaw 0 and 90).
 * Exit code 1 when a cue count is off, the output clipped, or left / right is swapped.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { wavBytes } from '../src/app3d/audio/synth';
import { gunOf } from '../src/app3d/audio/events';
import { loadHarness3dData, runHarness3d } from './harness3d';
import { db } from './audio-metrics';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const DIR = resolve(arg('--dir', 'dist-3d'));
const PORT = Number(arg('--port', '4186'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FROM = Number(arg('--from', '15'));
const TO = Number(arg('--to', '35'));
const TAG = arg('--tag', 'current');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };

function serve(dir: string): Server {
  const s = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
    try {
      if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  s.listen(PORT, '127.0.0.1');
  return s;
}

/** The output tap: every node connected to a context's destination is also connected to a recording worklet. */
const TAP = `(() => {
  const code = 'class T extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.peak = 0; this.over = 0; this.sq = 0; this.n = 0; this.rec = []; this.port.onmessage = (e) => { if (e.data === "start") { this.on = true; this.peak = 0; this.over = 0; this.sq = 0; this.n = 0; this.rec = []; } else if (e.data === "get") { let n = 0; for (const c of this.rec) n += c.length; const o = new Float32Array(n); let k = 0; for (const c of this.rec) { o.set(c, k); k += c.length; } this.port.postMessage({ peak: this.peak, over: this.over, rms: Math.sqrt(this.sq / Math.max(1, this.n)), n: this.n, rec: o }); this.on = false; } }; } process(inputs) { const inp = inputs[0]; if (this.on && inp && inp.length) { for (const ch of inp) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a; if (a > 1) this.over++; this.sq += a * a; } this.n += inp[0].length * inp.length; this.rec.push(new Float32Array(inp[0])); } return true; } } registerProcessor("a2-tap", T);';
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const taps = new Map();
  const orig = AudioNode.prototype.connect;
  const tapOf = (ctx) => {
    let t = taps.get(ctx);
    if (t === undefined) {
      t = { node: null, pending: [], ready: ctx.audioWorklet.addModule(url).then(() => {
        const node = new AudioWorkletNode(ctx, 'a2-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
        const sink = ctx.createGain(); sink.gain.value = 0; orig.call(node, sink); orig.call(sink, ctx.destination);
        t.node = node; for (const n of t.pending) orig.call(n, node); t.pending = [];
      }) };
      taps.set(ctx, t);
      window.__a2tap = t;
    }
    return t;
  };
  const srcs = []; window.__a2srcs = srcs;
  const oStart = AudioBufferSourceNode.prototype.start;
  const oStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (when, ...rest) {
    if (this.context instanceof AudioContext) {
      const at = Math.max(when || 0, this.context.currentTime);
      const dur = this.buffer ? this.buffer.duration / Math.max(0.01, this.playbackRate.value) : 0;
      this.__a2 = { at, end: this.loop ? Infinity : at + dur };
      if (srcs.length < 50000) srcs.push(this.__a2);
    }
    return oStart.call(this, when, ...rest);
  };
  AudioBufferSourceNode.prototype.stop = function (when, ...rest) {
    if (this.__a2) this.__a2.end = Math.min(this.__a2.end, Math.max(when || 0, this.context.currentTime));
    return oStop.call(this, when, ...rest);
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode && this.context instanceof AudioContext) {
      const t = tapOf(this.context);
      if (t.node !== null) orig.call(this, t.node); else t.pending.push(this);
    }
    return r;
  };
})();`;

interface TapResult {
  peak: number;
  over: number;
  rms: number;
  n: number;
  rec: number[] | Float32Array;
}

/** Voices at once per 100 ms (the most in each bin) and starts per second. */
function accounting(v: readonly { at: number; end: number }[], from: number, to: number): { total: number; perSecMax: number; perSecMean: number; atOnceMax: number; atOnceMean: number; binsOver12: number } {
  const bins = Math.max(1, Math.ceil((to - from) / 0.1));
  const most = new Array<number>(bins).fill(0);
  const ev: [number, number][] = [];
  for (const x of v) {
    ev.push([x.at, 1]);
    ev.push([Math.max(x.at, x.end), -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0;
  let k = 0;
  for (let b = 0; b < bins; b++) {
    const t1 = from + (b + 1) * 0.1;
    let m = n;
    while (k < ev.length && (ev[k] as [number, number])[0] < t1) {
      n += (ev[k] as [number, number])[1];
      m = Math.max(m, n);
      k++;
    }
    most[b] = m;
  }
  const secs = Math.max(1, Math.ceil(to - from));
  const per = new Array<number>(secs).fill(0);
  for (const x of v) {
    const s = Math.floor(x.at - from);
    if (s >= 0 && s < secs) per[s] = (per[s] as number) + 1;
  }
  const mean = (a: number[]): number => Number((a.reduce((p, q) => p + q, 0) / Math.max(1, a.length)).toFixed(1));
  return { total: v.length, perSecMax: Math.max(...per), perSecMean: mean(per), atOnceMax: Math.max(...most), atOnceMean: mean(most), binsOver12: most.filter((m) => m > 12).length };
}

async function main(): Promise<void> {
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const opts = { headless: true, args: ['--autoplay-policy=no-user-gesture-required'] };
  const browser = await chromium.launch(exe === undefined ? opts : { ...opts, executablePath: exe });
  const problems: string[] = [];
  const report: Record<string, unknown> = { dir: DIR, from: FROM, to: TO, tag: TAG };
  let page: Page | null = null;
  try {
    page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    await page.addInitScript(TAP);
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.__cs2sim3d !== undefined && window.__cs2a1 !== undefined, null, { timeout: 120_000 });
    await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 60_000 });
    await page.click('#view');
    await page.waitForFunction(() => window.__cs2a1?.stats().audio.state === 'running', null, { timeout: 20_000 });
    await page.click('#start').catch(() => undefined);
    await page.evaluate((t) => window.__cs2sim3d?.seek(t), FROM);
    await page.waitForFunction((k) => (window.__cs2sim3d?.stats().tick ?? 0) >= k, Math.round(FROM * 64), { timeout: 180_000 });
    const landed = (await page.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0)) as number;
    await page.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    // Start both meters (the output tap; the A2 engine's own before / after the limiter, if this build has it).
    await page.waitForFunction(() => (window as unknown as { __a2tap?: { node: unknown } }).__a2tap?.node != null, null, { timeout: 20_000 });
    await page.evaluate(() => (window as unknown as { __a2tap: { node: AudioWorkletNode } }).__a2tap.node.port.postMessage('start'));
    const winStart = (await page.evaluate(() => (window as unknown as { __a2tap: { node: AudioWorkletNode } }).__a2tap.node.context.currentTime)) as number;
    const a2 = (await page.evaluate(() => typeof window.__cs2a1?.meter === 'function')) as boolean;
    if (a2) await page.evaluate(() => window.__cs2a1?.meter(false));
    const t0 = Date.now();
    await page.waitForFunction((k) => (window.__cs2sim3d?.stats().tick ?? 0) >= k, Math.round(TO * 64), { timeout: 600_000, polling: 100 });
    const wallSec = (Date.now() - t0) / 1000;
    const winEnd = (await page.evaluate(() => (window as unknown as { __a2tap: { node: AudioWorkletNode } }).__a2tap.node.context.currentTime)) as number;
    const srcs = ((await page.evaluate(() => (window as unknown as { __a2srcs: { at: number; end: number }[] }).__a2srcs.map((x) => [x.at, Number.isFinite(x.end) ? x.end : 1e9]))) as [number, number][]).filter(([a]) => a >= winStart && a <= winEnd);
    report['voices'] = { sources: accounting(srcs.map(([at, end]) => ({ at, end })), winStart, winEnd) };
    const endTick = (await page.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0)) as number;
    // Let the last sounds ring out before reading the meters.
    await page.evaluate(() => document.getElementById('pause')?.click());
    await page.waitForTimeout(600);
    const tap = (await page.evaluate(
      () =>
        new Promise<{ peak: number; over: number; rms: number; n: number; rec: number[] }>((res) => {
          const node = (window as unknown as { __a2tap: { node: AudioWorkletNode } }).__a2tap.node;
          node.port.onmessage = (e: MessageEvent<{ peak: number; over: number; rms: number; n: number; rec: Float32Array }>) => res({ ...e.data, rec: Array.from(e.data.rec) });
          node.port.postMessage('get');
        }),
    )) as TapResult;
    const rate = (await page.evaluate(() => (window.__cs2a1?.stats().audio as { rate?: number } | undefined)?.rate ?? 48000)) as number;
    const outPeakDb = db(tap.peak);
    report['window'] = { landed, endTick, wallSec: Number(wallSec.toFixed(1)), realTimeRatio: Number((((endTick - landed) / 64) / wallSec).toFixed(2)) };
    report['output'] = { peakDb: Number(outPeakDb.toFixed(2)), samplesOver0dBFS: tap.over, rmsDb: Number(db(tap.rms).toFixed(2)), seconds: Number((tap.n / 2 / rate).toFixed(2)) };
    if (tap.over > 0) problems.push(`output clipped: ${tap.over} samples beyond ±1 (peak ${outPeakDb.toFixed(2)} dBFS)`);
    mkdirSync(resolve('logs/audio'), { recursive: true });
    const wav = resolve(`logs/audio/mix-${FROM}-${TO}-${TAG}.wav`);
    writeFileSync(wav, wavBytes(Float32Array.from(tap.rec), rate));
    report['wav'] = wav;
    if (a2) {
      const m = await page.evaluate(() => window.__cs2a1?.meterStats());
      if (m !== null && m !== undefined) report['limiter'] = { prePeakDb: Number(db(m.pre.peak).toFixed(2)), preOver0dBFS: m.pre.over, postPeakDb: Number(db(m.post.peak).toFixed(2)), postOver0dBFS: m.post.over };
      // Cues of the window (the director's log since the seek's reset) vs the harness's events on the same ticks.
      const cues = (await page.evaluate(([a, b]) => window.__cs2a1?.cues(a, b) ?? [], [landed + 1, Math.round(TO * 64)])) as { tick: number; id: string }[];
      const run = runHarness3d(loadHarness3dData(), { human: null, driver: null, lastTick: Math.round(TO * 64) + 2, seed: 1 });
      const inWin = run.entries.filter((e) => e.observe.tick > landed && e.observe.tick <= Math.round(TO * 64));
      const shots = inWin.reduce((n, e) => n + e.observe.events.filter((ev) => ev.type === 'shot' && gunOf(ev.weapon) !== null).length, 0);
      const steps = inWin.reduce((n, e) => n + e.observe.events.filter((ev) => ev.type === 'sound' && ev.kind === 'footstep').length, 0);
      const fire = cues.filter((c) => c.id.startsWith('fire.')).length;
      const step = cues.filter((c) => c.id.startsWith('step.')).length;
      report['cues'] = { total: cues.length, fire, shotEvents: shots, step, footstepEvents: steps, byKind: Object.fromEntries([...new Set(cues.map((c) => c.id.split('.')[0]))].map((k) => [k, cues.filter((c) => c.id.split('.')[0] === k).length])) };
      if (fire !== shots) problems.push(`fire cues ${fire} ≠ shot events ${shots}`);
      if (step !== steps) problems.push(`step cues ${step} ≠ footstep events ${steps}`);
      // Timing: each cue's lead over its arrival, and the audio spacing of one shooter's consecutive shots.
      const timing = (await page.evaluate(() => window.__cs2a1?.timing() ?? [])) as { tick: number; id: string; source: string | null; at: number; lead: number }[];
      const leads = timing.map((t) => t.lead * 1000);
      // Spacing error of consecutive cues one tick or more apart (all cues, by tick order): audio time vs tick time,
      // for the A2 schedule (`at`) and for playing each cue the moment it arrives (A1: `at − lead`).
      const gaps: number[] = [];
      const gapsArrival: number[] = [];
      const byTick = [...timing].sort((x, y) => x.tick - y.tick);
      for (let i = 1; i < byTick.length; i++) {
        const p = byTick[i - 1] as { tick: number; at: number; lead: number };
        const t = byTick[i] as { tick: number; at: number; lead: number };
        if (t.tick === p.tick || t.tick - p.tick > 16) continue;
        const want = (t.tick - p.tick) / 64;
        gaps.push(Math.abs(t.at - p.at - want) * 1000);
        gapsArrival.push(Math.abs(t.at - t.lead - (p.at - p.lead) - want) * 1000);
      }
      const q = (xs: number[], f: number): number => {
        const v = [...xs].sort((a, b) => a - b);
        return Number((v[Math.min(v.length - 1, Math.floor(f * v.length))] ?? 0).toFixed(2));
      };
      const stat = (xs: number[]): { n: number; min: number; median: number; p90: number; max: number } => ({ n: xs.length, min: q(xs, 0), median: q(xs, 0.5), p90: q(xs, 0.9), max: Number(Math.max(...xs).toFixed(2)) });
      const audio = (await page.evaluate(() => window.__cs2a1?.stats().audio)) as Record<string, unknown>;
      const voices = (await page.evaluate(() => window.__cs2a1?.voices() ?? [])) as { at: number; id: string; event: string; source: string | null; distance: number; gain: number; local: boolean; end: number }[];
      const audible = voices.filter((v) => v.gain > 0.001);
      const stepRate = new Map<string, number>();
      for (const v of voices) {
        if (!v.id.startsWith('step.') || v.source === null) continue;
        const k = `${v.source} ${Math.floor(v.at - winStart)}`;
        stepRate.set(k, (stepRate.get(k) ?? 0) + 1);
      }
      const byEvent = new Map<string, number>();
      for (const v of voices) byEvent.set(v.event, (byEvent.get(v.event) ?? 0) + 1);
      (report['voices'] as Record<string, unknown>)['engine'] = {
        started: voices.length,
        audible: audible.length,
        all: accounting(voices, winStart, winEnd),
        audibleAtOnce: accounting(audible, winStart, winEnd),
        maxStepsPerPawnPerSec: Math.max(0, ...stepRate.values()),
        culledBeyondCurve: audio['culled'],
        topEvents: [...byEvent.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12),
      };
      const csv = ['at_s,id,event,source,distance_u,gain_db,local,dur_s', ...voices.map((v) => `${(v.at - winStart).toFixed(3)},${v.id},${v.event},${v.source ?? ''},${v.distance.toFixed(0)},${(20 * Math.log10(Math.max(1e-6, v.gain))).toFixed(1)},${v.local ? 1 : 0},${(Math.min(v.end, 1e6) - v.at).toFixed(3)}`)];
      writeFileSync(resolve(`logs/audio/voices-${TAG}.csv`), csv.join('\n') + '\n');
      const lr0 = await page.evaluate(() => window.__cs2a1?.probeLR(0));
      const lr90 = await page.evaluate(() => window.__cs2a1?.probeLR(90));
      report['leftRight'] = { yaw0: lr0, yaw90: lr90 };
      for (const lr of [lr0, lr90]) if (lr === undefined || !(lr.right > lr.left * 1.5)) problems.push(`left / right: a sound on the right is not louder on the right ${JSON.stringify(lr)}`);
      report['bank'] = { inBuild: audio['bank'], realFiles: audio['realFiles'] };
      report['timing'] = { leadMs: stat(leads), spacingErrorMs: gaps.length > 0 ? stat(gaps) : null, spacingErrorIfPlayedOnArrivalMs: gapsArrival.length > 0 ? stat(gapsArrival) : null, late: audio['late'], limited: audio['limited'], skipped: audio['skipped'], latency: await page.evaluate(() => window.__cs2a1?.latency()) };
    }
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close();
    server.close();
  }
  report['problems'] = problems;
  mkdirSync(resolve('logs/audio'), { recursive: true });
  writeFileSync(resolve(`logs/audio/check-${TAG}.json`), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  if (problems.length > 0) process.exit(1);
}

void main();
