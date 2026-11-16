/**
 * The page's side of the pipeline: one worker per dropped demo (kept alive so another player can be analyzed without
 * parsing again). `.craw` / `.craw.gz` files go straight to the worker; demos (`.dem`, `.dem.bz2`, `.dem.zst`,
 * `.dem.gz`) go through K1's browser parser (`src/coach-parser`) when this build has it, found with
 * `import.meta.glob` so the page builds without it.
 */
import type { RawDemo } from '../coach/model/raw';
import { MAP_PACK_BASE } from './config';
import type { ParsedInfo, PipelineMessage, PipelineRequest, Stage } from './protocol';

interface ParserModule {
  parseDemo(input: File | Blob | Uint8Array, onProgress?: (stage: string, fraction: number) => void): Promise<RawDemo>;
}
const parserModules = import.meta.glob<ParserModule>('../coach-parser/index.ts');

/** True when this build can parse `.dem` files itself. */
export const CAN_PARSE_DEMOS = Object.keys(parserModules).length > 0;

export const NO_PARSER_MESSAGE = 'Demo parsing isn\'t built into this build yet. Drop a .craw or .craw.gz instead (npm run coach -- parse <demo> writes one).';

export type ReportMessage = Extract<PipelineMessage, { type: 'report' }>;

export interface PipelineHandlers {
  onProgress(stage: Stage, fraction: number): void;
  onParsed(info: ParsedInfo): void;
  onReport(m: ReportMessage): void;
  onError(message: string): void;
}

function rawTransferables(raw: RawDemo): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const v of Object.values(raw.ticks)) if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  for (const p of raw.projectiles) out.add(p.path.buffer as ArrayBuffer);
  return [...out];
}

/** Whether a file is our RawDemo container: by its magic, or `.craw.gz` by name (gzip hides the magic). */
async function isCraw(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x43 && head[1] === 0x52 && head[2] === 0x41 && head[3] === 0x57) return true;
  return /\.craw(\.gz)?$/i.test(file.name);
}

export class Pipeline {
  private worker: Worker;
  info: ParsedInfo | null = null;
  readonly mapBase = new URL(MAP_PACK_BASE, location.href).href;

  constructor(private readonly h: PipelineHandlers) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<PipelineMessage>): void => {
      const m = e.data;
      if (m.type === 'progress') h.onProgress(m.stage, m.fraction);
      else if (m.type === 'parsed') { this.info = m.info; h.onParsed(m.info); }
      else if (m.type === 'report') h.onReport(m);
      else h.onError(m.message);
    };
    this.worker.onerror = (e): void => h.onError(e.message || 'The pipeline worker failed.');
  }

  private send(req: PipelineRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(req, transfer);
  }

  async load(file: File): Promise<void> {
    if (await isCraw(file)) {
      this.send({ type: 'load', file, fileName: file.name, mapBase: this.mapBase });
      return;
    }
    const loader = Object.values(parserModules)[0];
    if (!loader) { this.h.onError(NO_PARSER_MESSAGE); return; }
    try {
      const mod = await loader();
      const raw = await mod.parseDemo(file, (_stage, f) => this.h.onProgress(f < 0.08 ? 'reading' : 'parsing', f));
      this.send({ type: 'raw', raw, fileName: file.name, mapBase: this.mapBase }, rawTransferables(raw));
    } catch (err) {
      this.h.onError(err instanceof Error ? err.message : String(err));
    }
  }

  analyze(user: number): void {
    this.send({ type: 'analyze', user });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
