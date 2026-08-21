import { existsSync } from 'node:fs';
import path from 'node:path';
import { harnessRoot, readText } from './fs-utils.js';
import { resolveRunId } from './show.js';

/**
 * 이전 run을 이어받아 새 run을 시작한다.
 *
 * 하네스는 요청 하나를 받아 파이프라인을 돌고 끝나는 배치 실행이다. 실행 중인
 * 스텝에 끼어들 수는 없다 — CLI가 이미 프롬프트를 받아 돌고 있고 stdin도 막혀
 * 있다. 대신 끝난 run의 결과 위에 다음 지시를 쌓을 수는 있다.
 *
 * 이어받는 것은 두 가지다.
 * - 변경: 이전 run의 `changes.patch`를 새 워크스페이스에 적용한다. 앞선 작업이
 *   살아 있어야 "그것도 같이 해줘"가 성립한다.
 * - 맥락: 원래 요청과 무엇을 바꿨는지, 검증과 감독이 뭐라고 했는지를 컨텍스트로
 *   넣는다. 그래야 이어지는 지시가 앞의 작업을 아는 상태에서 해석된다.
 *
 * 반대로 "A 말고 B"라면 이어받지 않는 것이 맞다. 격리 실행이 기본이므로 이전
 * run의 변경은 원본에 반영되지 않았고, 그냥 새 run을 돌리면 없던 일이 된다.
 */

export async function loadContinuation(runId) {
  const resolvedRunId = await resolveRunId(runId || '--latest');
  const runDir = path.join(harnessRoot, 'runs', resolvedRunId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Cannot continue: run not found: ${resolvedRunId}`);
  }

  const manifest = JSON.parse(await readText(manifestPath));
  const workspace = manifest.workspace || {};
  const patchPath = workspace.patchPath || path.join(runDir, 'changes.patch');
  const hasPatch = existsSync(patchPath) && (await readText(patchPath)).trim().length > 0;

  return {
    runId: resolvedRunId,
    runDir,
    manifest,
    // 격리 실행이 아니었다면 변경이 이미 원본에 있으므로 다시 적용하지 않는다.
    patchPath: workspace.isolated && hasPatch ? patchPath : null,
    isolated: workspace.isolated === true,
    hasPatch
  };
}

function lastInspection(manifest) {
  const inspections = (manifest.steps || []).filter((step) => step.type === 'inspection');
  return inspections.length > 0 ? inspections[inspections.length - 1] : null;
}

/**
 * 이어지는 지시가 앞선 작업을 아는 상태에서 해석되도록 요약을 만든다.
 *
 * 스텝 출력 전문을 넣지 않는다. 그건 이미 끝난 대화이고, 다시 넣으면 컨텍스트만
 * 부풀린다. 다음 판단에 필요한 것은 "무엇을 요청했고, 무엇이 바뀌었고, 검증과
 * 감독이 뭐라고 했는가"다.
 */
export function formatContinuationContext(continuation) {
  const { manifest, runId } = continuation;
  const inspection = lastInspection(manifest);
  const changed = (inspection?.changedFiles || []).map((entry) => entry.path);
  const validation = (manifest.steps || [])
    .filter((step) => step.type === 'validation' && step.status !== 'skipped')
    .map((step) => `${step.stepId}: ${step.status}${step.exitCode === null || step.exitCode === undefined ? '' : ` (exit ${step.exitCode})`}`);
  const decision = (manifest.supervisorDecisions || []).at(-1);

  const lines = [
    `## previous run (${runId})`,
    '',
    'The work below was already done. The new request continues from this state;',
    'the changes are already present in this workspace.',
    '',
    `request: ${manifest.request || '(none)'}`,
    `pipeline: ${manifest.completedPipeline || manifest.pipeline || '(unknown)'}`,
    `status: ${manifest.status || '(unknown)'}`,
    `changedFiles: ${changed.length > 0 ? changed.join(', ') : '(none)'}`,
    `validation: ${validation.length > 0 ? validation.join('; ') : '(none ran)'}`
  ];

  if (decision) {
    lines.push(`supervisor: ${decision.nextAction} (${decision.status})`);
    if (decision.reason) {
      lines.push(`supervisorReason: ${decision.reason}`);
    }
  }
  if (manifest.failure) {
    lines.push(`failure: ${manifest.failure.kind} — ${manifest.failure.summary}`);
  }

  return lines.join('\n');
}

/** 이어받기 결과를 manifest에 남긴다. 어디서 이어졌는지는 감사 대상이다. */
export function continuationRecord(continuation, { patchApplied }) {
  return {
    runId: continuation.runId,
    request: continuation.manifest.request || null,
    status: continuation.manifest.status || null,
    patchApplied,
    patchPath: continuation.patchPath,
    isolated: continuation.isolated
  };
}
