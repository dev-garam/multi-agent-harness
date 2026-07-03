import path from 'node:path';
import { existsSync } from 'node:fs';
import { getAgentVersion, resolveAgentConfig, runAgentStep } from './agent.js';
import { loadConfig, getPipeline } from './config.js';
import { cleanRuns } from './clean.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { renderPrompt } from './prompt.js';
import { runValidationCommand, validationCommandsFromProjectConfig } from './validation.js';
import { trustBoundarySummary } from './trust.js';
import { inspectChanges, inspectionSummary } from './inspection.js';
import { evaluatePolicy, policyFromProjectConfig } from './policy.js';
import { finalizeWorkspace, prepareWorkspace, workspaceModeFromOptions } from './workspace.js';
import { parseReporterSummary } from './reporter-summary.js';
import { appendSupervisorInstructions, parseSupervisorDecision } from './supervisor.js';
import { gitSnapshot } from './git.js';
import { resourceConfigFromProjectConfig } from './resources.js';
import { appendManifestStep, saveManifest } from './manifest.js';
import { formatConfigValidationIssues, validateProjectConfig } from './config-validation.js';
import { assertRuntimeRunnerAvailable, runtimeRunnerFromOptions } from './runtime-runner.js';

const HERMES_STEP_ID = 'hermes';
const DEFAULT_MAX_SUPERVISOR_TURNS = 3;
const DEFAULT_MAX_STEP_RETRIES = 1;

function requireRepo(repo) {
  if (!repo) {
    throw new Error('Missing --repo.');
  }

  const resolved = path.resolve(repo);
  if (!existsSync(resolved)) {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }

  return resolved;
}

function validationSummary(result) {
  return [
    `command: ${result.command}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    `timedOut: ${Boolean(result.timedOut)}`,
    `stdoutPath: ${result.stdoutPath}`,
    `stderrPath: ${result.stderrPath}`
  ].join('\n');
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

function directRunPolicyFromProjectConfig(projectConfig = {}) {
  return {
    ...policyFromProjectConfig(projectConfig),
    enforceApprovalForDirectRun: projectConfig.policy?.enforceApprovalForDirectRun === true ||
      projectConfig.hermes?.policy?.enforceApprovalForDirectRun === true
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

async function runValidationStage({ repo, runDir, step, attempt, validationCommands, manifest, previousOutputs, resources, runtime }) {
  const validationStageId = validationStageIdForAttempt(step, attempt);
  if (validationCommands.length === 0) {
    const skipped = {
      type: 'validation',
      stepId: validationStageId,
      status: 'skipped',
      reason: 'no validation commands configured'
    };
    await appendManifestStep(runDir, manifest, skipped);
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
      command: validation.command,
      timeoutMs: validation.timeoutMs || resources.validationTimeoutMs,
      maxLogBytes: validation.maxLogBytes || resources.maxLogBytes,
      runtime
    });
    await appendManifestStep(runDir, manifest, validationResult);
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

async function runInspectionStage({ repo, runDir, step, attempt, manifest, previousOutputs }) {
  const inspectionId = attempt <= 1 ? `after-${step.id}` : `after-${step.id}-retry-${attempt - 1}`;
  const result = await inspectChanges({
    repo,
    runDir,
    id: inspectionId,
    baselineStatusShort: manifest.git?.statusShort || ''
  });
  await appendManifestStep(runDir, manifest, result);

  return `${previousOutputs}\n\n## inspection:${result.id}\n${inspectionSummary(result)}`;
}

export async function runPipeline(options, request) {
  const repo = requireRepo(options.repo || process.cwd());
  if (!request) {
    throw new Error('Missing request.');
  }

  const config = await loadConfig();
  const projectConfigPath = path.join(repo, '.harness.json');
  let projectConfig = {};
  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(await readText(projectConfigPath));
    } catch (error) {
      throw new Error(`Invalid .harness.json: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const configValidation = validateProjectConfig(projectConfig, { harnessConfig: config });
  if (!configValidation.valid) {
    throw new Error(`Invalid .harness.json:\n${formatConfigValidationIssues(configValidation)}`);
  }

  const pipelineName = options.pipeline || projectConfig.pipeline;
  let selected = getPipeline(config, pipelineName);
  const agent = resolveAgentConfig({ options, projectConfig });
  const agentVersionCache = new Map();
  let runtime = null;
  async function cachedAgentVersion(stepAgent) {
    const key = `${stepAgent.name}\0${stepAgent.command}\0${JSON.stringify(stepAgent.versionArgs)}`;
    if (!agentVersionCache.has(key)) {
      agentVersionCache.set(key, await getAgentVersion(stepAgent, {
        skip: options.dryRun,
        runtime,
        cwd: runtime?.mode === 'docker' ? runtime.mounts[0] : process.cwd()
      }));
    }
    return agentVersionCache.get(key);
  }
  const validationCommands = validationCommandsFromProjectConfig(projectConfig);
  const supervisorConfig = supervisorConfigFromProjectConfig(projectConfig);
  const resources = resourceConfigFromProjectConfig(projectConfig);
  const policy = directRunPolicyFromProjectConfig(projectConfig);
  const basePolicyDecision = evaluatePolicy({
    request,
    policy,
    mode: 'direct'
  });
  const policyDecision = options.policyApproved
    ? {
        ...basePolicyDecision,
        allowed: true,
        requiresApproval: false,
        approved: true,
        reason: `Policy approval supplied; original decision: ${basePolicyDecision.reason}`
      }
    : basePolicyDecision;
  const runId = timestampId();
  const runDir = path.join(harnessRoot, 'runs', runId);
  await ensureDir(runDir);
  const workspaceMode = workspaceModeFromOptions(options, projectConfig);
  let workspace;
  try {
    workspace = await prepareWorkspace({
      repo,
      runDir,
      mode: workspaceMode,
      dryRun: options.dryRun
    });
  } catch (error) {
    const failedManifest = {
      schemaVersion: 1,
      runId,
      repo,
      request,
      pipeline: selected.pipelineName,
      dryRun: Boolean(options.dryRun),
      workspace: {
        mode: workspaceMode,
        originalRepo: repo,
        executionRepo: repo,
        prepared: false,
        error: error instanceof Error ? error.message : String(error)
      },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'failed',
      steps: []
    };
    await writeText(path.join(runDir, 'request.txt'), request + '\n');
    await saveManifest(runDir, failedManifest);
    throw error;
  }
  const executionRepo = workspace.executionRepo;
  runtime = runtimeRunnerFromOptions(options, projectConfig, {
    repo: executionRepo,
    runDir
  });
  if (!options.dryRun) {
    assertRuntimeRunnerAvailable(runtime);
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    repo,
    executionRepo,
    request,
    pipeline: selected.pipelineName,
    dryRun: Boolean(options.dryRun),
    agent: {
      provider: agent.name,
      command: agent.command,
      version: await cachedAgentVersion(agent),
      outputMode: agent.outputMode,
      defaultTimeoutMs: agent.defaultTimeoutMs,
      capabilities: agent.capabilities,
      custom: agent.custom
    },
    roleAgents: {
      hermes: projectConfig.supervisor?.agent || null,
      ...(projectConfig.agents || {})
    },
    nodeVersion: process.version,
    projectConfig,
    workspace,
    runtime,
    policy: {
      mode: 'direct',
      approved: Boolean(options.policyApproved),
      config: policy,
      decision: policyDecision
    },
    trustBoundary: trustBoundarySummary(projectConfig),
    validationCommands,
    resources,
    supervisor: supervisorConfig,
    git: await gitSnapshot(executionRepo),
    startedAt: new Date().toISOString(),
    steps: [],
    supervisorDecisions: [],
    pipelineChanges: []
  };
  await writeText(path.join(runDir, 'request.txt'), request + '\n');
  await saveManifest(runDir, manifest);

  console.error(`Harness run: ${runId}`);
  console.error(`Repo: ${repo}`);
  if (executionRepo !== repo) {
    console.error(`Execution repo: ${executionRepo}`);
  }
  console.error(`Pipeline: ${selected.pipelineName}`);
  console.error(`Agent: ${agent.name} (${agent.command})`);
  console.error(`Runner: ${runtime.mode}${runtime.image ? ` (${runtime.image})` : ''}`);
  console.error(`Run dir: ${runDir}`);

  if (!policyDecision.allowed && !options.dryRun) {
    manifest.finishedAt = new Date().toISOString();
    manifest.status = 'failed';
    manifest.failureReason = policyDecision.reason;
    await saveManifest(runDir, manifest);
    throw new Error(`Policy blocked this run: ${policyDecision.reason} See ${runDir}`);
  }

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
      repo: executionRepo,
      previousOutputs,
      projectConfig,
      validationCommands,
      supervisorInstructions
    });
    const promptPath = path.join(runDir, `${step.id}.prompt.md`);
    await writeText(promptPath, prompt);

    if (options.dryRun) {
      console.error(`[dry-run] ${step.id}`);
      await appendManifestStep(runDir, manifest, {
        type: 'agent',
        stepId: step.id,
        status: 'skipped',
        reason: 'dry-run',
        agent: stepAgent.name,
        command: stepAgent.command,
        agentVersion: stepAgentVersion,
      sandbox: step.sandbox || 'read-only',
      approval: step.approval || 'never',
      model: step.model || null,
      outputMode: stepAgent.outputMode,
      capabilities: stepAgent.capabilities,
      customAgent: stepAgent.custom,
      runtime: runtime.mode
    });

      if (validationAfter.has(baseStep.id)) {
        const skipped = {
          type: 'validation',
          stepId: `validation:after-${baseStep.id}`,
          status: 'skipped',
          reason: 'dry-run'
        };
        await appendManifestStep(runDir, manifest, skipped);
        previousOutputs += `\n\n## validation after ${step.id}\nSkipped because this was a dry run.`;
      }

      stepIndex += 1;
      continue;
    }

    console.error(`\n== ${step.id} ==`);
    const result = await runAgentStep({
      repo: executionRepo,
      runDir,
      step,
      prompt,
      promptPath,
      agent: stepAgent,
      resources,
      runtime
    });
    result.agentVersion = stepAgentVersion;
    await appendManifestStep(runDir, manifest, result);

    if (existsSync(result.finalPath)) {
      const output = await readText(result.finalPath);
      previousOutputs += `\n\n## ${step.id}\n${output}`;
    }

    if (result.exitCode !== 0) {
      manifest.finishedAt = new Date().toISOString();
      manifest.status = 'failed';
      manifest.workspace = await finalizeWorkspace({
        workspace: manifest.workspace,
        runDir
      });
      await saveManifest(runDir, manifest);
      throw new Error(`Step failed: ${step.id} (exit ${result.exitCode}). See ${runDir}`);
    }

    if (validationAfter.has(baseStep.id)) {
      const validationStage = await runValidationStage({
        repo: executionRepo,
        runDir,
        step: baseStep,
        attempt,
        validationCommands,
        manifest,
        previousOutputs,
        resources,
        runtime
      });
      previousOutputs = validationStage.previousOutputs;
      activeValidationFailures = validationStage.failures;
      previousOutputs = await runInspectionStage({
        repo: executionRepo,
        runDir,
        step: baseStep,
        attempt,
        manifest,
        previousOutputs
      });
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
      await saveManifest(runDir, manifest);

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
            repo: executionRepo,
            runDir,
            step: targetStep,
            attempt: validationAttempts[targetStep.id],
            validationCommands,
            manifest,
            previousOutputs,
            resources,
            runtime
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
          await saveManifest(runDir, manifest);
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

    if (baseStep.id === 'reporter' && existsSync(result.finalPath)) {
      const output = await readText(result.finalPath);
      manifest.reporterSummary = {
        ...parseReporterSummary(output),
        stepId: step.id,
        sourcePath: result.finalPath,
        createdAt: new Date().toISOString()
      };
      await saveManifest(runDir, manifest);
    }

    stepIndex += 1;
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.completedPipeline = selected.pipelineName;
  manifest.gitAfter = await gitSnapshot(executionRepo);
  manifest.workspace = await finalizeWorkspace({
    workspace: manifest.workspace,
    runDir
  });
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
  await saveManifest(runDir, manifest);
  console.error(`\nDone. Final report: ${path.join(runDir, `${selected.pipeline.steps.at(-1).id}.md`)}`);

  if (shouldStopAfterReporter) {
    throw new Error(`Hermes stopped the run (${supervisorTerminalStatus || 'failed'}). See ${runDir}`);
  }

  if (activeValidationFailures.length > 0) {
    throw new Error(`Validation failed (${activeValidationFailures.length} command(s)). See ${runDir}`);
  }
}
