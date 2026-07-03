import assert from 'node:assert/strict';
import { createHarnessRuntime } from '../src/middleware.js';

const runtime = createHarnessRuntime({
  projectConfig: {
    redaction: {
      enabled: true,
      mode: 'hash',
      patterns: [
        {
          id: 'custom-secret',
          pattern: 'SECRET_[A-Z0-9]+'
        }
      ]
    },
    context: {
      maxPreviousOutputBytes: 32,
      maxStepOutputBytes: 16
    },
    budget: {
      maxAgentSteps: 1,
      maxValidationCommands: 1
    },
    retry: {
      agentRetries: 1,
      validationRetries: 1,
      backoffMs: 0
    }
  }
});

const redacted = runtime.redactText('token SECRET_ABC123', {
  surface: 'test'
});
assert.equal(redacted.redacted, true);
assert.match(redacted.text, /\[REDACTED:[a-f0-9]{12}\]/);
assert.equal(runtime.state.counters.redactions, 1);

const stepOutput = runtime.trimStepOutput('abcdefghijklmnopqrstuvwxyz');
assert.match(stepOutput, /context truncated by harness/);
assert.equal(runtime.state.counters.contextTruncations, 1);

runtime.assertBudget('agent');
assert.throws(() => runtime.assertBudget('agent'), /maxAgentSteps/);
runtime.assertBudget('validation');
assert.throws(() => runtime.assertBudget('validation'), /maxValidationCommands/);

runtime.hook('run:start', {
  runId: 'test'
});
assert.ok(runtime.events.some((event) => event.type === 'hook:run:start'));
assert.equal(runtime.summary().config.retry.agentRetries, 1);

console.log('middleware tests passed');
