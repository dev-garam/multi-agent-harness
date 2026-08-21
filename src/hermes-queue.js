import { rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, harnessRoot, writeText } from './fs-utils.js';

const QUEUE_STATUSES = ['pending', 'running', 'approval_pending', 'done', 'failed', 'rejected'];

// running에 갇힌 task를 stale로 볼 기준. 하네스 run의 기본 budget(maxRuntimeMs
// 15분)보다 충분히 크게 잡아 진행 중인 작업을 잘못 죽이지 않는다.
const DEFAULT_STALE_RUNNING_MS = 60 * 60 * 1000;

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

/**
 * running에 갇힌 task를 회수한다.
 *
 * claimPendingTask는 pending -> running으로 rename해 선점한다. 그 뒤 프로세스가
 * 죽으면(크래시·Ctrl+C·머신 종료) task 파일은 running에 남고, 다음 tick은 pending만
 * 보므로 그 task는 영원히 처리되지 않는다. 자율 운영에서 이건 오류가 아니라
 * "조용한 정지"로 나타난다 — 큐에 일이 있는데 tick은 계속 idle을 보고한다.
 *
 * 회수는 failed로 보낸다. 자동 재실행하지 않는 이유는 죽은 run이 파일을 이미
 * 일부 바꿨을 수 있어서다. 무엇이 끝났는지 모르는 채 다시 돌리면 중복 적용
 * 위험이 있으므로 사람이 판단하도록 남긴다.
 *
 * now를 주입할 수 있게 해 시계에 의존하지 않고 테스트한다.
 */
export async function reclaimStaleRunning({
  staleMs = DEFAULT_STALE_RUNNING_MS,
  now = Date.now()
} = {}) {
  await ensureQueueDirs();
  const running = await listTasks('running');
  const reclaimed = [];

  for (const task of running) {
    const startedAt = Date.parse(task.startedAt || task.updatedAt || task.createdAt || '');
    // 시각을 알 수 없는 task는 건드리지 않는다(판단 근거가 없다).
    if (!Number.isFinite(startedAt)) {
      continue;
    }
    const age = now - startedAt;
    if (age < staleMs) {
      continue;
    }

    const finishedAt = new Date(now).toISOString();
    const staleTask = {
      ...task,
      status: 'failed',
      error: `Task was stuck in running for ${Math.round(age / 1000)}s (limit ${Math.round(staleMs / 1000)}s). `
        + 'The harness process likely exited before finishing. Review the run before retrying.',
      stale: { reclaimedAt: finishedAt, ageMs: age, staleMs },
      finishedAt,
      updatedAt: finishedAt
    };
    const from = taskPath('running', task.taskId);
    await writeJson(from, staleTask);
    await rename(from, taskPath('failed', task.taskId));
    reclaimed.push(staleTask);
  }

  return reclaimed;
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
