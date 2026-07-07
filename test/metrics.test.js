import assert from 'node:assert/strict';
import { computeMetrics, formatMetrics } from '../src/metrics.js';

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
