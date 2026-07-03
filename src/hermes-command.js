import { enqueueHermesTask } from './hermes-enqueue.js';
import { formatFeedback, writeFeedback } from './hermes-feedback.js';
import {
  formatMemoryRebuild,
  formatMemorySearch,
  memoryFreshness,
  readHermesMemory,
  readRunManifests,
  rebuildHermesMemory,
  searchHermesMemoryRecords
} from './hermes-memory.js';
import { formatHermesPlan, planHermesRequest } from './hermes-planner.js';
import { formatPromotionResult, promoteHermesPatterns } from './hermes-promotion.js';
import {
  buildHermesStatus,
  createHermesReport,
  formatHermesReport,
  formatHermesStatus
} from './hermes-report.js';
import {
  approveHermesTask,
  formatApprovalResult,
  formatQueueSummary,
  rejectHermesTask,
  summarizeQueue
} from './hermes-queue.js';
import { formatHermesTick, runHermesTick } from './hermes-tick.js';

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

  if (subcommand === 'approve') {
    return formatApprovalResult('approve', await approveHermesTask({
      taskId: options.task,
      note: request
    }));
  }

  if (subcommand === 'reject') {
    return formatApprovalResult('reject', await rejectHermesTask({
      taskId: options.task,
      note: request
    }));
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
