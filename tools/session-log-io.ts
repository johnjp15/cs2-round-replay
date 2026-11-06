/** Node helpers to read and write SessionLog JSONL files (logs/ is gitignored). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SessionLog } from '../src/contracts/index';

export function readSessionLog(path: string): SessionLog {
  return SessionLog.fromText(readFileSync(path, 'utf8'));
}

/** Write the log as UTF-8 JSONL ("\n" line endings), creating parent folders. */
export function writeSessionLog(path: string, log: SessionLog): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, log.toText(), 'utf8');
}
