import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 변경 0건 게이트: 쓰기 스텝(coder)이 돌았는데 아무것도 바뀌지 않으면 요청이
// 이행되지 않은 것이다. validation은 이 경우에도 통과할 수 있어(기존 상태로 빌드
// 성공) validation 결과만으로는 잡히지 않는다.
//
// 실제 run(2026-07-06_141743_877)에서 build가 exit 0인데 hermes가 "변경 0건,
// build 통과는 기존 스캐폴드 확인일 뿐"이라며 stop_failed를 냈다. 그 판단 근거는
// 이미 manifest의 changedFiles=0에 있었으므로 LLM 없이 결정론적으로 잡을 수 있다.

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(prefix, harnessConfig, mockBody) {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(path.join(repo, 'mock-agent.cjs'), mockBody);
  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify(harnessConfig, null, 2));
  git(['add', '.'], repo);
  git(['commit', '-m', 'setup'], repo);
  return repo;
}

function baseConfig(extra = {}) {
  return {
    pipeline: 'quick_fix',
    // patch 모드: 격리 실행은 worktree와 같지만 run 종료 시 worktree가 제거되어
    // 테스트가 runs/ 아래에 부산물을 남기지 않는다.
    workspaceMode: 'patch',
    protectedBranches: ['main'],
    // validation은 통과한다. 변경이 없어도 성공하는 명령을 일부러 쓴다.
    validationCommands: [{ id: 'noop', command: 'echo validation-ok' }],
    agent: {
      provider: 'mock',
      command: 'node',
      versionArgs: ['--version'],
      outputMode: 'file',
      args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
    },
    supervisor: { enabled: false },
    ...extra
  };
}

// 아무 파일도 바꾸지 않는 coder(권한 거부 등으로 변경 0건인 상황을 흉내낸다).
const NO_CHANGE_MOCK = `
const fs = require('fs');
fs.writeFileSync(process.argv[3], 'mock output: nothing changed');
`;

// 실제로 파일을 바꾸는 coder.
const CHANGE_MOCK = `
const fs = require('fs');
if (process.argv[2] === 'coder') {
  fs.writeFileSync('created.txt', 'changed\\n');
}
fs.writeFileSync(process.argv[3], 'mock output');
`;

function runHarness(repo, args = []) {
  return spawnSync('node', [harnessBin, 'run', '--repo', repo, ...args, 'implement the feature'], {
    cwd: harnessRoot,
    encoding: 'utf8'
  });
}

function manifestFor(result) {
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, `run dir missing:\n${result.stderr}`);
  return JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// 차단: 옵트인 + 변경 0건 → validation이 통과해도 런을 실패시킨다.
// ---------------------------------------------------------------------------
const blockedRepo = makeRepo(
  'harness-no-change-',
  baseConfig({ policy: { blockOnNoChanges: true } }),
  NO_CHANGE_MOCK
);
const blocked = runHarness(blockedRepo);
assert.notEqual(blocked.status, 0, 'write step with no changes must fail when gate is on');
assert.match(blocked.stderr, /Policy blocked this run: write step ran but produced no changes/, blocked.stderr);

const blockedManifest = manifestFor(blocked);
assert.equal(blockedManifest.status, 'failed');
assert.equal(blockedManifest.policyBlock.kind, 'no-change');
assert.equal(blockedManifest.policyBlock.changedFiles, 0);
// validation은 실제로 통과했는데도 차단됐다는 점이 이 게이트의 핵심이다.
const blockedValidation = blockedManifest.steps.filter((step) => step.type === 'validation');
assert.ok(blockedValidation.length > 0, 'validation should have run');
assert.ok(
  blockedValidation.every((step) => step.exitCode === 0),
  'validation passed yet the run was still blocked'
);
// hermes를 호출하기 전에 끝나므로 provider 호출을 아낀다.
assert.equal(
  blockedManifest.steps.filter((step) => step.type === 'agent' && step.stepId === 'reporter').length,
  0,
  'gate should stop before reporter'
);

// ---------------------------------------------------------------------------
// 승인 우회: --policy-approved면 통과한다.
// ---------------------------------------------------------------------------
const approved = runHarness(blockedRepo, ['--policy-approved']);
assert.equal(approved.status, 0, `approved run should proceed: ${approved.stderr}`);

// ---------------------------------------------------------------------------
// 기본값(옵트아웃): 게이트가 없으면 변경 0건이어도 차단하지 않는다.
// 다만 신호는 manifest와 컨텍스트에 남아 hermes가 판단할 수 있어야 한다.
// ---------------------------------------------------------------------------
const offRepo = makeRepo('harness-no-change-off-', baseConfig(), NO_CHANGE_MOCK);
const notGated = runHarness(offRepo);
assert.equal(notGated.status, 0, `without blockOnNoChanges the run proceeds: ${notGated.stderr}`);

const offManifest = manifestFor(notGated);
const offInspection = offManifest.steps.find((step) => step.type === 'inspection');
assert.ok(offInspection, 'inspection step should exist');
assert.equal(offInspection.noChangeAssessment.suspicious, true, 'signal must be recorded even when not blocking');
assert.equal(offInspection.noChangeAssessment.writeStepRan, true);
assert.equal(offInspection.noChangeAssessment.changedFiles, 0);

// ---------------------------------------------------------------------------
// 오탐 방지: 실제로 파일이 바뀌면 게이트가 켜져 있어도 통과한다.
// ---------------------------------------------------------------------------
const changedRepo = makeRepo(
  'harness-no-change-ok-',
  baseConfig({ policy: { blockOnNoChanges: true } }),
  CHANGE_MOCK
);
const changed = runHarness(changedRepo);
assert.equal(changed.status, 0, `run with real changes should proceed: ${changed.stderr}`);

const changedManifest = manifestFor(changed);
const changedInspection = changedManifest.steps.find((step) => step.type === 'inspection');
assert.equal(changedInspection.noChangeAssessment.suspicious, false);
assert.ok(changedInspection.changedFiles.length > 0, 'inspection should see the created file');

console.log('no-change gate tests passed');
