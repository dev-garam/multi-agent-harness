import { spawn } from 'node:child_process';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { harnessRoot, writeText } from './fs-utils.js';
import { readProjectHarnessConfig } from './hermes-config.js';
import { createHermesReport } from './hermes-report.js';
import {
  ensureQueueDirs,
  listTasks,
  taskPath
} from './hermes-queue.js';
import { formatNotificationSummary, notifyHermesEvent } from './notify.js';
import { evaluateProtectedBranchPolicy } from './policy.js';

async function writeJson(filePath, value) {
  await writeText(filePath, JSON.stringify(value, null, 2) + '\n');
}

function parseRunId(output) {
  const match = String(output).match(/Harness run: ([^\n]+)/);
  return match ? match[1].trim() : null;
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
    ...(task.policy?.approved ? ['--policy-approved'] : []),
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
  const projectConfig = await readProjectHarnessConfig(task.repo);
  const branchDecision = await evaluateProtectedBranchPolicy({
    repo: task.repo,
    projectConfig: projectConfig.value
  });
  const approved = task.policy?.approved === true || task.approval?.status === 'approved';
  const requiresApproval = !approved &&
    (task.policy?.requireHumanApproval || task.policy?.decision?.requiresApproval || branchDecision.requiresApproval);
  if (requiresApproval) {
    const approvalTask = {
      ...task,
      status: 'approval_pending',
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
      approval: {
        status: 'pending',
        reason: task.policy?.decision?.requiresApproval
          ? task.policy.decision.reason
          : branchDecision.requiresApproval
            ? branchDecision.reason
            : 'Policy requires human approval.',
        requestedAt: new Date().toISOString()
      }
    };
    await writeJson(taskPath('pending', task.taskId), approvalTask);
    await rename(taskPath('pending', task.taskId), taskPath('approval_pending', task.taskId));
    const result = {
      status: 'approval_pending',
      task: approvalTask
    };
    const report = await createHermesReport({ kind: 'tick', tickResult: result });
    const notifications = await notifyHermesEvent({
      repo: approvalTask.repo,
      event: 'tick.approval_pending',
      title: 'Hermes task awaiting approval',
      message: approvalTask.error,
      reportPath: report.reportPath,
      payload: {
        repo: approvalTask.repo,
        taskId: approvalTask.taskId,
        status: approvalTask.status,
        reason: approvalTask.error
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
