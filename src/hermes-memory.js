import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, harnessRoot, writeText } from './fs-utils.js';

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

function parseRunTimestamp(name) {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{6})(?:_(?<ms>\d{3}))?$/.exec(name);
  if (!match) {
    return null;
  }

  const time = match.groups.time;
  const ms = match.groups.ms || '000';
  return new Date(`${match.groups.date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${ms}`);
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

export function similarMemoryRecords(records, request, repo) {
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

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function repoProfileFromMemory(records, repo) {
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

export async function memoryFreshness() {
  const records = await readHermesMemory();
  return {
    available: records.length > 0,
    totalRuns: records.length,
    latestRunId: records.at(-1)?.runId || null
  };
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
