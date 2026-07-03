import assert from 'node:assert/strict';
import { createHarnessRuntime } from '../src/middleware.js';

const runtime = createHarnessRuntime({
  projectConfig: {
    redaction: {
      enabled: true,
      mode: 'hash'
    },
    context: {
      maxPreviousOutputBytes: 20,
      maxStepOutputBytes: 12
    },
    budget: {
      maxAgentSteps: 1,
      maxValidationCommands: 1
    },
    retry: {
      agentRetries: 1,
      validationRetries: 1,
      backoffMs: 1
    }
  }
});

const redacted = runtime.redactText('token sk-abcdefghijklmnopqrstuvwxyz', {
  surface: 'test'
});
assert.equal(redacted.redacted, true);
assert.match(redacted.text, /\[REDACTED:/);
assert.equal(runtime.state.counters.redactions, 1);

const trimmed = runtime.trimPreviousOutputs('012345678901234567890123456789', {
  surface: 'test'
});
assert.match(trimmed, /context truncated by harness/);
assert.equal(runtime.state.counters.contextTruncations, 1);

runtime.assertBudget('agent');
assert.throws(() => runtime.assertBudget('agent'), /maxAgentSteps/);
runtime.assertBudget('validation');
assert.throws(() => runtime.assertBudget('validation'), /maxValidationCommands/);

const summary = runtime.summary();
assert.equal(summary.config.retry.agentRetries, 1);
assert.ok(summary.events.some((event) => event.type === 'redaction'));

console.log('middleware tests passed');
