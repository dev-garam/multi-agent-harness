import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { runCapture, writeText } from './fs-utils.js';

// 기본은 격리 실행이다. 실패한 run이 원본 워킹 트리를 더럽히지 않는 편이,
// 적용 단계가 하나 늘어나는 것보다 낫다(적용은 `harness apply`가 한다).
const DEFAULT_WORKSPACE_MODE = 'worktree';

function explicitWorkspaceMode(options = {}, projectConfig = {}) {
  return options.workspaceMode || projectConfig.workspaceMode || projectConfig.workspace?.mode || null;
}

export function workspaceModeFromOptions(options = {}, projectConfig = {}) {
  const mode = explicitWorkspaceMode(options, projectConfig) || DEFAULT_WORKSPACE_MODE;
  if (!['direct', 'worktree', 'patch'].includes(mode)) {
    throw new Error(`Unsupported workspace mode "${mode}". Available: direct, worktree, patch`);
  }
  return mode;
}

/**
 * 사용자가 workspace mode를 직접 지정했는지.
 *
 * 격리 모드는 git work tree와 HEAD commit을 요구한다. 사용자가 명시적으로
 * 요청했다면 조건이 안 맞을 때 에러를 내야 하지만, 기본값이라면 에러 대신
 * direct로 내려간다. 기본값이 git 아닌 프로젝트의 진입 자체를 막으면 안 된다.
 */
export function workspaceModeIsExplicit(options = {}, projectConfig = {}) {
  return Boolean(explicitWorkspaceMode(options, projectConfig));
}

export function carryUncommittedFromConfig(options = {}, projectConfig = {}) {
  if (options.carryUncommitted !== undefined) {
    return options.carryUncommitted === true;
  }
  const configured = projectConfig.workspace?.carryUncommitted;
  if (configured !== undefined) {
    return configured === true;
  }
  // 기본 on. 격리가 기본인 이상, 작업 중 변경이 보이지 않으면 "왜 내 수정이
  // 반영 안 되지"가 되어 격리 자체를 못 쓰게 된다. 두 기본값은 짝이다.
  return true;
}

/**
 * 원본의 커밋되지 않은 변경을 격리 워크스페이스로 옮긴다.
 *
 * worktree는 HEAD 기준으로 만들어지므로 작업 중인 변경이 보이지 않는다. 뭔가
 * 고치다가 일부를 하네스에 맡기는 흐름에서는 이게 정면으로 걸린다 — 하네스가
 * 고치기 전 파일을 보고 작업하게 된다.
 *
 * 원본 repo를 절대 건드리지 않는 방식으로 옮긴다:
 * - tracked 변경은 `git diff HEAD --binary`로 떠서 worktree에 apply한다.
 *   (원본에서 `git add`를 하지 않는다. 인덱스를 바꾸면 부작용이 된다.)
 * - untracked 파일은 `--exclude-standard`로 gitignore된 것을 뺀 뒤 복사한다.
 *   node_modules 같은 것이 딸려오면 안 된다.
 */
async function carryUncommittedChanges({ repo, worktreePath, runDir }) {
  const result = { attempted: true, tracked: 0, untracked: 0, status: 'succeeded', error: null };

  const diff = await runCapture('git', ['diff', 'HEAD', '--binary'], { cwd: repo });
  if (diff.exitCode !== 0) {
    return { ...result, status: 'failed', error: diff.stderr || 'git diff failed' };
  }

  if (diff.stdout.trim().length > 0) {
    const patchPath = path.join(runDir, 'carried-uncommitted.patch');
    await writeText(patchPath, diff.stdout + '\n');
    const apply = await runCapture('git', ['apply', patchPath], { cwd: worktreePath });
    if (apply.exitCode !== 0) {
      return { ...result, status: 'failed', error: apply.stderr || 'git apply failed', patchPath };
    }
    result.tracked = (diff.stdout.match(/^diff --git /gm) || []).length;
    result.patchPath = patchPath;
  }

  const others = await runCapture('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo });
  if (others.exitCode === 0 && others.stdout.trim().length > 0) {
    const files = others.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const file of files) {
      const from = path.join(repo, file);
      const to = path.join(worktreePath, file);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    result.untracked = files.length;
  }

  return result;
}

export async function prepareWorkspace({
  repo, runDir, mode, dryRun, carryUncommitted = false, explicitMode = true, basePatchPath = null
}) {
  if (mode === 'direct' || dryRun) {
    return {
      mode,
      originalRepo: repo,
      executionRepo: repo,
      isolated: false,
      prepared: true,
      reason: dryRun ? 'dry-run uses the original repo without executing agents' : null
    };
  }

  // 격리 조건을 못 맞출 때: 사용자가 직접 요청했으면 에러, 기본값이면 direct로 내려간다.
  const fallback = (reason) => {
    if (explicitMode) {
      throw new Error(`Workspace mode "${mode}" requires ${reason}.`);
    }
    return {
      mode: 'direct',
      originalRepo: repo,
      executionRepo: repo,
      isolated: false,
      prepared: true,
      fallbackFrom: mode,
      fallbackReason: `default isolation unavailable: repo requires ${reason}`
    };
  };

  const inside = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode !== 0 || inside.stdout !== 'true') {
    return fallback('a git work tree');
  }

  const commit = await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo });
  if (commit.exitCode !== 0 || !commit.stdout) {
    return fallback('a valid HEAD commit');
  }

  const worktreePath = path.join(runDir, 'worktree');
  const add = await runCapture('git', ['worktree', 'add', '--detach', worktreePath, commit.stdout], { cwd: repo });
  if (add.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${add.stderr || add.stdout}`);
  }

  // 이어받기: 이전 run의 변경을 먼저 얹는다. 그 위에 작업 중 변경을 올려야
  // 순서가 맞는다(이전 결과 -> 지금 내 편집).
  let basePatchApplied = false;
  if (basePatchPath) {
    const apply = await runCapture('git', ['apply', basePatchPath], { cwd: worktreePath });
    if (apply.exitCode !== 0) {
      await runCapture('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo });
      throw new Error(
        `Failed to continue: the previous run's patch does not apply to ${repo}. `
        + `${(apply.stderr || apply.stdout || '').trim()} `
        + 'The repo likely moved since that run. Start a fresh run instead.'
      );
    }
    basePatchApplied = true;
  }

  const carried = carryUncommitted
    ? await carryUncommittedChanges({ repo, worktreePath, runDir })
    : { attempted: false };

  // 옮기기에 실패하면 조용히 HEAD 기준으로 진행하지 않는다. 사용자는 작업 중
  // 변경이 반영됐다고 믿을 텐데 실제로는 아닌 상태가 가장 나쁘다.
  if (carried.attempted && carried.status === 'failed') {
    await runCapture('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo });
    throw new Error(
      `Failed to carry uncommitted changes into the workspace: ${carried.error}. `
      + 'Commit or stash them, or disable workspace.carryUncommitted.'
    );
  }

  return {
    mode,
    originalRepo: repo,
    executionRepo: worktreePath,
    isolated: true,
    prepared: true,
    baseCommit: commit.stdout,
    worktreePath,
    carriedUncommitted: carried,
    basePatchApplied
  };
}

export async function finalizeWorkspace({ workspace, runDir }) {
  if (!workspace?.isolated) {
    return {
      ...workspace,
      finalized: true
    };
  }

  const patchPath = path.join(runDir, 'changes.patch');
  await runCapture('git', ['add', '-N', '.'], { cwd: workspace.executionRepo });
  const diff = await runCapture('git', ['diff', '--binary'], { cwd: workspace.executionRepo });
  await writeText(patchPath, (diff.stdout || '') + (diff.stdout ? '\n' : ''));
  const remove = workspace.mode === 'patch'
    ? await runCapture('git', ['worktree', 'remove', '--force', workspace.executionRepo], { cwd: workspace.originalRepo })
    : null;

  return {
    ...workspace,
    finalized: true,
    patchPath,
    patchStatus: diff.exitCode === 0 ? 'succeeded' : 'failed',
    patchError: diff.exitCode === 0 ? null : diff.stderr,
    worktreeRemoved: remove ? remove.exitCode === 0 : false,
    worktreeRemoveError: remove && remove.exitCode !== 0 ? remove.stderr || remove.stdout : null
  };
}
