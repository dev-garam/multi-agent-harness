import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

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
        command: "node -e \"require('fs').appendFileSync('.validation.log', 'validated\\\\n')\""
      }
    ],
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

const rerun = runHarness('rerun');
assert.ok(rerun.steps.includes('coder-retry-1'), 'Hermes should rerun coder');
assert.deepEqual(rerun.manifest.supervisorDecisions.map((entry) => entry.nextAction), ['rerun_step', 'continue']);
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

console.log('hermes controller tests passed');
