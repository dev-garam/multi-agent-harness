import path from 'node:path';
import { runCapture, writeText } from './fs-utils.js';

export function workspaceModeFromOptions(options = {}, projectConfig = {}) {
  const mode = options.workspaceMode || projectConfig.workspaceMode || projectConfig.workspace?.mode || 'direct';
  if (!['direct', 'worktree', 'patch'].includes(mode)) {
    throw new Error(`Unsupported workspace mode "${mode}". Available: direct, worktree, patch`);
  }
  return mode;
}

export async function prepareWorkspace({ repo, runDir, mode, dryRun }) {
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

  return {
    mode,
    originalRepo: repo,
    executionRepo: worktreePath,
    isolated: true,
    prepared: true,
    baseCommit: commit.stdout,
    worktreePath
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
