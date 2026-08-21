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

// ---------------------------------------------------------------------------
// B6c: 소모량 상한(billedTokens / costUsd).
// 호출 횟수 상한만으로는 "호출 6번인데 토큰을 다 태운" 경우를 막지 못한다.
// usage는 스텝을 실행해봐야 알 수 있으므로, 누적은 recordUsage로 하고 검사는
// 다음 호출 시작 시점(assertBudget)에 한다 — maxRuntimeMs와 같은 패턴이다.
// ---------------------------------------------------------------------------
{
  const runtime = createHarnessRuntime({ projectConfig: { budget: { maxBilledTokens: 100000 } } });
  // 아직 아무것도 안 썼으면 통과한다.
  runtime.assertBudget('agent');
  runtime.recordUsage({ billedTokens: 60000, costUsd: 0.2 });
  runtime.assertBudget('agent');
  assert.equal(runtime.state.counters.billedTokens, 60000);

  // 상한을 넘긴 뒤에는 다음 호출을 시작하지 않는다.
  runtime.recordUsage({ billedTokens: 60000, costUsd: 0.2 });
  assert.throws(
    () => runtime.assertBudget('agent'),
    (error) => error.code === 'HARNESS_BUDGET_EXCEEDED' && /maxBilledTokens=100000/.test(error.message)
  );
}

{
  const runtime = createHarnessRuntime({ projectConfig: { budget: { maxCostUsd: 1 } } });
  runtime.recordUsage({ billedTokens: 10, costUsd: 1.5 });
  assert.throws(
    () => runtime.assertBudget('validation'),
    (error) => error.code === 'HARNESS_BUDGET_EXCEEDED' && /maxCostUsd=1/.test(error.message)
  );
}

{
  // 상한을 설정하지 않으면 아무리 써도 제한이 없다(하위 호환).
  const runtime = createHarnessRuntime({ projectConfig: {} });
  runtime.recordUsage({ billedTokens: 9_999_999, costUsd: 999 });
  runtime.assertBudget('agent');
  assert.equal(runtime.state.counters.billedTokens, 9_999_999);
}

{
  // usage를 파싱하지 못한 스텝(null/미상)은 누적에 영향을 주지 않는다.
  const runtime = createHarnessRuntime({ projectConfig: { budget: { maxBilledTokens: 100 } } });
  runtime.recordUsage(null);
  runtime.recordUsage(undefined);
  runtime.recordUsage({ billedTokens: null, costUsd: null });
  runtime.recordUsage({ status: 'unknown' });
  runtime.assertBudget('agent');
  assert.equal(runtime.state.counters.billedTokens, 0);
  assert.equal(runtime.state.counters.costUsd, 0);
}

console.log('middleware usage budget tests passed');
