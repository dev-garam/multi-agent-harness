import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { harnessRoot } from './fs-utils.js';

/**
 * manifest 배열에서 하네스 품질 지표를 계산한다(순수 함수, 부작용 없음).
 *
 * - byStatus: 최종 status 분포
 * - recoveryRate: validation 실패가 있었으나 최종 succeeded 인 비율(복구율)
 * - rerunRate: supervisor 가 rerun_step 을 결정한 run 비율
 * - humanReviewRate: request_human_review 결정 비율
 * - providerSuccessRate: agent.provider 별 성공률
 * - avgDurationMs: startedAt~finishedAt 평균
 */
export function computeMetrics(manifests = []) {
  const total = manifests.length;
  const byStatus = {};
  let recovered = 0;
  let recoverable = 0;
  let rerun = 0;
  let humanReview = 0;
  const byProvider = {};
  let durationSum = 0;
  let durationCount = 0;

  for (const manifest of manifests) {
    const status = manifest.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;

    // 복구율: validation 스텝이 실패했지만 최종적으로 succeeded 한 run.
    const hadValidationFailure = (manifest.steps || []).some(
      (step) => step.type === 'validation' && step.status === 'failed'
    );
    if (hadValidationFailure) {
      recoverable += 1;
      if (status === 'succeeded') {
        recovered += 1;
      }
    }

    // 재실행 / 사람 검토: supervisor 결정 기준.
    const decisions = manifest.supervisorDecisions || [];
    if (decisions.some((decision) => decision.nextAction === 'rerun_step')) {
      rerun += 1;
    }
    if (decisions.some((decision) => decision.nextAction === 'request_human_review')) {
      humanReview += 1;
    }

    // provider 별 성공률.
    const provider = (manifest.agent && manifest.agent.provider) || 'unknown';
    if (!byProvider[provider]) {
      byProvider[provider] = { total: 0, succeeded: 0 };
    }
    byProvider[provider].total += 1;
    if (status === 'succeeded') {
      byProvider[provider].succeeded += 1;
    }

    // 평균 소요 시간.
    if (manifest.startedAt && manifest.finishedAt) {
      const duration = new Date(manifest.finishedAt).getTime() - new Date(manifest.startedAt).getTime();
      if (Number.isFinite(duration) && duration >= 0) {
        durationSum += duration;
        durationCount += 1;
      }
    }
  }

  const rate = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);

  return {
    total,
    byStatus,
    recoveryRate: rate(recovered, recoverable),
    recoverableRuns: recoverable,
    rerunRate: rate(rerun, total),
    humanReviewRate: rate(humanReview, total),
    providerSuccessRate: Object.fromEntries(
      Object.entries(byProvider).map(([provider, counts]) => [
        provider,
        { ...counts, successRate: rate(counts.succeeded, counts.total) }
      ])
    ),
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0
  };
}

/**
 * runs/ 디렉토리를 스캔해 각 run 의 manifest.json 을 로드한다.
 * manifest 가 없거나 파싱 불가한 run 은 건너뛴다.
 */
export async function loadRunManifests(runsDir = path.join(harnessRoot, 'runs')) {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    try {
      const raw = await readFile(path.join(runsDir, entry.name, 'manifest.json'), 'utf8');
      manifests.push(JSON.parse(raw));
    } catch {
      // manifest 없음/파싱 실패 — 건너뛴다.
    }
  }
  return manifests;
}

/** 지표를 사람이 읽기 좋은 문자열로 포맷한다(순수 함수). */
export function formatMetrics(metrics) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const statusLine = Object.entries(metrics.byStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  const lines = [
    `Total runs: ${metrics.total}`,
    `Status: ${statusLine || '(none)'}`,
    `Recovery rate: ${pct(metrics.recoveryRate)} (${metrics.recoverableRuns} run(s) had validation failures)`,
    `Rerun rate: ${pct(metrics.rerunRate)}`,
    `Human-review rate: ${pct(metrics.humanReviewRate)}`,
    `Avg duration: ${metrics.avgDurationMs} ms`,
    'Provider success:'
  ];
  const providerEntries = Object.entries(metrics.providerSuccessRate);
  if (providerEntries.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [provider, counts] of providerEntries) {
      lines.push(`  ${provider}: ${pct(counts.successRate)} (${counts.succeeded}/${counts.total})`);
    }
  }
  return lines.join('\n');
}
