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
  // 토큰/비용은 usage를 실제로 파싱할 수 있었던 run만 집계한다. 구버전 manifest나
  // usage를 노출하지 않는 provider까지 분모에 넣으면 평균이 0으로 희석된다.
  let usageRuns = 0;
  const usageTotals = {
    totalTokens: 0,
    billedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    agentTurns: 0,
    costUsd: 0
  };
  const usageByPipeline = {};

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

    // 토큰/비용 집계. 판정 기준은 파싱 "상태"가 아니라 실제 값의 유무다.
    // 구버전 manifest나 regex 파서 오탐으로 status=parsed인데 값이 전부 0인
    // run이 있고, 그런 run을 분모에 넣으면 평균이 그만큼 낮게 나온다.
    const usage = manifest.usageSummary;
    if (usage && ((usage.billedTokens || 0) > 0 || (usage.costUsd || 0) > 0)) {
      usageRuns += 1;
      for (const key of Object.keys(usageTotals)) {
        usageTotals[key] += usage[key] || 0;
      }

      // 어떤 파이프라인이 비싼지 보이게 한다(승격으로 파이프라인이 바뀐 run은
      // 실제로 완주한 파이프라인 기준).
      const pipeline = manifest.completedPipeline || manifest.pipeline || 'unknown';
      if (!usageByPipeline[pipeline]) {
        usageByPipeline[pipeline] = { runs: 0, billedTokens: 0, costUsd: 0 };
      }
      usageByPipeline[pipeline].runs += 1;
      usageByPipeline[pipeline].billedTokens += usage.billedTokens || 0;
      usageByPipeline[pipeline].costUsd += usage.costUsd || 0;

      byProvider[provider].usageRuns = (byProvider[provider].usageRuns || 0) + 1;
      byProvider[provider].billedTokens = (byProvider[provider].billedTokens || 0) + (usage.billedTokens || 0);
      byProvider[provider].costUsd = (byProvider[provider].costUsd || 0) + (usage.costUsd || 0);
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
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    usage: {
      // runs: 토큰을 실제로 잴 수 있었던 run 수. totalRuns와의 격차 자체가
      // "얼마나 측정되고 있는가"를 보여주는 지표다.
      runs: usageRuns,
      totalRuns: total,
      ...usageTotals,
      avgBilledTokens: usageRuns > 0 ? Math.round(usageTotals.billedTokens / usageRuns) : 0,
      avgCostUsd: usageRuns > 0 ? usageTotals.costUsd / usageRuns : 0,
      // 캐시 조회 비중. 스텝마다 새 프로세스가 뜨는 구조의 비용이 여기 드러난다.
      cacheReadRatio: rate(usageTotals.cacheReadTokens, usageTotals.billedTokens),
      byPipeline: usageByPipeline
    }
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
  const num = (value) => Number(value || 0).toLocaleString('en-US');
  const usd = (value) => `$${Number(value || 0).toFixed(4)}`;
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
      const cost = counts.costUsd
        ? `, ${usd(counts.costUsd)} over ${counts.usageRuns} measured run(s)`
        : '';
      lines.push(`  ${provider}: ${pct(counts.successRate)} (${counts.succeeded}/${counts.total})${cost}`);
    }
  }

  const usage = metrics.usage;
  if (!usage || usage.runs === 0) {
    lines.push('', `Token usage: no runs with parsed usage (0/${usage?.totalRuns ?? metrics.total})`);
    return lines.join('\n');
  }

  lines.push(
    '',
    `Token usage (measured in ${usage.runs}/${usage.totalRuns} run(s))`,
    `  Billed tokens:   ${num(usage.billedTokens)} (avg ${num(usage.avgBilledTokens)}/run)`,
    `  Cache read:      ${num(usage.cacheReadTokens)} (${pct(usage.cacheReadRatio)} of billed)`,
    `  Cache creation:  ${num(usage.cacheCreationTokens)}`,
    `  Input + output:  ${num(usage.totalTokens)}`,
    `  Agent turns:     ${num(usage.agentTurns)}`,
    `  Cost USD:        ${usd(usage.costUsd)} (avg ${usd(usage.avgCostUsd)}/run)`
  );

  const pipelineEntries = Object.entries(usage.byPipeline || {})
    .sort((left, right) => right[1].costUsd - left[1].costUsd);
  if (pipelineEntries.length > 0) {
    lines.push('  By pipeline:');
    for (const [pipeline, counts] of pipelineEntries) {
      lines.push(`    ${pipeline}: ${usd(counts.costUsd)}, ${num(counts.billedTokens)} billed (${counts.runs} run(s))`);
    }
  }

  return lines.join('\n');
}
