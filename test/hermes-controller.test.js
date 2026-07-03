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
  } else if (scenario === 'escalate' && hermesCount === 1) {
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

function runHarness(scenario) {
  const repo = mkdtempSync(path.join(tmpdir(), `harness-${scenario}-`));
  writeProjectConfig(repo, scenario);

  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, '--pipeline', 'quick_fix', `${scenario} test`], {
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

runBlockedHarness();
runPatchWorkspaceHarness();
runAgentTimeoutHarness();
runValidationTimeoutHarness();
runAgentOutputHarness();

console.log('hermes controller tests passed');
