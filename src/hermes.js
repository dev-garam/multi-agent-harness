import { spawn } from 'node:child_process';
import { rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, harnessRoot, timestampId, writeText } from './fs-utils.js';
import { formatNotificationSummary, notifyHermesEvent } from './notify.js';

const RISK_KEYWORDS = [
  'auth',
  'authentication',
  'authorization',
  'payment',
  'billing',
  'security',
  'migration',
  'delete',
  'destructive',
  'database',
  'credential',
  'token',
  '인증',
  '인가',
  '결제',
  '보안',
  '마이그레이션',
  '삭제',
  '데이터베이스'
];

const DESTRUCTIVE_KEYWORDS = [
  'delete',
  'drop',
  'remove all',
  'truncate',
  'destroy',
  'wipe',
  '삭제',
  '드롭',
  '전체 삭제',
  '파기'
];

const REVIEW_KEYWORDS = [
  'review',
  '리뷰',
  '검토',
  '읽기 전용',
  'read-only'
];

const SMALL_FIX_KEYWORDS = [
  'typo',
  '오타',
  '문구',
  'readme',
  '작게',
  '간단',
  'small'
];

function parseRunTimestamp(name) {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{6})(?:_(?<ms>\d{3}))?$/.exec(name);
  if (!match) {
    return null;
  }

  const time = match.groups.time;
  const ms = match.groups.ms || '000';
  return new Date(`${match.groups.date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${ms}`);
}

function queueRoot() {
  return path.join(harnessRoot, '.harness', 'queue');
}

function memoryRoot() {
  return path.join(harnessRoot, '.harness', 'memory');
}

function memoryRunsPath() {
  return path.join(memoryRoot(), 'runs.jsonl');
}

function memoryReposPath() {
  return path.join(memoryRoot(), 'repos.json');
}

function feedbackRoot() {
  return path.join(harnessRoot, '.harness', 'feedback');
}

function promotionRoot() {
  return path.join(harnessRoot, '.harness', 'promotions');
}

function reportRoot() {
  return path.join(harnessRoot, '.harness', 'reports');
}

function queueDir(status) {
  return path.join(queueRoot(), status);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await writeText(filePath, JSON.stringify(value, null, 2) + '\n');
}

async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writeJsonl(filePath, records) {
  await writeText(filePath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
}

async function ensureQueueDirs() {
  await Promise.all([
    ensureDir(queueDir('pending')),
    ensureDir(queueDir('running')),
    ensureDir(queueDir('done')),
    ensureDir(queueDir('failed'))
  ]);
}

function taskPath(status, taskId) {
  return path.join(queueDir(status), `${taskId}.json`);
}

async function listTasks(status) {
  await ensureQueueDirs();
  const entries = await readdir(queueDir(status), { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const task = await readJson(path.join(queueDir(status), entry.name));
    if (task) {
      tasks.push(task);
    }
  }
  return tasks.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function parseRunId(output) {
  const match = String(output).match(/Harness run: ([^\n]+)/);
  return match ? match[1].trim() : null;
}

function classifyRequestRisk(request) {
  const normalized = String(request || '').toLowerCase();
  const riskKeywords = RISK_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  const destructiveKeywords = DESTRUCTIVE_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  return {
    riskKeywords,
    destructiveKeywords,
    highRisk: riskKeywords.length > 0 || destructiveKeywords.length > 0,
    destructive: destructiveKeywords.length > 0
  };
}

export function defaultPolicy() {
  return {
    allowAutonomousRun: true,
    allowEdits: true,
    allowDestructiveCommands: false,
    protectedBranches: ['main', 'production'],
    requireApprovalFor: ['auth', 'payment', 'data deletion', 'database migration']
  };
}

export function evaluatePolicy({ request, policy = defaultPolicy() }) {
  const risk = classifyRequestRisk(request);
  const requiresApproval = !policy.allowAutonomousRun ||
    (risk.destructive && !policy.allowDestructiveCommands) ||
    risk.riskKeywords.some((keyword) => {
      return (policy.requireApprovalFor || []).some((entry) => keyword.toLowerCase().includes(String(entry).toLowerCase()) || String(entry).toLowerCase().includes(keyword.toLowerCase()));
    });

  return {
    allowed: !requiresApproval,
    requiresApproval,
    risk,
    reason: requiresApproval
      ? 'Policy requires human approval for this request.'
      : 'Policy allows autonomous execution.'
  };
}

async function runCapture(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', resolve);
  });

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

async function currentGitBranch(repo) {
  const result = await runCapture('git', ['branch', '--show-current'], { cwd: repo });
  if (result.exitCode !== 0 || !result.stdout) {
    return {
      available: false,
      branch: null,
      reason: result.stderr || 'current git branch unavailable'
    };
  }

  return {
    available: true,
    branch: result.stdout,
    reason: null
  };
}

function protectedBranchesFromConfig(config = {}, policy = defaultPolicy()) {
  const candidates = [
    config.protectedBranches,
    config.policy?.protectedBranches,
    config.hermes?.policy?.protectedBranches,
    policy.protectedBranches
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length > 0) {
      return value.map((branch) => String(branch));
    }
  }
  return [];
}

async function evaluateProtectedBranchPolicy(repo, policy = defaultPolicy()) {
  const projectConfig = await readProjectHarnessConfig(repo);
  const protectedBranches = protectedBranchesFromConfig(projectConfig.value, policy);
  const git = await currentGitBranch(repo);
  const protectedBranch = git.available && protectedBranches.includes(git.branch);

  return {
    allowed: !protectedBranch,
    requiresApproval: protectedBranch,
    reason: protectedBranch
      ? `Policy requires human approval on protected branch: ${git.branch}.`
      : 'Protected branch policy allows autonomous execution.',
    branch: git.branch,
    gitAvailable: git.available,
    gitReason: git.reason,
    protectedBranches
  };
}

async function feedbackPath(runId) {
  await ensureDir(feedbackRoot());
  return path.join(feedbackRoot(), `${runId}.json`);
}

export async function writeFeedback({ runId, rating, note }) {
  if (!runId) {
    throw new Error('Missing --run for `harness hermes feedback`.');
  }
  if (!rating) {
    throw new Error('Missing --rating for `harness hermes feedback`.');
  }

  const feedback = {
    schemaVersion: 1,
    runId,
    rating,
    note: note || '',
    createdAt: new Date().toISOString()
  };
  await writeJson(await feedbackPath(runId), feedback);
  return feedback;
}

async function readFeedbackMap() {
  await ensureDir(feedbackRoot());
  const entries = await readdir(feedbackRoot(), { withFileTypes: true });
  const feedback = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const record = await readJson(path.join(feedbackRoot(), entry.name));
    if (record?.runId) {
      feedback[record.runId] = record;
    }
  }
  return feedback;
}

export async function readRunManifests({ limit = 20 } = {}) {
  const runsDir = path.join(harnessRoot, 'runs');
  let entries = [];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runIds = entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.trash')
    .map((entry) => ({ runId: entry.name, timestamp: parseRunTimestamp(entry.name) }))
    .filter((entry) => entry.timestamp)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, limit === null ? undefined : Number(limit) || 20);

  const manifests = [];
  for (const entry of runIds) {
    const manifest = await readJson(path.join(runsDir, entry.runId, 'manifest.json'));
    if (manifest) {
      manifests.push(manifest);
    }
  }

  return manifests;
}

function validationFailuresFromManifest(manifest) {
  return (manifest.steps || [])
    .filter((step) => step.type === 'validation' && step.status === 'failed')
    .map((step) => ({
      stepId: step.stepId,
      id: step.id,
      command: step.command,
      exitCode: step.exitCode
    }));
}

function changedFilesFromGitSnapshot(snapshot) {
  if (!snapshot?.statusShort) {
    return [];
  }
  return String(snapshot.statusShort)
    .split('\n')
    .map((line) => line.trim().slice(3).trim())
    .filter(Boolean);
}

export function manifestToMemoryRecord(manifest, feedback = null) {
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    repo: manifest.repo,
    request: manifest.request,
    pipeline: manifest.pipeline,
    completedPipeline: manifest.completedPipeline || manifest.pipeline,
    status: manifest.status || 'running',
    validationFailures: validationFailuresFromManifest(manifest),
    supervisorActions: (manifest.supervisorDecisions || []).map((decision) => decision.nextAction),
    changedFiles: changedFilesFromGitSnapshot(manifest.gitAfter || manifest.git),
    feedback,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    createdAt: manifest.startedAt || manifest.finishedAt || null
  };
}

function buildRepoMemory(records) {
  const repos = {};
  for (const record of records) {
    const repo = record.repo || 'unknown';
    repos[repo] ||= {
      repo,
      totalRuns: 0,
      statuses: {},
      pipelines: {},
      supervisorActions: {},
      validationFailures: 0,
      lastRunId: null,
      lastRunAt: null
    };

    const summary = repos[repo];
    summary.totalRuns += 1;
    summary.statuses[record.status] = (summary.statuses[record.status] || 0) + 1;
    summary.pipelines[record.completedPipeline || record.pipeline || 'unknown'] =
      (summary.pipelines[record.completedPipeline || record.pipeline || 'unknown'] || 0) + 1;
    for (const action of record.supervisorActions || []) {
      summary.supervisorActions[action] = (summary.supervisorActions[action] || 0) + 1;
    }
    summary.validationFailures += (record.validationFailures || []).length;
    if (!summary.lastRunAt || String(record.createdAt || '').localeCompare(summary.lastRunAt) > 0) {
      summary.lastRunAt = record.createdAt;
      summary.lastRunId = record.runId;
    }
  }
  return repos;
}

export async function rebuildHermesMemory() {
  await ensureDir(memoryRoot());
  const manifests = await readRunManifests({ limit: null });
  const feedback = await readFeedbackMap();
  const records = manifests
    .map((manifest) => manifestToMemoryRecord(manifest, feedback[manifest.runId] || null))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const repos = buildRepoMemory(records);

  await writeJsonl(memoryRunsPath(), records);
  await writeJson(memoryReposPath(), {
    schemaVersion: 1,
    rebuiltAt: new Date().toISOString(),
    totalRuns: records.length,
    repos
  });

  return {
    records,
    repos
  };
}

export async function readHermesMemory() {
  return readJsonl(memoryRunsPath());
}

export function searchHermesMemoryRecords(records, query) {
  const normalized = String(query || '').toLowerCase();
  if (!normalized) {
    return records.slice(-10).reverse();
  }

  return records
    .filter((record) => {
      return [
        record.runId,
        record.repo,
        record.request,
        record.pipeline,
        record.completedPipeline,
        record.status,
        ...(record.supervisorActions || [])
      ].some((value) => String(value || '').toLowerCase().includes(normalized));
    })
    .slice(-10)
    .reverse();
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣_/-]+/u)
    .filter((token) => token.length >= 2);
}

function similarMemoryRecords(records, request, repo) {
  const queryTokens = new Set(tokenize(request));
  return records
    .filter((record) => !repo || record.repo === path.resolve(repo))
    .map((record) => {
      const recordTokens = new Set(tokenize(record.request));
      let score = 0;
      for (const token of queryTokens) {
        if (recordTokens.has(token)) {
          score += 1;
        }
      }
      if (record.completedPipeline === 'safe_fix') {
        score += 0.5;
      }
      if ((record.supervisorActions || []).includes('escalate_to_safe_fix')) {
        score += 1;
      }
      if ((record.validationFailures || []).length > 0) {
        score += 0.5;
      }
      if (record.feedback?.rating === 'bad') {
        score += 1;
      }
      if (record.feedback?.rating === 'good') {
        score += 0.25;
      }
      return { record, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((entry) => entry.record);
}

function repoProfileFromMemory(records, repo) {
  if (!repo) {
    return null;
  }

  const resolvedRepo = path.resolve(repo);
  const repoRecords = records.filter((record) => record.repo === resolvedRepo);
  if (repoRecords.length === 0) {
    return null;
  }

  return {
    repo: resolvedRepo,
    totalRuns: repoRecords.length,
    pipelineCounts: countBy(repoRecords.map((record) => record.completedPipeline || record.pipeline)),
    statusCounts: countBy(repoRecords.map((record) => record.status)),
    actionCounts: countBy(repoRecords.flatMap((record) => record.supervisorActions || [])),
    validationFailureCount: repoRecords.reduce((sum, record) => sum + (record.validationFailures || []).length, 0)
  };
}

async function memoryFreshness() {
  const records = await readHermesMemory();
  return {
    available: records.length > 0,
    totalRuns: records.length,
    latestRunId: records.at(-1)?.runId || null
  };
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

export function planHermesRequest(request, { agent = 'codex', repo = null, memoryRecords = [], policy = defaultPolicy() } = {}) {
  const normalized = String(request || '').toLowerCase();
  const hasRisk = RISK_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const isReview = REVIEW_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const isSmall = SMALL_FIX_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const similarRuns = similarMemoryRecords(memoryRecords, request, repo);
  const repoProfile = repoProfileFromMemory(memoryRecords, repo);
  const policyDecision = evaluatePolicy({ request, policy });

  let pipeline = 'code_fix';
  const reasons = [];
  const memoryEvidence = [];

  if (isReview) {
    pipeline = 'review_only';
    reasons.push('Request looks like a read-only review.');
  } else if (hasRisk) {
    pipeline = 'safe_fix';
    reasons.push('Request contains high-risk keywords and should include verifier coverage.');
  } else if (isSmall) {
    pipeline = 'quick_fix';
    reasons.push('Request looks small and focused.');
  } else {
    reasons.push('Default code change path is appropriate.');
  }

  if (!isReview && repoProfile) {
    if ((repoProfile.actionCounts.escalate_to_safe_fix || 0) > 0) {
      pipeline = 'safe_fix';
      reasons.push('Memory shows prior safe_fix escalation for this repo.');
      memoryEvidence.push({
        type: 'repo_profile',
        signal: 'escalate_to_safe_fix',
        count: repoProfile.actionCounts.escalate_to_safe_fix
      });
    }

    if (repoProfile.validationFailureCount > 0 && pipeline !== 'safe_fix') {
      pipeline = 'safe_fix';
      reasons.push('Memory shows validation failures for this repo; verifier coverage is recommended.');
      memoryEvidence.push({
        type: 'repo_profile',
        signal: 'validation_failures',
        count: repoProfile.validationFailureCount
      });
    }
  }

  for (const record of similarRuns.slice(0, 3)) {
    memoryEvidence.push({
      type: 'similar_run',
      runId: record.runId,
      pipeline: record.pipeline,
      completedPipeline: record.completedPipeline,
      status: record.status,
      supervisorActions: record.supervisorActions,
      feedback: record.feedback ? {
        rating: record.feedback.rating,
        note: record.feedback.note
      } : null
    });
  }

  if (!isReview && similarRuns.some((record) => record.completedPipeline === 'safe_fix' || (record.supervisorActions || []).includes('escalate_to_safe_fix'))) {
    pipeline = 'safe_fix';
    reasons.push('Similar memory records used safe_fix or escalated to safe_fix.');
  }

  const badFeedback = similarRuns.filter((record) => record.feedback?.rating === 'bad');
  if (badFeedback.length > 0) {
    reasons.push('Memory contains negative feedback for similar runs; use extra caution.');
    memoryEvidence.push({
      type: 'feedback',
      signal: 'bad_feedback',
      count: badFeedback.length
    });
  }

  return {
    pipeline,
    agent,
    requiresApproval: policyDecision.requiresApproval,
    validation: 'use project config',
    reason: reasons.join(' '),
    source: memoryEvidence.length > 0 ? 'memory-backed' : 'rule-based',
    memoryEvidence,
    policyDecision
  };
}

export function formatHermesPlan(plan) {
  const lines = [
    'Hermes plan',
    `Recommended pipeline: ${plan.pipeline}`,
    `Recommended agent: ${plan.agent}`,
    `Requires approval: ${plan.requiresApproval}`,
    `Validation: ${plan.validation}`,
    `Reason: ${plan.reason}`,
    `Source: ${plan.source}`
  ];

  if (plan.policyDecision) {
    lines.push(`Policy: ${plan.policyDecision.allowed ? 'allowed' : 'requires_approval'} (${plan.policyDecision.reason})`);
  }

  if ((plan.memoryEvidence || []).length > 0) {
    lines.push('Memory evidence:');
    for (const evidence of plan.memoryEvidence) {
      if (evidence.type === 'similar_run') {
        const feedback = evidence.feedback ? ` feedback=${evidence.feedback.rating}` : '';
        lines.push(`- similar run ${evidence.runId}: ${evidence.pipeline}->${evidence.completedPipeline} ${evidence.status}${feedback}`);
      } else {
        lines.push(`- ${evidence.signal}: ${evidence.count}`);
      }
    }
  }

  lines.push('', 'Decision JSON:', JSON.stringify(plan, null, 2));
  return lines.join('\n');
}

function taskSummary(task) {
  return `${task.taskId} ${task.status} ${task.pipeline} repo=${task.repo} request="${task.request}"`;
}

export async function enqueueHermesTask({ repo, request, pipeline, agent }) {
  if (!repo) {
    throw new Error('Missing --repo for `harness hermes enqueue`.');
  }
  if (!request) {
    throw new Error('Missing request for `harness hermes enqueue`.');
  }

  await ensureQueueDirs();
  const plan = pipeline ? { pipeline, agent: agent || 'codex' } : planHermesRequest(request, { agent: agent || 'codex' });
  const policyDecision = evaluatePolicy({ request });
  const taskId = timestampId();
  const task = {
    schemaVersion: 1,
    taskId,
    repo: path.resolve(repo),
    request,
    pipeline: plan.pipeline,
    agent: plan.agent || agent || 'codex',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    policy: {
      allowEdits: true,
      allowNetwork: false,
      requireHumanApproval: policyDecision.requiresApproval,
      decision: policyDecision
    },
    plan
  };

  await writeJson(taskPath('pending', taskId), task);
  return task;
}

export async function summarizeQueue() {
  const statuses = ['pending', 'running', 'done', 'failed'];
  const groups = {};
  for (const status of statuses) {
    groups[status] = await listTasks(status);
  }
  return groups;
}

export function formatQueueSummary(groups) {
  const lines = ['Hermes queue'];
  for (const status of ['pending', 'running', 'done', 'failed']) {
    lines.push(`${status}: ${groups[status].length}`);
    for (const task of groups[status].slice(0, 5)) {
      lines.push(`- ${taskSummary(task)}`);
    }
  }
  return lines.join('\n');
}

export function formatMemoryRebuild(result) {
  return [
    'Hermes memory rebuild',
    `Indexed runs: ${result.records.length}`,
    `Repos: ${Object.keys(result.repos).length}`,
    `Path: ${memoryRunsPath()}`
  ].join('\n');
}

export function formatMemorySearch(records, query) {
  const lines = [
    'Hermes memory search',
    `Query: ${query || '(latest)'}`,
    `Matches: ${records.length}`
  ];

  for (const record of records) {
    lines.push(`- ${record.runId} ${record.status} ${record.pipeline}->${record.completedPipeline} repo=${record.repo}`);
    lines.push(`  request="${record.request || ''}"`);
    if ((record.supervisorActions || []).length > 0) {
      lines.push(`  actions=${record.supervisorActions.join(',')}`);
    }
    if ((record.validationFailures || []).length > 0) {
      lines.push(`  validationFailures=${record.validationFailures.length}`);
    }
    if (record.feedback) {
      lines.push(`  feedback=${record.feedback.rating} note="${record.feedback.note || ''}"`);
    }
  }

  return lines.join('\n');
}

function validationFailureCounts(records) {
  const counts = {};
  for (const record of records) {
    for (const failure of record.validationFailures || []) {
      const command = failure.command || failure.id || failure.stepId || 'unknown';
      counts[command] ||= {
        command,
        count: 0,
        runIds: []
      };
      counts[command].count += 1;
      counts[command].runIds.push(record.runId);
    }
  }
  return Object.values(counts).sort((left, right) => right.count - left.count);
}

function repoPatternCounts(records) {
  const repos = {};
  for (const record of records) {
    const repo = record.repo || 'unknown';
    repos[repo] ||= {
      repo,
      totalRuns: 0,
      safeFixRuns: 0,
      escalations: 0,
      badFeedback: 0,
      runIds: []
    };
    const summary = repos[repo];
    summary.totalRuns += 1;
    summary.runIds.push(record.runId);
    if ((record.completedPipeline || record.pipeline) === 'safe_fix') {
      summary.safeFixRuns += 1;
    }
    if ((record.supervisorActions || []).includes('escalate_to_safe_fix')) {
      summary.escalations += 1;
    }
    if (record.feedback?.rating === 'bad') {
      summary.badFeedback += 1;
    }
  }
  return Object.values(repos).sort((left, right) => {
    return (right.escalations + right.safeFixRuns + right.badFeedback) - (left.escalations + left.safeFixRuns + left.badFeedback);
  });
}

function buildPromotionProposals(records) {
  const createdAt = new Date().toISOString();
  const proposals = [];

  for (const repo of repoPatternCounts(records)) {
    if (repo.escalations >= 2 || repo.safeFixRuns >= 2) {
      proposals.push({
        schemaVersion: 1,
        proposalId: `${timestampId()}-routing-${proposals.length + 1}`,
        type: 'routing_policy',
        title: 'Prefer safe_fix for a repo with repeated risk signals',
        reason: `Repo has ${repo.safeFixRuns} safe_fix run(s) and ${repo.escalations} safe_fix escalation(s).`,
        target: 'policy',
        action: 'review_route_to_safe_fix',
        status: 'proposed',
        createdAt,
        evidence: {
          repo: repo.repo,
          runIds: repo.runIds.slice(-5),
          safeFixRuns: repo.safeFixRuns,
          escalations: repo.escalations
        }
      });
    }

    if (repo.badFeedback > 0) {
      proposals.push({
        schemaVersion: 1,
        proposalId: `${timestampId()}-feedback-${proposals.length + 1}`,
        type: 'feedback_review',
        title: 'Review recurring bad feedback before autonomous execution',
        reason: `Repo has ${repo.badFeedback} run(s) with bad feedback.`,
        target: 'policy',
        action: 'require_review_for_similar_requests',
        status: 'proposed',
        createdAt,
        evidence: {
          repo: repo.repo,
          runIds: repo.runIds.slice(-5),
          badFeedback: repo.badFeedback
        }
      });
    }
  }

  for (const failure of validationFailureCounts(records).filter((entry) => entry.count >= 2).slice(0, 5)) {
    proposals.push({
      schemaVersion: 1,
      proposalId: `${timestampId()}-validation-${proposals.length + 1}`,
      type: 'validation_policy',
      title: 'Promote recurring validation failure into project validation review',
      reason: `Validation command failed ${failure.count} time(s): ${failure.command}`,
      target: '.harness.json',
      action: 'review_validation_command',
      status: 'proposed',
      createdAt,
      evidence: {
        command: failure.command,
        runIds: failure.runIds.slice(-5),
        failureCount: failure.count
      }
    });
  }

  return proposals;
}

function promotionPatchPayload(proposal) {
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    type: proposal.type,
    title: proposal.title,
    reason: proposal.reason,
    target: proposal.target,
    action: proposal.action,
    evidence: proposal.evidence,
    reviewStatus: 'pending',
    createdAt: proposal.createdAt
  };
}

function patchFileName(proposal) {
  return `.harness.promotions/${proposal.proposalId}.json`;
}

function jsonNewFilePatch(fileName, value) {
  const json = JSON.stringify(value, null, 2) + '\n';
  const lines = [
    `diff --git a/${fileName} b/${fileName}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${fileName}`,
    `@@ -0,0 +1,${json.split('\n').length - 1} @@`,
    ...json.split('\n').filter((line, index, array) => index < array.length - 1).map((line) => `+${line}`)
  ];
  return lines.join('\n') + '\n';
}

function jsonReplaceFilePatch(fileName, beforeValue, afterValue) {
  return textReplaceFilePatch(
    fileName,
    JSON.stringify(beforeValue, null, 2) + '\n',
    JSON.stringify(afterValue, null, 2) + '\n'
  );
}

function patchLines(text) {
  const hasFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasFinalNewline) {
    lines.pop();
  }
  return {
    lines,
    hasFinalNewline
  };
}

function textReplaceFilePatch(fileName, beforeText, afterText) {
  const before = patchLines(beforeText);
  const after = patchLines(afterText);
  const body = [];
  for (const line of before.lines) {
    body.push(`-${line}`);
  }
  if (!before.hasFinalNewline) {
    body.push('\\ No newline at end of file');
  }
  for (const line of after.lines) {
    body.push(`+${line}`);
  }
  if (!after.hasFinalNewline) {
    body.push('\\ No newline at end of file');
  }
  return [
    `diff --git a/${fileName} b/${fileName}`,
    `--- a/${fileName}`,
    `+++ b/${fileName}`,
    `@@ -1,${before.lines.length} +1,${after.lines.length} @@`,
    ...body
  ].join('\n') + '\n';
}

async function readProjectHarnessConfig(repo) {
  const configPath = path.join(repo, '.harness.json');
  try {
    const rawText = await readFile(configPath, 'utf8');
    return {
      exists: true,
      rawText,
      value: JSON.parse(rawText)
    };
  } catch {
    return {
      exists: false,
      rawText: '',
      value: {}
    };
  }
}

function promotionConfigHint(proposal) {
  return {
    proposalId: proposal.proposalId,
    type: proposal.type,
    action: proposal.action,
    reason: proposal.reason,
    evidence: proposal.evidence,
    status: 'pending_review',
    createdAt: proposal.createdAt
  };
}

function configWithPromotionHint(config, proposal) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.hermes ||= {};
  next.hermes.promotions = Array.isArray(next.hermes.promotions) ? next.hermes.promotions : [];
  if (!next.hermes.promotions.some((entry) => entry.proposalId === proposal.proposalId)) {
    next.hermes.promotions.push(promotionConfigHint(proposal));
  }

  if (proposal.type === 'validation_policy' && proposal.evidence?.command) {
    next.hermes.suggestedValidationCommands = Array.isArray(next.hermes.suggestedValidationCommands)
      ? next.hermes.suggestedValidationCommands
      : [];
    if (!next.hermes.suggestedValidationCommands.some((entry) => entry.command === proposal.evidence.command)) {
      next.hermes.suggestedValidationCommands.push({
        command: proposal.evidence.command,
        reason: proposal.reason,
        proposalId: proposal.proposalId
      });
    }
  }

  if (proposal.type === 'routing_policy') {
    next.hermes.routingHints = Array.isArray(next.hermes.routingHints) ? next.hermes.routingHints : [];
    next.hermes.routingHints.push({
      pipeline: 'safe_fix',
      reason: proposal.reason,
      proposalId: proposal.proposalId
    });
  }

  if (proposal.type === 'feedback_review') {
    next.hermes.reviewHints = Array.isArray(next.hermes.reviewHints) ? next.hermes.reviewHints : [];
    next.hermes.reviewHints.push({
      reason: proposal.reason,
      proposalId: proposal.proposalId
    });
  }

  return next;
}

async function harnessConfigPatch(repo, proposal) {
  const current = await readProjectHarnessConfig(repo);
  const next = configWithPromotionHint(current.value, proposal);
  if (current.exists) {
    return textReplaceFilePatch('.harness.json', current.rawText, JSON.stringify(next, null, 2) + '\n');
  }
  return jsonNewFilePatch('.harness.json', next);
}

async function writePromotionPatchArtifacts(proposals) {
  await ensureDir(promotionRoot());
  const artifacts = [];
  for (const proposal of proposals) {
    const repo = proposal.evidence?.repo || harnessRoot;
    const fileName = patchFileName(proposal);
    const patchPath = path.join(promotionRoot(), `${proposal.proposalId}.patch`);
    const patch = [
      jsonNewFilePatch(fileName, promotionPatchPayload(proposal)),
      await harnessConfigPatch(repo, proposal)
    ].join('\n');
    await writeText(patchPath, patch);
    artifacts.push({
      proposalId: proposal.proposalId,
      repo,
      targetFiles: [fileName, '.harness.json'],
      patchPath
    });
  }
  return artifacts;
}

export async function promoteHermesPatterns({ apply = false } = {}) {
  let records = await readHermesMemory();
  let source = 'memory';
  if (records.length === 0) {
    const rebuilt = await rebuildHermesMemory();
    records = rebuilt.records;
    source = 'rebuilt-memory';
  }

  const proposals = buildPromotionProposals(records);
  const result = {
    schemaVersion: 1,
    mode: apply ? 'apply' : 'dry-run',
    source,
    createdAt: new Date().toISOString(),
    proposalCount: proposals.length,
    proposals: proposals.map((proposal) => ({
      ...proposal,
      status: apply ? 'recorded' : 'proposed'
    })),
    note: apply
      ? 'Safe apply records promotion proposals under .harness/promotions. Project config and prompts are not modified automatically.'
      : 'Dry-run only. Use --apply to record safe promotion proposals.'
  };

  if (apply) {
    await ensureDir(promotionRoot());
    result.patchArtifacts = await writePromotionPatchArtifacts(result.proposals);
    result.recordPath = path.join(promotionRoot(), `${timestampId()}.json`);
    await writeJson(result.recordPath, result);
  }

  return result;
}

export function formatPromotionResult(result) {
  const lines = [
    'Hermes promote',
    `Mode: ${result.mode}`,
    `Source: ${result.source}`,
    `Proposals: ${result.proposalCount}`,
    result.recordPath ? `Promotion record: ${result.recordPath}` : null,
    result.patchArtifacts?.length ? `Patch artifacts: ${result.patchArtifacts.length}` : null,
    `Note: ${result.note}`
  ].filter(Boolean);

  for (const proposal of result.proposals) {
    lines.push(`- [${proposal.type}] ${proposal.title}`);
    lines.push(`  action=${proposal.action} target=${proposal.target}`);
    lines.push(`  reason=${proposal.reason}`);
    const artifact = (result.patchArtifacts || []).find((candidate) => candidate.proposalId === proposal.proposalId);
    if (artifact) {
      lines.push(`  targets=${artifact.targetFiles.join(',')}`);
      lines.push(`  patch=${artifact.patchPath}`);
    }
  }

  if (result.proposals.length === 0) {
    lines.push('- no promotion candidates found');
  }

  lines.push('', 'Proposal JSON:', JSON.stringify(result, null, 2));
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

async function runHarnessTask(task) {
  const args = [
    path.join(harnessRoot, 'bin', 'harness'),
    'run',
    '--repo',
    task.repo,
    '--pipeline',
    task.pipeline,
    '--agent',
    task.agent,
    task.request
  ];

  const child = spawn(process.execPath, args, {
    cwd: harnessRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      stdout += value;
      process.stdout.write(value);
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(value);
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', resolve);
  });

  return {
    exitCode,
    stdout,
    stderr,
    runId: parseRunId(stderr) || parseRunId(stdout)
  };
}

export async function runHermesTick() {
  await ensureQueueDirs();
  const pending = await listTasks('pending');
  if (pending.length === 0) {
    const result = {
      status: 'idle',
      message: 'No pending tasks.'
    };
    const report = await createHermesReport({ kind: 'tick', tickResult: result });
    return {
      ...result,
      reportPath: report.reportPath
    };
  }

  const task = pending[0];
  const branchDecision = await evaluateProtectedBranchPolicy(task.repo);
  const requiresApproval = task.policy?.requireHumanApproval || task.policy?.decision?.requiresApproval || branchDecision.requiresApproval;
  if (requiresApproval) {
    const failedTask = {
      ...task,
      status: 'failed',
      error: task.policy?.decision?.requiresApproval
        ? task.policy.decision.reason
        : branchDecision.requiresApproval
          ? branchDecision.reason
          : 'Policy requires human approval.',
      policy: {
        ...(task.policy || {}),
        requireHumanApproval: true,
        branchDecision
      },
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    await writeJson(taskPath('pending', task.taskId), failedTask);
    await rename(taskPath('pending', task.taskId), taskPath('failed', task.taskId));
    const result = {
      status: 'failed',
      task: failedTask
    };
    const report = await createHermesReport({ kind: 'tick', tickResult: result });
    const notifications = await notifyHermesEvent({
      repo: failedTask.repo,
      event: 'tick.failed',
      title: 'Hermes task blocked',
      message: failedTask.error,
      reportPath: report.reportPath,
      payload: {
        repo: failedTask.repo,
        taskId: failedTask.taskId,
        status: failedTask.status,
        reason: failedTask.error
      }
    });
    return {
      ...result,
      reportPath: report.reportPath,
      notifications
    };
  }

  const pendingPath = taskPath('pending', task.taskId);
  const runningPath = taskPath('running', task.taskId);
  const runningTask = {
    ...task,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeJson(pendingPath, runningTask);
  await rename(pendingPath, runningPath);

  const harnessResult = await runHarnessTask(runningTask);
  const finishedStatus = harnessResult.exitCode === 0 ? 'done' : 'failed';
  const finishedTask = {
    ...runningTask,
    status: finishedStatus,
    runId: harnessResult.runId,
    exitCode: harnessResult.exitCode,
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (harnessResult.exitCode !== 0) {
    finishedTask.error = harnessResult.stderr.trim() || harnessResult.stdout.trim() || `harness run exited ${harnessResult.exitCode}`;
  }

  await writeJson(runningPath, finishedTask);
  await rename(runningPath, taskPath(finishedStatus, task.taskId));

  const result = {
    status: finishedStatus,
    task: finishedTask
  };
  const report = await createHermesReport({ kind: 'tick', tickResult: result });
  const notifications = await notifyHermesEvent({
    repo: finishedTask.repo,
    event: `tick.${finishedStatus}`,
    title: `Hermes task ${finishedStatus}`,
    message: finishedTask.error || `Task ${finishedStatus}`,
    reportPath: report.reportPath,
    payload: {
      repo: finishedTask.repo,
      taskId: finishedTask.taskId,
      status: finishedTask.status,
      runId: finishedTask.runId,
      reason: finishedTask.error || null
    }
  });
  return {
    ...result,
    reportPath: report.reportPath,
    notifications
  };
}

export function formatHermesTick(result) {
  if (result.status === 'idle') {
    return [
      'Hermes tick',
      result.message,
      result.reportPath ? `Report: ${result.reportPath}` : null
    ].filter(Boolean).join('\n');
  }

  return [
    'Hermes tick',
    `Task: ${result.task.taskId}`,
    `Status: ${result.status}`,
    `Pipeline: ${result.task.pipeline}`,
    `Run: ${result.task.runId || '(none)'}`,
    `Exit code: ${result.task.exitCode ?? '(none)'}`,
    result.task.error ? `Error: ${result.task.error}` : null,
    result.reportPath ? `Report: ${result.reportPath}` : null,
    result.notifications ? `Notifications: ${formatNotificationSummary(result.notifications)}` : null
  ].filter(Boolean).join('\n');
}

export function formatFeedback(feedback) {
  return [
    'Hermes feedback',
    `Run: ${feedback.runId}`,
    `Rating: ${feedback.rating}`,
    `Note: ${feedback.note || '(none)'}`
  ].join('\n');
}

export async function runHermesCommand({ subcommand, request, options = {} }) {
  if (!subcommand || subcommand === 'status') {
    const manifests = await readRunManifests({ limit: options.limit ?? 20 });
    const status = buildHermesStatus(manifests);
    status.memory = await memoryFreshness();
    return formatHermesStatus(status);
  }

  if (subcommand === 'plan') {
    if (!request) {
      throw new Error('Missing request for `harness hermes plan`.');
    }
    return formatHermesPlan(planHermesRequest(request, {
      agent: options.agent || 'codex',
      repo: options.repo || null,
      memoryRecords: await readHermesMemory()
    }));
  }

  if (subcommand === 'enqueue') {
    const task = await enqueueHermesTask({
      repo: options.repo,
      request,
      pipeline: options.pipeline,
      agent: options.agent
    });
    return [
      'Hermes enqueue',
      `Task: ${task.taskId}`,
      `Status: ${task.status}`,
      `Pipeline: ${task.pipeline}`,
      `Repo: ${task.repo}`
    ].join('\n');
  }

  if (subcommand === 'queue') {
    return formatQueueSummary(await summarizeQueue());
  }

  if (subcommand === 'feedback') {
    return formatFeedback(await writeFeedback({
      runId: options.run,
      rating: options.rating,
      note: request
    }));
  }

  if (subcommand === 'tick') {
    return formatHermesTick(await runHermesTick());
  }

  if (subcommand === 'promote') {
    return formatPromotionResult(await promoteHermesPatterns({
      apply: options.apply === true
    }));
  }

  if (subcommand === 'report') {
    return formatHermesReport(await createHermesReport());
  }

  if (subcommand === 'memory') {
    const memoryArgs = request ? request.split(' ') : [];
    const memoryCommand = memoryArgs.shift() || 'rebuild';
    const memoryQuery = memoryArgs.join(' ').trim();

    if (memoryCommand === 'rebuild') {
      return formatMemoryRebuild(await rebuildHermesMemory());
    }

    if (memoryCommand === 'search') {
      const records = await readHermesMemory();
      return formatMemorySearch(searchHermesMemoryRecords(records, memoryQuery), memoryQuery);
    }

    throw new Error(`Unknown hermes memory command: ${memoryCommand}`);
  }

  throw new Error(`Unknown hermes command: ${subcommand}`);
}
