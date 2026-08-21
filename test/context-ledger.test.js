import assert from 'node:assert/strict';
import {
  ContextLedger,
  DEFAULT_ROLE_POLICY,
  contextSelectionFromProjectConfig
} from '../src/context-ledger.js';

// ---------------------------------------------------------------------------
// 동작 보존: 선별이 꺼져 있으면 기존 누적 문자열과 바이트 단위로 같아야 한다.
// 기존 구현은 ''에서 시작해 `${prev}\n\n## title\nbody` 를 반복 append 했으므로
// 첫 섹션 앞에도 "\n\n" 이 붙는다. 이 선행 개행까지 재현해야 프롬프트가 바뀌지 않는다.
// ---------------------------------------------------------------------------
const sections = [
  { kind: 'agent', baseStepId: 'planner', stepId: 'planner', text: '## planner\nplan body' },
  { kind: 'agent', baseStepId: 'coder', stepId: 'coder', text: '## coder\ncode body' },
  { kind: 'validation', baseStepId: 'coder', stepId: 'test', text: '## validation:test\nstatus: succeeded' },
  { kind: 'inspection', baseStepId: 'coder', stepId: 'after-coder', text: '## inspection:after-coder\nchanged 1' },
  { kind: 'agent', baseStepId: 'qa', stepId: 'qa', text: '## qa\nqa body' },
  { kind: 'supervisor', text: '## hermes decision for reporter\nstatus: success' },
  { kind: 'usage', baseStepId: 'reporter', text: '## harness usage summary\nproviderCalls: 3' }
];

// 기존 로직을 그대로 재현한 기준값.
let legacy = '';
for (const section of sections) {
  legacy = `${legacy}\n\n${section.text}`;
}

const offLedger = new ContextLedger({ selection: { enabled: false } });
for (const section of sections) {
  offLedger.push(section);
}
assert.equal(offLedger.render(), legacy);
// 선별이 꺼져 있으면 stepId를 줘도 전체를 낸다.
assert.equal(offLedger.render('reporter'), legacy);
assert.equal(offLedger.render('coder'), legacy);
assert.equal(offLedger.stats('reporter').applied, false);
assert.equal(offLedger.stats('reporter').savedBytes, 0);

// ---------------------------------------------------------------------------
// 선별 on: 역할별 정책이 적용된다.
// ---------------------------------------------------------------------------
function onLedger() {
  const ledger = new ContextLedger({ selection: { enabled: true } });
  for (const section of sections) {
    ledger.push(section);
  }
  return ledger;
}

// coder: planner 출력만 받고 뒤 단계(coder/qa) 원문은 제외. 검증/조사/감독은 유지.
const coderContext = onLedger().render('coder');
assert.match(coderContext, /## planner/);
assert.doesNotMatch(coderContext, /## coder\n/);
assert.doesNotMatch(coderContext, /## qa\n/);
assert.match(coderContext, /## validation:test/);
assert.match(coderContext, /## inspection:after-coder/);
assert.match(coderContext, /## hermes decision/);

// qa: planner + coder 를 받고 qa 자신의 이전 출력은 제외.
const qaContext = onLedger().render('qa');
assert.match(qaContext, /## planner/);
assert.match(qaContext, /## coder\n/);
assert.doesNotMatch(qaContext, /## qa\n/);

// reporter: hermes 가 이미 종합했으므로 planner/coder/qa 원문을 넣지 않는다.
// usage 섹션은 "Harness usage" 절을 쓰기 위해 반드시 남아야 한다.
const reporterContext = onLedger().render('reporter');
assert.doesNotMatch(reporterContext, /## planner/);
assert.doesNotMatch(reporterContext, /## coder\n/);
assert.doesNotMatch(reporterContext, /## qa\n/);
assert.match(reporterContext, /## harness usage summary/);
assert.match(reporterContext, /## validation:test/);
assert.match(reporterContext, /## hermes decision/);

// verifier/hermes 는 정책이 없다 = 전체를 받는다.
// verifier 프롬프트가 "planner, coder, QA, reviewer 출력에서 주장을 추출하라"고
// 명시하므로 여기서 선별하면 역할이 깨진다. 이 단언이 그 계약을 고정한다.
assert.equal(onLedger().render('verifier'), legacy);
assert.equal(onLedger().render('hermes'), legacy);
assert.equal(DEFAULT_ROLE_POLICY.verifier, undefined);
assert.equal(DEFAULT_ROLE_POLICY.hermes, undefined);

// 재시도로 stepId에 접미사가 붙어도 baseStepId로 매칭된다.
const retryLedger = new ContextLedger({ selection: { enabled: true } });
retryLedger.push({ kind: 'agent', baseStepId: 'planner', stepId: 'planner-retry-1', text: '## planner-retry-1\nretried' });
assert.match(retryLedger.render('coder'), /## planner-retry-1/);

// 절감 측정.
const stats = onLedger().stats('reporter');
assert.equal(stats.applied, true);
assert.equal(stats.totalSections, 7);
assert.equal(stats.selectedSections, 4);
assert.ok(stats.savedBytes > 0);
assert.equal(stats.fullBytes - stats.selectedBytes, stats.savedBytes);

// ---------------------------------------------------------------------------
// 설정 읽기: 기본은 off(하위 호환), 명시적 true 에서만 켜진다.
// ---------------------------------------------------------------------------
assert.equal(contextSelectionFromProjectConfig({}).enabled, false);
assert.equal(contextSelectionFromProjectConfig({ context: {} }).enabled, false);
assert.equal(contextSelectionFromProjectConfig({ context: { selection: {} } }).enabled, false);
assert.equal(contextSelectionFromProjectConfig({ context: { selection: { enabled: 'yes' } } }).enabled, false);
assert.equal(contextSelectionFromProjectConfig({ context: { selection: { enabled: true } } }).enabled, true);
assert.equal(contextSelectionFromProjectConfig({ context: { selection: { enabled: true } } }).mode, 'role-aware');

// 알 수 없는 kind 는 즉시 실패한다(오타가 조용히 통과하지 않게).
assert.throws(() => new ContextLedger().push({ kind: 'unknown', text: 'x' }), /Unknown context section kind/);

// null/undefined 본문은 무시한다.
const skipLedger = new ContextLedger();
skipLedger.push({ kind: 'note', text: null });
assert.equal(skipLedger.render(), '');

console.log('context ledger tests passed');
