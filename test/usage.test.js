import assert from 'node:assert/strict';
import {
  parseProviderUsage,
  summarizeManifestUsage,
  formatUsageSummary,
  formatCostLine,
  billingModeFromProjectConfig,
  costAvailableFromSummary,
  turnsAvailableFromSummary
} from '../src/usage.js';

const jsonUsage = parseProviderUsage('{"usage":{"input_tokens":10,"output_tokens":5,"cost_usd":0.02}}', {
  provider: 'codex'
});
assert.equal(jsonUsage.status, 'parsed');
assert.equal(jsonUsage.provider, 'codex');
assert.equal(jsonUsage.adapter, 'codex');
assert.equal(jsonUsage.inputTokens, 10);
assert.equal(jsonUsage.outputTokens, 5);
assert.equal(jsonUsage.totalTokens, 15);
assert.equal(jsonUsage.costUsd, 0.02);

const textUsage = parseProviderUsage('prompt tokens: 20 completion tokens: 7 total_tokens: 27 cost $0.03', {
  provider: 'claude'
});
assert.equal(textUsage.status, 'parsed');
assert.equal(textUsage.adapter, 'claude');
assert.equal(textUsage.inputTokens, 20);
assert.equal(textUsage.outputTokens, 7);
assert.equal(textUsage.totalTokens, 27);
assert.equal(textUsage.costUsd, 0.03);

const unknownUsage = parseProviderUsage('ordinary log line', {
  provider: 'my-cli'
});
assert.equal(unknownUsage.status, 'unknown');
assert.equal(unknownUsage.adapter, 'custom');
assert.equal(unknownUsage.totalTokens, null);

console.log('usage parser tests passed');

// ---------------------------------------------------------------------------
// claude `--output-format json` 실측 형태.
// usage는 중첩 객체, 비용은 최상위 total_cost_usd, turn 수는 num_turns에 있다.
// 캐시 토큰(cache_creation/cache_read)은 input_tokens에 포함되지 않으므로
// 별도 집계하지 않으면 실제 소비의 극히 일부만 보게 된다.
// ---------------------------------------------------------------------------
const claudeJson = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.10422,
  result: 'ok',
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 9616,
    cache_read_input_tokens: 15900,
    output_tokens: 4
  }
});

const claudeUsage = parseProviderUsage(claudeJson, { provider: 'claude' });
assert.equal(claudeUsage.status, 'parsed');
assert.equal(claudeUsage.adapter, 'claude');
assert.equal(claudeUsage.inputTokens, 2);
assert.equal(claudeUsage.outputTokens, 4);
assert.equal(claudeUsage.cacheCreationTokens, 9616);
assert.equal(claudeUsage.cacheReadTokens, 15900);
// totalTokens는 기존 계약(input+output)을 유지한다.
assert.equal(claudeUsage.totalTokens, 6);
// 실제 청구 기준은 캐시 토큰까지 포함한다. 이 차이가 이 변경의 핵심이다.
assert.equal(claudeUsage.billedTokens, 25522);
assert.equal(claudeUsage.turns, 3);
assert.equal(claudeUsage.costUsd, 0.10422);

// 멀티라인 pretty-print JSON도 통짜 파싱 경로로 처리된다.
const claudePretty = parseProviderUsage(JSON.stringify(JSON.parse(claudeJson), null, 2), {
  provider: 'claude'
});
assert.equal(claudePretty.status, 'parsed');
assert.equal(claudePretty.billedTokens, 25522);
assert.equal(claudePretty.costUsd, 0.10422);

// 캐시 필드가 없으면 billedTokens는 input+output과 같다(하위 호환).
assert.equal(jsonUsage.billedTokens, 15);
assert.equal(jsonUsage.totalTokens, 15);

// 알 수 없는 출력은 모든 소비 필드가 null이다.
assert.equal(unknownUsage.billedTokens, null);
assert.equal(unknownUsage.cacheReadTokens, null);
assert.equal(unknownUsage.turns, null);

// ---------------------------------------------------------------------------
// manifest 집계: 캐시 토큰과 turn 수가 run 단위로 합산되어야 한다.
// ---------------------------------------------------------------------------
const summary = summarizeManifestUsage({
  steps: [
    { type: 'agent', stepId: 'coder', usage: claudeUsage },
    { type: 'agent', stepId: 'qa', usage: claudeUsage },
    { type: 'validation', stepId: 'validation:after-coder', status: 'succeeded' }
  ],
  middleware: { state: { counters: { providerCalls: 2 } }, config: { budget: { maxProviderCalls: 8 } } }
});
assert.equal(summary.parsedUsageEntries, 2);
assert.equal(summary.unknownUsageEntries, 0);
assert.equal(summary.billedTokens, 51044);
assert.equal(summary.cacheReadTokens, 31800);
assert.equal(summary.cacheCreationTokens, 19232);
assert.equal(summary.agentTurns, 6);
assert.equal(Number(summary.costUsd.toFixed(5)), 0.20844);
assert.equal(summary.remainingProviderCalls, 6);

// 사람이 읽는 요약에도 실제 소비 지표가 드러나야 한다.
const formatted = formatUsageSummary(summary);
assert.match(formatted, /billedTokens: 51044/);
assert.match(formatted, /cacheReadTokens: 31800/);
assert.match(formatted, /agentTurns: 6/);

console.log('usage cache/turn accounting tests passed');

// ---------------------------------------------------------------------------
// 비용 표기: provider가 주는 cost는 API 요금 환산값이다. 구독 인증이면 실제 청구가
// 아니라 사용량 한도에서 차감된다. 하네스는 사용자의 요금제를 알 수 없으므로
// 선언된 경우에만 단정하고, 기본(unknown)에서는 환산값임을 드러낸다.
// ---------------------------------------------------------------------------
const apiLine = formatCostLine(0.6935, 'api');
assert.equal(apiLine, 'Cost USD: $0.6935');
assert.equal(/API-equivalent/.test(apiLine), false, 'declared API billing shows a plain cost');

const subLine = formatCostLine(0.6935, 'subscription');
assert.match(subLine, /API-equivalent/);
assert.match(subLine, /not billed/);

const unknownLine = formatCostLine(0.6935, 'unknown');
assert.match(unknownLine, /API-equivalent/);
assert.match(unknownLine, /estimate/);
// 기본값도 unknown과 같아야 한다(모르면 단정하지 않는다).
assert.equal(formatCostLine(0.6935), unknownLine);
// 값이 없어도 안전하다.
assert.match(formatCostLine(undefined), /~\$0\.0000/);

assert.equal(billingModeFromProjectConfig({}), 'unknown');
assert.equal(billingModeFromProjectConfig({ agent: {} }), 'unknown');
assert.equal(billingModeFromProjectConfig({ agent: { billing: 'nonsense' } }), 'unknown');
assert.equal(billingModeFromProjectConfig({ agent: { billing: 'api' } }), 'api');
assert.equal(billingModeFromProjectConfig({ agent: { billing: 'subscription' } }), 'subscription');

// formatUsageSummary도 billing을 반영한다.
assert.match(formatUsageSummary({ costUsd: 0.5 }, { billing: 'api' }), /Cost USD: \$0\.5000/);
assert.match(formatUsageSummary({ costUsd: 0.5 }), /API-equivalent/);

console.log('usage cost labeling tests passed');

// ---------------------------------------------------------------------------
// provider마다 노출하는 항목이 다르다. codex는 billedTokens만 주고 cost/turns는
// 비운다. null을 0으로 합산하면 "비용 0"과 "비용을 모름"이 구분되지 않는다.
// ---------------------------------------------------------------------------
const codexSummary = summarizeManifestUsage({
  steps: [
    { type: 'agent', stepId: 'coder', usage: { status: 'parsed', billedTokens: 486612, costUsd: null, turns: null } },
    { type: 'agent', stepId: 'hermes', usage: { status: 'parsed', billedTokens: 71410, costUsd: null, turns: null } }
  ]
});
assert.equal(codexSummary.billedTokens, 558022, 'tokens are still counted');
assert.equal(codexSummary.costReported, 0);
assert.equal(codexSummary.turnsReported, 0);
assert.equal(codexSummary.costAvailable, false);
assert.equal(costAvailableFromSummary(codexSummary), false);
assert.equal(turnsAvailableFromSummary(codexSummary), false);

const codexText = formatUsageSummary(codexSummary);
assert.match(codexText, /Cost: not reported/);
assert.match(codexText, /agentTurns: not reported/);
assert.match(codexText, /billedTokens: 558022/, 'token figures stay visible');

// 비용을 주는 provider는 그대로 표시된다.
const claudeSummary = summarizeManifestUsage({
  steps: [{ type: 'agent', stepId: 'coder', usage: { status: 'parsed', billedTokens: 100, costUsd: 0.17, turns: 4 } }]
});
assert.equal(claudeSummary.costAvailable, true);
assert.equal(costAvailableFromSummary(claudeSummary), true);
assert.match(formatUsageSummary(claudeSummary), /API-equivalent/);

// 하위 호환: costAvailable 필드가 없는 과거 manifest도 entries로 판단한다.
assert.equal(costAvailableFromSummary({ entries: [{ costUsd: null }, { costUsd: null }] }), false);
assert.equal(costAvailableFromSummary({ entries: [{ costUsd: null }, { costUsd: 0.1 }] }), true);
// 판단 근거가 없으면 기존 동작을 유지한다(비용을 감추지 않는다).
assert.equal(costAvailableFromSummary({}), true);
assert.equal(costAvailableFromSummary({ entries: [] }), true);
assert.equal(turnsAvailableFromSummary({}), true);

// 미노출일 때 provider 이름을 밝힌다.
assert.match(formatCostLine(0, 'unknown', { available: false, provider: 'codex' }), /not reported by codex/);
assert.match(formatCostLine(0, 'unknown', { available: false }), /not reported by this provider/);

console.log('usage availability tests passed');
