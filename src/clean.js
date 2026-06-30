import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, harnessRoot } from './fs-utils.js';

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
