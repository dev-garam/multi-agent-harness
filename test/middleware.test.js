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

// A1: redaction hardening — 기본 ON / 명시적 false만 OFF
const defaultOn = createHarnessRuntime({ projectConfig: {} });
assert.equal(defaultOn.redactText('sk-abcdefghijklmnopqrstuvwxyz').redacted, true, 'redaction defaults on');
const explicitOff = createHarnessRuntime({ projectConfig: { redaction: { enabled: false } } });
assert.equal(explicitOff.redactText('sk-abcdefghijklmnopqrstuvwxyz').redacted, false, 'explicit false disables');

// 확장 패턴
assert.equal(defaultOn.redactText('AKIAIOSFODNN7EXAMPLE').redacted, true, 'aws access key pattern');
assert.equal(defaultOn.redactText('password: hunter2secret').redacted, true, 'generic assignment pattern');
assert.equal(
  defaultOn.redactText('eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4').redacted,
  true,
  'jwt pattern'
);

// 스트림 청크 경계 누수 방지
const stream = defaultOn.redactStream({ surface: 'test' });
const streamSecret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
let streamOut = stream.push('prefix sk-ABCDEFGHIJ');
streamOut += stream.push('KLMNOPQRSTUVWXYZ012345 tail\n');
streamOut += stream.flush();
assert.ok(!streamOut.includes(streamSecret), 'stream redactor prevents chunk-boundary leak');
assert.match(streamOut, /\[REDACTED\]/, 'stream redactor masks secret');

// 무효 custom 패턴 경고
const badPatternRt = createHarnessRuntime({
  projectConfig: { redaction: { enabled: true, patterns: [{ id: 'bad', pattern: '(' }] } }
});
assert.ok(
  badPatternRt.events.some((event) => event.type === 'redaction:invalid-pattern'),
  'invalid custom pattern is warned'
);

console.log('middleware tests passed');
