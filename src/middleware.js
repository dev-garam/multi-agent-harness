import crypto from 'node:crypto';

const DEFAULT_CONTEXT_MAX_BYTES = 256 * 1024;
const DEFAULT_STEP_OUTPUT_MAX_BYTES = 64 * 1024;

const DEFAULT_SECRET_PATTERNS = [
  {
    id: 'openai-key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g
  },
  {
    id: 'slack-token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/g
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  }
];

function asPositiveNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function replacementFor(value, mode) {
  if (mode === 'hash') {
    return `[REDACTED:${hashValue(value)}]`;
  }
  return '[REDACTED]';
}

function normalizeRedactionConfig(projectConfig = {}) {
  const config = projectConfig.redaction || projectConfig.security?.redaction || {};
  return {
    enabled: config.enabled === true,
    mode: config.mode || 'mask',
    patterns: Array.isArray(config.patterns) ? config.patterns : []
  };
}

function normalizeContextConfig(projectConfig = {}) {
  const config = projectConfig.context || {};
  return {
    maxPreviousOutputBytes: asPositiveNumber(config.maxPreviousOutputBytes, DEFAULT_CONTEXT_MAX_BYTES),
    maxStepOutputBytes: asPositiveNumber(config.maxStepOutputBytes, DEFAULT_STEP_OUTPUT_MAX_BYTES)
  };
}

function normalizeBudgetConfig(projectConfig = {}) {
  const config = projectConfig.budget || {};
  return {
    maxAgentSteps: asPositiveNumber(config.maxAgentSteps),
    maxProviderCalls: asPositiveNumber(config.maxProviderCalls),
    maxValidationCommands: asPositiveNumber(config.maxValidationCommands),
    maxRuntimeMs: asPositiveNumber(config.maxRuntimeMs)
  };
}

function normalizeRetryConfig(projectConfig = {}) {
  const config = projectConfig.retry || {};
  return {
    agentRetries: Number.isInteger(config.agentRetries) && config.agentRetries >= 0 ? config.agentRetries : 0,
    validationRetries: Number.isInteger(config.validationRetries) && config.validationRetries >= 0 ? config.validationRetries : 0,
    backoffMs: asPositiveNumber(config.backoffMs, 0),
    fallbackAgents: Array.isArray(config.fallbackAgents) ? config.fallbackAgents : []
  };
}

function trimToBytes(text, maxBytes) {
  const value = String(text || '');
  if (!maxBytes || Buffer.byteLength(value) <= maxBytes) {
    return {
      text: value,
      truncated: false,
      originalBytes: Buffer.byteLength(value),
      maxBytes
    };
  }

  const marker = '\n\n[context truncated by harness]\n';
  const markerBytes = Buffer.byteLength(marker);
  const available = Math.max(0, maxBytes - markerBytes);
  const buffer = Buffer.from(value);
  return {
    text: marker + buffer.subarray(Math.max(0, buffer.length - available)).toString(),
    truncated: true,
    originalBytes: buffer.length,
    maxBytes
  };
}

function compilePattern(entry) {
  if (!entry || typeof entry !== 'object' || !entry.pattern) {
    return null;
  }
  try {
    return {
      id: entry.id || 'custom',
      pattern: new RegExp(entry.pattern, entry.flags || 'g')
    };
  } catch {
    return null;
  }
}

export function createHarnessRuntime({ projectConfig = {} } = {}) {
  const startedAt = Date.now();
  const redaction = normalizeRedactionConfig(projectConfig);
  const context = normalizeContextConfig(projectConfig);
  const budget = normalizeBudgetConfig(projectConfig);
  const retry = normalizeRetryConfig(projectConfig);
  const events = [];
  const state = {
    counters: {
      agentSteps: 0,
      providerCalls: 0,
      validationCommands: 0,
      hookEvents: 0,
      redactions: 0,
      contextTruncations: 0,
      retries: 0,
      fallbacks: 0,
      toolSetups: 0,
      toolTeardowns: 0
    },
    flags: {},
    values: {}
  };
  const customPatterns = redaction.patterns.map(compilePattern).filter(Boolean);
  const patterns = [...DEFAULT_SECRET_PATTERNS, ...customPatterns];

  function recordEvent(type, detail = {}) {
    const event = {
      type,
      detail,
      createdAt: new Date().toISOString()
    };
    events.push(event);
    state.counters.hookEvents += 1;
    return event;
  }

  function hook(name, detail = {}) {
    return recordEvent(`hook:${name}`, detail);
  }

  function redactText(text, detail = {}) {
    const value = String(text || '');
    if (!redaction.enabled) {
      return {
        text: value,
        redacted: false,
        findings: []
      };
    }

    const findings = [];
    let next = value;
    for (const entry of patterns) {
      next = next.replace(entry.pattern, (match) => {
        findings.push({
          id: entry.id,
          length: match.length
        });
        return replacementFor(match, redaction.mode);
      });
    }

    if (findings.length > 0) {
      state.counters.redactions += findings.length;
      recordEvent('redaction', {
        ...detail,
        findings
      });
    }

    return {
      text: next,
      redacted: findings.length > 0,
      findings
    };
  }

  function trimStepOutput(text, detail = {}) {
    const result = trimToBytes(text, context.maxStepOutputBytes);
    if (result.truncated) {
      state.counters.contextTruncations += 1;
      recordEvent('context:step-output-truncated', {
        ...detail,
        originalBytes: result.originalBytes,
        maxBytes: result.maxBytes
      });
    }
    return result.text;
  }

  function trimPreviousOutputs(text, detail = {}) {
    const result = trimToBytes(text, context.maxPreviousOutputBytes);
    if (result.truncated) {
      state.counters.contextTruncations += 1;
      recordEvent('context:previous-outputs-truncated', {
        ...detail,
        originalBytes: result.originalBytes,
        maxBytes: result.maxBytes
      });
    }
    return result.text;
  }

  function assertBudget(kind, increment = 1) {
    const elapsed = Date.now() - startedAt;
    if (budget.maxRuntimeMs && elapsed > budget.maxRuntimeMs) {
      const error = new Error(`Harness budget exceeded: maxRuntimeMs=${budget.maxRuntimeMs}`);
      error.code = 'HARNESS_BUDGET_EXCEEDED';
      throw error;
    }

    if (kind === 'agent') {
      state.counters.agentSteps += increment;
      state.counters.providerCalls += increment;
      if (budget.maxAgentSteps && state.counters.agentSteps > budget.maxAgentSteps) {
        throw new Error(`Harness budget exceeded: maxAgentSteps=${budget.maxAgentSteps}`);
      }
      if (budget.maxProviderCalls && state.counters.providerCalls > budget.maxProviderCalls) {
        throw new Error(`Harness budget exceeded: maxProviderCalls=${budget.maxProviderCalls}`);
      }
    }

    if (kind === 'validation') {
      state.counters.validationCommands += increment;
      if (budget.maxValidationCommands && state.counters.validationCommands > budget.maxValidationCommands) {
        throw new Error(`Harness budget exceeded: maxValidationCommands=${budget.maxValidationCommands}`);
      }
    }
  }

  function summary() {
    return {
      state,
      events,
      config: {
        redaction,
        context,
        budget,
        retry
      }
    };
  }

  return {
    state,
    events,
    redaction,
    context,
    budget,
    retry,
    recordEvent,
    hook,
    redactText,
    trimStepOutput,
    trimPreviousOutputs,
    assertBudget,
    summary
  };
}

export function appendRuntimeSummary(manifest, runtime) {
  manifest.middleware = runtime.summary();
}
