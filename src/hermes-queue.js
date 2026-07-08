import { rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, harnessRoot, writeText } from './fs-utils.js';

const QUEUE_STATUSES = ['pending', 'running', 'approval_pending', 'done', 'failed', 'rejected'];

function queueRoot() {
  return path.join(harnessRoot, '.harness', 'queue');
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

export async function ensureQueueDirs() {
  await Promise.all(QUEUE_STATUSES.map((status) => ensureDir(queueDir(status))));
}

export function taskPath(status, taskId) {
  return path.join(queueDir(status), `${taskId}.json`);
}

export async function listTasks(status) {
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

// A2b: pending 작업을 원자적 rename으로 선점한다. rename은 원자적이라 동시 tick
// 둘이 같은 후보를 잡아도 하나만 성공하고, 늦은 쪽은 ENOENT를 받아 다음 후보로
// 넘어간다. 반환된 task는 이미 running 디렉터리로 옮겨진 상태(내용은 그대로).
// 선점에 성공한 후보가 없으면 null.
export async function claimPendingTask() {
  await ensureQueueDirs();
  const pending = await listTasks('pending');
  for (const candidate of pending) {
    const from = taskPath('pending', candidate.taskId);
    const to = taskPath('running', candidate.taskId);
    try {
      await rename(from, to);
      return { task: candidate, runningPath: to };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 다른 tick이 먼저 선점함 → 다음 후보 시도.
        continue;
      }
      throw error;
    }
  }
  return null;
}

function taskSummary(task) {
  return `${task.taskId} ${task.status} ${task.pipeline} repo=${task.repo} request="${task.request}"`;
}

export async function summarizeQueue() {
  const groups = {};
  for (const status of QUEUE_STATUSES) {
    groups[status] = await listTasks(status);
  }
  return groups;
}

export function formatQueueSummary(groups) {
  const lines = ['Hermes queue'];
  for (const status of QUEUE_STATUSES) {
    lines.push(`${status}: ${groups[status].length}`);
    for (const task of groups[status].slice(0, 5)) {
      lines.push(`- ${taskSummary(task)}`);
    }
  }
  return lines.join('\n');
}

async function findQueuedTask(taskId, statuses = QUEUE_STATUSES) {
  await ensureQueueDirs();
  for (const status of statuses) {
    const filePath = taskPath(status, taskId);
    const task = await readJson(filePath);
    if (task) {
      return { status, filePath, task };
    }
  }
  return null;
}

export async function approveHermesTask({ taskId, note }) {
  if (!taskId) {
    throw new Error('Missing --task for `harness hermes approve`.');
  }

  const found = await findQueuedTask(taskId, ['approval_pending']);
  if (!found) {
    throw new Error(`Approval pending task not found: ${taskId}`);
  }

  const approvedAt = new Date().toISOString();
  const approvedTask = {
    ...found.task,
    status: 'pending',
    error: null,
    approval: {
      status: 'approved',
      note: note || '',
      approvedAt
    },
    policy: {
      ...(found.task.policy || {}),
      requireHumanApproval: false,
      approved: true
    },
    updatedAt: approvedAt
  };
  await writeJson(found.filePath, approvedTask);
  await rename(found.filePath, taskPath('pending', taskId));
  return approvedTask;
}

export async function rejectHermesTask({ taskId, note }) {
  if (!taskId) {
    throw new Error('Missing --task for `harness hermes reject`.');
  }

  const found = await findQueuedTask(taskId, ['approval_pending']);
  if (!found) {
    throw new Error(`Approval pending task not found: ${taskId}`);
  }

  const rejectedAt = new Date().toISOString();
  const rejectedTask = {
    ...found.task,
    status: 'rejected',
    approval: {
      status: 'rejected',
      note: note || '',
      rejectedAt
    },
    finishedAt: rejectedAt,
    updatedAt: rejectedAt
  };
  await writeJson(found.filePath, rejectedTask);
  await rename(found.filePath, taskPath('rejected', taskId));
  return rejectedTask;
}

export function formatApprovalResult(action, task) {
  return [
    `Hermes ${action}`,
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Pipeline: ${task.pipeline}`,
    `Repo: ${task.repo}`,
    task.approval?.note ? `Note: ${task.approval.note}` : null
  ].filter(Boolean).join('\n');
}
