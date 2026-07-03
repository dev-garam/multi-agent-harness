import path from 'node:path';
import { ensureDir, harnessRoot, timestampId, writeText } from './fs-utils.js';
import { memoryFreshness, readRunManifests } from './hermes-memory.js';
import { summarizeQueue } from './hermes-queue.js';

function reportRoot() {
  return path.join(harnessRoot, '.harness', 'reports');
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeValidationFailures(manifests) {
  const failures = [];
  for (const manifest of manifests) {
    for (const step of manifest.steps || []) {
      if (step.type === 'validation' && step.status === 'failed') {
        failures.push({
          runId: manifest.runId,
          stepId: step.stepId,
          command: step.command,
          exitCode: step.exitCode
        });
      }
    }
  }
  return failures;
}

export function buildHermesStatus(manifests) {
  const statuses = countBy(manifests.map((manifest) => manifest.status || 'running'));
  const actions = countBy(manifests.flatMap((manifest) => {
    return (manifest.supervisorDecisions || []).map((decision) => decision.nextAction);
  }));
  const validationFailures = summarizeValidationFailures(manifests).slice(0, 5);
  const recent = manifests.slice(0, 5).map((manifest) => ({
    runId: manifest.runId,
    pipeline: manifest.pipeline,
    completedPipeline: manifest.completedPipeline || manifest.pipeline,
    status: manifest.status || 'running',
    repo: manifest.repo
  }));
  const latestCleanup = manifests.find((manifest) => manifest.cleanup)?.cleanup || null;

  return {
    totalRuns: manifests.length,
    statuses,
    hermesActions: actions,
    validationFailures,
    latestCleanup,
    recent
  };
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key}: ${value}`).join(', ');
}

function markdownTable(rows, columns) {
  if (rows.length === 0) {
    return '_none_';
  }

  const header = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    return `| ${columns.map((column) => String(row[column.key] ?? '').replaceAll('\n', ' ')).join(' | ')} |`;
  });
  return [header, divider, ...body].join('\n');
}

export function formatHermesStatus(status) {
  const lines = [
    'Hermes status',
    `Runs: ${status.totalRuns} recent`,
    `Run statuses: ${formatCounts(status.statuses)}`,
    `Hermes actions: ${formatCounts(status.hermesActions)}`
  ];

  if (status.validationFailures.length > 0) {
    lines.push('Recent validation failures:');
    for (const failure of status.validationFailures) {
      lines.push(`- ${failure.runId} ${failure.stepId} exit=${failure.exitCode} command=${failure.command}`);
    }
  } else {
    lines.push('Recent validation failures: none');
  }

  if (status.latestCleanup) {
    lines.push(`Cleanup: ${status.latestCleanup.status}${status.latestCleanup.reason ? ` (${status.latestCleanup.reason})` : ''}`);
  } else {
    lines.push('Cleanup: no cleanup record found');
  }

  if (status.recent.length > 0) {
    lines.push('Recent runs:');
    for (const run of status.recent) {
      lines.push(`- ${run.runId} ${run.status} ${run.pipeline}->${run.completedPipeline}`);
    }
  }

  if (status.memory) {
    lines.push(`Memory: ${status.memory.available ? `${status.memory.totalRuns} indexed runs` : 'not built'}${status.memory.latestRunId ? `, latest=${status.memory.latestRunId}` : ''}`);
  }

  return lines.join('\n');
}

async function writeHermesMarkdownReport({ kind, title, summary, data }) {
  await ensureDir(reportRoot());
  const reportPath = path.join(reportRoot(), `${timestampId()}-${kind}.md`);
  const lines = [
    `# ${title}`,
    '',
    `- Created at: ${new Date().toISOString()}`,
    `- Kind: ${kind}`,
    '',
    '## Summary',
    '',
    ...summary,
    '',
    '## Data',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    ''
  ];
  await writeText(reportPath, lines.join('\n'));
  return reportPath;
}

export async function createHermesReport({ kind = 'status', tickResult = null } = {}) {
  const manifests = await readRunManifests({ limit: 20 });
  const status = buildHermesStatus(manifests);
  status.memory = await memoryFreshness();
  const queue = await summarizeQueue();

  const queueRows = ['pending', 'running', 'done', 'failed'].map((queueStatus) => ({
    status: queueStatus,
    count: queue[queueStatus].length
  }));
  const recentRows = status.recent.map((run) => ({
    runId: run.runId,
    status: run.status,
    pipeline: `${run.pipeline}->${run.completedPipeline}`
  }));

  const summary = [
    `Runs: ${status.totalRuns} recent`,
    `Run statuses: ${formatCounts(status.statuses)}`,
    `Hermes actions: ${formatCounts(status.hermesActions)}`,
    `Memory: ${status.memory.available ? `${status.memory.totalRuns} indexed runs` : 'not built'}`,
    '',
    '### Queue',
    '',
    markdownTable(queueRows, [
      { key: 'status', label: 'Status' },
      { key: 'count', label: 'Count' }
    ]),
    '',
    '### Recent Runs',
    '',
    markdownTable(recentRows, [
      { key: 'runId', label: 'Run' },
      { key: 'status', label: 'Status' },
      { key: 'pipeline', label: 'Pipeline' }
    ])
  ];

  if (tickResult) {
    summary.splice(0, 0, `Tick result: ${tickResult.status}`);
  }

  const reportPath = await writeHermesMarkdownReport({
    kind,
    title: kind === 'tick' ? 'Hermes Tick Report' : 'Hermes Operations Report',
    summary,
    data: {
      status,
      queueCounts: Object.fromEntries(queueRows.map((row) => [row.status, row.count])),
      tickResult
    }
  });

  return {
    kind,
    reportPath,
    status,
    queueCounts: Object.fromEntries(queueRows.map((row) => [row.status, row.count])),
    tickResult
  };
}

export function formatHermesReport(result) {
  return [
    'Hermes report',
    `Kind: ${result.kind}`,
    `Path: ${result.reportPath}`,
    `Runs: ${result.status.totalRuns}`,
    `Queue: ${formatCounts(result.queueCounts)}`
  ].join('\n');
}
