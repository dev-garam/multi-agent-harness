import assert from 'node:assert/strict';
import { buildDeterministicReport, reporterModeFromProjectConfig } from '../src/reporter-deterministic.js';
import { parseReporterSummary } from '../src/reporter-summary.js';

// 결정론 reporter는 agent reporter와 같은 산출물 계약을 지켜야 한다:
// 사람이 읽는 markdown + 마지막에 fenced JSON. 그래야 기존 파서와 소비자가 그대로 동작한다.

function baseManifest(overrides = {}) {
  return {
    runId: '2026-08-21_000000_000',
    pipeline: 'quick_fix',
    agent: { provider: 'claude' },
    workspace: { mode: 'direct' },
    runtime: { mode: 'local' },
    steps: [
      { type: 'agent', stepId: 'coder', status: 'succeeded' },
      { type: 'validation', stepId: 'test', status: 'succeeded', exitCode: 0 },
      {
        type: 'inspection',
        stepId: 'inspection:after-coder',
        changedFiles: [{ status: 'M', path: 'src/app.js' }],
        riskyFiles: [],
        secretFindings: [],
        noChangeAssessment: { suspicious: false }
      }
    ],
    supervisorDecisions: [
      { nextAction: 'continue', status: 'success', reason: 'validation passed', instructions: 'report the change', valid: true }
    ],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 계약: 생성한 markdown을 기존 파서로 되읽으면 같은 summary가 나와야 한다.
// ---------------------------------------------------------------------------
const ok = buildDeterministicReport({ manifest: baseManifest(), request: 'fix the bug' });
const reparsed = parseReporterSummary(ok.markdown);
assert.equal(reparsed.valid, true, 'generated markdown must parse with the existing reporter parser');
assert.equal(reparsed.status, ok.summary.status);
assert.deepEqual(reparsed.changedFiles, ok.summary.changedFiles);
assert.deepEqual(reparsed.risks, ok.summary.risks);
assert.deepEqual(
  reparsed.validation.map((entry) => entry.id),
  ok.summary.validation.map((entry) => entry.id)
);

// 내용 확인.
assert.equal(ok.summary.status, 'success');
assert.deepEqual(ok.summary.changedFiles, ['src/app.js']);
assert.match(ok.markdown, /Status: \*\*success\*\*/);
assert.match(ok.markdown, /fix the bug/, 'request must appear in the report');
assert.match(ok.markdown, /- src\/app\.js/);
assert.match(ok.markdown, /## Supervisor/);
assert.match(ok.markdown, /report the change/, 'supervisor instructions must reach the user');

// ---------------------------------------------------------------------------
// validation 실패는 supervisor가 continue라고 해도 이긴다(결정론적 실패 신호).
// ---------------------------------------------------------------------------
const failed = buildDeterministicReport({
  manifest: baseManifest({
    steps: [
      { type: 'validation', stepId: 'test', status: 'failed', exitCode: 1 },
      {
        type: 'inspection',
        stepId: 'inspection:after-coder',
        changedFiles: [{ status: 'M', path: 'src/app.js' }],
        riskyFiles: [],
        secretFindings: []
      }
    ]
  }),
  request: 'fix'
});
assert.equal(failed.summary.status, 'failed');
assert.ok(failed.summary.risks.some((risk) => /Validation failed: test \(exit 1\)/.test(risk)));

// ---------------------------------------------------------------------------
// 정책 차단도 실패로 보고된다.
// ---------------------------------------------------------------------------
const blocked = buildDeterministicReport({
  manifest: baseManifest({ policyBlock: { kind: 'no-change', reasons: ['no files changed'] } }),
  request: 'fix'
});
assert.equal(blocked.summary.status, 'failed');
assert.ok(blocked.summary.risks.some((risk) => /Policy blocked the run \(no-change\)/.test(risk)));

// ---------------------------------------------------------------------------
// 위험 신호 수집: 위험 경로·secret·변경 0건·승격.
// ---------------------------------------------------------------------------
const risky = buildDeterministicReport({
  manifest: baseManifest({
    steps: [
      { type: 'validation', stepId: 'test', status: 'succeeded', exitCode: 0 },
      {
        type: 'inspection',
        stepId: 'inspection:after-coder',
        changedFiles: [],
        riskyFiles: [{ ruleId: 'environment-file', path: '.env' }],
        secretFindings: [{ path: '.env' }],
        noChangeAssessment: { suspicious: true }
      }
    ],
    pipelineChanges: [{ from: 'quick_fix', to: 'safe_fix', reason: 'needs verification' }]
  }),
  request: 'fix'
});
const riskText = risky.summary.risks.join('\n');
assert.match(riskText, /environment-file.*\.env/);
assert.match(riskText, /Possible secret in the diff/);
assert.match(riskText, /write step ran but produced no changes/);
assert.match(riskText, /escalated from quick_fix to safe_fix/);

// ---------------------------------------------------------------------------
// supervisor 결정별 상태 매핑.
// ---------------------------------------------------------------------------
const stopFailed = buildDeterministicReport({
  manifest: baseManifest({
    supervisorDecisions: [{ nextAction: 'stop_failed', status: 'failed', reason: 'nothing implemented', valid: true }]
  }),
  request: 'fix'
});
assert.equal(stopFailed.summary.status, 'failed');
assert.ok(stopFailed.summary.risks.some((risk) => /nothing implemented/.test(risk)));

const humanReview = buildDeterministicReport({
  manifest: baseManifest({
    supervisorDecisions: [{ nextAction: 'request_human_review', status: 'incomplete', reason: 'unclear', valid: false }]
  }),
  request: 'fix'
});
assert.equal(humanReview.summary.status, 'incomplete');
assert.ok(humanReview.summary.risks.some((risk) => /could not be parsed/.test(risk)));

// ---------------------------------------------------------------------------
// validation이 아예 없으면 "검증된 것이 없다"를 리스크로 남긴다.
// ---------------------------------------------------------------------------
const noValidation = buildDeterministicReport({
  manifest: baseManifest({ steps: [{ type: 'agent', stepId: 'coder', status: 'succeeded' }] }),
  request: 'fix'
});
assert.ok(noValidation.summary.risks.some((risk) => /No validation commands ran/.test(risk)));
assert.deepEqual(noValidation.summary.changedFiles, []);

// supervisor instructions가 있으면 빈 리스크를 "없음"으로 단정하지 않고 그쪽을 가리킨다.
assert.match(ok.markdown, /None beyond the supervisor instructions below\./);
const noInstructions = buildDeterministicReport({
  manifest: baseManifest({
    supervisorDecisions: [{ nextAction: 'continue', status: 'success', reason: 'ok', instructions: '', valid: true }]
  }),
  request: 'fix'
});
assert.match(noInstructions.markdown, /None recorded\./);

// usage summary가 있으면 "Harness usage" 절이 들어간다(reporter.md 계약).
const withUsage = buildDeterministicReport({
  manifest: baseManifest({ usageSummary: { providerCalls: 2, costUsd: 0.1, billedTokens: 1000 } }),
  request: 'fix'
});
assert.match(withUsage.markdown, /## Harness usage/);
assert.match(withUsage.markdown, /providerCalls: 2/);

// ---------------------------------------------------------------------------
// 설정: 기본은 agent, 명시적으로 deterministic일 때만 바뀐다.
// ---------------------------------------------------------------------------
assert.equal(reporterModeFromProjectConfig({}), 'agent');
assert.equal(reporterModeFromProjectConfig({ reporter: {} }), 'agent');
assert.equal(reporterModeFromProjectConfig({ reporter: { mode: 'agent' } }), 'agent');
assert.equal(reporterModeFromProjectConfig({ reporter: { mode: 'nonsense' } }), 'agent');
assert.equal(reporterModeFromProjectConfig({ reporter: { mode: 'deterministic' } }), 'deterministic');

console.log('deterministic reporter tests passed');
