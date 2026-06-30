import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getAgentVersion, resolveAgentConfig, runAgentStep } from './agent.js';
import { loadConfig, getPipeline } from './config.js';
import { cleanRuns } from './clean.js';
import { runDoctor } from './doctor.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { installIdeTask } from './ide.js';
import { renderPrompt } from './prompt.js';
import { runValidationCommand, validationCommandsFromProjectConfig } from './validation.js';

const HERMES_STEP_ID = 'hermes';
const DEFAULT_MAX_SUPERVISOR_TURNS = 3;
const DEFAULT_MAX_STEP_RETRIES = 1;
const SUPERVISOR_ACTIONS = new Set([
  'continue',
  'run_validation',
  'escalate_to_safe_fix',
  'rerun_step',
  'stop_failed',
  'request_human_review'
]);
const SUPERVISOR_STATUSES = new Set([
  'success',
  'success_with_risks',
  'failed',
  'incomplete'
]);

function usage() {
  return [
    'Usage:',
    '  harness run --repo <path> [--pipeline <name>] [--agent <provider>] "<request>"',
    '  harness install-ide-task --repo <path>',
    '  harness init-project --repo <path>',
    '  harness doctor [--repo <path>] [--agent <provider>]',
    '  harness clean [--days <n>] [--keep <n>] [--dry-run]',
    '',
    'Examples:',
    '  harness run --repo "$PWD" --agent codex "Fix failing tests"',
    '  harness install-ide-task --repo "$PWD"'
  ].join('\n');
}

function parseArgs(args) {
  const command = args.shift();
  const options = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo') {
      options.repo = args[++index];
    } else if (arg === '--pipeline') {
      options.pipeline = args[++index];
    } else if (arg === '--agent') {
      options.agent = args[++index];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--days') {
      options.days = args[++index];
    } else if (arg === '--keep') {
      options.keep = args[++index];
    } else {
      positionals.push(arg);
    }
  }

  return { command, options, request: positionals.join(' ').trim() };
}

function requireRepo(repo) {
  if (!repo) {
    throw new Error(`Missing --repo.\n\n${usage()}`);
  }

  const resolved = path.resolve(repo);
  if (!existsSync(resolved)) {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }

  return resolved;
}

async function initProject(repo) {
  const configPath = path.join(repo, '.harness.json');
  if (!existsSync(configPath)) {
    await writeText(configPath, JSON.stringify({
      pipeline: 'code_fix',
      agent: {
        provider: 'codex'
      },
      testCommand: '',
      buildCommand: '',
      validationCommands: [],
      supervisor: {
        enabled: true,
        maxSupervisorTurns: 3,
        maxStepRetries: 1
      },
      cleanup: {
        enabled: false,
        days: 7,
        keep: 20
      },
      protectedBranches: ['main', 'production']
    }, null, 2) + '\n');
  }
  return configPath;
}

function validationSummary(result) {
  return [
    `command: ${result.command}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    `stdoutPath: ${result.stdoutPath}`,
    `stderrPath: ${result.stderrPath}`
  ].join('\n');
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

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitSnapshot(repo) {
  const inside = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode !== 0 || inside.stdout !== 'true') {
    return {
      available: false,
      reason: inside.stderr || 'not a git work tree'
    };
  }

  const [commit, branch, statusShort, diffStat] = await Promise.all([
    runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    runCapture('git', ['branch', '--show-current'], { cwd: repo }),
    runCapture('git', ['status', '--short'], { cwd: repo }),
    runCapture('git', ['diff', '--stat'], { cwd: repo })
  ]);

  return {
    available: true,
    commit: commit.exitCode === 0 ? commit.stdout : null,
    branch: branch.exitCode === 0 ? branch.stdout : null,
    dirty: statusShort.exitCode === 0 ? statusShort.stdout.length > 0 : null,
    statusShort: statusShort.exitCode === 0 ? statusShort.stdout : statusShort.stderr,
    diffStat: diffStat.exitCode === 0 ? diffStat.stdout : diffStat.stderr
  };
}

function supervisorConfigFromProjectConfig(projectConfig = {}) {
  const supervisor = projectConfig.supervisor || {};
  const maxSupervisorTurns = Number.isInteger(supervisor.maxSupervisorTurns)
    ? supervisor.maxSupervisorTurns
    : DEFAULT_MAX_SUPERVISOR_TURNS;
  const maxStepRetries = Number.isInteger(supervisor.maxStepRetries)
    ? supervisor.maxStepRetries
    : DEFAULT_MAX_STEP_RETRIES;

  return {
    enabled: supervisor.enabled !== false,
    maxSupervisorTurns,
    maxStepRetries
  };
}

function cleanupConfigFromProjectConfig(projectConfig = {}) {
  const cleanup = projectConfig.cleanup || {};
  return {
    enabled: cleanup.enabled === true,
    days: cleanup.days ?? 7,
    keep: cleanup.keep ?? 5,
    dryRun: cleanup.dryRun === true
  };
}

async function runCleanupHook({ projectConfig, currentRunId, dryRun }) {
  const cleanup = cleanupConfigFromProjectConfig(projectConfig);
  if (!cleanup.enabled) {
    return {
      status: 'skipped',
      reason: 'cleanup disabled'
    };
  }

  try {
    return await cleanRuns({
      days: cleanup.days,
      keep: cleanup.keep,
      dryRun: dryRun || cleanup.dryRun,
      exclude: [currentRunId]
    });
  } catch (error) {
    return {
      status: 'failed',
      days: cleanup.days,
      keep: cleanup.keep,
      dryRun: dryRun || cleanup.dryRun,
      excludedRuns: [currentRunId],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function supervisorDecisionError(message, value = {}) {
  return {
    status: 'incomplete',
    nextAction: 'request_human_review',
    targetStep: null,
    reason: message,
    instructions: 'Tell the user that Hermes returned an invalid supervisor decision and human review is required.',
    valid: false,
    schemaErrors: [message],
    rawDecision: value
  };
}

function normalizeSupervisorDecision(value) {
  if (!value || typeof value !== 'object') {
    return supervisorDecisionError('Supervisor decision must be a JSON object.', value);
  }

  const nextAction = String(value.nextAction || value.action || '').trim();
  if (!SUPERVISOR_ACTIONS.has(nextAction)) {
    return supervisorDecisionError(`Unsupported supervisor nextAction: ${nextAction || '(missing)'}.`, value);
  }

  const status = String(value.status || 'incomplete').trim();
  if (!SUPERVISOR_STATUSES.has(status)) {
    return supervisorDecisionError(`Unsupported supervisor status: ${status || '(missing)'}.`, value);
  }

  const targetStep = value.targetStep === null || value.targetStep === undefined
    ? null
    : String(value.targetStep).trim();

  if (nextAction === 'rerun_step' && !targetStep) {
    return supervisorDecisionError('rerun_step requires targetStep.', value);
  }

  return {
    status,
    nextAction,
    targetStep: targetStep || null,
    reason: String(value.reason || '').trim(),
    instructions: String(value.instructions || '').trim(),
    valid: true,
    schemaErrors: []
  };
}

function parseSupervisorDecision(output) {
  const fencedBlocks = [...String(output).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let index = fencedBlocks.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(fencedBlocks[index][1]);
      const decision = normalizeSupervisorDecision(parsed);
      return decision;
    } catch {
      // Keep scanning earlier blocks. Hermes may include example JSON before the final decision.
    }
  }

  return {
    status: 'incomplete',
    nextAction: 'request_human_review',
    targetStep: null,
    reason: 'Hermes did not return a parseable supervisor decision JSON block.',
    instructions: 'Tell the user that the run needs human review because the supervisor decision could not be parsed.',
    valid: false,
    schemaErrors: ['No parseable supervisor decision JSON block found.']
  };
}

function appendSupervisorInstructions(previousOutputs, decision) {
  return `${previousOutputs}\n\n## hermes decision for ${decision.targetStep || 'reporter'}\n` +
    `status: ${decision.status}\n` +
    `nextAction: ${decision.nextAction}\n` +
    `reason: ${decision.reason || '(none)'}\n` +
    `instructions: ${decision.instructions || '(none)'}`;
}

function stepForAttempt(step, attempt) {
  if (attempt <= 1) {
    return step;
  }

  return {
    ...step,
    id: `${step.id}-retry-${attempt - 1}`
  };
}

function validationIdForAttempt(validation, step, attempt) {
  if (attempt <= 1) {
    return validation.id;
  }

  return `${validation.id}-after-${step.id}-retry-${attempt - 1}`;
}

function validationStageIdForAttempt(step, attempt) {
  if (attempt <= 1) {
    return `validation:after-${step.id}`;
  }

  return `validation:after-${step.id}-retry-${attempt - 1}`;
}

function findStepIndex(steps, stepId) {
  return steps.findIndex((candidate) => candidate.id === stepId);
}

function findValidationTargetStep(steps, validationAfter, preferredStepId) {
  if (preferredStepId) {
    const preferred = steps.find((candidate) => candidate.id === preferredStepId);
    if (preferred) {
      return preferred;
    }
  }

  const firstValidationStepId = [...validationAfter][0];
  return steps.find((candidate) => candidate.id === firstValidationStepId) || null;
}

function roleAgentConfig(projectConfig, stepId) {
  if (stepId === HERMES_STEP_ID && projectConfig.supervisor?.agent) {
    return projectConfig.supervisor.agent;
  }

  return projectConfig.agents?.[stepId] || null;
}

function resolveStepAgent({ defaultAgent, projectConfig, stepId }) {
  const agentConfig = roleAgentConfig(projectConfig, stepId);
  if (!agentConfig) {
    return defaultAgent;
  }

  return resolveAgentConfig({
    options: {},
    projectConfig: {
      agent: agentConfig
    }
  });
}

async function runValidationStage({ repo, runDir, step, attempt, validationCommands, manifest, previousOutputs }) {
  const validationStageId = validationStageIdForAttempt(step, attempt);
  if (validationCommands.length === 0) {
    const skipped = {
      type: 'validation',
      stepId: validationStageId,
      status: 'skipped',
      reason: 'no validation commands configured'
    };
    manifest.steps.push(skipped);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {
      failures: [],
      previousOutputs: `${previousOutputs}\n\n## ${validationStageId}\nNo validation commands configured.`
    };
  }

  const failures = [];
  let nextPreviousOutputs = previousOutputs;

  for (const validation of validationCommands) {
    const validationId = validationIdForAttempt(validation, step, attempt);
    console.error(`\n== validation:${validationId} ==`);
    const validationResult = await runValidationCommand({
      repo,
      runDir,
      id: validationId,
      command: validation.command
    });
    manifest.steps.push(validationResult);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    nextPreviousOutputs += `\n\n## validation:${validationResult.id}\n${validationSummary(validationResult)}`;

    if (validationResult.exitCode !== 0) {
      failures.push(validationResult);
    }
  }

  return {
    failures,
    previousOutputs: nextPreviousOutputs
  };
}

async function run(options, request) {
  const repo = requireRepo(options.repo || process.cwd());
  if (!request) {
    throw new Error(`Missing request.\n\n${usage()}`);
  }

  const config = await loadConfig();
  const projectConfigPath = path.join(repo, '.harness.json');
  let projectConfig = {};
  if (existsSync(projectConfigPath)) {
    projectConfig = JSON.parse(await readText(projectConfigPath));
  }

  const pipelineName = options.pipeline || projectConfig.pipeline;
  let selected = getPipeline(config, pipelineName);
  const agent = resolveAgentConfig({ options, projectConfig });
  const agentVersionCache = new Map();
  async function cachedAgentVersion(stepAgent) {
    const key = `${stepAgent.name}\0${stepAgent.command}\0${JSON.stringify(stepAgent.versionArgs)}`;
    if (!agentVersionCache.has(key)) {
      agentVersionCache.set(key, await getAgentVersion(stepAgent, { skip: options.dryRun }));
    }
    return agentVersionCache.get(key);
  }
  const validationCommands = validationCommandsFromProjectConfig(projectConfig);
  const supervisorConfig = supervisorConfigFromProjectConfig(projectConfig);
  const runId = timestampId();
  const runDir = path.join(harnessRoot, 'runs', runId);
  await ensureDir(runDir);

  const manifest = {
    schemaVersion: 1,
    runId,
    repo,
    request,
    pipeline: selected.pipelineName,
    dryRun: Boolean(options.dryRun),
    agent: {
      provider: agent.name,
      command: agent.command,
      version: await cachedAgentVersion(agent)
    },
    roleAgents: {
      hermes: projectConfig.supervisor?.agent || null,
      ...(projectConfig.agents || {})
    },
    nodeVersion: process.version,
    projectConfig,
    validationCommands,
    supervisor: supervisorConfig,
    git: await gitSnapshot(repo),
    startedAt: new Date().toISOString(),
    steps: [],
    supervisorDecisions: [],
    pipelineChanges: []
  };
  await writeText(path.join(runDir, 'request.txt'), request + '\n');
  await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.error(`Harness run: ${runId}`);
  console.error(`Repo: ${repo}`);
  console.error(`Pipeline: ${selected.pipelineName}`);
  console.error(`Agent: ${agent.name} (${agent.command})`);
  console.error(`Run dir: ${runDir}`);

  let previousOutputs = '';
  let activeValidationFailures = [];
  let validationAfter = new Set(selected.pipeline.validationAfter || []);
  const stepAttempts = {};
  const stepRetries = {};
  const validationAttempts = {};
  let supervisorTurns = 0;
  let supervisorInstructions = '';
  let supervisorTerminalStatus = null;
  let shouldStopAfterReporter = false;
  let escalatedToSafeFix = selected.pipelineName === 'safe_fix';
  let stepIndex = 0;

  while (stepIndex < selected.pipeline.steps.length) {
    const baseStep = selected.pipeline.steps[stepIndex];

    if (!supervisorConfig.enabled && baseStep.id === HERMES_STEP_ID) {
      stepIndex += 1;
      continue;
    }

    stepAttempts[baseStep.id] = (stepAttempts[baseStep.id] || 0) + 1;
    const attempt = stepAttempts[baseStep.id];
    const step = stepForAttempt(baseStep, attempt);
    const stepAgent = resolveStepAgent({ defaultAgent: agent, projectConfig, stepId: baseStep.id });
    const stepAgentVersion = await cachedAgentVersion(stepAgent);

    const prompt = await renderPrompt(step, {
      request,
      repo,
      previousOutputs,
      projectConfig,
      validationCommands,
      supervisorInstructions
    });
    const promptPath = path.join(runDir, `${step.id}.prompt.md`);
    await writeText(promptPath, prompt);

    if (options.dryRun) {
      console.error(`[dry-run] ${step.id}`);
      manifest.steps.push({
        type: 'agent',
        stepId: step.id,
        status: 'skipped',
        reason: 'dry-run',
        agent: stepAgent.name,
        command: stepAgent.command,
        agentVersion: stepAgentVersion,
        sandbox: step.sandbox || 'read-only',
        approval: step.approval || 'never',
        model: step.model || null
      });
      await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

      if (validationAfter.has(baseStep.id)) {
        const skipped = {
          type: 'validation',
          stepId: `validation:after-${baseStep.id}`,
          status: 'skipped',
          reason: 'dry-run'
        };
        manifest.steps.push(skipped);
        await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        previousOutputs += `\n\n## validation after ${step.id}\nSkipped because this was a dry run.`;
      }

      stepIndex += 1;
      continue;
    }

    console.error(`\n== ${step.id} ==`);
    const result = await runAgentStep({ repo, runDir, step, prompt, promptPath, agent: stepAgent });
    result.agentVersion = stepAgentVersion;
    manifest.steps.push(result);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (existsSync(result.finalPath)) {
      const output = await readText(result.finalPath);
      previousOutputs += `\n\n## ${step.id}\n${output}`;
    }

    if (result.exitCode !== 0) {
      manifest.finishedAt = new Date().toISOString();
      manifest.status = 'failed';
      await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      throw new Error(`Step failed: ${step.id} (exit ${result.exitCode}). See ${runDir}`);
    }

    if (validationAfter.has(baseStep.id)) {
      const validationStage = await runValidationStage({
        repo,
        runDir,
        step: baseStep,
        attempt,
        validationCommands,
        manifest,
        previousOutputs
      });
      previousOutputs = validationStage.previousOutputs;
      activeValidationFailures = validationStage.failures;
    }

    if (baseStep.id === HERMES_STEP_ID && existsSync(result.finalPath)) {
      supervisorTurns += 1;
      const output = await readText(result.finalPath);
      const decision = parseSupervisorDecision(output);
      const decisionRecord = {
        ...decision,
        turn: supervisorTurns,
        stepId: step.id,
        sourcePath: result.finalPath,
        createdAt: new Date().toISOString()
      };
      manifest.supervisorDecisions.push(decisionRecord);
      await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

      console.error(`Hermes decision: ${decision.nextAction} (${decision.status})`);

      if (decision.nextAction === 'continue') {
        supervisorTerminalStatus = decision.status;
        stepIndex += 1;
        continue;
      }

      if (decision.nextAction === 'run_validation') {
        const targetStep = findValidationTargetStep(selected.pipeline.steps, validationAfter, decision.targetStep);
        if (targetStep && supervisorTurns < supervisorConfig.maxSupervisorTurns) {
          validationAttempts[targetStep.id] = (validationAttempts[targetStep.id] || stepAttempts[targetStep.id] || 0) + 1;
          supervisorInstructions = appendSupervisorInstructions('', decision);
          previousOutputs = appendSupervisorInstructions(previousOutputs, decision);
          const validationStage = await runValidationStage({
            repo,
            runDir,
            step: targetStep,
            attempt: validationAttempts[targetStep.id],
            validationCommands,
            manifest,
            previousOutputs
          });
          previousOutputs = validationStage.previousOutputs;
          activeValidationFailures = validationStage.failures;
          stepIndex = findStepIndex(selected.pipeline.steps, HERMES_STEP_ID);
          continue;
        }

        supervisorTerminalStatus = 'incomplete';
        shouldStopAfterReporter = true;
        previousOutputs += `\n\n## hermes validation rerun not performed\n` +
          `targetStep: ${decision.targetStep || '(auto)'}\n` +
          `reason: validation target was unavailable or supervisor turn limit was reached.`;
        stepIndex += 1;
        continue;
      }

      if (decision.nextAction === 'escalate_to_safe_fix') {
        if (!escalatedToSafeFix && config.pipelines.safe_fix && supervisorTurns < supervisorConfig.maxSupervisorTurns) {
          const previousPipeline = selected.pipelineName;
          selected = getPipeline(config, 'safe_fix');
          validationAfter = new Set(selected.pipeline.validationAfter || []);
          escalatedToSafeFix = true;
          supervisorInstructions = appendSupervisorInstructions('', decision);
          previousOutputs = appendSupervisorInstructions(previousOutputs, decision);
          manifest.pipelineChanges.push({
            from: previousPipeline,
            to: selected.pipelineName,
            reason: decision.reason,
            instructions: decision.instructions,
            turn: supervisorTurns,
            createdAt: new Date().toISOString()
          });
          await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
          stepIndex = 0;
          continue;
        }

        supervisorTerminalStatus = 'incomplete';
        shouldStopAfterReporter = true;
        previousOutputs += `\n\n## hermes escalation not performed\n` +
          `reason: safe_fix was unavailable, already active, or supervisor turn limit was reached.`;
        stepIndex += 1;
        continue;
      }

      if (decision.nextAction === 'stop_failed' || decision.nextAction === 'request_human_review') {
        supervisorTerminalStatus = decision.status;
        shouldStopAfterReporter = true;
        stepIndex += 1;
        continue;
      }

      if (decision.nextAction === 'rerun_step') {
        const targetIndex = findStepIndex(selected.pipeline.steps, decision.targetStep);
        const canRerun = targetIndex >= 0 && targetIndex < stepIndex && decision.targetStep !== HERMES_STEP_ID;
        const retryCount = stepRetries[decision.targetStep] || 0;

        if (canRerun && retryCount < supervisorConfig.maxStepRetries && supervisorTurns < supervisorConfig.maxSupervisorTurns) {
          stepRetries[decision.targetStep] = retryCount + 1;
          supervisorInstructions = appendSupervisorInstructions('', decision);
          previousOutputs = appendSupervisorInstructions(previousOutputs, decision);
          stepIndex = targetIndex;
          continue;
        }

        supervisorTerminalStatus = 'incomplete';
        shouldStopAfterReporter = true;
        previousOutputs += `\n\n## hermes rerun not performed\n` +
          `targetStep: ${decision.targetStep || '(none)'}\n` +
          `reason: rerun was not allowed, target was unavailable, or retry limits were reached.`;
        stepIndex += 1;
        continue;
      }
    }

    stepIndex += 1;
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.completedPipeline = selected.pipelineName;
  manifest.gitAfter = await gitSnapshot(repo);
  if (supervisorTerminalStatus === 'failed' || shouldStopAfterReporter || activeValidationFailures.length > 0) {
    manifest.status = 'failed';
  } else if (supervisorTerminalStatus === 'incomplete') {
    manifest.status = 'incomplete';
  } else {
    manifest.status = 'succeeded';
  }
  manifest.cleanup = await runCleanupHook({
    projectConfig,
    currentRunId: runId,
    dryRun: options.dryRun
  });
  await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.error(`\nDone. Final report: ${path.join(runDir, `${selected.pipeline.steps.at(-1).id}.md`)}`);

  if (shouldStopAfterReporter) {
    throw new Error(`Hermes stopped the run (${supervisorTerminalStatus || 'failed'}). See ${runDir}`);
  }

  if (activeValidationFailures.length > 0) {
    throw new Error(`Validation failed (${activeValidationFailures.length} command(s)). See ${runDir}`);
  }
}

export async function main(args) {
  const parsed = parseArgs([...args]);

  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    console.log(usage());
    return;
  }

  if (parsed.command === 'run') {
    await run(parsed.options, parsed.request);
    return;
  }

  if (parsed.command === 'install-ide-task') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const tasksPath = await installIdeTask(repo);
    console.log(`Installed IDE task: ${tasksPath}`);
    return;
  }

  if (parsed.command === 'init-project') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const configPath = await initProject(repo);
    console.log(`Project harness config: ${configPath}`);
    return;
  }

  if (parsed.command === 'doctor') {
    await runDoctor({
      repo: parsed.options.repo || process.cwd(),
      agent: parsed.options.agent || null
    });
    return;
  }

  if (parsed.command === 'clean') {
    await cleanRuns({
      days: parsed.options.days ?? 7,
      keep: parsed.options.keep ?? 5,
      dryRun: parsed.options.dryRun
    });
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
}
