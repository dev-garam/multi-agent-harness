import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatContinuationContext, continuationRecord } from '../src/continuation.js';

// 이어받기(--continue): 끝난 run의 결과 위에 다음 지시를 쌓는다.
//
// 실행 중인 스텝에 끼어들 수는 없다(CLI가 이미 프롬프트를 받아 돌고 stdin도
// 막혀 있다). 대신 두 가지를 이어받는다: 변경(changes.patch)과 맥락(요약).
//
// 반대로 "A 말고 B"는 이어받지 않는 것이 맞다. 격리 실행이 기본이라 이전 변경은
// 원본에 없고, 그냥 새 run을 돌리면 없던 일이 된다. 그 경로도 함께 고정한다.

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-continue-'));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);

  // 프롬프트에 "make B"가 있으면 B를, 아니면 A를 만든다.
  writeFileSync(path.join(repo, 'mock-agent.cjs'), `
const fs = require('fs');
const stepId = process.argv[2];
const finalPath = process.argv[3];
const promptPath = process.argv[4];
const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
if (stepId === 'coder') {
  if (/make B/.test(prompt)) {
    fs.writeFileSync('B.txt', 'B done\\n');
  } else {
    fs.writeFileSync('A.txt', 'A done\\n');
  }
}
fs.writeFileSync(finalPath, '# ' + stepId + '\\n\\nmock');
`);
  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
    pipeline: 'quick_fix',
    protectedBranches: [],
    agent: {
      provider: 'mock', command: 'node', versionArgs: ['--version'], outputMode: 'file',
      args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}', '{{promptPath}}']
    },
    supervisor: { enabled: false }
  }, null, 2));
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

function runHarness(repo, extraArgs, request) {
  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, ...extraArgs, request], {
    cwd: harnessRoot, encoding: 'utf8'
  });
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, `run dir missing:\n${result.stderr}`);
  const runDir = match[1].trim();
  return {
    result,
    runDir,
    runId: path.basename(runDir),
    manifest: JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
  };
}

const repos = [];
try {
  const repo = makeRepo();
  repos.push(repo);

  // 1차: A 작업.
  const first = runHarness(repo, [], 'make A');
  assert.equal(first.manifest.status, 'succeeded', first.result.stderr.slice(-300));
  assert.equal(existsSync(path.join(first.runDir, 'worktree', 'A.txt')), true);
  // 격리 실행이므로 원본은 그대로다.
  assert.equal(existsSync(path.join(repo, 'A.txt')), false, 'isolated run must not touch the original');

  // -------------------------------------------------------------------------
  // 누적: --continue 로 B를 얹는다. 앞선 A가 살아 있어야 한다.
  // -------------------------------------------------------------------------
  const second = runHarness(repo, ['--continue', first.runId], 'make B too');
  assert.equal(second.manifest.status, 'succeeded', second.result.stderr.slice(-300));
  assert.equal(existsSync(path.join(second.runDir, 'worktree', 'A.txt')), true, 'previous work is carried');
  assert.equal(existsSync(path.join(second.runDir, 'worktree', 'B.txt')), true, 'new work is added on top');

  // 이어받았다는 사실이 기록된다(감사 대상).
  assert.equal(second.manifest.continuedFrom.runId, first.runId);
  assert.equal(second.manifest.continuedFrom.patchApplied, true);
  assert.equal(second.manifest.continuedFrom.request, 'make A');
  assert.match(second.result.stderr, /Continuing from: /);

  // 맥락이 첫 스텝부터 보인다. 이어지는 지시가 앞의 작업을 아는 상태에서 해석되어야 한다.
  const coderPrompt = readFileSync(path.join(second.runDir, 'coder.prompt.md'), 'utf8');
  assert.match(coderPrompt, /## previous run/);
  assert.match(coderPrompt, /request: make A/);
  assert.match(coderPrompt, /changedFiles: A\.txt/);

  // -------------------------------------------------------------------------
  // 정정: --continue 없이 새 run. 이전 변경은 따라오지 않는다.
  // "A 말고 B"에서 롤백이 필요 없는 이유다 — A는 원본에 들어간 적이 없다.
  // -------------------------------------------------------------------------
  const third = runHarness(repo, [], 'make B too');
  assert.equal(existsSync(path.join(third.runDir, 'worktree', 'B.txt')), true);
  assert.equal(
    existsSync(path.join(third.runDir, 'worktree', 'A.txt')),
    false,
    'a fresh run must not inherit the previous run'
  );
  assert.equal(third.manifest.continuedFrom, null);

  // --latest 로도 이어받을 수 있다.
  const fourth = runHarness(repo, ['--continue'], 'make B too');
  assert.equal(fourth.manifest.continuedFrom.runId, third.runId, 'defaults to the latest run');

  // 존재하지 않는 run은 명확히 실패한다.
  const missing = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--continue', '2099-12-31_235959_999', 'x'], {
    cwd: harnessRoot, encoding: 'utf8'
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot continue: run not found/);
} finally {
  for (const repo of repos) {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 요약 포맷: 다음 판단에 필요한 것만 담는다. 스텝 출력 전문은 넣지 않는다 —
// 이미 끝난 대화이고 다시 넣으면 컨텍스트만 부풀린다.
// ---------------------------------------------------------------------------
const context = formatContinuationContext({
  runId: '2026-01-01_000000_000',
  manifest: {
    request: 'fix the parser',
    pipeline: 'quick_fix',
    completedPipeline: 'safe_fix',
    status: 'failed',
    steps: [
      { type: 'validation', stepId: 'test', status: 'failed', exitCode: 1 },
      { type: 'inspection', changedFiles: [{ path: 'src/parse.js' }] }
    ],
    supervisorDecisions: [{ nextAction: 'stop_failed', status: 'failed', reason: 'tests still red' }],
    failure: { kind: 'agent-error', summary: 'The step exited with an error.' }
  }
});
assert.match(context, /## previous run \(2026-01-01_000000_000\)/);
assert.match(context, /request: fix the parser/);
assert.match(context, /pipeline: safe_fix/, 'reports the pipeline that actually ran');
assert.match(context, /status: failed/);
assert.match(context, /changedFiles: src\/parse\.js/);
assert.match(context, /validation: test: failed \(exit 1\)/);
assert.match(context, /supervisor: stop_failed \(failed\)/);
assert.match(context, /supervisorReason: tests still red/);
assert.match(context, /failure: agent-error/);

// 기록.
const record = continuationRecord(
  { runId: 'r1', patchPath: '/p', isolated: true, manifest: { request: 'r', status: 'succeeded' } },
  { patchApplied: true }
);
assert.deepEqual(record, {
  runId: 'r1', request: 'r', status: 'succeeded', patchApplied: true, patchPath: '/p', isolated: true
});

console.log('continuation tests passed');
