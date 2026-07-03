import assert from 'node:assert/strict';
import { createHarnessRuntime } from '../src/middleware.js';

const runtime = createHarnessRuntime({
  projectConfig: {
    redaction: {
      enabled: true,
      mode: 'hash'
    },
    context: {
      maxPreviousOutputBytes: 90,
      maxStepOutputBytes: 12,
      summarizer: {
        enabled: true,
        headBytes: 4,
        tailBytes: 4
      }
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

const trimmed = runtime.trimPreviousOutputs('012345678901234567890123456789'.repeat(10), {
  surface: 'test'
});
assert.match(trimmed, /context summarized by harness/);
assert.equal(runtime.state.counters.contextTruncations, 1);

const retryable = runtime.shouldRetryResult({
  exitCode: 1,
  stderrTail: 'provider rate limit exceeded'
});
assert.equal(retryable.retryable, true);

const notRetryable = runtime.shouldRetryResult({
  exitCode: 1,
  stderrTail: 'unit tests failed'
});
assert.equal(notRetryable.retryable, false);

runtime.assertBudget('agent');
assert.throws(() => runtime.assertBudget('agent'), /maxAgentSteps/);
runtime.assertBudget('validation');
assert.throws(() => runtime.assertBudget('validation'), /maxValidationCommands/);

const summary = runtime.summary();
assert.equal(summary.config.retry.agentRetries, 1);
assert.ok(summary.events.some((event) => event.type === 'redaction'));

console.log('middleware tests passed');
