import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import {
  claimPendingTask,
  ensureQueueDirs,
  listTasks,
  reclaimStaleRunning,
  taskPath
} from '../src/hermes-queue.js';
import { writeText } from '../src/fs-utils.js';

// A2b: 큐 클레임 rename 선점.
// 목적 — 동시 tick 대비. 한 번 선점(pending→running rename)된 작업은 다시
// 선점되지 않아 이중 실행이 불가능함을 결정론적으로 고정한다.

const stamp = `test-claim-${process.pid}-${Date.now()}`;
const ids = [`${stamp}-a`, `${stamp}-b`];

async function seedPending(taskId, createdAt) {
  await writeText(taskPath('pending', taskId), JSON.stringify({
    taskId,
    createdAt,
    status: 'pending',
    repo: '/tmp/repo',
    request: 'noop',
    pipeline: 'quick_fix'
  }, null, 2) + '\n');
}

async function cleanup() {
  const statuses = ['pending', 'running', 'approval_pending', 'done', 'failed', 'rejected'];
  for (const status of statuses) {
    for (const id of ids) {
      await rm(taskPath(status, id), { force: true });
    }
  }
}

await ensureQueueDirs();
await cleanup();

try {
  // A는 B보다 먼저 생성 → 클레임은 createdAt 오름차순(A 먼저).
  await seedPending(ids[0], '2026-01-01T00:00:00.000Z');
  await seedPending(ids[1], '2026-01-01T00:00:01.000Z');

  const first = await claimPendingTask();
  assert.ok(first, 'first claim succeeds');
  assert.equal(first.task.taskId, ids[0], 'oldest pending is claimed first');
  // 선점된 작업은 running으로 이동, pending에서 사라짐.
  const runningIdsAfterFirst = (await listTasks('running')).map((entry) => entry.taskId);
  assert.ok(runningIdsAfterFirst.includes(ids[0]), 'claimed task moved to running');

  const second = await claimPendingTask();
  assert.ok(second, 'second claim succeeds');
  assert.notEqual(second.task.taskId, first.task.taskId, 'a claimed task is never re-claimed (no double execution)');
  assert.equal(second.task.taskId, ids[1], 'next-oldest pending is claimed second');

  // 우리 두 작업 모두 소진되면(다른 pending이 없다는 보장은 못 하므로 id로 확인)
  // 남은 pending에 우리 id가 없어야 한다.
  const remainingPending = (await listTasks('pending')).map((entry) => entry.taskId);
  assert.equal(remainingPending.includes(ids[0]), false, 'task A no longer pending');
  assert.equal(remainingPending.includes(ids[1]), false, 'task B no longer pending');
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------
// stale running 회수.
// claimPendingTask는 pending -> running으로 선점한다. 그 뒤 프로세스가 죽으면
// task가 running에 갇히고, 다음 tick은 pending만 보므로 영원히 처리되지 않는다.
// 자율 운영에서는 오류가 아니라 "조용한 정지"로 나타난다.
// ---------------------------------------------------------------------------
const staleIds = [`${stamp}-stale`, `${stamp}-fresh`, `${stamp}-notime`];

async function seedRunning(taskId, startedAt) {
  await writeText(taskPath('running', taskId), JSON.stringify({
    taskId,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(startedAt ? { startedAt } : {}),
    status: 'running',
    repo: '/tmp/repo',
    request: 'noop',
    pipeline: 'quick_fix'
  }, null, 2) + '\n');
}

async function cleanupStale() {
  const statuses = ['pending', 'running', 'approval_pending', 'done', 'failed', 'rejected'];
  for (const status of statuses) {
    for (const id of staleIds) {
      await rm(taskPath(status, id), { force: true });
    }
  }
}

await cleanupStale();

try {
  const now = Date.parse('2026-01-01T02:00:00.000Z');
  await seedRunning(staleIds[0], '2026-01-01T00:00:00.000Z');   // 2시간 전 → stale
  await seedRunning(staleIds[1], '2026-01-01T01:59:00.000Z');   // 1분 전 → 진행 중
  await seedRunning(staleIds[2], null);                          // 시각 불명 → 건드리지 않음

  const reclaimed = await reclaimStaleRunning({ staleMs: 60 * 60 * 1000, now });
  const reclaimedIds = reclaimed.map((task) => task.taskId);

  assert.ok(reclaimedIds.includes(staleIds[0]), 'stuck task is reclaimed');
  assert.equal(reclaimedIds.includes(staleIds[1]), false, 'a task still within the limit is left running');
  // createdAt만 있는 task는 그것을 기준으로 판단한다(2026-01-01T00:00:00 → stale).
  assert.ok(reclaimedIds.includes(staleIds[2]), 'falls back to createdAt when startedAt is missing');

  // 회수된 task는 failed로 이동하고 원인이 남는다. 자동 재실행하지 않는다 —
  // 죽은 run이 파일을 일부 바꿨을 수 있어 중복 적용 위험이 있다.
  const stillRunning = (await listTasks('running')).map((entry) => entry.taskId);
  assert.equal(stillRunning.includes(staleIds[0]), false, 'reclaimed task left running/');
  assert.ok(stillRunning.includes(staleIds[1]), 'fresh task stays in running/');

  const failed = await listTasks('failed');
  const reclaimedTask = failed.find((entry) => entry.taskId === staleIds[0]);
  assert.ok(reclaimedTask, 'reclaimed task moved to failed/');
  assert.equal(reclaimedTask.status, 'failed');
  assert.match(reclaimedTask.error, /stuck in running/);
  assert.ok(reclaimedTask.stale.ageMs >= 60 * 60 * 1000);
  assert.ok(reclaimedTask.finishedAt, 'reclaimed task gets finishedAt');

  // pending으로 되돌리지 않는다(중복 실행 방지).
  const pendingIds = (await listTasks('pending')).map((entry) => entry.taskId);
  assert.equal(pendingIds.includes(staleIds[0]), false, 'must not silently requeue a dead run');

  // 멱등: 다시 돌려도 회수할 것이 없다.
  const second = await reclaimStaleRunning({ staleMs: 60 * 60 * 1000, now });
  assert.equal(second.map((task) => task.taskId).includes(staleIds[0]), false);
} finally {
  await cleanupStale();
}

console.log('hermes queue claim tests passed');
