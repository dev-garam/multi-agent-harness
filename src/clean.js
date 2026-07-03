import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, harnessRoot, runCapture, writeText } from './fs-utils.js';

function parseRunTimestamp(name) {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{6})(?:_(?<ms>\d{3}))?$/.exec(name);
  if (!match) {
    return null;
  }

  const time = match.groups.time;
  const ms = match.groups.ms || '000';
  return new Date(`${match.groups.date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${ms}`);
}

export async function cleanRuns({ days = 7, keep = 5, dryRun = false, exclude = [] } = {}) {
  const runsDir = path.join(harnessRoot, 'runs');
  const trashDir = path.join(runsDir, '.trash');
  await ensureDir(trashDir);
  const excludedRuns = new Set(exclude);

  const entries = await readdir(runsDir, { withFileTypes: true });
  const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.trash')
    .map((entry) => ({ name: entry.name, timestamp: parseRunTimestamp(entry.name) }))
    .filter((entry) => entry.timestamp)
    .sort((left, right) => right.timestamp - left.timestamp);

  const protectedRuns = new Set(runDirs.slice(0, Number(keep)).map((entry) => entry.name));
  const targets = runDirs.filter((entry) => {
    return !excludedRuns.has(entry.name) && !protectedRuns.has(entry.name) && entry.timestamp.getTime() < cutoff;
  });
  const moved = [];

  for (const target of targets) {
    const from = path.join(runsDir, target.name);
    const to = path.join(trashDir, `${target.name}_${Date.now()}`);
    if (dryRun) {
      console.log(`[dry-run] move ${from} -> ${to}`);
    } else {
      await rename(from, to);
      console.log(`moved ${from} -> ${to}`);
    }
    moved.push({ from, to, dryRun });
  }

  if (targets.length === 0) {
    console.log('No runs matched clean criteria.');
  }

  return {
    status: 'succeeded',
    days: Number(days),
    keep: Number(keep),
    dryRun: Boolean(dryRun),
    excludedRuns: [...excludedRuns],
    matched: targets.length,
    moved
  };
}

async function readManifest(runDir) {
  try {
    return JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function worktreeCleanTargets(runDirs, { days, keep, exclude }) {
  const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
  const excludedRuns = new Set(exclude);
  const protectedRuns = new Set(runDirs.slice(0, Number(keep)).map((entry) => entry.name));
  return runDirs.filter((entry) => {
    return !excludedRuns.has(entry.name) && !protectedRuns.has(entry.name) && entry.timestamp.getTime() < cutoff;
  });
}

export async function cleanWorktrees({ days = 7, keep = 5, dryRun = false, exclude = [] } = {}) {
  const runsDir = path.join(harnessRoot, 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.trash')
    .map((entry) => ({ name: entry.name, timestamp: parseRunTimestamp(entry.name) }))
    .filter((entry) => entry.timestamp)
    .sort((left, right) => right.timestamp - left.timestamp);

  const candidates = worktreeCleanTargets(runDirs, { days, keep, exclude });
  const cleaned = [];
  const skipped = [];

  for (const candidate of candidates) {
    const runDir = path.join(runsDir, candidate.name);
    const manifest = await readManifest(runDir);
    const workspace = manifest?.workspace;
    const worktreePath = workspace?.worktreePath;

    if (!workspace?.isolated || !worktreePath || workspace.worktreeRemoved === true) {
      skipped.push({
        runId: candidate.name,
        reason: 'no active isolated worktree recorded'
      });
      continue;
    }

    if (!existsSync(worktreePath)) {
      skipped.push({
        runId: candidate.name,
        worktreePath,
        reason: 'worktree path already missing'
      });
      if (!dryRun && manifest) {
        manifest.workspace = {
          ...workspace,
          worktreeRemoved: true,
          worktreeRemoveReason: 'worktree path already missing',
          worktreeRemovedAt: new Date().toISOString()
        };
        await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      }
      continue;
    }

    const originalRepo = workspace.originalRepo || manifest.repo;
    const remove = originalRepo && existsSync(originalRepo)
      ? dryRun
        ? { exitCode: 0, stdout: '', stderr: '' }
        : await runCapture('git', ['worktree', 'remove', '--force', worktreePath], { cwd: originalRepo })
      : { exitCode: 1, stdout: '', stderr: 'original repo unavailable' };

    if (dryRun) {
      console.log(`[dry-run] remove worktree ${worktreePath}`);
      cleaned.push({
        runId: candidate.name,
        worktreePath,
        dryRun: true
      });
      continue;
    }

    if (remove.exitCode !== 0 && existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true });
    }

    const removed = !existsSync(worktreePath);
    if (removed && manifest) {
      manifest.workspace = {
        ...workspace,
        worktreeRemoved: true,
        worktreeRemoveError: remove.exitCode === 0 ? null : remove.stderr || remove.stdout || null,
        worktreeRemovedAt: new Date().toISOString()
      };
      await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }

    console.log(removed ? `removed worktree ${worktreePath}` : `failed to remove worktree ${worktreePath}`);
    cleaned.push({
      runId: candidate.name,
      worktreePath,
      removed,
      gitExitCode: remove.exitCode,
      error: remove.exitCode === 0 ? null : remove.stderr || remove.stdout || null
    });
  }

  if (cleaned.length === 0) {
    console.log('No worktrees matched clean criteria.');
  }

  return {
    status: cleaned.every((entry) => entry.dryRun || entry.removed !== false) ? 'succeeded' : 'failed',
    days: Number(days),
    keep: Number(keep),
    dryRun: Boolean(dryRun),
    excludedRuns: [...new Set(exclude)],
    matched: cleaned.length,
    cleaned,
    skipped
  };
}
