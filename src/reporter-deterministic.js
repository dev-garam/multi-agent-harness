import { formatUsageSummary } from './usage.js';

/**
 * manifest만으로 최종 보고서를 만든다.
 *
 * reporter가 쓰던 내용의 재료는 이미 전부 manifest에 있다: 변경 파일(inspection),
 * 검증 결과(validation 스텝), 감독 판단과 지시(supervisorDecisions), 사용량
 * (usageSummary). LLM은 그걸 산문으로 옮겨 적을 뿐이고, 실측에서 그 작업이 run
 * 비용의 30.9%를 썼다. 같은 내용을 결정론적으로 만들면 그 비용이 사라지고
 * 보고 내용도 manifest와 어긋날 수 없다.
 *
 * 하네스의 다른 출력(show/metrics/doctor)과 맞춰 영어로 쓴다.
 */

function lastInspection(manifest) {
  const inspections = (manifest.steps || []).filter((step) => step.type === 'inspection');
  return inspections.length > 0 ? inspections[inspections.length - 1] : null;
}

function validationEntries(manifest) {
  return (manifest.steps || [])
    .filter((step) => step.type === 'validation')
    .map((step) => ({
      id: String(step.stepId || step.id || ''),
      status: step.status === 'succeeded' || step.exitCode === 0
        ? 'succeeded'
        : step.status === 'skipped'
          ? 'skipped'
          : 'failed',
      exitCode: step.exitCode ?? null
    }));
}

function finalDecision(manifest) {
  const decisions = manifest.supervisorDecisions || [];
  return decisions.length > 0 ? decisions[decisions.length - 1] : null;
}

/**
 * 보고 상태를 정한다. supervisor 판단을 우선하되, 검증 실패나 정책 차단처럼
 * 결정론적으로 확실한 실패 신호가 있으면 그것이 이긴다.
 */
function resolveStatus({ manifest, validation, decision }) {
  if (manifest.policyBlock) {
    return 'failed';
  }
  if (validation.some((entry) => entry.status === 'failed')) {
    return 'failed';
  }
  if (decision) {
    if (decision.nextAction === 'stop_failed') {
      return 'failed';
    }
    if (decision.nextAction === 'request_human_review') {
      return 'incomplete';
    }
    if (decision.status === 'failed') {
      return 'failed';
    }
    if (decision.status === 'incomplete') {
      return 'incomplete';
    }
    if (decision.status === 'success_with_risks') {
      return 'success_with_risks';
    }
  }
  return 'success';
}

/** 사람이 후속 조치를 판단해야 하는 항목만 모은다. */
function collectRisks({ manifest, inspection, validation, decision }) {
  const risks = [];

  if (manifest.policyBlock) {
    const reasons = Array.isArray(manifest.policyBlock.reasons) ? manifest.policyBlock.reasons.join('; ') : '';
    risks.push(`Policy blocked the run (${manifest.policyBlock.kind})${reasons ? `: ${reasons}` : '.'}`);
  }

  for (const entry of validation.filter((item) => item.status === 'failed')) {
    risks.push(`Validation failed: ${entry.id} (exit ${entry.exitCode}).`);
  }
  if (validation.length === 0) {
    risks.push('No validation commands ran, so nothing was verified automatically.');
  }

  if (inspection) {
    for (const risky of inspection.riskyFiles || []) {
      risks.push(`Risky path changed (${risky.ruleId}): ${risky.path}.`);
    }
    if ((inspection.secretFindings || []).length > 0) {
      const paths = inspection.secretFindings.map((finding) => finding.path).join(', ');
      risks.push(`Possible secret in the diff: ${paths}.`);
    }
    if (inspection.noChangeAssessment?.suspicious) {
      risks.push('A write step ran but produced no changes; the request may not be implemented.');
    }
  }

  for (const change of manifest.pipelineChanges || []) {
    risks.push(`Pipeline was escalated from ${change.from} to ${change.to}: ${change.reason || 'no reason given'}.`);
  }

  if (decision && decision.valid === false) {
    risks.push('The supervisor decision could not be parsed, so human review is required.');
  }
  if (decision && decision.status && decision.status !== 'success' && decision.reason) {
    risks.push(`Supervisor: ${decision.reason}`);
  }

  if (manifest.workspace?.mode === 'worktree' || manifest.workspace?.mode === 'patch') {
    risks.push(`Changes are isolated in ${manifest.workspace.mode} mode and are not applied to the original repo.`);
  }

  return risks;
}

function changedFilePaths(inspection) {
  return (inspection?.changedFiles || []).map((entry) => String(entry.path));
}

function bulletList(items, emptyText) {
  if (items.length === 0) {
    return `- ${emptyText}`;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * manifest에서 최종 보고서(markdown)와 기계 판독용 summary를 만든다.
 * 반환하는 markdown은 agent reporter와 같은 계약을 따른다: 마지막에 fenced JSON.
 */
export function buildDeterministicReport({ manifest, request }) {
  const inspection = lastInspection(manifest);
  const validation = validationEntries(manifest);
  const decision = finalDecision(manifest);
  const status = resolveStatus({ manifest, validation, decision });
  const changedFiles = changedFilePaths(inspection);
  const risks = collectRisks({ manifest, inspection, validation, decision });

  const summaryText = changedFiles.length > 0
    ? `${manifest.pipeline} run changed ${changedFiles.length} file(s) with ${validation.length} validation command(s).`
    : `${manifest.pipeline} run completed without file changes.`;

  const validationLines = validation.length === 0
    ? '- No validation commands were configured.'
    : validation
      .map((entry) => `- ${entry.id}: ${entry.status}${entry.exitCode === null ? '' : ` (exit ${entry.exitCode})`}`)
      .join('\n');

  const sections = [
    '# Harness Report',
    '',
    `Status: **${status}**`,
    '',
    '## Request',
    '',
    String(request || '(none)'),
    '',
    '## What ran',
    '',
    `- Pipeline: ${manifest.pipeline}${manifest.completedPipeline && manifest.completedPipeline !== manifest.pipeline ? ` -> ${manifest.completedPipeline}` : ''}`,
    `- Agent: ${manifest.agent?.provider || '(unknown)'}`,
    `- Workspace mode: ${manifest.workspace?.mode || '(unknown)'}`,
    `- Runner: ${manifest.runtime?.mode || '(unknown)'}`,
    '',
    '## Changed files',
    '',
    bulletList(changedFiles, 'No files changed.'),
    '',
    '## Validation',
    '',
    validationLines,
    '',
    '## Risks and follow-ups',
    '',
    // supervisor instructions에 주의사항이 담겨 있는데 여기서 "None recorded."라고
    // 단정하면 오해를 준다. 아래 Supervisor 절을 가리킨다.
    bulletList(risks, decision?.instructions
      ? 'None beyond the supervisor instructions below.'
      : 'None recorded.')
  ];

  if (decision) {
    sections.push(
      '',
      '## Supervisor',
      '',
      `- Decision: ${decision.nextAction} (${decision.status})`,
      `- Reason: ${decision.reason || '(none)'}`,
      `- Instructions: ${decision.instructions || '(none)'}`
    );
  }

  if (manifest.usageSummary) {
    sections.push(
      '',
      '## Harness usage',
      '',
      '```text',
      formatUsageSummary(manifest.usageSummary, { billing: manifest.agent?.billing || 'unknown' }),
      '```'
    );
  }

  const summary = {
    status,
    summary: summaryText,
    changedFiles,
    validation,
    risks
  };

  sections.push(
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    ''
  );

  return {
    markdown: sections.join('\n'),
    summary
  };
}

export function reporterModeFromProjectConfig(projectConfig = {}) {
  const mode = projectConfig.reporter?.mode;
  // 안전 기본값: 기존처럼 agent가 보고서를 쓴다.
  return mode === 'deterministic' ? 'deterministic' : 'agent';
}
