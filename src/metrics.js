import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { harnessRoot } from './fs-utils.js';
import { costAvailableFromSummary } from './usage.js';
import { classifyFailure } from './failure.js';

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
/**
 * 스텝 id를 역할로 정규화한다(coder-retry-1 -> coder).
 */
function roleOf(stepId) {
  return String(stepId || 'unknown').replace(/-retry-\d+$/, '');
}

/**
 * 역할을 비용 범주로 묶는다. 어디에 돈이 가는지 판단하려면 "실제로 코드를 바꾸는
 * 일"과 "그걸 검토·감독·보고하는 일"을 나눠 봐야 한다.
 *
 * - write:  파일을 실제로 바꾸는 스텝
 * - review: 계획·검증 스텝
 * - meta:   감독·보고 스텝(작업 자체가 아니라 작업에 대한 작업)
 */
const ROLE_CATEGORY = {
  coder: 'write',
  planner: 'review',
  qa: 'review',
  verifier: 'review',
  reviewer: 'review',
  hermes: 'meta',
  reporter: 'meta'
};

/** 정렬된 표본에서 백분위 값을 낸다(가장 가까운 순위 방식). */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * run이 왜 실패했는지 한 가지로 정한다.
 *
 * 실패는 두 층위다. run 수준(정책 차단인가, 검증 실패인가, agent가 죽었나)과
 * agent 실패의 세부 유형(timeout인가, 한도 초과인가). 둘을 합쳐 하나의 라벨로
 * 낸다 — `agent:rate-limit` 처럼.
 *
 * manifest.failure는 나중에 추가된 필드라 과거 run에는 없다. 그때는 실패한 agent
 * 스텝에 classifyFailure를 다시 돌려 같은 분류를 얻는다. 그래야 이미 쌓인 run도
 * 읽을 수 있다.
 */
export function classifyRunFailure(manifest = {}) {
  if (manifest.status !== 'failed') {
    return null;
  }

  if (manifest.policyBlock) {
    return `policy-block:${manifest.policyBlock.kind}`;
  }

  const steps = manifest.steps || [];
  const failedAgent = [...steps].reverse().find((step) => step.type === 'agent' && step.status === 'failed');
  if (failedAgent) {
    const failure = manifest.failure && manifest.failure.kind
      ? manifest.failure
      : classifyFailure(failedAgent);
    return `agent:${failure?.kind || 'agent-error'}`;
  }

  if (steps.some((step) => step.type === 'validation' && step.status === 'failed')) {
    return 'validation';
  }

  const reason = String(manifest.failureReason || '');
  if (/budget/i.test(reason)) {
    return 'budget';
  }
  if (/policy/i.test(reason)) {
    return 'policy';
  }

  const decisions = manifest.supervisorDecisions || [];
  if (decisions.some((entry) => ['stop_failed', 'request_human_review'].includes(entry.nextAction))) {
    return 'supervisor-stopped';
  }

  return 'unknown';
}

/** 이 라벨이 재시도로 풀릴 수 있는 유형인지. 재시도 설정 판단의 근거가 된다. */
function labelIsRetryable(label) {
  return label === 'agent:rate-limit' || label === 'agent:network';
}

export function categoryOfRole(role) {
  return ROLE_CATEGORY[role] || 'other';
}

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
  let interrupted = 0;
  const byFailure = {};
  let retryableFailures = 0;
  const usageTotals = {
    totalTokens: 0,
    billedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    agentTurns: 0,
    costUsd: 0
  };
  const usageByPipeline = {};
  // 개별 run의 소모량을 모아 분포를 낸다. "$0.69"는 요금제마다 의미가 다르지만
  // "평소 run의 1.8배"는 누구에게나 통한다. 사용자의 상품 정보를 알 필요가 없다.
  const runBilledTokens = [];
  // 비용을 보고하지 않는 provider(codex 등)의 run을 따로 센다. 이들의 billedTokens는
  // 집계에 들어가지만 costUsd에는 기여하지 않으므로, 그 사실을 드러내지 않으면
  // "토큰은 많이 썼는데 비용은 적다"는 잘못된 그림이 된다.
  const providersWithoutCost = new Set();
  let runsWithoutCost = 0;
  const usageByRole = {};
  const usageByCategory = {};
  let agentStepCount = 0;

  for (const manifest of manifests) {
    const status = manifest.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;

    // 중단된 run: 최종 status나 finishedAt이 없다. 하네스 프로세스가 끝까지 가지
    // 못한 것(크래시·Ctrl+C·머신 종료)이라 성공도 실패도 아니다. 그냥 두면
    // 영구히 unknown으로 남아 지표를 오염시키므로 따로 센다.
    if (!manifest.status || !manifest.finishedAt) {
      interrupted += 1;
    }

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

    // 실패 원인 분류. 어떤 실패가 자주 나는지 모르면 무엇을 고쳐야 할지도 모른다.
    const failureLabel = classifyRunFailure(manifest);
    if (failureLabel) {
      byFailure[failureLabel] = (byFailure[failureLabel] || 0) + 1;
      if (labelIsRetryable(failureLabel)) {
        retryableFailures += 1;
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
      runBilledTokens.push(usage.billedTokens || 0);
      if (!costAvailableFromSummary(usage)) {
        runsWithoutCost += 1;
        providersWithoutCost.add(provider);
      }
      usageByPipeline[pipeline].runs += 1;
      usageByPipeline[pipeline].billedTokens += usage.billedTokens || 0;
      usageByPipeline[pipeline].costUsd += usage.costUsd || 0;

      // 역할별/범주별 분해. entries는 agent 스텝 단위라 여기서 어느 역할이 돈을
      // 쓰는지 드러난다(실측에서 감독·보고가 실제 작업의 3배였다).
      for (const entry of usage.entries || []) {
        const role = roleOf(entry.stepId);
        const category = categoryOfRole(role);
        agentStepCount += 1;
        for (const [bucket, key] of [[usageByRole, role], [usageByCategory, category]]) {
          if (!bucket[key]) {
            bucket[key] = { steps: 0, billedTokens: 0, costUsd: 0, turns: 0 };
          }
          bucket[key].steps += 1;
          bucket[key].billedTokens += entry.billedTokens || 0;
          bucket[key].costUsd += entry.costUsd || 0;
          bucket[key].turns += entry.turns || 0;
        }
      }

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
    interruptedRuns: interrupted,
    byFailure,
    retryableFailures,
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
      // 스텝 하나를 띄우는 데 드는 평균 비용. 스텝마다 새 CLI 프로세스가 뜨므로
      // 이 값이 사실상 스텝당 고정비다.
      // 사용자 자신의 이력이 기준선이다. 요금제·provider·과금 모델과 무관하게
      // "이번 run이 평소보다 큰가"를 판단할 수 있다.
      typicalRun: (() => {
        const sorted = [...runBilledTokens].sort((left, right) => left - right);
        return {
          runs: sorted.length,
          medianBilledTokens: percentile(sorted, 0.5),
          p90BilledTokens: percentile(sorted, 0.9),
          maxBilledTokens: sorted.length > 0 ? sorted[sorted.length - 1] : 0
        };
      })(),
      agentSteps: agentStepCount,
      avgCostPerStep: agentStepCount > 0 ? usageTotals.costUsd / agentStepCount : 0,
      runsWithoutCost,
      providersWithoutCost: [...providersWithoutCost],
      byPipeline: usageByPipeline,
      byRole: usageByRole,
      byCategory: usageByCategory
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
    ...(metrics.interruptedRuns > 0
      ? [`Interrupted: ${metrics.interruptedRuns} run(s) never finished (no final status)`]
      : []),
    `Rerun rate: ${pct(metrics.rerunRate)}`,
    `Human-review rate: ${pct(metrics.humanReviewRate)}`,
    `Avg duration: ${metrics.avgDurationMs} ms`,
    'Provider success:'
  ];
  const failureEntries = Object.entries(metrics.byFailure || {}).sort((left, right) => right[1] - left[1]);
  if (failureEntries.length > 0) {
    const failedTotal = failureEntries.reduce((sum, [, count]) => sum + count, 0);
    lines.push('', `Failures by cause (${failedTotal} failed run(s)):`);
    for (const [label, count] of failureEntries) {
      lines.push(`  ${label.padEnd(26)} ${String(count).padStart(4)}  ${pct(count / failedTotal)}`);
    }
    // 재시도 설정을 켤지 판단하는 근거다. 0이면 켜도 건질 것이 없다.
    lines.push(
      `  ${'→ retryable cause'.padEnd(26)} ${String(metrics.retryableFailures).padStart(4)}`
        + (metrics.retryableFailures === 0
          ? '  (nothing to gain from retries yet)'
          : '  (retry.agentRetries + backoffMs would target these)')
    );
    lines.push('');
  }

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
    `  Cost:            ~${usd(usage.costUsd)} API-equivalent (avg ~${usd(usage.avgCostUsd)}/run)`
  );

  if (usage.agentSteps > 0) {
    lines.push(`  Agent steps:     ${num(usage.agentSteps)} (avg ${usd(usage.avgCostPerStep)}/step)`);
  }

  // 비용 미노출 provider가 섞여 있으면 cost 수치를 그대로 비교하면 안 된다.
  if (usage.runsWithoutCost > 0) {
    lines.push(
      `  Note:            ${usage.runsWithoutCost} run(s) report no cost `
        + `(${usage.providersWithoutCost.join(', ')}); their tokens count, their cost does not.`
    );
  }

  // 요금제를 모르므로 절대 금액 대신 사용자 자신의 이력을 기준선으로 준다.
  const typical = usage.typicalRun;
  if (typical && typical.runs > 0) {
    lines.push(
      `  Typical run:     ${num(typical.medianBilledTokens)} billed (median of ${typical.runs})`
        + `, ${num(typical.p90BilledTokens)} (p90), ${num(typical.maxBilledTokens)} (max)`
    );
  }

  const pipelineEntries = Object.entries(usage.byPipeline || {})
    .sort((left, right) => right[1].costUsd - left[1].costUsd);
  if (pipelineEntries.length > 0) {
    lines.push('  By pipeline:');
    for (const [pipeline, counts] of pipelineEntries) {
      lines.push(`    ${pipeline}: ${usd(counts.costUsd)}, ${num(counts.billedTokens)} billed (${counts.runs} run(s))`);
    }
  }

  const share = (value) => (usage.costUsd > 0 ? ` ${pct(value / usage.costUsd)}` : '');

  // 범주별: 실제 코드 변경 대비 검토·감독·보고에 얼마가 가는지.
  const categoryLabels = {
    write: 'write  (code changes)',
    review: 'review (plan/verify)',
    meta: 'meta   (supervise/report)',
    other: 'other'
  };
  const categoryEntries = Object.entries(usage.byCategory || {})
    .sort((left, right) => right[1].costUsd - left[1].costUsd);
  if (categoryEntries.length > 0) {
    lines.push('  By category:');
    for (const [category, counts] of categoryEntries) {
      lines.push(`    ${categoryLabels[category] || category}: ${usd(counts.costUsd)}${share(counts.costUsd)}, ${counts.steps} step(s)`);
    }
  }

  const roleEntries = Object.entries(usage.byRole || {})
    .sort((left, right) => right[1].costUsd - left[1].costUsd);
  if (roleEntries.length > 0) {
    lines.push('  By role:');
    for (const [role, counts] of roleEntries) {
      lines.push(`    ${role}: ${usd(counts.costUsd)}${share(counts.costUsd)}, ${num(counts.billedTokens)} billed, ${counts.turns} turn(s)`);
    }
  }

  return lines.join('\n');
}
