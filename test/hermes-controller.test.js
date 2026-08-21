import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function runGit(args, repo) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `git failed: ${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout.trim();
}

function writeMockAgent(repo) {
  const mockPath = path.join(repo, 'mock-agent.cjs');
  writeFileSync(mockPath, `
const fs = require('fs');
const path = require('path');
const scenario = process.env.HARNESS_TEST_SCENARIO;
const stepId = process.argv[2];
const finalPath = process.argv[3];
const statePath = path.join(process.cwd(), '.mock-state.json');
const logPath = path.join(process.cwd(), '.mock-steps.log');
const fence = String.fromCharCode(96, 96, 96);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
state[stepId] = (state[stepId] || 0) + 1;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.appendFileSync(logPath, stepId + '\\n');

function decision(value) {
  return '# ' + stepId + '\\n\\n' + fence + 'json\\n' + JSON.stringify(value, null, 2) + '\\n' + fence + '\\n';
}

let body = '# ' + stepId + '\\n\\nmock output';

if (stepId.startsWith('reporter')) {
  body = '# ' + stepId + '\\n\\n' + fence + 'json\\n' + JSON.stringify({
    status: 'success',
    summary: 'mock report',
    changedFiles: [],
    validation: [],
    risks: []
  }, null, 2) + '\\n' + fence + '\\n';
}

if (scenario === 'workspace' && stepId === 'coder') {
  fs.writeFileSync('workspace-output.txt', 'created in isolated workspace\\n');
}

if (scenario === 'agent-output' && stepId === 'coder') {
  console.log('agent produced output');
}

if (scenario === 'agent-timeout' && stepId === 'coder') {
  setTimeout(() => {}, 10000);
  return;
}

if (stepId.startsWith('hermes')) {
  const hermesCount = Object.keys(state).filter((key) => key.startsWith('hermes')).reduce((sum, key) => sum + state[key], 0);
  if (scenario === 'rerun' && hermesCount === 1) {
    body = decision({ status: 'incomplete', nextAction: 'rerun_step', targetStep: 'coder', reason: 'mock retry', instructions: 'retry coder once' });
  } else if (scenario === 'validation' && hermesCount === 1) {
    body = decision({ status: 'incomplete', nextAction: 'run_validation', targetStep: 'coder', reason: 'mock validation', instructions: 'run validation again' });
  } else if (scenario.indexOf('escalate') === 0 && hermesCount === 1) {
    body = decision({ status: 'incomplete', nextAction: 'escalate_to_safe_fix', targetStep: null, reason: 'mock escalation', instructions: 'use safe fix' });
  } else {
    body = decision({ status: 'success', nextAction: 'continue', targetStep: null, reason: 'mock ok', instructions: 'report success' });
  }
}

fs.writeFileSync(finalPath, body);
`);
  return mockPath;
}

function writeProjectConfig(repo, scenario) {
  const mockPath = writeMockAgent(repo);
  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
    pipeline: 'quick_fix',
    agent: {
      provider: 'mock',
      command: 'node',
      versionArgs: ['--version'],
      outputMode: 'file',
      args: [mockPath, '{{stepId}}', '{{finalPath}}']
    },
    validationCommands: [
      {
        id: 'mock-validation',
        command: scenario === 'validation-timeout'
          ? "node -e \"setTimeout(() => {}, 10000)\""
          : "node -e \"require('fs').appendFileSync('.validation.log', 'validated\\\\n')\""
      }
    ],
    resources: scenario === 'agent-timeout'
      ? {
          agentTimeoutMs: 100,
          validationTimeoutMs: 1000,
          maxLogBytes: 1024
        }
      : scenario === 'validation-timeout'
        ? {
            agentTimeoutMs: 1000,
            validationTimeoutMs: 100,
            maxLogBytes: 1024
          }
        : undefined,
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 4,
      maxStepRetries: 1,
      escalation: scenario === 'escalate-resume'
        ? { skipCompletedSteps: true }
        : undefined,
      agent: {
        provider: 'mock-supervisor',
        command: 'node',
        versionArgs: ['--version'],
        outputMode: 'file',
        args: [mockPath, '{{stepId}}', '{{finalPath}}']
      }
    },
    cleanup: {
      enabled: true,
      days: 999999,
      keep: 999999
    }
  }, null, 2));
  writeFileSync(path.join(repo, '.scenario'), scenario);
}

function runHarness(scenario, pipeline = 'quick_fix') {
  const repo = mkdtempSync(path.join(tmpdir(), `harness-${scenario}-`));
  writeProjectConfig(repo, scenario);

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', pipeline, `${scenario} test`], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: scenario
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `${scenario} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, `run dir missing for ${scenario}`);
  const runDir = match[1].trim();
  const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  const steps = readFileSync(path.join(repo, '.mock-steps.log'), 'utf8').trim().split('\n');
  return { repo, runDir, manifest, steps };
}

function runBlockedHarness() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-policy-blocked-'));
  writeProjectConfig(repo, 'blocked');

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', '데이터베이스 전체 삭제'], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: 'blocked'
    },
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'destructive direct run should be blocked before agent execution');
  assert.match(result.stderr, /Policy blocked this run/);
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, 'run dir missing for blocked policy run');
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.policy.decision.allowed, false);
  assert.equal(manifest.policy.decision.risk.destructive, true);
  assert.throws(() => readFileSync(path.join(repo, '.mock-steps.log'), 'utf8'));
}

function runPatchWorkspaceHarness() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-workspace-'));
  writeProjectConfig(repo, 'workspace');
  runGit(['init', '-b', 'main'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', '--workspace-mode', 'patch', 'workspace test'], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: 'workspace'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `workspace patch run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.throws(() => readFileSync(path.join(repo, 'workspace-output.txt'), 'utf8'));
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, 'run dir missing for workspace patch run');
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  assert.equal(manifest.workspace.mode, 'patch');
  assert.equal(manifest.workspace.isolated, true);
  assert.equal(manifest.workspace.worktreeRemoved, true);
  assert.match(readFileSync(manifest.workspace.patchPath, 'utf8'), /workspace-output\.txt/);
}

function runAgentTimeoutHarness() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-agent-timeout-'));
  writeProjectConfig(repo, 'agent-timeout');

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', 'agent timeout test'], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: 'agent-timeout'
    },
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'agent timeout should fail the run');
  assert.match(result.stderr, /Step failed: coder/);
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, 'run dir missing for agent timeout run');
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  const coder = manifest.steps.find((entry) => entry.stepId === 'coder');
  assert.equal(coder.timedOut, true);
  assert.equal(coder.exitCode, 124);
}

function runValidationTimeoutHarness() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-validation-timeout-'));
  writeProjectConfig(repo, 'validation-timeout');

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', 'validation timeout test'], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: 'validation-timeout'
    },
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'validation timeout should fail the run');
  assert.match(result.stderr, /Validation failed/);
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, 'run dir missing for validation timeout run');
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  const validation = manifest.steps.find((entry) => entry.type === 'validation' && entry.id === 'mock-validation');
  assert.equal(validation.timedOut, true);
  assert.equal(validation.exitCode, 124);
}

function runAgentOutputHarness() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-agent-output-'));
  writeProjectConfig(repo, 'agent-output');

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', 'agent output test'], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HARNESS_TEST_SCENARIO: 'agent-output'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `agent output run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, 'run dir missing for agent output run');
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  const coder = manifest.steps.find((entry) => entry.stepId === 'coder');
  assert.ok(coder.lastOutputAt, 'agent step should record lastOutputAt when output is produced');
}

const rerun = runHarness('rerun');
assert.ok(rerun.steps.includes('coder-retry-1'), 'Hermes should rerun coder');
assert.deepEqual(rerun.manifest.supervisorDecisions.map((entry) => entry.nextAction), ['rerun_step', 'continue']);
assert.equal(rerun.manifest.reporterSummary.valid, true);
assert.equal(rerun.manifest.reporterSummary.status, 'success');
assert.equal(rerun.manifest.steps.find((entry) => entry.stepId === 'hermes').agent, 'mock-supervisor');
assert.equal(rerun.manifest.cleanup.status, 'succeeded');
assert.deepEqual(rerun.manifest.cleanup.excludedRuns, [rerun.manifest.runId]);

const validation = runHarness('validation');
assert.deepEqual(validation.manifest.supervisorDecisions.map((entry) => entry.nextAction), ['run_validation', 'continue']);
assert.match(readFileSync(path.join(validation.repo, '.validation.log'), 'utf8'), /validated\nvalidated\n/);

const escalation = runHarness('escalate');
assert.deepEqual(escalation.manifest.supervisorDecisions.map((entry) => entry.nextAction), ['escalate_to_safe_fix', 'continue']);
assert.equal(escalation.manifest.pipelineChanges.length, 1);
assert.equal(escalation.manifest.pipelineChanges[0].to, 'safe_fix');
assert.ok(escalation.steps.includes('verifier'), 'safe_fix escalation should run verifier');

// 기본값(옵트인 off)은 기존 동작을 유지한다: 승격 후 파이프라인을 처음부터 다시 돈다.
// quick_fix에서 coder를 한 번 돌았으므로 safe_fix 재실행으로 coder가 두 번 실행된다.
assert.equal(escalation.manifest.pipelineChanges[0].resumeStepIndex, 0);
assert.deepEqual(escalation.manifest.pipelineChanges[0].skippedSteps, []);
// 기본은 planner부터 다시 돌므로 coder가 재실행(coder-retry-1)된다.
assert.deepEqual(
  escalation.steps,
  ['coder', 'hermes', 'planner', 'coder-retry-1', 'qa', 'verifier', 'hermes-retry-1', 'reporter']
);
assert.ok(escalation.steps.includes('planner'), 'default escalation runs planner again');

// 옵트인 시: 승격은 검증 보강이므로 계획·구현을 다시 하지 않는다.
// quick_fix(coder 완료) -> safe_fix 이면 qa/verifier 부터 이어간다.
const escalationResume = runHarness('escalate-resume');
assert.deepEqual(
  escalationResume.manifest.supervisorDecisions.map((entry) => entry.nextAction),
  ['escalate_to_safe_fix', 'continue']
);
assert.equal(escalationResume.manifest.pipelineChanges[0].to, 'safe_fix');
assert.deepEqual(escalationResume.manifest.pipelineChanges[0].skippedSteps, ['planner', 'coder']);
assert.equal(escalationResume.manifest.pipelineChanges[0].resumeStepIndex, 2);
// 옵트인은 계획·구현을 건너뛰고 검증 보강만 추가한다.
assert.deepEqual(
  escalationResume.steps,
  ['coder', 'hermes', 'qa', 'verifier', 'hermes-retry-1', 'reporter']
);
assert.equal(
  escalationResume.steps.filter((step) => step.startsWith('coder')).length,
  1,
  'escalation resume must not rerun coder'
);
assert.ok(!escalationResume.steps.includes('planner'), 'escalation resume must not run planner after coder');
// 보강 대상인 검증 스텝과 최종 감독/보고는 반드시 실행된다.
assert.ok(escalationResume.steps.includes('qa'), 'escalation resume must run qa');
assert.ok(escalationResume.steps.includes('verifier'), 'escalation resume must run verifier');
assert.ok(escalationResume.steps.some((step) => step.startsWith('reporter')), 'reporter must run');
assert.equal(escalationResume.manifest.reporterSummary.valid, true);

// 절감: 옵트인 쪽이 실행 스텝 수가 더 적어야 한다.
assert.ok(
  escalationResume.steps.length < escalation.steps.length,
  `escalation resume should run fewer steps (${escalationResume.steps.length} vs ${escalation.steps.length})`
);

// 안전 케이스: review_only에서 승격하면 아직 코드를 쓴 적이 없다. 이때의 승격은
// "수정이 필요하다"는 뜻이므로 옵트인이 켜져 있어도 건너뛰지 않고 처음부터 돈다.
// 여기서 coder를 건너뛰면 승격이 아무 수정도 하지 않고 끝난다.
const escalationFromReview = runHarness('escalate-resume', 'review_only');
assert.equal(escalationFromReview.manifest.pipelineChanges[0].to, 'safe_fix');
assert.deepEqual(escalationFromReview.manifest.pipelineChanges[0].skippedSteps, []);
assert.equal(escalationFromReview.manifest.pipelineChanges[0].resumeStepIndex, 0);
assert.ok(escalationFromReview.steps.includes('coder'), 'review_only escalation must run coder');
assert.ok(escalationFromReview.steps.includes('planner'), 'review_only escalation must run planner');

runBlockedHarness();
runPatchWorkspaceHarness();
runAgentTimeoutHarness();
runValidationTimeoutHarness();
runAgentOutputHarness();

console.log('hermes controller tests passed');
