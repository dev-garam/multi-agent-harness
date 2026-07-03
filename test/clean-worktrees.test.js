import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const runId = '2000-01-01_000000_000';
const runDir = path.join(harnessRoot, 'runs', runId);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

rmSync(runDir, { recursive: true, force: true });

const repo = mkdtempSync(path.join(tmpdir(), 'harness-clean-worktree-repo-'));
mkdirSync(runDir, { recursive: true });
writeFileSync(path.join(repo, 'README.md'), '# clean worktree test\n');
run('git', ['init', '-b', 'main'], repo);
run('git', ['config', 'user.email', 'test@example.com'], repo);
run('git', ['config', 'user.name', 'Test'], repo);
run('git', ['add', '.'], repo);
run('git', ['commit', '-m', 'init'], repo);

const worktreePath = path.join(runDir, 'worktree');
run('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], repo);
assert.equal(existsSync(worktreePath), true);

writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  runId,
  repo,
  executionRepo: worktreePath,
  status: 'succeeded',
  workspace: {
    mode: 'worktree',
    originalRepo: repo,
    executionRepo: worktreePath,
    isolated: true,
    prepared: true,
    worktreePath,
    finalized: true,
    patchPath: path.join(runDir, 'changes.patch'),
    patchStatus: 'succeeded',
    worktreeRemoved: false
  },
  steps: []
}, null, 2) + '\n');

try {
  const dryRun = spawnSync('node', [harnessBin, 'clean', '--worktrees', '--days', '0', '--keep', '0', '--dry-run'], {
    cwd: harnessRoot,
    encoding: 'utf8'
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry-run.*remove worktree/);
  assert.equal(existsSync(worktreePath), true);

  const clean = spawnSync('node', [harnessBin, 'clean', '--worktrees', '--days', '0', '--keep', '0'], {
    cwd: harnessRoot,
    encoding: 'utf8'
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /removed worktree/);
  assert.equal(existsSync(worktreePath), false);

  const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.workspace.worktreeRemoved, true);
  assert.ok(manifest.workspace.worktreeRemovedAt);
} finally {
  rmSync(runDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log('clean worktrees tests passed');
