import { runCapture } from './fs-utils.js';

export async function gitSnapshot(repo) {
  const inside = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode !== 0 || inside.stdout !== 'true') {
    return {
      available: false,
      reason: inside.stderr || 'not a git work tree'
    };
  }

  const [commit, branch, statusShort, diffStat] = await Promise.all([
    runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    runCapture('git', ['branch', '--show-current'], { cwd: repo }),
    runCapture('git', ['status', '--short'], { cwd: repo }),
    runCapture('git', ['diff', '--stat'], { cwd: repo })
  ]);

  return {
    available: true,
    commit: commit.exitCode === 0 ? commit.stdout : null,
    branch: branch.exitCode === 0 ? branch.stdout : null,
    dirty: statusShort.exitCode === 0 ? statusShort.stdout.length > 0 : null,
    statusShort: statusShort.exitCode === 0 ? statusShort.stdout : statusShort.stderr,
    diffStat: diffStat.exitCode === 0 ? diffStat.stdout : diffStat.stderr
  };
}
