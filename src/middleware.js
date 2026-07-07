import crypto from 'node:crypto';

const DEFAULT_CONTEXT_MAX_BYTES = 256 * 1024;
const DEFAULT_STEP_OUTPUT_MAX_BYTES = 64 * 1024;
const DEFAULT_CONTEXT_SUMMARY_HEAD_BYTES = 8 * 1024;
const DEFAULT_CONTEXT_SUMMARY_TAIL_BYTES = 24 * 1024;
const DEFAULT_RETRY_EXIT_CODES = [124];
const DEFAULT_RETRY_PATTERNS = [
  'timed out',
  'timeout',
  'rate limit',
  'temporarily unavailable',
  'temporary failure',
  'econnreset',
  'etimedout',
  'socket hang up',
  '503',
  '502',
  '429'
];

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
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi
  },
  {
    id: 'generic-secret-assignment',
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{6,}["']?/gi
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  }
];

// 스트림 redactor가 개행 없이 누적할 수 있는 최대 바이트(안전장치).
// 완성된 줄 단위로 redact하되, 개행이 이 크기까지 없으면 강제로 비워 메모리를 보호한다.
const DEFAULT_STREAM_MAX_CARRY_BYTES = 64 * 1024;

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
    // 안전 기본값: 명시적으로 false를 준 경우에만 비활성화한다(기본 ON).
    enabled: config.enabled !== false,
    mode: config.mode || 'mask',
    patterns: Array.isArray(config.patterns) ? config.patterns : []
  };
}

function normalizeContextConfig(projectConfig = {}) {
  const config = projectConfig.context || {};
  const summarizer = config.summarizer && typeof config.summarizer === 'object'
    ? config.summarizer
    : {};
  return {
    maxPreviousOutputBytes: asPositiveNumber(config.maxPreviousOutputBytes, DEFAULT_CONTEXT_MAX_BYTES),
    maxStepOutputBytes: asPositiveNumber(config.maxStepOutputBytes, DEFAULT_STEP_OUTPUT_MAX_BYTES),
    summarizer: {
      enabled: summarizer.enabled === true,
      mode: summarizer.mode || 'deterministic',
      headBytes: asPositiveNumber(summarizer.headBytes, DEFAULT_CONTEXT_SUMMARY_HEAD_BYTES),
      tailBytes: asPositiveNumber(summarizer.tailBytes, DEFAULT_CONTEXT_SUMMARY_TAIL_BYTES),
      provider: summarizer.provider || null
    }
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
    fallbackAgents: Array.isArray(config.fallbackAgents) ? config.fallbackAgents : [],
    retryOnExitCodes: Array.isArray(config.retryOnExitCodes)
      ? config.retryOnExitCodes.filter((entry) => Number.isInteger(entry) && entry >= 0)
      : DEFAULT_RETRY_EXIT_CODES,
    retryOnStderrPatterns: Array.isArray(config.retryOnStderrPatterns)
      ? config.retryOnStderrPatterns.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : DEFAULT_RETRY_PATTERNS
  };
}

function summarizeToBytes(text, maxBytes, summarizer) {
  const value = String(text || '');
  if (!summarizer?.enabled) {
    return null;
  }

  const marker = [
    '',
    '',
    '[context summarized by harness]',
    `mode: ${summarizer.mode}`,
    `originalBytes: ${Buffer.byteLength(value)}`,
    ''
  ].join('\n');
  const markerBytes = Buffer.byteLength(marker);
  const maxHeadBytes = Math.min(summarizer.headBytes, Math.max(0, maxBytes - markerBytes));
  const maxTailBytes = Math.min(summarizer.tailBytes, Math.max(0, maxBytes - markerBytes - maxHeadBytes));
  const buffer = Buffer.from(value);
  const head = buffer.subarray(0, maxHeadBytes).toString();
  const tail = buffer.subarray(Math.max(0, buffer.length - maxTailBytes)).toString();
  const summary = `${head}${marker}${tail}`;

  if (Buffer.byteLength(summary) <= maxBytes) {
    return summary;
  }

  return null;
}

function trimToBytes(text, maxBytes, summarizer = null) {
  const value = String(text || '');
  if (!maxBytes || Buffer.byteLength(value) <= maxBytes) {
    return {
      text: value,
      truncated: false,
      originalBytes: Buffer.byteLength(value),
      maxBytes
    };
  }

  const summarized = summarizeToBytes(value, maxBytes, summarizer);
  if (summarized !== null) {
    return {
      text: summarized,
      truncated: true,
      summarized: true,
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
    summarized: false,
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

/**
 * 스트림 청크마다 redact를 호출하면 secret이 청크 경계에서 쪼개져 누수된다.
 * 이 redactor는 개행(줄) 경계를 기준으로, 완성된 줄만 redact해 emit하고 미완성
 * 줄은 다음 청크로 이월(carry)한다. 대부분의 secret은 한 줄 안에 있으므로 경계
 * 누수를 막는다. 개행 없이 maxCarryBytes까지 누적되면 메모리 보호를 위해 강제로
 * 비운다. 스트림 종료 시 flush()로 잔여분을 마스킹한다.
 */
function createStreamRedactor(redactFn, { maxCarryBytes = DEFAULT_STREAM_MAX_CARRY_BYTES } = {}) {
  let carry = '';
  return {
    push(chunk) {
      carry += String(chunk ?? '');
      const lastNewline = carry.lastIndexOf('\n');
      if (lastNewline === -1) {
        if (carry.length >= maxCarryBytes) {
          const out = redactFn(carry).text;
          carry = '';
          return out;
        }
        return '';
      }
      const complete = carry.slice(0, lastNewline + 1);
      carry = carry.slice(lastNewline + 1);
      return redactFn(complete).text;
    },
    flush() {
      const out = carry ? redactFn(carry).text : '';
      carry = '';
      return out;
    }
  };
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
  const invalidPatterns = [];
  const customPatterns = [];
  for (const entry of redaction.patterns) {
    const compiled = compilePattern(entry);
    if (compiled) {
      customPatterns.push(compiled);
    } else {
      invalidPatterns.push(entry);
    }
  }
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

  // 무효 custom redaction 패턴은 조용히 버리지 않고 경고로 기록한다(잘못된 안전감 방지).
  if (invalidPatterns.length > 0) {
    recordEvent('redaction:invalid-pattern', {
      count: invalidPatterns.length,
      ids: invalidPatterns.map((entry) => entry?.id || 'custom')
    });
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

  // 스트림(stdout/stderr 청크)용 경계-안전 redactor. push/flush로 사용한다.
  function redactStream(detail = {}, options = {}) {
    return createStreamRedactor((chunk) => redactText(chunk, detail), options);
  }

  function trimStepOutput(text, detail = {}) {
    const result = trimToBytes(text, context.maxStepOutputBytes, context.summarizer);
    if (result.truncated) {
      state.counters.contextTruncations += 1;
      recordEvent('context:step-output-truncated', {
        ...detail,
        summarized: Boolean(result.summarized),
        originalBytes: result.originalBytes,
        maxBytes: result.maxBytes
      });
    }
    return result.text;
  }

  function trimPreviousOutputs(text, detail = {}) {
    const result = trimToBytes(text, context.maxPreviousOutputBytes, context.summarizer);
    if (result.truncated) {
      state.counters.contextTruncations += 1;
      recordEvent('context:previous-outputs-truncated', {
        ...detail,
        summarized: Boolean(result.summarized),
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

  function shouldRetryResult(result, kind = 'agent') {
    if (!result || result.exitCode === 0 || result.cancelled) {
      return {
        retryable: false,
        reason: result?.cancelled ? 'cancelled by signal' : 'not failed'
      };
    }

    if (retry.retryOnExitCodes.includes(result.exitCode)) {
      return {
        retryable: true,
        reason: `exit ${result.exitCode}`
      };
    }

    const text = `${result.stderr || ''}\n${result.stderrTail || ''}\n${result.error || ''}`.toLowerCase();
    const pattern = retry.retryOnStderrPatterns.find((entry) => text.includes(entry.toLowerCase()));
    if (pattern) {
      return {
        retryable: true,
        reason: `matched stderr pattern "${pattern}"`
      };
    }

    return {
      retryable: false,
      reason: `${kind} failure is not classified as transient`
    };
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
    redactStream,
    trimStepOutput,
    trimPreviousOutputs,
    assertBudget,
    shouldRetryResult,
    summary
  };
}

export function appendRuntimeSummary(manifest, runtime) {
  manifest.middleware = runtime.summary();
}
