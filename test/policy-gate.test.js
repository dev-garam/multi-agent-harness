import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function runGit(args, repo) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `git failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function initMainBranch(repo) {
  const init = spawnSync('git', ['init', '-b', 'main'], {
    cwd: repo,
    encoding: 'utf8'
  });
  if (init.status !== 0) {
    runGit(['init'], repo);
    runGit(['checkout', '-b', 'main'], repo);
  }
  assert.equal(runGit(['branch', '--show-current'], repo), 'main');
}

const repo = mkdtempSync(path.join(tmpdir(), 'harness-policy-gate-'));
initMainBranch(repo);
writeFileSync(path.join(repo, 'mock-agent.cjs'), `
const fs = require('fs');
fs.writeFileSync(process.argv[3], 'mock output');
`);
writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
  pipeline: 'quick_fix',
  workspaceMode: 'direct',
  protectedBranches: ['main'],
  agent: {
    provider: 'mock',
    command: 'node',
    versionArgs: ['--version'],
    outputMode: 'file',
    args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
  },
  supervisor: {
    enabled: false
  }
}, null, 2));

const blocked = spawnSync('node', [harnessBin, 'run', '--repo', repo, 'README를 수정해줘'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.notEqual(blocked.status, 0);
assert.match(blocked.stderr, /Policy blocked direct writes on protected branch/);

const approved = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--policy-approved', 'README를 수정해줘'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(approved.status, 0, approved.stderr);
assert.match(approved.stderr, /Harness run:/);

console.log('policy gate tests passed');
