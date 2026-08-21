import assert from 'node:assert/strict';
import { categoryOfRole, classifyRunFailure, computeMetrics, formatMetrics } from '../src/metrics.js';

// fixture manifest 3건으로 순수 함수 computeMetrics 를 검증한다.
const manifests = [
  {
    // validation 실패 후 복구된 성공 run + rerun 결정.
    status: 'succeeded',
    agent: { provider: 'claude' },
    steps: [
      { type: 'validation', status: 'failed' },
      { type: 'validation', status: 'succeeded' }
    ],
    supervisorDecisions: [{ nextAction: 'rerun_step' }],
    startedAt: '2026-07-07T00:00:00.000Z',
    finishedAt: '2026-07-07T00:00:10.000Z'
  },
  {
    // 실패 run + human review 결정.
    status: 'failed',
    agent: { provider: 'codex' },
    steps: [{ type: 'agent', status: 'failed' }],
    supervisorDecisions: [{ nextAction: 'request_human_review' }],
    startedAt: '2026-07-07T00:00:00.000Z',
    finishedAt: '2026-07-07T00:00:04.000Z'
  },
  {
    // validation 실패 없는 성공 run.
    status: 'succeeded',
    agent: { provider: 'claude' },
    steps: [{ type: 'agent', status: 'succeeded' }],
    supervisorDecisions: [],
    startedAt: '2026-07-07T00:00:00.000Z',
    finishedAt: '2026-07-07T00:00:06.000Z'
  }
];

const metrics = computeMetrics(manifests);

assert.equal(metrics.total, 3);
assert.equal(metrics.byStatus.succeeded, 2);
assert.equal(metrics.byStatus.failed, 1);

// 복구율: validation 실패가 있던 run 1건이 모두 최종 성공 → 100%.
assert.equal(metrics.recoverableRuns, 1);
assert.equal(metrics.recoveryRate, 1);

// 재실행/사람검토: 각각 1/3.
assert.ok(Math.abs(metrics.rerunRate - 1 / 3) < 1e-9);
assert.ok(Math.abs(metrics.humanReviewRate - 1 / 3) < 1e-9);

// provider 별 성공률.
assert.equal(metrics.providerSuccessRate.claude.successRate, 1);
assert.equal(metrics.providerSuccessRate.claude.total, 2);
assert.equal(metrics.providerSuccessRate.codex.successRate, 0);

// 평균 소요 시간: (10000 + 4000 + 6000) / 3 = 6667(반올림).
assert.equal(metrics.avgDurationMs, 6667);

// 중단된 run: 최종 status나 finishedAt이 없으면 성공도 실패도 아니다.
// 그냥 두면 영구히 unknown으로 남아 지표를 오염시키므로 따로 센다.
assert.equal(metrics.interruptedRuns, 0, 'fixtures all finished');
const withInterrupted = computeMetrics([
  ...manifests,
  // 프로세스가 죽어 status/finishedAt이 없는 run.
  { agent: { provider: 'claude' }, steps: [{ type: 'agent', stepId: 'coder', status: 'succeeded' }], startedAt: '2026-07-07T00:00:00.000Z' },
  // status는 있으나 finishedAt이 없는 경우도 중단으로 본다.
  { status: 'succeeded', agent: { provider: 'claude' }, steps: [], startedAt: '2026-07-07T00:00:00.000Z' }
]);
assert.equal(withInterrupted.interruptedRuns, 2);
assert.match(formatMetrics(withInterrupted), /Interrupted: 2 run\(s\) never finished/);
// 중단 run이 없으면 그 줄 자체가 나오지 않는다(노이즈 방지).
assert.equal(/Interrupted:/.test(formatMetrics(metrics)), false);

// 빈 입력도 안전하게 0 을 낸다.
const empty = computeMetrics([]);
assert.equal(empty.total, 0);
assert.equal(empty.recoveryRate, 0);
assert.equal(empty.avgDurationMs, 0);

// 포맷 문자열.
const text = formatMetrics(metrics);
assert.match(text, /Total runs: 3/);
assert.match(text, /claude:/);

console.log('metrics tests passed');

// ---------------------------------------------------------------------------
// 토큰/비용 집계.
// ---------------------------------------------------------------------------

// usageSummary가 없는 기존 fixture는 측정 대상이 0건이어야 한다.
assert.equal(metrics.usage.runs, 0);
assert.equal(metrics.usage.totalRuns, 3);
assert.equal(metrics.usage.billedTokens, 0);
assert.match(formatMetrics(metrics), /Token usage: no runs with parsed usage \(0\/3\)/);

const usageManifests = [
  {
    status: 'succeeded',
    pipeline: 'quick_fix',
    agent: { provider: 'claude' },
    steps: [],
    usageSummary: {
      parsedUsageEntries: 3,
      totalTokens: 7370,
      billedTokens: 320000,
      cacheReadTokens: 275000,
      cacheCreationTokens: 37000,
      agentTurns: 11,
      costUsd: 0.7,
      entries: [
        { stepId: 'coder', billedTokens: 100000, costUsd: 0.2, turns: 4 },
        { stepId: 'hermes', billedTokens: 120000, costUsd: 0.3, turns: 4 },
        { stepId: 'reporter', billedTokens: 100000, costUsd: 0.2, turns: 3 }
      ]
    }
  },
  {
    // 승격된 run은 실제로 완주한 파이프라인(completedPipeline) 기준으로 잡힌다.
    status: 'succeeded',
    pipeline: 'quick_fix',
    completedPipeline: 'safe_fix',
    agent: { provider: 'claude' },
    steps: [],
    usageSummary: {
      parsedUsageEntries: 6,
      totalTokens: 12000,
      billedTokens: 680000,
      cacheReadTokens: 600000,
      cacheCreationTokens: 60000,
      agentTurns: 22,
      costUsd: 1.3,
      entries: [
        { stepId: 'planner', billedTokens: 80000, costUsd: 0.1, turns: 2 },
        // 재시도 스텝은 base 역할(coder)로 정규화되어야 한다.
        { stepId: 'coder-retry-1', billedTokens: 200000, costUsd: 0.4, turns: 6 },
        { stepId: 'qa', billedTokens: 100000, costUsd: 0.2, turns: 3 },
        { stepId: 'verifier', billedTokens: 100000, costUsd: 0.2, turns: 3 },
        { stepId: 'hermes', billedTokens: 120000, costUsd: 0.3, turns: 5 },
        { stepId: 'reporter', billedTokens: 80000, costUsd: 0.1, turns: 3 }
      ]
    }
  },
  {
    // status=parsed지만 값이 전부 0인 run(구버전 manifest·regex 오탐)은
    // 분모에서 빠져야 한다. 포함하면 평균이 그만큼 낮게 나온다.
    status: 'succeeded',
    pipeline: 'review_only',
    agent: { provider: 'codex' },
    steps: [],
    usageSummary: {
      parsedUsageEntries: 1,
      totalTokens: 0,
      billedTokens: 0,
      costUsd: 0
    }
  },
  {
    // usageSummary 자체가 없는 run도 분모에서 빠진다.
    status: 'succeeded',
    pipeline: 'quick_fix',
    agent: { provider: 'mock' },
    steps: []
  }
];

const usageMetrics = computeMetrics(usageManifests);

// 측정 대상은 실제 값이 있는 2건뿐이다(총 4 run 중).
assert.equal(usageMetrics.usage.runs, 2);
assert.equal(usageMetrics.usage.totalRuns, 4);

assert.equal(usageMetrics.usage.billedTokens, 1000000);
assert.equal(usageMetrics.usage.cacheReadTokens, 875000);
assert.equal(usageMetrics.usage.totalTokens, 19370);
assert.equal(usageMetrics.usage.agentTurns, 33);
assert.equal(Number(usageMetrics.usage.costUsd.toFixed(4)), 2);

// 평균은 측정된 2건 기준(4건이 아니다).
assert.equal(usageMetrics.usage.avgBilledTokens, 500000);
assert.equal(Number(usageMetrics.usage.avgCostUsd.toFixed(4)), 1);

// 캐시 조회 비중.
assert.equal(usageMetrics.usage.cacheReadRatio, 0.875);

// 파이프라인별: 승격 run은 completedPipeline(safe_fix)으로 잡힌다.
assert.equal(usageMetrics.usage.byPipeline.quick_fix.runs, 1);
assert.equal(usageMetrics.usage.byPipeline.quick_fix.billedTokens, 320000);
assert.equal(usageMetrics.usage.byPipeline.safe_fix.runs, 1);
assert.equal(usageMetrics.usage.byPipeline.safe_fix.billedTokens, 680000);
// 값이 0인 review_only run은 아예 항목이 생기지 않는다.
assert.equal(usageMetrics.usage.byPipeline.review_only, undefined);

// provider별 비용은 측정된 run만 센다.
assert.equal(usageMetrics.providerSuccessRate.claude.usageRuns, 2);
assert.equal(Number(usageMetrics.providerSuccessRate.claude.costUsd.toFixed(4)), 2);
assert.equal(usageMetrics.providerSuccessRate.codex.usageRuns, undefined);

// 자기 이력 기준선: 요금제를 모르므로 절대 금액 대신 사용자 자신의 분포를 준다.
// 측정된 run은 2건(320000, 680000)이다.
assert.equal(usageMetrics.usage.typicalRun.runs, 2);
assert.equal(usageMetrics.usage.typicalRun.medianBilledTokens, 320000);
assert.equal(usageMetrics.usage.typicalRun.p90BilledTokens, 680000);
assert.equal(usageMetrics.usage.typicalRun.maxBilledTokens, 680000);
// 측정 run이 없으면 0으로 안전하게 나온다.
assert.equal(computeMetrics([]).usage.typicalRun.runs, 0);
assert.equal(computeMetrics([]).usage.typicalRun.medianBilledTokens, 0);

// 비용 미노출 provider가 섞이면 그 사실을 드러낸다. 토큰은 세지만 비용은 못 센다.
const mixedMetrics = computeMetrics([
  {
    status: 'succeeded', pipeline: 'quick_fix', agent: { provider: 'claude' }, steps: [],
    usageSummary: {
      parsedUsageEntries: 1, billedTokens: 100000, costUsd: 0.2, costAvailable: true,
      entries: [{ stepId: 'coder', billedTokens: 100000, costUsd: 0.2, turns: 3 }]
    }
  },
  {
    // codex형: 토큰만 있고 비용은 null.
    status: 'succeeded', pipeline: 'quick_fix', agent: { provider: 'codex' }, steps: [],
    usageSummary: {
      parsedUsageEntries: 1, billedTokens: 500000, costUsd: 0, costAvailable: false,
      entries: [{ stepId: 'coder', billedTokens: 500000, costUsd: null, turns: null }]
    }
  }
]);
assert.equal(mixedMetrics.usage.runsWithoutCost, 1);
assert.deepEqual(mixedMetrics.usage.providersWithoutCost, ['codex']);
// 토큰은 두 run 모두 집계된다.
assert.equal(mixedMetrics.usage.billedTokens, 600000);
const mixedText = formatMetrics(mixedMetrics);
assert.match(mixedText, /1 run\(s\) report no cost \(codex\)/);
assert.match(mixedText, /their tokens count, their cost does not/);

// 전부 비용을 보고하면 Note가 나오지 않는다(노이즈 방지).
assert.equal(/report no cost/.test(formatMetrics(usageMetrics)), false);

// 포맷 출력.
const usageText = formatMetrics(usageMetrics);
assert.match(usageText, /Token usage \(measured in 2\/4 run\(s\)\)/);
assert.match(usageText, /Billed tokens:\s+1,000,000 \(avg 500,000\/run\)/);
assert.match(usageText, /Cache read:\s+875,000 \(87\.5% of billed\)/);
// 비용은 환산값임을 드러낸다(요금제를 모르므로 단정하지 않는다).
assert.match(usageText, /Cost:\s+~\$2\.0000 API-equivalent/);
assert.match(usageText, /Typical run:\s+320,000 billed \(median of 2\)/);
// 비싼 파이프라인이 먼저 나온다.
assert.ok(usageText.indexOf('safe_fix:') < usageText.indexOf('quick_fix:'));

// ---------------------------------------------------------------------------
// 역할별/범주별 비용 분해. "어디에 돈이 가는가"를 판단하려면 실제 코드 변경과
// 그걸 검토·감독·보고하는 비용을 나눠 봐야 한다.
// ---------------------------------------------------------------------------
assert.equal(usageMetrics.usage.agentSteps, 9);
assert.equal(Number(usageMetrics.usage.avgCostPerStep.toFixed(4)), Number((2 / 9).toFixed(4)));

// 재시도 접미사는 base 역할로 정규화된다(coder-retry-1 -> coder).
assert.equal(categoryOfRole('coder'), 'write');
assert.equal(categoryOfRole('hermes'), 'meta');
assert.equal(categoryOfRole('verifier'), 'review');
assert.equal(categoryOfRole('custom-step'), 'other');

assert.equal(usageMetrics.usage.byRole.coder.steps, 2);
assert.equal(Number(usageMetrics.usage.byRole.coder.costUsd.toFixed(4)), 0.6);
assert.equal(usageMetrics.usage.byRole.coder.billedTokens, 300000);
assert.equal(usageMetrics.usage.byRole['coder-retry-1'], undefined, 'retry suffix must normalize to base role');
assert.equal(Number(usageMetrics.usage.byRole.hermes.costUsd.toFixed(4)), 0.6);

// 범주 합계: write 0.6 / review 0.5 / meta 0.9 = 2.0
assert.equal(Number(usageMetrics.usage.byCategory.write.costUsd.toFixed(4)), 0.6);
assert.equal(Number(usageMetrics.usage.byCategory.review.costUsd.toFixed(4)), 0.5);
assert.equal(Number(usageMetrics.usage.byCategory.meta.costUsd.toFixed(4)), 0.9);
assert.equal(usageMetrics.usage.byCategory.meta.steps, 4);

// 범주 비용 합은 전체 비용과 같아야 한다(누락 없이 분해됐는지).
const categorySum = Object.values(usageMetrics.usage.byCategory)
  .reduce((total, counts) => total + counts.costUsd, 0);
assert.equal(Number(categorySum.toFixed(4)), Number(usageMetrics.usage.costUsd.toFixed(4)));

// 포맷: 비싼 범주·역할이 먼저 오고 비중이 표시된다.
assert.match(usageText, /By category:/);
assert.match(usageText, /meta\s+\(supervise\/report\): \$0\.9000 45\.0%/);
assert.match(usageText, /By role:/);
assert.match(usageText, /Agent steps:\s+9/);
assert.ok(
  usageText.indexOf('meta   (supervise/report)') < usageText.indexOf('write  (code changes)'),
  'more expensive category comes first'
);

console.log('metrics usage aggregation tests passed');

// ---------------------------------------------------------------------------
// 실패 원인 분류. 어떤 실패가 자주 나는지 모르면 무엇을 고쳐야 할지도 모른다.
//
// 실패는 두 층위다: run 수준(정책 차단/검증/agent)과 agent 실패의 세부 유형.
// 둘을 합쳐 하나의 라벨로 낸다(`agent:rate-limit`).
// ---------------------------------------------------------------------------
assert.equal(classifyRunFailure({ status: 'succeeded' }), null, 'successful runs have no failure cause');
assert.equal(classifyRunFailure({}), null);

// 정책 차단이 가장 우선한다. 차단된 런은 다른 신호가 있어도 차단이 원인이다.
assert.equal(
  classifyRunFailure({
    status: 'failed',
    policyBlock: { kind: 'no-change' },
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 1 }]
  }),
  'policy-block:no-change'
);

// manifest.failure가 있으면 그 유형을 쓴다.
assert.equal(
  classifyRunFailure({
    status: 'failed',
    failure: { kind: 'rate-limit' },
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 1 }]
  }),
  'agent:rate-limit'
);

// manifest.failure는 나중에 추가된 필드다. 과거 run은 실패한 스텝을 다시 분류해
// 같은 답을 얻어야 한다. 그래야 이미 쌓인 run도 읽을 수 있다.
assert.equal(
  classifyRunFailure({
    status: 'failed',
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 124, timedOut: true }]
  }),
  'agent:timeout',
  'old manifests are classified from their steps'
);
assert.equal(
  classifyRunFailure({
    status: 'failed',
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 1, stderrTail: 'spawn claude ENOENT' }]
  }),
  'agent:command-not-found'
);

// agent가 죽지 않았고 검증만 실패한 경우.
assert.equal(
  classifyRunFailure({
    status: 'failed',
    steps: [
      { type: 'agent', stepId: 'coder', status: 'succeeded' },
      { type: 'validation', stepId: 'test', status: 'failed', exitCode: 1 }
    ]
  }),
  'validation'
);

assert.equal(
  classifyRunFailure({ status: 'failed', steps: [], failureReason: 'Harness budget exceeded: maxAgentSteps=8' }),
  'budget'
);
assert.equal(
  classifyRunFailure({
    status: 'failed',
    steps: [],
    supervisorDecisions: [{ nextAction: 'request_human_review' }]
  }),
  'supervisor-stopped'
);
assert.equal(classifyRunFailure({ status: 'failed', steps: [] }), 'unknown');

// 집계와 retryable 카운트.
const failureMetrics = computeMetrics([
  { status: 'failed', agent: { provider: 'claude' }, steps: [], failure: { kind: 'rate-limit' },
    // agent 스텝이 있어야 agent: 라벨이 붙는다.
    ...{ steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 1 }] } },
  { status: 'failed', agent: { provider: 'claude' },
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 124, timedOut: true }] },
  { status: 'failed', agent: { provider: 'claude' }, policyBlock: { kind: 'change-risk' }, steps: [] },
  { status: 'succeeded', agent: { provider: 'claude' }, steps: [] }
]);
assert.equal(failureMetrics.byFailure['agent:rate-limit'], 1);
assert.equal(failureMetrics.byFailure['agent:timeout'], 1);
assert.equal(failureMetrics.byFailure['policy-block:change-risk'], 1);
assert.equal(failureMetrics.byFailure.unknown, undefined, 'successful runs are not counted');

// retryable은 rate-limit / network 뿐이다. timeout은 세지 않는다 —
// 재시도를 켤지 판단하는 근거이므로 낙관적으로 세면 안 된다.
assert.equal(failureMetrics.retryableFailures, 1);

const failureText = formatMetrics(failureMetrics);
assert.match(failureText, /Failures by cause \(3 failed run\(s\)\)/);
assert.match(failureText, /agent:rate-limit/);
assert.match(failureText, /→ retryable cause\s+1/);

// retryable이 0이면 재시도를 켜도 건질 것이 없다고 분명히 말한다.
const noRetryable = computeMetrics([
  { status: 'failed', agent: { provider: 'claude' },
    steps: [{ type: 'agent', stepId: 'coder', status: 'failed', exitCode: 124, timedOut: true }] }
]);
assert.equal(noRetryable.retryableFailures, 0);
assert.match(formatMetrics(noRetryable), /nothing to gain from retries yet/);

console.log('metrics failure aggregation tests passed');
