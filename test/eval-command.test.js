import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const repo = mkdtempSync(path.join(tmpdir(), 'harness-eval-command-'));

writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  },
  testCommand: 'npm test',
  protectedBranches: ['main', 'production'],
  redaction: {
    enabled: true
  },
  budget: {
    maxAgentSteps: 10
  }
}, null, 2));

const run = spawnSync('node', [harnessBin, 'eval', '--repo', repo], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(run.status, 0, run.stderr);
assert.match(run.stdout, /Harness eval/);
assert.match(run.stdout, /project-config-schema/);
assert.match(run.stdout, /Status: passed/);

const json = spawnSync('node', [harnessBin, 'eval', '--repo', repo, '--json'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(json.status, 0, json.stderr);
const parsed = JSON.parse(json.stdout);
assert.equal(parsed.status, 'passed');
assert.ok(parsed.checks.some((entry) => entry.id === 'budget-policy' && entry.status === 'pass'));
assert.ok(existsSync(parsed.reportPath));

console.log('eval command tests passed');
