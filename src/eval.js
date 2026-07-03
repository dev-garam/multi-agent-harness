import path from 'node:path';
import { ensureDir, harnessRoot, runCapture, timestampId, writeText } from './fs-utils.js';

const DEFAULT_EVAL_COMMANDS = [
  {
    id: 'test',
    command: 'npm test'
  },
  {
    id: 'check',
    command: 'npm run check'
  }
];

function splitShellCommand(command) {
  return process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', command]]
    : ['sh', ['-lc', command]];
}

export async function runHarnessEval({ json = false } = {}) {
  const evalId = timestampId();
  const evalDir = path.join(harnessRoot, '.harness', 'eval');
  await ensureDir(evalDir);
  const startedAt = new Date();
  const results = [];

  for (const entry of DEFAULT_EVAL_COMMANDS) {
    const [command, args] = splitShellCommand(entry.command);
    const result = await runCapture(command, args, {
      cwd: harnessRoot
    });
    results.push({
      id: entry.id,
      command: entry.command,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }

  const finishedAt = new Date();
  const report = {
    evalId,
    status: results.every((entry) => entry.status === 'passed') ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    results
  };
  const reportPath = path.join(evalDir, `${evalId}.json`);
  await writeText(reportPath, JSON.stringify(report, null, 2) + '\n');

  if (json) {
    return JSON.stringify({
      ...report,
      reportPath
    }, null, 2);
  }

  return [
    'Harness eval',
    `Status: ${report.status}`,
    `Report: ${reportPath}`,
    ...results.map((entry) => `- ${entry.id}: ${entry.status} (${entry.command})`)
  ].join('\n');
}
