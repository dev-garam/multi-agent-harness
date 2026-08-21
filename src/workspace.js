import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { runCapture, writeText } from './fs-utils.js';

export function workspaceModeFromOptions(options = {}, projectConfig = {}) {
  const mode = options.workspaceMode || projectConfig.workspaceMode || projectConfig.workspace?.mode || 'direct';
  if (!['direct', 'worktree', 'patch'].includes(mode)) {
    throw new Error(`Unsupported workspace mode "${mode}". Available: direct, worktree, patch`);
  }
  return mode;
}

export function carryUncommittedFromConfig(options = {}, projectConfig = {}) {
  if (options.carryUncommitted !== undefined) {
    return options.carryUncommitted === true;
  }
  const configured = projectConfig.workspace?.carryUncommitted;
  // 안전 기본값: 기존처럼 HEAD 기준으로만 격리한다.
  return configured === true;
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

export async function prepareWorkspace({ repo, runDir, mode, dryRun, carryUncommitted = false }) {
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

  const inside = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode !== 0 || inside.stdout !== 'true') {
    throw new Error(`Workspace mode "${mode}" requires a git work tree.`);
  }

  const commit = await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo });
  if (commit.exitCode !== 0 || !commit.stdout) {
    throw new Error(`Workspace mode "${mode}" requires a valid HEAD commit.`);
  }

  const worktreePath = path.join(runDir, 'worktree');
  const add = await runCapture('git', ['worktree', 'add', '--detach', worktreePath, commit.stdout], { cwd: repo });
  if (add.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${add.stderr || add.stdout}`);
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
    carriedUncommitted: carried
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
