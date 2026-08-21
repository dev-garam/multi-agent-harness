import { existsSync } from 'node:fs';
import path from 'node:path';
import { harnessRoot, readText, runCapture } from './fs-utils.js';
import { resolveRunId } from './show.js';

/**
 * 격리 실행(worktree/patch)의 결과를 원본 repo에 적용한다.
 *
 * 하네스는 격리 모드에서 원본을 건드리지 않는다. 대신 run이 끝날 때
 * `runs/<runId>/changes.patch`를 남긴다(untracked 파일도 `git add -N`으로 포함된다).
 * 적용은 사람이 검토한 뒤 하는 일이고, 이 명령은 그 마지막 한 걸음만 대신한다.
 *
 * 되돌리기 어려운 작업이므로 기본은 보수적이다:
 * - 적용 전에 항상 `git apply --check`로 검증한다.
 * - 원본에 커밋되지 않은 변경이 있으면 멈춘다(--force로 진행).
 * - --dry-run은 무엇이 바뀔지만 보여준다.
 */
export async function applyRun({ runId, repo = null, dryRun = false, force = false } = {}) {
  const resolvedRunId = await resolveRunId(runId || '--latest');

  const runDir = path.join(harnessRoot, 'runs', resolvedRunId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Run not found: ${resolvedRunId}`);
  }

  const manifest = JSON.parse(await readText(manifestPath));
  const workspace = manifest.workspace || {};

  if (!workspace.isolated) {
    throw new Error(
      `Run ${resolvedRunId} used workspaceMode "${workspace.mode || 'direct'}", `
      + 'so its changes were already written to the repo. There is nothing to apply.'
    );
  }

  const patchPath = workspace.patchPath || path.join(runDir, 'changes.patch');
  if (!existsSync(patchPath)) {
    throw new Error(`No patch artifact for run ${resolvedRunId}: ${patchPath}`);
  }

  const patch = await readText(patchPath);
  if (patch.trim().length === 0) {
    return {
      runId: resolvedRunId,
      status: 'empty',
      patchPath,
      repo: repo || workspace.originalRepo || manifest.repo,
      files: [],
      message: 'The run produced no changes.'
    };
  }

  const targetRepo = path.resolve(repo || workspace.originalRepo || manifest.repo);
  if (!existsSync(targetRepo)) {
    throw new Error(`Target repo does not exist: ${targetRepo}`);
  }

  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);

  // 원본이 dirty하면 적용 결과가 섞여 되돌리기 어려워진다. 기본은 멈춘다.
  const status = await runCapture('git', ['status', '--porcelain'], { cwd: targetRepo });
  const dirty = String(status.stdout || '').split('\n').filter((line) => line.trim().length > 0);
  if (dirty.length > 0 && !force && !dryRun) {
    throw new Error(
      `Target repo has ${dirty.length} uncommitted change(s). `
      + 'Commit or stash them first so the applied patch stays reviewable, or pass --force.'
    );
  }

  // 적용 가능한지 먼저 검증한다. run 이후 원본이 바뀌었으면 여기서 걸린다.
  const check = await runCapture('git', ['apply', '--check', patchPath], { cwd: targetRepo });
  if (check.exitCode !== 0) {
    const reason = (check.stderr || check.stdout || '').trim();
    throw new Error(
      `Patch does not apply cleanly to ${targetRepo}.\n${reason}\n`
      + 'The repo likely changed after the run. Re-run the task, or apply the patch by hand.'
    );
  }

  if (dryRun) {
    return {
      runId: resolvedRunId,
      status: 'dry-run',
      patchPath,
      repo: targetRepo,
      files,
      dirtyFiles: dirty.length
    };
  }

  const applied = await runCapture('git', ['apply', patchPath], { cwd: targetRepo });
  if (applied.exitCode !== 0) {
    throw new Error(`git apply failed: ${(applied.stderr || applied.stdout || '').trim()}`);
  }

  return {
    runId: resolvedRunId,
    status: 'applied',
    patchPath,
    repo: targetRepo,
    files,
    dirtyFiles: dirty.length
  };
}

export function formatApplyResult(result) {
  if (result.status === 'empty') {
    return [`Run ${result.runId} produced no changes.`, `Patch: ${result.patchPath}`].join('\n');
  }

  const lines = [
    result.status === 'dry-run'
      ? `[dry-run] ${result.files.length} file(s) would be applied to ${result.repo}`
      : `Applied ${result.files.length} file(s) to ${result.repo}`,
    `Run: ${result.runId}`,
    `Patch: ${result.patchPath}`,
    ''
  ];
  for (const file of result.files) {
    lines.push(`  ${file}`);
  }
  if (result.status === 'applied') {
    lines.push('', 'Review the changes before committing.');
  }
  return lines.join('\n');
}
