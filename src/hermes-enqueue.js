import path from 'node:path';
import { timestampId, writeText } from './fs-utils.js';
import { taskPath, ensureQueueDirs } from './hermes-queue.js';
import { planHermesRequest } from './hermes-planner.js';
import { evaluatePolicy } from './policy.js';

async function writeJson(filePath, value) {
  await writeText(filePath, JSON.stringify(value, null, 2) + '\n');
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
