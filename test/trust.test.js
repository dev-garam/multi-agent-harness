import assert from 'node:assert/strict';
import { trustBoundarySummary, trustBoundaryWarnings } from '../src/trust.js';

// 순수 함수 계약 검증만 수행한다. 파일시스템 부작용이 있는 inspectHarnessGitignore는 다루지 않는다.

// ---------------------------------------------------------------------------
// trustBoundarySummary — 반환 구조 계약.
// ---------------------------------------------------------------------------
const summary = trustBoundarySummary();
assert.equal(summary.executionModel, 'local-first');
assert.ok(Array.isArray(summary.trustedInputs));
assert.equal(summary.trustedInputs.length, 4);
assert.ok(Array.isArray(summary.notGuaranteed));
assert.equal(summary.notGuaranteed.length, 4);
assert.ok(Array.isArray(summary.warnings));

// 빈 config에서도 기본 경고 3개가 항상 warnings에 포함된다.
assert.equal(summary.warnings.length, 3);

// ---------------------------------------------------------------------------
// trustBoundaryWarnings — 기본 경고 3개(id/severity/message 필드).
// ---------------------------------------------------------------------------
const base = trustBoundaryWarnings();
assert.ok(Array.isArray(base));
assert.equal(base.length, 3);

for (const warning of base) {
  assert.equal(typeof warning.id, 'string');
  assert.equal(typeof warning.severity, 'string');
  assert.equal(typeof warning.message, 'string');
}

const baseIds = base.map((warning) => warning.id);
assert.deepEqual(baseIds, [
  'local-first-execution',
  'trusted-repo-required',
  'logs-may-contain-sensitive-data'
]);

const byId = new Map(base.map((warning) => [warning.id, warning]));
assert.equal(byId.get('local-first-execution').severity, 'info');
assert.equal(byId.get('trusted-repo-required').severity, 'warning');
assert.equal(byId.get('logs-may-contain-sensitive-data').severity, 'warning');

// ---------------------------------------------------------------------------
// validationCommands가 있으면 validation-commands-execute-shell 경고가
// commands 배열과 함께 추가된다.
// ---------------------------------------------------------------------------
const withValidation = trustBoundaryWarnings({
  testCommand: 'npm test',
  validationCommands: [{ id: 'check', command: 'npm run check' }]
});
const validationWarning = withValidation.find(
  (warning) => warning.id === 'validation-commands-execute-shell'
);
assert.ok(validationWarning, 'validation-commands-execute-shell 경고가 있어야 한다');
assert.equal(validationWarning.severity, 'warning');
assert.ok(Array.isArray(validationWarning.commands));
assert.ok(validationWarning.commands.length >= 1);
for (const entry of validationWarning.commands) {
  assert.equal(typeof entry.id, 'string');
  assert.equal(typeof entry.command, 'string');
}
const commandIds = validationWarning.commands.map((entry) => entry.id);
assert.ok(commandIds.includes('test'));
assert.ok(commandIds.includes('check'));

// validationCommands가 없으면 해당 경고도 없다.
const noValidation = trustBoundaryWarnings();
assert.equal(
  noValidation.some((warning) => warning.id === 'validation-commands-execute-shell'),
  false
);

// ---------------------------------------------------------------------------
// agent.command/args가 있으면 custom-agent-command 경고가 추가된다.
// ---------------------------------------------------------------------------
const withAgent = trustBoundaryWarnings({ agent: { command: 'node' } });
const agentWarning = withAgent.find((warning) => warning.id === 'custom-agent-command');
assert.ok(agentWarning, 'custom-agent-command 경고가 있어야 한다');
assert.equal(agentWarning.severity, 'warning');
assert.equal(agentWarning.command, 'node');

// agent 설정이 없으면 해당 경고도 없다.
assert.equal(
  trustBoundaryWarnings().some((warning) => warning.id === 'custom-agent-command'),
  false
);

console.log('trust tests passed');
