import assert from 'node:assert/strict';
import { parseProviderUsage, summarizeManifestUsage, formatUsageSummary } from '../src/usage.js';

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
