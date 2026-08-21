import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanRuns } from '../src/clean.js';

const testRoot = mkdtempSync(path.join(tmpdir(), 'harness-clean-interrupted-'));
const runsDir = path.join(testRoot, 'runs');
const runIds = [
  '2099-01-01_000000_000',
  '2099-01-01_000001_000',
  '2099-01-01_000002_000',
  '2099-01-01_000003_000',
  '2099-01-01_000004_000'
];
mkdirSync(runsDir, { recursive: true });

function writeManifest(runId, manifest) {
  const runDir = path.join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return runDir;
}

writeManifest(runIds[0], { runId: runIds[0], startedAt: '2099-01-01T00:00:00.000Z' });
writeManifest(runIds[1], { runId: runIds[1], status: 'succeeded' });
writeManifest(runIds[2], { runId: runIds[2], status: 'succeeded', finishedAt: '2099-01-01T00:00:02.000Z' });
writeManifest(runIds[3]);
const invalidManifestDir = writeManifest(runIds[4]);
writeFileSync(path.join(invalidManifestDir, 'manifest.json'), '{not json');

const messages = [];
const originalLog = console.log;
console.log = (message) => messages.push(message);

try {
  const result = await cleanRuns({ days: 0, keep: 0, exclude: runIds, runsDir });

  assert.deepEqual(result.interrupted, [runIds[1], runIds[0]]);
  assert.equal(result.moved.length, 0);
  assert.deepEqual(messages, [
    'Interrupted: 2 run(s) never finished.',
    'No runs matched clean criteria.'
  ]);
} finally {
  console.log = originalLog;
  for (const runId of runIds) {
    rmSync(path.join(runsDir, runId), { recursive: true, force: true });
  }
  rmSync(testRoot, { recursive: true, force: true });
}

console.log('clean interrupted tests passed');
