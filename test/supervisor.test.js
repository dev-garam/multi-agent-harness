import assert from 'node:assert/strict';
import {
  normalizeSupervisorDecision,
  parseSupervisorDecision,
  appendSupervisorInstructions
} from '../src/supervisor.js';

// B1: Hermes decision fixtures.
// 목적 — supervisor decision의 정규화/파싱이 정확하고, 잘못된 입력이
// 항상 human review로 안전하게 붕괴하는지를 골든 케이스로 고정한다.

// --- 유효 결정 정규화 (각 nextAction) ---
for (const action of ['continue', 'run_validation', 'escalate_to_safe_fix', 'stop_failed', 'request_human_review']) {
  const decision = normalizeSupervisorDecision({ nextAction: action, status: 'success' });
  assert.equal(decision.valid, true, `${action} should be valid`);
  assert.equal(decision.nextAction, action);
}

// rerun_step 은 targetStep 이 있어야 유효
const rerun = normalizeSupervisorDecision({ nextAction: 'rerun_step', status: 'failed', targetStep: 'coder' });
assert.equal(rerun.valid, true, 'rerun_step with targetStep is valid');
assert.equal(rerun.targetStep, 'coder');

// action 별칭(action) 지원
const aliased = normalizeSupervisorDecision({ action: 'continue', status: 'success' });
assert.equal(aliased.valid, true, 'action alias supported');
assert.equal(aliased.nextAction, 'continue');

// --- 잘못된 입력은 항상 human review 로 붕괴 ---
// rerun_step 인데 targetStep 없음
const rerunNoTarget = normalizeSupervisorDecision({ nextAction: 'rerun_step', status: 'failed' });
assert.equal(rerunNoTarget.valid, false, 'rerun_step without targetStep is invalid');
assert.equal(rerunNoTarget.nextAction, 'request_human_review');

// 지원하지 않는 action
const badAction = normalizeSupervisorDecision({ nextAction: 'delete_everything', status: 'success' });
assert.equal(badAction.valid, false, 'unsupported action is invalid');
assert.equal(badAction.nextAction, 'request_human_review');

// 지원하지 않는 status
const badStatus = normalizeSupervisorDecision({ nextAction: 'continue', status: 'whatever' });
assert.equal(badStatus.valid, false, 'unsupported status is invalid');
assert.equal(badStatus.nextAction, 'request_human_review');

// 비객체 입력
assert.equal(normalizeSupervisorDecision(null).valid, false, 'null is invalid');
assert.equal(normalizeSupervisorDecision('a string').valid, false, 'string is invalid');
assert.equal(normalizeSupervisorDecision(null).nextAction, 'request_human_review');

// --- parse: fenced JSON 블록 추출 ---
const parsed = parseSupervisorDecision(
  'reasoning about the run...\n```json\n{"nextAction":"escalate_to_safe_fix","status":"failed"}\n```'
);
assert.equal(parsed.valid, true, 'fenced decision parses');
assert.equal(parsed.nextAction, 'escalate_to_safe_fix');

// 여러 블록이면 마지막(실제 결정)을 선택 — 예제 JSON 이 앞에 있어도 안전
const multi = parseSupervisorDecision(
  '```json\n{"nextAction":"continue","status":"success"}\n```\nmore text\n```json\n{"nextAction":"stop_failed","status":"failed"}\n```'
);
assert.equal(multi.nextAction, 'stop_failed', 'last decision block wins');

// 파싱 불가(산문만) → human review
const proseOnly = parseSupervisorDecision('no json here, just prose about what happened');
assert.equal(proseOnly.valid, false, 'unparseable output is invalid');
assert.equal(proseOnly.nextAction, 'request_human_review');

// 깨진 JSON 블록 → human review
const brokenJson = parseSupervisorDecision('```json\n{not valid json}\n```');
assert.equal(brokenJson.valid, false, 'broken json is invalid');
assert.equal(brokenJson.nextAction, 'request_human_review');

// --- appendSupervisorInstructions ---
const instructions = appendSupervisorInstructions('previous outputs', {
  status: 'failed',
  nextAction: 'rerun_step',
  targetStep: 'coder',
  reason: 'tests failed',
  instructions: 'fix the failing test'
});
assert.match(instructions, /hermes decision for coder/, 'includes target step');
assert.match(instructions, /nextAction: rerun_step/, 'includes next action');
assert.match(instructions, /status: failed/, 'includes status');

console.log('supervisor decision tests passed');
