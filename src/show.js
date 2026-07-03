import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { harnessRoot } from './fs-utils.js';

const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}(?:_\d{3})?$/;

function runsRoot() {
  return path.join(harnessRoot, 'runs');
}

async function listRunIds() {
  let entries = [];
  try {
    entries = await readdir(runsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function resolveRunId(runId) {
  if (runId && runId !== '--latest') {
    return runId;
  }

  const runIds = await listRunIds();
  const latest = runIds.at(-1);
  if (!latest) {
    throw new Error('No harness runs found.');
  }
  return latest;
}

async function readManifest(runId) {
  const manifestPath = path.join(runsRoot(), runId, 'manifest.json');
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Run manifest not found: ${manifestPath}`);
  }
}

function stepSummary(step) {
  return {
    type: step.type || 'step',
    id: step.id || null,
    stepId: step.stepId || step.id || '(unknown)',
    status: step.status || '(unknown)',
    agent: step.agent || null,
    command: step.command || null,
    exitCode: step.exitCode ?? null,
    durationMs: step.durationMs ?? null,
    timedOut: step.timedOut === true,
    finalPath: step.finalPath || null,
    reason: step.reason || null
  };
}

function validationFailures(steps) {
  return steps
    .filter((step) => step.type === 'validation' && step.status === 'failed')
    .map((step) => ({
      stepId: step.stepId,
      id: step.id || null,
      command: step.command || null,
      exitCode: step.exitCode ?? null,
      timedOut: step.timedOut === true
    }));
}

function agentUsageSummary(steps) {
  const usageEntries = steps
    .filter((step) => step.type === 'agent' && step.usage)
    .map((step) => ({
      stepId: step.stepId,
      provider: step.usage.provider || step.agent || null,
      adapter: step.usage.adapter || null,
      status: step.usage.status || 'unknown',
      inputTokens: step.usage.inputTokens ?? null,
      outputTokens: step.usage.outputTokens ?? null,
      totalTokens: step.usage.totalTokens ?? null,
      costUsd: step.usage.costUsd ?? null
    }));
  return {
    parsed: usageEntries.filter((entry) => entry.status === 'parsed').length,
    unknown: usageEntries.filter((entry) => entry.status !== 'parsed').length,
    totalTokens: usageEntries.reduce((total, entry) => total + (entry.totalTokens || 0), 0),
    costUsd: usageEntries.reduce((total, entry) => total + (entry.costUsd || 0), 0),
    entries: usageEntries
  };
}

function retrySummary(manifest) {
  const events = manifest.middleware?.events || [];
  return {
    retries: manifest.middleware?.state?.counters?.retries ?? 0,
    fallbacks: manifest.middleware?.state?.counters?.fallbacks ?? 0,
    events: events
      .filter((event) => event.type?.startsWith('retry:') || event.type?.startsWith('fallback:'))
      .map((event) => ({
        type: event.type,
        detail: event.detail,
        createdAt: event.createdAt
      }))
  };
}

function redactionSummary(manifest) {
  return {
    redactions: manifest.middleware?.state?.counters?.redactions ?? 0,
    contextTruncations: manifest.middleware?.state?.counters?.contextTruncations ?? 0
  };
}

function latestReporterPath(manifest) {
  const reporterStep = [...(manifest.steps || [])].reverse()
    .find((step) => step.type === 'agent' && step.stepId === 'reporter' && step.finalPath);
  return reporterStep?.finalPath || null;
}

function existingPath(filePath) {
  return filePath && existsSync(filePath) ? filePath : null;
}

export function summarizeRunManifest(manifest) {
  const steps = (manifest.steps || []).map(stepSummary);
  const reporterPath = latestReporterPath(manifest);
  return {
    runId: manifest.runId,
    status: manifest.status || 'running',
    repo: manifest.repo,
    executionRepo: manifest.executionRepo || manifest.workspace?.executionRepo || manifest.repo,
    request: manifest.request,
    pipeline: manifest.pipeline,
    completedPipeline: manifest.completedPipeline || manifest.pipeline,
    agent: manifest.agent?.provider || manifest.agent?.name || null,
    startedAt: manifest.startedAt || null,
    finishedAt: manifest.finishedAt || null,
    workspace: {
      mode: manifest.workspace?.mode || 'direct',
      isolated: manifest.workspace?.isolated === true,
      patchPath: existingPath(manifest.workspace?.patchPath),
      worktreePath: manifest.workspace?.worktreePath || null,
      worktreeRemoved: manifest.workspace?.worktreeRemoved ?? null
    },
    policy: {
      allowed: manifest.policy?.decision?.allowed ?? null,
      requiresApproval: manifest.policy?.decision?.requiresApproval ?? null,
      reason: manifest.policy?.decision?.reason || null,
      approved: manifest.policy?.decision?.approved === true || manifest.policy?.approved === true,
      protectedBranch: manifest.policy?.protectedBranch || null
    },
    runtime: {
      mode: manifest.runtime?.mode || null,
      contract: manifest.runtime?.contract || null
    },
    middleware: {
      retry: retrySummary(manifest),
      redaction: redactionSummary(manifest)
    },
    usage: agentUsageSummary(manifest.steps || []),
    promptCache: manifest.promptCache
      ? {
          path: existingPath(manifest.promptCache.path),
          strategy: manifest.promptCache.strategy || null,
          cacheKey: manifest.promptCache.cacheKey || null,
          templates: manifest.promptCache.templates?.length || 0
        }
      : null,
    steps,
    validationFailures: validationFailures(manifest.steps || []),
    supervisorDecisions: (manifest.supervisorDecisions || []).map((decision) => ({
      turn: decision.turn,
      stepId: decision.stepId,
      status: decision.status,
      nextAction: decision.nextAction,
      targetStep: decision.targetStep,
      reason: decision.reason
    })),
    reporterSummary: manifest.reporterSummary || null,
    artifacts: {
      runDir: path.join(runsRoot(), manifest.runId),
      manifestPath: path.join(runsRoot(), manifest.runId, 'manifest.json'),
      reporterPath: existingPath(reporterPath),
      patchPath: existingPath(manifest.workspace?.patchPath)
    }
  };
}

function formatNullable(value) {
  return value === null || value === undefined || value === '' ? '(none)' : String(value);
}

export function formatRunSummary(summary) {
  const lines = [
    'Harness run',
    `Run: ${summary.runId}`,
    `Status: ${summary.status}`,
    `Repo: ${summary.repo}`,
    `Execution repo: ${summary.executionRepo}`,
    `Pipeline: ${summary.pipeline}->${summary.completedPipeline}`,
    `Agent: ${formatNullable(summary.agent)}`,
    `Request: ${formatNullable(summary.request)}`,
    `Started: ${formatNullable(summary.startedAt)}`,
    `Finished: ${formatNullable(summary.finishedAt)}`,
    '',
    'Workspace',
    `Mode: ${summary.workspace.mode}${summary.workspace.isolated ? ' (isolated)' : ''}`,
    `Patch: ${formatNullable(summary.workspace.patchPath)}`,
    `Worktree removed: ${formatNullable(summary.workspace.worktreeRemoved)}`,
    '',
    'Policy',
    `Allowed: ${formatNullable(summary.policy.allowed)}`,
    `Requires approval: ${formatNullable(summary.policy.requiresApproval)}`,
    `Approved: ${summary.policy.approved}`,
    `Reason: ${formatNullable(summary.policy.reason)}`,
    `Protected branch blocked: ${formatNullable(summary.policy.protectedBranch?.writeBlocked)}`,
    '',
    'Runtime',
    `Mode: ${formatNullable(summary.runtime.mode)}`,
    `Isolation: ${formatNullable(summary.runtime.contract?.processIsolation)}`,
    `Env policy: ${formatNullable(summary.runtime.contract?.envPolicy)}`,
    '',
    'Middleware',
    `Retries: ${summary.middleware.retry.retries}`,
    `Fallbacks: ${summary.middleware.retry.fallbacks}`,
    `Redactions: ${summary.middleware.redaction.redactions}`,
    `Context truncations: ${summary.middleware.redaction.contextTruncations}`,
    '',
    'Usage',
    `Parsed entries: ${summary.usage.parsed}`,
    `Unknown entries: ${summary.usage.unknown}`,
    `Total tokens: ${summary.usage.totalTokens}`,
    `Cost USD: ${summary.usage.costUsd}`,
    '',
    'Prompt Cache',
    `Path: ${formatNullable(summary.promptCache?.path)}`,
    `Strategy: ${formatNullable(summary.promptCache?.strategy)}`,
    `Templates: ${formatNullable(summary.promptCache?.templates)}`,
    '',
    'Steps'
  ];

  for (const step of summary.steps) {
    const details = [
      step.agent ? `agent=${step.agent}` : null,
      step.id ? `id=${step.id}` : null,
      step.exitCode !== null ? `exit=${step.exitCode}` : null,
      step.timedOut ? 'timedOut=true' : null,
      step.reason ? `reason=${step.reason}` : null
    ].filter(Boolean).join(' ');
    lines.push(`- ${step.stepId} [${step.type}] ${step.status}${details ? ` (${details})` : ''}`);
  }

  lines.push('', 'Validation');
  if (summary.validationFailures.length === 0) {
    lines.push('Failures: none');
  } else {
    for (const failure of summary.validationFailures) {
      lines.push(`- ${failure.stepId} exit=${failure.exitCode} command=${formatNullable(failure.command)}`);
    }
  }

  if (summary.supervisorDecisions.length > 0) {
    lines.push('', 'Hermes Decisions');
    for (const decision of summary.supervisorDecisions) {
      lines.push(`- turn ${decision.turn}: ${decision.nextAction} (${decision.status}) reason=${formatNullable(decision.reason)}`);
    }
  }

  if (summary.reporterSummary) {
    lines.push('', 'Reporter');
    lines.push(`Status: ${summary.reporterSummary.status}`);
    if (summary.reporterSummary.summary) {
      lines.push(`Summary: ${summary.reporterSummary.summary}`);
    }
    if ((summary.reporterSummary.schemaErrors || []).length > 0) {
      lines.push(`Schema errors: ${summary.reporterSummary.schemaErrors.join('; ')}`);
    }
  }

  lines.push('', 'Artifacts');
  lines.push(`Run dir: ${summary.artifacts.runDir}`);
  lines.push(`Manifest: ${summary.artifacts.manifestPath}`);
  lines.push(`Reporter: ${formatNullable(summary.artifacts.reporterPath)}`);
  lines.push(`Patch: ${formatNullable(summary.artifacts.patchPath)}`);

  return lines.join('\n');
}

export async function showRun({ runId, json = false } = {}) {
  const resolvedRunId = await resolveRunId(runId);
  const manifest = await readManifest(resolvedRunId);
  const summary = summarizeRunManifest(manifest);
  return json ? JSON.stringify(summary, null, 2) : formatRunSummary(summary);
}
