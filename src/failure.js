/**
 * 실패를 유형으로 나누고, 각 유형에 맞는 조치를 붙인다.
 *
 * 기존에는 모든 실패가 `Step failed: coder (exit 1)` 한 줄로 끝났다. 원인이
 * 바이너리 부재인지, 한도 초과인지, 작업이 너무 커서 시간이 다한 것인지 구분되지
 * 않으면 사용자가 다음에 뭘 해야 할지 알 수 없다.
 *
 * 재시도 판정도 여기서 함께 정한다. 유형별로 전망이 크게 다르기 때문이다:
 * 한도 초과나 네트워크 끊김은 잠시 뒤 다시 하면 대개 풀리지만, 시간이 다해
 * 죽은 작업은 다시 해도 같은 이유로 죽는다. 그래서 timeout은 재시도하지 않고
 * 차단한다 — 두 배의 시간을 쓰고 같은 결과를 얻는 것이 가장 나쁘다.
 */

const FAILURE_RULES = [
  {
    kind: 'cancelled',
    retryable: false,
    match: (ctx) => ctx.cancelled === true || ctx.exitCode === 130,
    summary: 'The step was cancelled by a signal.',
    nextStep: 'Re-run when ready. Nothing was left running.'
  },
  {
    kind: 'timeout',
    retryable: false,
    match: (ctx) => ctx.timedOut === true || ctx.exitCode === 124,
    summary: 'The step ran out of time and was killed.',
    // 재시도하지 않는 이유를 조치에 담는다. 같은 작업을 같은 시간 안에 다시
    // 시키는 것은 대개 같은 결과를 낸다.
    nextStep: 'Retrying rarely helps here. Narrow the request, or raise '
      + '`resources.agentTimeoutMs` / the step `timeoutMs` if the work legitimately takes longer.'
  },
  {
    kind: 'command-not-found',
    retryable: false,
    match: (ctx) => /enoent|command not found|no such file or directory|is not recognized/.test(ctx.text),
    summary: 'The provider CLI could not be started.',
    nextStep: 'Run `harness doctor` to check the agent command and its CLI flags.'
  },
  {
    kind: 'auth',
    retryable: false,
    match: (ctx) => /unauthor|forbidden|invalid api key|authentication|not logged in|401|403/.test(ctx.text),
    summary: 'The provider rejected the request as unauthenticated or unauthorized.',
    nextStep: 'Check the provider login or API key, then re-run.'
  },
  {
    kind: 'rate-limit',
    retryable: true,
    match: (ctx) => /rate limit|too many requests|quota|429/.test(ctx.text),
    summary: 'The provider refused the request because a usage limit was hit.',
    nextStep: 'Wait and re-run. Enable `retry.agentRetries` with a non-zero `retry.backoffMs` '
      + 'to let the harness back off automatically.'
  },
  {
    kind: 'network',
    retryable: true,
    match: (ctx) => /econnreset|etimedout|socket hang up|network|502|503|504|temporarily unavailable|temporary failure/.test(ctx.text),
    summary: 'The provider connection failed in a way that is usually transient.',
    nextStep: 'Re-run. Enable `retry.agentRetries` with `retry.backoffMs` to recover automatically.'
  }
];

const UNKNOWN_FAILURE = {
  kind: 'agent-error',
  retryable: false,
  summary: 'The step exited with an error.',
  nextStep: 'Read the step stderr log in the run directory to see what the agent reported.'
};

function failureContext(result = {}) {
  const text = [result.stderr, result.stderrTail, result.error]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    text
  };
}

/**
 * 실패 하나를 분류한다. 성공한 결과에는 null을 반환한다.
 *
 * 설정된 재시도 패턴(`retry.retryOnStderrPatterns`, `retryOnExitCodes`)은 여기서
 * 다루지 않는다. 그것은 사용자가 명시적으로 넓힌 범위이고, 이 함수는 하네스가
 * 기본으로 아는 유형만 판정한다.
 */
export function classifyFailure(result = {}) {
  // exitCode가 없으면 실패인지 판단할 근거가 없다. 성공과 마찬가지로 분류하지 않는다.
  if (!result || !Number.isInteger(result.exitCode) || result.exitCode === 0) {
    return null;
  }
  const context = failureContext(result);
  const rule = FAILURE_RULES.find((entry) => entry.match(context));
  const matched = rule || UNKNOWN_FAILURE;
  return {
    kind: matched.kind,
    retryable: matched.retryable,
    summary: matched.summary,
    nextStep: matched.nextStep,
    exitCode: result.exitCode ?? null
  };
}

/** 사람이 읽는 실패 메시지. 무엇이 일어났고 다음에 뭘 하면 되는지까지 준다. */
export function formatFailure({ stepId, runDir, failure }) {
  if (!failure) {
    return `Step failed: ${stepId}. See ${runDir}`;
  }
  return [
    `Step failed: ${stepId} (${failure.kind}, exit ${failure.exitCode})`,
    failure.summary,
    `Next: ${failure.nextStep}`,
    `See ${runDir}`
  ].join('\n');
}
