import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import {
  claimPendingTask,
  ensureQueueDirs,
  listTasks,
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

console.log('hermes queue claim tests passed');
