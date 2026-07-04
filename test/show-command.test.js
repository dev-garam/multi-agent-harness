import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const runId = '2099-01-01_000000_000';
const runDir = path.join(harnessRoot, 'runs', runId);

function runHarness(args) {
  const result = spawnSync('node', [harnessBin, ...args], {
    cwd: harnessRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `harness ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(path.join(runDir, 'reporter.md'), '# report\n');
writeFileSync(path.join(runDir, 'changes.patch'), 'diff --git a/demo.txt b/demo.txt\n');
writeFileSync(path.join(runDir, 'prompt-cache.json'), '{}\n');
writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  runId,
  repo: '/tmp/show-demo',
  executionRepo: '/tmp/show-demo-worktree',
  request: 'show command test',
  pipeline: 'quick_fix',
  completedPipeline: 'quick_fix',
  pipelineSelection: {
    mode: 'deterministic',
    selected: 'quick_fix',
    riskScore: 0,
    complexityScore: 1
  },
  status: 'succeeded',
  startedAt: '2099-01-01T00:00:00.000Z',
  finishedAt: '2099-01-01T00:00:01.000Z',
  agent: {
    provider: 'mock'
  },
  workspace: {
    mode: 'patch',
    isolated: true,
    patchPath: path.join(runDir, 'changes.patch'),
    worktreeRemoved: true
  },
  policy: {
    decision: {
      allowed: true,
      requiresApproval: false,
      reason: 'ok'
    },
    protectedBranch: {
      writeBlocked: false
    }
  },
  runtime: {
    mode: 'local',
    contract: {
      processIsolation: 'none',
      envPolicy: 'inherits process.env unless command/tool envAllowlist is set'
    }
  },
  middleware: {
    state: {
      counters: {
        retries: 1,
        fallbacks: 0,
        redactions: 2,
        contextTruncations: 1
      }
    },
    events: [
      {
        type: 'retry:agent',
        detail: {
          reason: 'exit 124'
        }
      }
    ]
  },
  promptCache: {
    path: path.join(runDir, 'prompt-cache.json'),
    strategy: 'static-context-hash',
    cacheKey: 'demo',
    templates: [
      {
        stepId: 'coder'
      }
    ]
  },
  steps: [
    {
      type: 'agent',
      stepId: 'coder',
      status: 'succeeded',
      agent: 'mock',
      exitCode: 0,
      usage: {
        status: 'parsed',
        provider: 'mock',
        adapter: 'custom',
        totalTokens: 12,
        costUsd: 0.01
      },
      finalPath: path.join(runDir, 'coder.md')
    },
    {
      type: 'validation',
      stepId: 'validation:demo',
      id: 'demo',
      status: 'failed',
      command: 'npm test',
      exitCode: 1
    },
    {
      type: 'agent',
      stepId: 'reporter',
      status: 'succeeded',
      agent: 'mock',
      exitCode: 0,
      finalPath: path.join(runDir, 'reporter.md')
    }
  ],
  supervisorDecisions: [
    {
      turn: 1,
      stepId: 'hermes',
      status: 'success',
      nextAction: 'continue',
      targetStep: null,
      reason: 'ok'
    }
  ],
  reporterSummary: {
    status: 'success',
    summary: 'show summary',
    changedFiles: ['demo.txt'],
    validation: [],
    risks: []
  }
}, null, 2) + '\n');

try {
  const text = runHarness(['show', runId]);
  assert.match(text, /Harness run/);
  assert.match(text, new RegExp(`Run: ${runId}`));
  assert.match(text, /Mode: patch \(isolated\)/);
  assert.match(text, /Pipeline selection: deterministic selected=quick_fix risk=0 complexity=1/);
  assert.match(text, /Runtime/);
  assert.match(text, /Isolation: none/);
  assert.match(text, /Retries: 1/);
  assert.match(text, /Redactions: 2/);
  assert.match(text, /Total tokens: 12/);
  assert.match(text, /Strategy: static-context-hash/);
  assert.match(text, /validation:demo \[validation\] failed \(id=demo exit=1\)/);
  assert.match(text, /Patch: .*changes\.patch/);

  const latest = runHarness(['show', '--latest']);
  assert.match(latest, new RegExp(`Run: ${runId}`));

  const json = JSON.parse(runHarness(['show', '--json', runId]));
  assert.equal(json.runId, runId);
  assert.equal(json.status, 'succeeded');
  assert.equal(json.workspace.mode, 'patch');
  assert.equal(json.pipelineSelection.selected, 'quick_fix');
  assert.equal(json.validationFailures.length, 1);
  assert.equal(json.middleware.retry.retries, 1);
  assert.equal(json.middleware.redaction.redactions, 2);
  assert.equal(json.usage.totalTokens, 12);
  assert.equal(json.runtime.contract.processIsolation, 'none');
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

console.log('show command tests passed');
