/**
 * Fetch the pinned public test demo (Valve matchmaking, de_mirage, from demoparser2's repo at a fixed commit) to
 * local/demos/test_demo.dem and check its SHA-256. If the shared copy on the agents' machine exists it is copied
 * instead of downloaded. Never commit the demo.
 *
 *   npm run coach:fetch-test-demo [-- --force]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DEMO = {
  url: 'https://raw.githubusercontent.com/LaihoE/demoparser/8035c3d9c61e00fb6634f76541e535f64f0f4d3f/src/parser/test_demo.dem',
  bytes: 60_601_900,
  sha256: '84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2',
};
const SHARED_COPY = '/home/claude/coach-data/demos/test_demo.dem';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TEST_DEMO_PATH = resolve(ROOT, 'local/demos/test_demo.dem');

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function main(): void {
  const force = process.argv.includes('--force');
  if (!force && existsSync(TEST_DEMO_PATH) && sha(TEST_DEMO_PATH) === TEST_DEMO.sha256) {
    console.log(`ok: ${TEST_DEMO_PATH} (already present, hash matches)`);
    return;
  }
  mkdirSync(dirname(TEST_DEMO_PATH), { recursive: true });
  const tmp = `${TEST_DEMO_PATH}.part`;
  rmSync(tmp, { force: true });
  if (existsSync(SHARED_COPY)) {
    console.log(`copying ${SHARED_COPY}`);
    copyFileSync(SHARED_COPY, tmp);
  } else {
    console.log(`downloading ${TEST_DEMO.url}`);
    const r = spawnSync('curl', ['-fL', '--retry', '3', '-o', tmp, TEST_DEMO.url], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`curl failed (${r.status})`);
  }
  const got = sha(tmp);
  if (got !== TEST_DEMO.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`SHA-256 mismatch: got ${got}, want ${TEST_DEMO.sha256}`);
  }
  renameSync(tmp, TEST_DEMO_PATH);
  console.log(`ok: ${TEST_DEMO_PATH} (${TEST_DEMO.bytes} bytes, sha256 ${TEST_DEMO.sha256})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
