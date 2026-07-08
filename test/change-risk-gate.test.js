import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// C2b 하드 블록: 실제 diff가 위험(migration 등)하면 policy.blockOnChangeRisk 시
// 런을 차단하고, --policy-approved면 통과함을 end-to-end로 고정한다.

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const repo = mkdtempSync(path.join(tmpdir(), 'harness-change-risk-'));
const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
if (init.status !== 0) {
  git(['init'], repo);
  git(['checkout', '-b', 'work'], repo);
}
git(['config', 'user.email', 'test@example.com'], repo);
git(['config', 'user.name', 'test'], repo);

// coder가 위험 경로(migration)에 파일을 만드는 mock agent.
writeFileSync(path.join(repo, 'mock-agent.cjs'), `
const fs = require('fs');
fs.mkdirSync('db/migrations', { recursive: true });
fs.writeFileSync('db/migrations/001_add_users.sql', 'CREATE TABLE users();\\n');
fs.writeFileSync(process.argv[3], 'mock output');
`);
writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
  pipeline: 'quick_fix',
  workspaceMode: 'worktree',
  protectedBranches: ['main'],
  policy: { blockOnChangeRisk: true },
  agent: {
    provider: 'mock',
    command: 'node',
    versionArgs: ['--version'],
    outputMode: 'file',
    args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
  },
  supervisor: { enabled: false }
}, null, 2));
git(['add', '.'], repo);
git(['commit', '-m', 'setup'], repo);

// 차단: 위험 변경 + 승인 없음 → 실패, 명확한 메시지.
const blocked = spawnSync('node', [harnessBin, 'run', '--repo', repo, 'update the schema'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.notEqual(blocked.status, 0, 'risky change without approval must fail');
assert.match(blocked.stderr, /Policy blocked this run: risky change detected/, blocked.stderr);
assert.match(blocked.stderr, /migration/, 'block reason names the migration risk');

// 승인: --policy-approved → 통과.
const approved = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--policy-approved', 'update the schema'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(approved.status, 0, `approved run should proceed: ${approved.stderr}`);
assert.match(approved.stderr, /Harness run:/);

// 옵트아웃(기본): blockOnChangeRisk 없으면 위험해도 차단하지 않음(관측만).
const repo2 = mkdtempSync(path.join(tmpdir(), 'harness-change-risk-off-'));
const init2 = spawnSync('git', ['init', '-b', 'work'], { cwd: repo2, encoding: 'utf8' });
if (init2.status !== 0) {
  git(['init'], repo2);
  git(['checkout', '-b', 'work'], repo2);
}
git(['config', 'user.email', 'test@example.com'], repo2);
git(['config', 'user.name', 'test'], repo2);
writeFileSync(path.join(repo2, 'mock-agent.cjs'), `
const fs = require('fs');
fs.mkdirSync('db/migrations', { recursive: true });
fs.writeFileSync('db/migrations/001_add_users.sql', 'CREATE TABLE users();\\n');
fs.writeFileSync(process.argv[3], 'mock output');
`);
writeFileSync(path.join(repo2, '.harness.json'), JSON.stringify({
  pipeline: 'quick_fix',
  workspaceMode: 'worktree',
  protectedBranches: ['main'],
  agent: {
    provider: 'mock',
    command: 'node',
    versionArgs: ['--version'],
    outputMode: 'file',
    args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
  },
  supervisor: { enabled: false }
}, null, 2));
git(['add', '.'], repo2);
git(['commit', '-m', 'setup'], repo2);
const notGated = spawnSync('node', [harnessBin, 'run', '--repo', repo2, 'update the schema'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(notGated.status, 0, `without blockOnChangeRisk the run proceeds: ${notGated.stderr}`);

console.log('change risk gate tests passed');
