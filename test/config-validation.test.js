import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateProjectConfig } from '../src/config-validation.js';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const harnessConfig = {
  pipelines: {
    quick_fix: {},
    code_fix: {}
  }
};

const valid = validateProjectConfig({
  pipeline: 'quick_fix',
  workspaceMode: 'patch',
  agent: {
    provider: 'mock',
    command: 'node',
    outputMode: 'file',
    args: ['mock.cjs', '{{stepId}}', '{{finalPath}}']
  },
  validationCommands: [
    {
      id: 'test',
      command: 'npm test',
      timeoutMs: 1000,
      maxLogBytes: 1000
    }
  ],
  resources: {
    agentTimeoutMs: 1000,
    validationTimeoutMs: 1000,
    maxLogBytes: 1000
  },
  context: {
    maxPreviousOutputBytes: 1000,
    maxStepOutputBytes: 1000
  },
  supervisor: {
    enabled: true,
    maxSupervisorTurns: 1,
    maxStepRetries: 0
  },
  cleanup: {
    enabled: false,
    days: 7,
    keep: 20
  },
  redaction: {
    enabled: true,
    mode: 'mask',
    patterns: [
      {
        id: 'internal',
        pattern: 'SECRET_[A-Z]+'
      }
    ]
  },
  context: {
    maxPreviousOutputBytes: 1000,
    maxStepOutputBytes: 500,
    summarizer: {
      enabled: true,
      mode: 'deterministic',
      headBytes: 100,
      tailBytes: 200
    }
  },
  retry: {
    agentRetries: 1,
    validationRetries: 1,
    backoffMs: 0,
    retryOnExitCodes: [124],
    retryOnStderrPatterns: ['rate limit'],
    fallbackAgents: [
      {
        provider: 'mock',
        command: 'node',
        args: ['mock.cjs'],
        outputMode: 'stdout'
      }
    ]
  },
  budget: {
    maxAgentSteps: 10,
    maxProviderCalls: 10,
    maxValidationCommands: 10,
    maxRuntimeMs: 600000
  },
  tools: [
    {
      id: 'browser',
      setupCommand: 'echo setup',
      teardownCommand: 'echo teardown',
      timeoutMs: 1000,
      maxLogBytes: 1000,
      envAllowlist: ['HARNESS_TOKEN']
    }
  ],
  configSuggestions: {
    enabled: true,
    mode: 'ask'
  },
  runner: {
    mode: 'docker',
    image: 'node:22',
    network: 'none',
    envAllowlist: ['HARNESS_TOKEN']
  },
  policy: {
    allowAutonomousRun: true,
    protectedBranches: ['main']
  }
}, { harnessConfig });
assert.equal(valid.valid, true);
assert.deepEqual(valid.errors, []);

const invalid = validateProjectConfig({
  pipeline: 'missing',
  workspaceMode: 'container',
  agent: {
    outputMode: 'xml',
    args: [42]
  },
  agents: {
    coder: {
      provider: 'missing-provider'
    }
  },
  runner: {
    mode: 'docker'
  },
  validationCommands: [
    {
      id: '',
      command: '',
      timeoutMs: 0
    }
  ],
  resources: {
    agentTimeoutMs: -1
  },
  context: {
    maxPreviousOutputBytes: 0
  },
  supervisor: {
    enabled: 'yes',
    maxSupervisorTurns: 1.5
  },
  redaction: {
    enabled: 'yes',
    mode: 'block',
    patterns: [
      {
        id: '',
        pattern: ''
      }
    ]
  },
  context: {
    maxPreviousOutputBytes: 0,
    summarizer: {
      enabled: 'yes',
      mode: 'agent',
      headBytes: 0,
      provider: ''
    }
  },
  retry: {
    agentRetries: -1,
    validationRetries: 1.5,
    backoffMs: -1,
    retryOnExitCodes: [-1],
    retryOnStderrPatterns: [''],
    fallbackAgents: [
      {
        provider: 'missing-provider'
      }
    ]
  },
  budget: {
    maxAgentSteps: 0
  },
  tools: [
    {
      id: '',
      setupCommand: 1,
      timeoutMs: 0,
      envAllowlist: ['HARNESS_TOKEN', 1]
    }
  ],
  configSuggestions: {
    enabled: 'yes',
    mode: 'auto'
  },
  policy: {
    allowAutonomousRun: 'true',
    protectedBranches: ['main', 1]
  }
}, { harnessConfig });
assert.equal(invalid.valid, false);
assert.ok(invalid.errors.some((entry) => entry.path === 'pipeline'));
assert.ok(invalid.errors.some((entry) => entry.path === 'workspaceMode'));
assert.ok(invalid.errors.some((entry) => entry.path === 'agent.outputMode'));
assert.ok(invalid.errors.some((entry) => entry.path === 'agents.coder'));
assert.ok(invalid.errors.some((entry) => entry.path === 'runner.image'));
assert.ok(invalid.errors.some((entry) => entry.path === 'validationCommands[0].command'));
assert.ok(invalid.errors.some((entry) => entry.path === 'resources.agentTimeoutMs'));
assert.ok(invalid.errors.some((entry) => entry.path === 'context.maxPreviousOutputBytes'));
assert.ok(invalid.errors.some((entry) => entry.path === 'context.summarizer.enabled'));
assert.ok(invalid.errors.some((entry) => entry.path === 'context.summarizer.mode'));
assert.ok(invalid.errors.some((entry) => entry.path === 'context.summarizer.headBytes'));
assert.ok(invalid.errors.some((entry) => entry.path === 'context.summarizer.provider'));
assert.ok(invalid.errors.some((entry) => entry.path === 'redaction.enabled'));
assert.ok(invalid.errors.some((entry) => entry.path === 'redaction.mode'));
assert.ok(invalid.errors.some((entry) => entry.path === 'retry.agentRetries'));
assert.ok(invalid.errors.some((entry) => entry.path === 'retry.validationRetries'));
assert.ok(invalid.errors.some((entry) => entry.path === 'retry.retryOnExitCodes[0]'));
assert.ok(invalid.errors.some((entry) => entry.path === 'retry.retryOnStderrPatterns[0]'));
assert.ok(invalid.errors.some((entry) => entry.path === 'retry.fallbackAgents[0]'));
assert.ok(invalid.errors.some((entry) => entry.path === 'budget.maxAgentSteps'));
assert.ok(invalid.errors.some((entry) => entry.path === 'tools[0].id'));
assert.ok(invalid.errors.some((entry) => entry.path === 'tools[0].setupCommand'));
assert.ok(invalid.errors.some((entry) => entry.path === 'tools[0].timeoutMs'));
assert.ok(invalid.errors.some((entry) => entry.path === 'tools[0].envAllowlist[1]'));
assert.ok(invalid.errors.some((entry) => entry.path === 'supervisor.enabled'));
assert.ok(invalid.errors.some((entry) => entry.path === 'configSuggestions.enabled'));
assert.ok(invalid.errors.some((entry) => entry.path === 'configSuggestions.mode'));
assert.ok(invalid.errors.some((entry) => entry.path === 'policy.protectedBranches[1]'));

const repo = mkdtempSync(path.join(tmpdir(), 'harness-invalid-config-'));
writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
  pipeline: 'missing',
  validationCommands: [
    {
      command: ''
    }
  ]
}, null, 2));

const run = spawnSync('node', [harnessBin, 'run', '--repo', repo, 'invalid config should stop'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.notEqual(run.status, 0);
assert.match(run.stderr, /Invalid \.harness\.json/);
assert.match(run.stderr, /pipeline/);
assert.match(run.stderr, /validationCommands\[0\]\.command/);

const doctor = spawnSync('node', [harnessBin, 'doctor', '--repo', repo, '--agent', 'node'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.notEqual(doctor.status, 0);
assert.match(doctor.stdout, /project config validation/);
assert.match(doctor.stdout, /pipeline/);

console.log('config validation tests passed');
