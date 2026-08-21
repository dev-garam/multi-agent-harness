import assert from 'node:assert/strict';
import { classifyFailure, formatFailure } from '../src/failure.js';
import { createHarnessRuntime } from '../src/middleware.js';

// 실패를 유형으로 나누고 각 유형에 맞는 조치를 붙인다. "exit 1"만으로는 사용자가
// 다음에 뭘 해야 할지 알 수 없다.
//
// 재시도 전망이 유형별로 크게 다르다는 것이 핵심이다. 한도 초과나 네트워크
// 끊김은 잠시 뒤 다시 하면 대개 풀리지만, 시간이 다해 죽은 작업은 다시 해도
// 같은 이유로 죽는다.

// 성공은 분류 대상이 아니다.
assert.equal(classifyFailure({ exitCode: 0 }), null);
assert.equal(classifyFailure({}), null);

const cases = [
  {
    label: 'timeout',
    result: { exitCode: 124, timedOut: true, stderrTail: 'Timed out after 600000ms' },
    kind: 'timeout',
    retryable: false
  },
  {
    label: 'cancelled',
    result: { exitCode: 130, cancelled: true },
    kind: 'cancelled',
    retryable: false
  },
  {
    label: 'ENOENT',
    result: { exitCode: 1, stderrTail: 'spawn claude ENOENT' },
    kind: 'command-not-found',
    retryable: false
  },
  {
    label: 'auth',
    result: { exitCode: 1, stderrTail: '401 Unauthorized: invalid api key' },
    kind: 'auth',
    retryable: false
  },
  {
    label: 'rate limit',
    result: { exitCode: 1, stderrTail: 'Error: rate limit exceeded (429)' },
    kind: 'rate-limit',
    retryable: true
  },
  {
    label: 'network',
    result: { exitCode: 1, stderrTail: 'socket hang up' },
    kind: 'network',
    retryable: true
  },
  {
    label: 'unclassified',
    result: { exitCode: 1, stderrTail: 'AssertionError: expected 2 to equal 3' },
    kind: 'agent-error',
    retryable: false
  }
];

for (const entry of cases) {
  const failure = classifyFailure(entry.result);
  assert.equal(failure.kind, entry.kind, `${entry.label} -> ${entry.kind}`);
  assert.equal(failure.retryable, entry.retryable, `${entry.label} retryable=${entry.retryable}`);
  // 모든 유형이 무엇이 일어났는지와 다음에 뭘 할지를 말해야 한다.
  assert.ok(failure.summary.length > 0, `${entry.label} has a summary`);
  assert.ok(failure.nextStep.length > 0, `${entry.label} has a next step`);
  assert.equal(failure.exitCode, entry.result.exitCode);
}

// timeout은 재시도하지 않는다는 것이 이 변경의 핵심이다. 같은 작업을 같은
// 시간 안에 다시 시키면 대개 같은 결과를 내고 시간만 두 배로 쓴다.
const timeout = classifyFailure({ exitCode: 124, timedOut: true });
assert.equal(timeout.retryable, false);
assert.match(timeout.nextStep, /Retrying rarely helps/);
assert.match(timeout.nextStep, /timeoutMs/, 'tells the user how to raise the limit instead');

// 취소는 실패로 분류하되 재시도하지 않는다(사용자가 멈춘 것이다).
assert.equal(classifyFailure({ exitCode: 130, cancelled: true }).retryable, false);

// 우선순위: 취소와 timeout이 stderr 내용보다 앞선다. timeout으로 죽으면서
// stderr에 network 문구가 남아 있어도 timeout으로 봐야 한다.
const timeoutWithNoise = classifyFailure({
  exitCode: 124, timedOut: true, stderrTail: 'socket hang up\nTimed out after 100ms'
});
assert.equal(timeoutWithNoise.kind, 'timeout', 'timeout wins over stderr noise');

// 메시지: 유형·조치·run 위치가 모두 들어간다.
const message = formatFailure({
  stepId: 'coder',
  runDir: '/runs/x',
  failure: classifyFailure({ exitCode: 1, stderrTail: 'rate limit exceeded' })
});
assert.match(message, /Step failed: coder \(rate-limit, exit 1\)/);
assert.match(message, /Next: /);
assert.match(message, /See \/runs\/x/);
// 분류가 없어도 메시지는 나온다.
assert.match(formatFailure({ stepId: 'qa', runDir: '/runs/y', failure: null }), /Step failed: qa/);

// ---------------------------------------------------------------------------
// 재시도 판정이 분류와 일치해야 한다. 두 곳이 다른 답을 내면 신뢰할 수 없다.
// ---------------------------------------------------------------------------
{
  const runtime = createHarnessRuntime({ projectConfig: {} });

  // timeout은 기본 재시도 대상이 아니다(DEFAULT_RETRY_EXIT_CODES에서 124 제거).
  const timeoutDecision = runtime.shouldRetryResult(
    { exitCode: 124, timedOut: true, stderrTail: 'Timed out after 600000ms' }, 'agent'
  );
  assert.equal(timeoutDecision.retryable, false, 'timeout is not retried by default');
  assert.equal(timeoutDecision.failureKind, 'timeout');

  // 한도 초과와 네트워크는 재시도 대상이다.
  assert.equal(runtime.shouldRetryResult({ exitCode: 1, stderrTail: '429 too many requests' }, 'agent').retryable, true);
  assert.equal(runtime.shouldRetryResult({ exitCode: 1, stderrTail: 'ECONNRESET' }, 'agent').retryable, true);

  // 영구 오류는 아니다.
  const permanent = runtime.shouldRetryResult({ exitCode: 1, stderrTail: 'spawn claude ENOENT' }, 'agent');
  assert.equal(permanent.retryable, false);
  assert.match(permanent.reason, /command-not-found/);

  // 성공과 취소는 재시도하지 않는다.
  assert.equal(runtime.shouldRetryResult({ exitCode: 0 }, 'agent').retryable, false);
  assert.equal(runtime.shouldRetryResult({ exitCode: 130, cancelled: true }, 'agent').retryable, false);
}

{
  // 사용자가 명시적으로 넓히면 그 설정이 이긴다. timeout을 재시도하고 싶다면
  // retryOnExitCodes로 직접 넣을 수 있다.
  const runtime = createHarnessRuntime({ projectConfig: { retry: { retryOnExitCodes: [124] } } });
  assert.equal(
    runtime.shouldRetryResult({ exitCode: 124, timedOut: true }, 'agent').retryable,
    true,
    'explicit configuration still wins'
  );
}

console.log('failure classification tests passed');
