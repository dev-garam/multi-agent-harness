const PROVIDER_ADAPTERS = new Set(['generic', 'codex', 'claude', 'antigravity', 'custom']);

function parseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const number = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function sumDefined(...values) {
  const defined = values.filter((value) => value !== null && value !== undefined);
  return defined.length > 0 ? defined.reduce((total, value) => total + value, 0) : null;
}

function fromUsageObject(value, { provider = 'unknown', adapter = 'generic' } = {}) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const inputTokens = parseNumber(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens ?? value.promptTokens);
  const outputTokens = parseNumber(value.output_tokens ?? value.outputTokens ?? value.completion_tokens ?? value.completionTokens);
  const totalTokens = parseNumber(value.total_tokens ?? value.totalTokens);
  const costUsd = parseNumber(
    value.cost_usd ?? value.costUsd ?? value.cost ?? value.total_cost_usd ?? value.totalCostUsd
  );
  // 캐시 토큰은 청구 대상이지만 input_tokens에 포함되지 않는다. 별도로 집계하지
  // 않으면 실제 소비의 극히 일부만 보게 된다(예: input 2 / cache_read 15900).
  const cacheCreationTokens = parseNumber(
    value.cache_creation_input_tokens ?? value.cacheCreationInputTokens
  );
  const cacheReadTokens = parseNumber(
    value.cache_read_input_tokens ?? value.cacheReadInputTokens
  );
  // agent CLI가 내부적으로 돈 turn 수. 스텝 하나가 몇 번의 model 호출로
  // 이어졌는지 보여주는 소비 지표라 함께 보존한다.
  const turns = parseNumber(value.num_turns ?? value.numTurns ?? value.turns);

  if (
    inputTokens === null && outputTokens === null && totalTokens === null && costUsd === null &&
    cacheCreationTokens === null && cacheReadTokens === null
  ) {
    return null;
  }

  const resolvedTotal = totalTokens ?? sumDefined(inputTokens, outputTokens);

  return {
    status: 'parsed',
    provider,
    adapter,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: resolvedTotal,
    // 실제 청구 기준 합계: 캐시 생성/조회 토큰까지 포함한다. totalTokens는
    // 기존 계약(input+output)을 유지하고, 소비 판단은 billedTokens로 한다.
    billedTokens: sumDefined(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens),
    turns,
    costUsd
  };
}

// claude `--output-format json`은 usage를 중첩 객체에, 비용을 최상위
// total_cost_usd에 둔다. 한 객체로 병합해 fromUsageObject가 단일 형태만 다루게 한다.
function mergedUsageSource(parsed) {
  if (parsed && typeof parsed === 'object' && parsed.usage && typeof parsed.usage === 'object') {
    return {
      ...parsed.usage,
      cost_usd: parsed.usage.cost_usd ?? parsed.usage.costUsd ?? parsed.total_cost_usd ?? parsed.totalCostUsd,
      num_turns: parsed.usage.num_turns ?? parsed.num_turns ?? parsed.numTurns
    };
  }
  return parsed;
}

function parseJsonUsage(text, context = {}) {
  const value = String(text || '');

  // 전체가 하나의 JSON 문서인 경우(멀티라인 pretty-print 포함).
  const trimmedAll = value.trim();
  if (trimmedAll.startsWith('{') && trimmedAll.endsWith('}')) {
    try {
      const usage = fromUsageObject(mergedUsageSource(JSON.parse(trimmedAll)), context);
      if (usage) {
        return usage;
      }
    } catch {
      // 통짜 파싱 실패 — 줄 단위로 계속 시도한다.
    }
  }

  // 줄 단위 JSON 로그(마지막 usage 줄이 최종값이므로 역순으로 훑는다).
  const lines = value.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      continue;
    }
    try {
      const usage = fromUsageObject(mergedUsageSource(JSON.parse(trimmed)), context);
      if (usage) {
        return usage;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return null;
}

function parseRegexUsage(text, context = {}) {
  const value = String(text || '');
  const inputTokens = value.match(/(?:input|prompt)[_\s-]*tokens["':=\s]+([0-9,]+)/i)?.[1];
  const outputTokens = value.match(/(?:output|completion)[_\s-]*tokens["':=\s]+([0-9,]+)/i)?.[1];
  const totalTokens = value.match(/total[_\s-]*tokens["':=\s]+([0-9,]+)/i)?.[1];
  const costUsd = value.match(/(?:cost|cost_usd|usd)["':=\s$]+([0-9,.]+)/i)?.[1];
  return fromUsageObject({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd
  }, context);
}

function adapterForProvider(provider) {
  const normalized = String(provider || 'generic').toLowerCase();
  return PROVIDER_ADAPTERS.has(normalized) ? normalized : 'custom';
}

export function parseProviderUsage(text, { provider = 'unknown' } = {}) {
  const adapter = adapterForProvider(provider);
  const context = { provider, adapter };
  return parseJsonUsage(text, context) || parseRegexUsage(text, context) || {
    status: 'unknown',
    provider,
    adapter,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    totalTokens: null,
    billedTokens: null,
    turns: null,
    costUsd: null
  };
}

export function summarizeManifestUsage(manifest = {}) {
  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  const entries = steps
    .filter((step) => step.type === 'agent' && step.usage)
    .map((step) => ({
      stepId: step.stepId,
      provider: step.usage.provider || step.agent || null,
      adapter: step.usage.adapter || null,
      status: step.usage.status || 'unknown',
      totalTokens: step.usage.totalTokens ?? null,
      billedTokens: step.usage.billedTokens ?? null,
      cacheReadTokens: step.usage.cacheReadTokens ?? null,
      cacheCreationTokens: step.usage.cacheCreationTokens ?? null,
      turns: step.usage.turns ?? null,
      costUsd: step.usage.costUsd ?? null
    }));
  // provider마다 노출하는 항목이 다르다(codex는 billedTokens만 주고 cost/turns는
  // 비운다). null을 0으로 합산하면 "비용 0"과 "비용을 모름"이 구분되지 않으므로,
  // 몇 개 스텝이 실제로 보고했는지를 함께 남긴다.
  const reported = (key) => entries.filter((entry) => entry[key] !== null && entry[key] !== undefined).length;
  const costReported = reported('costUsd');
  const turnsReported = reported('turns');

  const providerCalls = manifest.middleware?.state?.counters?.providerCalls ?? 0;
  const maxProviderCalls = manifest.middleware?.config?.budget?.maxProviderCalls ?? null;
  const remainingProviderCalls = maxProviderCalls === null
    ? null
    : Math.max(0, maxProviderCalls - providerCalls);
  const sum = (key) => entries.reduce((total, entry) => total + (entry[key] || 0), 0);

  return {
    providerCalls,
    maxProviderCalls,
    remainingProviderCalls,
    parsedUsageEntries: entries.filter((entry) => entry.status === 'parsed').length,
    unknownUsageEntries: entries.filter((entry) => entry.status !== 'parsed').length,
    totalTokens: sum('totalTokens'),
    billedTokens: sum('billedTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheCreationTokens: sum('cacheCreationTokens'),
    agentTurns: sum('turns'),
    costUsd: entries.reduce((total, entry) => total + (entry.costUsd || 0), 0),
    costReported,
    turnsReported,
    // 아무 스텝도 비용을 보고하지 않았다면 costUsd 0은 "쓰지 않았다"가 아니라
    // "provider가 알려주지 않는다"는 뜻이다.
    costAvailable: costReported > 0,
    remainingTokens: null,
    remainingTokensReason: 'provider did not expose token budget',
    entries
  };
}

/**
 * 비용 표기를 정한다.
 *
 * provider CLI가 주는 cost는 API 요금 기준 환산값이다. 구독 인증으로 쓰면 실제
 * 청구가 아니라 사용량 한도에서 차감된다. 하네스는 사용자의 요금제를 알 수 없으므로
 * 아는 척하지 않고, `agent.billing`으로 선언된 경우에만 단정한다.
 *
 * 기본값(unknown)에서는 환산값임을 드러내는 쪽이 안전하다. "$0.69 썼다"를 청구로
 * 오해하는 것보다 낫다.
 */
/**
 * 이 요약이 비용을 실제로 담고 있는지 판단한다.
 *
 * costAvailable은 나중에 추가된 필드라 과거 manifest에는 없다. 그때는 entries의
 * costUsd가 하나라도 채워졌는지로 판단한다(미노출 provider는 null로 저장된다).
 * 판단 근거가 아예 없으면 기존 동작을 유지한다.
 */
export function costAvailableFromSummary(summary = {}) {
  if (typeof summary.costAvailable === 'boolean') {
    return summary.costAvailable;
  }
  const entries = summary.entries || [];
  if (entries.length === 0) {
    return true;
  }
  return entries.some((entry) => entry.costUsd !== null && entry.costUsd !== undefined);
}

export function turnsAvailableFromSummary(summary = {}) {
  if (Number.isFinite(summary.turnsReported)) {
    return summary.turnsReported > 0;
  }
  const entries = summary.entries || [];
  if (entries.length === 0) {
    return true;
  }
  return entries.some((entry) => entry.turns !== null && entry.turns !== undefined);
}

export function formatCostLine(costUsd, billing = 'unknown', { available = true, provider = null } = {}) {
  if (!available) {
    return `Cost: not reported${provider ? ` by ${provider}` : ' by this provider'} (billed tokens are still counted)`;
  }
  const value = Number(costUsd || 0);
  if (billing === 'api') {
    return `Cost USD: $${value.toFixed(4)}`;
  }
  const suffix = billing === 'subscription'
    ? ' (subscription: consumes plan usage, not billed)'
    : ' (estimate; not a bill if your provider uses a subscription)';
  return `Cost (API-equivalent): ~$${value.toFixed(4)}${suffix}`;
}

export function billingModeFromProjectConfig(projectConfig = {}) {
  const billing = projectConfig.agent?.billing;
  return billing === 'api' || billing === 'subscription' ? billing : 'unknown';
}

export function formatUsageSummary(summary = {}, { billing = 'unknown' } = {}) {
  return [
    `providerCalls: ${summary.providerCalls ?? 0}${summary.maxProviderCalls !== null && summary.maxProviderCalls !== undefined ? ` / ${summary.maxProviderCalls}` : ''}`,
    `remainingProviderCalls: ${summary.remainingProviderCalls ?? 'unknown'}`,
    `parsedUsageEntries: ${summary.parsedUsageEntries ?? 0}`,
    `unknownUsageEntries: ${summary.unknownUsageEntries ?? 0}`,
    `totalTokens: ${summary.totalTokens ?? 0}`,
    `billedTokens: ${summary.billedTokens ?? 0}`,
    `cacheReadTokens: ${summary.cacheReadTokens ?? 0}`,
    `cacheCreationTokens: ${summary.cacheCreationTokens ?? 0}`,
    turnsAvailableFromSummary(summary)
      ? `agentTurns: ${summary.agentTurns ?? 0}`
      : 'agentTurns: not reported by this provider',
    formatCostLine(summary.costUsd, billing, { available: costAvailableFromSummary(summary) }),
    `remainingTokens: ${summary.remainingTokens ?? 'unknown'}`,
    `remainingTokensReason: ${summary.remainingTokensReason || 'unknown'}`
  ].join('\n');
}
