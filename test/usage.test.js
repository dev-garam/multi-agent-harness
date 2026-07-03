import assert from 'node:assert/strict';
import { parseProviderUsage } from '../src/usage.js';

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
