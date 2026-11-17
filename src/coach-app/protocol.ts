/** Messages between the page (`client.ts`) and the pipeline worker (`worker.ts`). docs/coach/app.md "Worker protocol". */
import type { RawDemo } from '../coach/model/raw';
import type { Side, TeamId } from '../coach/model/match';
import type { MatchReport } from '../coach/model/report';

export type Stage = 'reading' | 'parsing' | 'rounds' | 'analysis' | 'replay';

export type PipelineRequest =
  /** A `.craw` / `.craw.gz` file: read (and gunzip) in the worker. */
  | { type: 'load'; file: Blob; fileName: string; mapBase: string }
  /** A RawDemo parsed elsewhere (K1's parser worker), typed arrays transferred. */
  | { type: 'raw'; raw: RawDemo; fileName: string; mapBase: string }
  /** Analyze the loaded demo for this player slot (again, for another player: no re-parse). */
  | { type: 'analyze'; user: number };

export interface PickerPlayer {
  slot: number;
  name: string;
  steamId: string;
  bot: boolean;
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  /** Damage per round over the rounds played. */
  adr: number;
}

export interface ParsedInfo {
  fileName: string;
  map: string;
  demoSha256: string;
  score: Record<TeamId, number>;
  /** Side of each team in the first round. */
  firstSide: Record<TeamId, Side>;
  rounds: number;
  players: PickerPlayer[];
}

export type PipelineMessage =
  | { type: 'progress'; stage: Stage; fraction: number }
  | { type: 'parsed'; info: ParsedInfo; ms: number }
  | {
    type: 'report';
    report: MatchReport;
    /** `analyze` = K2's analysis ran; `stub` = match facts only (no analysis in this build, or it failed: `note`). */
    source: 'analyze' | 'stub';
    note: string | null;
    replayBytes: number;
    /** Milliseconds per stage. */
    timings: Record<string, number>;
  }
  | { type: 'error'; message: string };
