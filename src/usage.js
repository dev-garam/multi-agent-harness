function parseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const number = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function fromUsageObject(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const inputTokens = parseNumber(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens ?? value.promptTokens);
  const outputTokens = parseNumber(value.output_tokens ?? value.outputTokens ?? value.completion_tokens ?? value.completionTokens);
  const totalTokens = parseNumber(value.total_tokens ?? value.totalTokens);
  const costUsd = parseNumber(value.cost_usd ?? value.costUsd ?? value.cost);

  if (inputTokens === null && outputTokens === null && totalTokens === null && costUsd === null) {
    return null;
  }

  return {
    status: 'parsed',
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (
      inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
    ),
    costUsd
  };
}

function parseJsonUsage(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const usage = fromUsageObject(parsed.usage || parsed);
      if (usage) {
        return usage;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return null;
}

function parseRegexUsage(text) {
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
  });
}

export function parseProviderUsage(text) {
  return parseJsonUsage(text) || parseRegexUsage(text) || {
    status: 'unknown',
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null
  };
}
