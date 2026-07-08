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
import { evaluatePolicy, evaluateProtectedBranchPolicy, policyFromProjectConfig } from './policy.js';
import { finalizeWorkspace, prepareWorkspace, workspaceModeFromOptions } from './workspace.js';
import { parseReporterSummary } from './reporter-summary.js';
import { appendSupervisorInstructions, parseSupervisorDecision } from './supervisor.js';
import { gitSnapshot } from './git.js';
import { resourceConfigFromProjectConfig } from './resources.js';
import { appendManifestStep, saveManifest } from './manifest.js';
import { formatConfigValidationIssues, validateProjectConfig } from './config-validation.js';
import { assertRuntimeRunnerAvailable, runtimeRunnerContract, runtimeRunnerFromOptions } from './runtime-runner.js';
import { appendRuntimeSummary, createHarnessRuntime } from './middleware.js';
import { runToolLifecycle, toolConfigsFromProjectConfig } from './tools.js';
import { writePromptCacheArtifact } from './prompt-cache.js';
import { selectPipeline } from './pipeline-selection.js';
import { formatUsageSummary, summarizeManifestUsage } from './usage.js';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * PipelineExecutor는 단일 파이프라인 실행의 전체 수명주기(설정 로드 → 워크스페이스
 * 준비 → manifest 작성 → 정책 게이트 → 툴 셋업 → 스텝 루프 → 종료/정리)를
 * 담당한다. 기존 runPipeline God function을 동작 보존한 채 단계별 메서드로 분해한 것.
 *
 * 실행 상태(manifest, runDir, harnessRuntime, 루프 카운터 등)는 인스턴스 필드로
 * 공유하며, run()이 단계 메서드를 순서대로 호출한다.
 */
export class PipelineExecutor {
  constructor(options, request) {
    this.options = options;
    this.request = request;
    this.agentVersionCache = new Map();
    this.runtime = null;
    this.toolsTornDown = false;
    this.workspaceFinalized = false;
  }

  async run() {
    this.repo = requireRepo(this.options.repo || process.cwd());
    if (!this.request) {
      throw new Error('Missing request.');
    }

    await this.#loadAndValidateConfig();
    this.#resolveRunConfig();
    await this.#prepareWorkspaceAndRuntime();
    await this.#buildManifest();
    await this.#persistAndAnnounce();
    await this.#enforcePolicyGates();
    await this.#setupTools();
    this.#initLoopState();

    // 스텝 실행부 전체를 try/finally로 감싸, budget 초과나 예외 등 어떤 경로로
    // 빠져나가도 워크스페이스·툴 정리가 항상 실행되게 한다(정리 누수 방지).
    try {
      await this.#executeSteps();
      await this.#finalizeRun();
    } finally {
      // 어떤 경로로 빠져나가도(정상/throw/budget 초과) 정리를 보장한다. 둘 다 멱등.
      try {
        await this.#teardownTools();
      } catch (cleanupError) {
        this.harnessRuntime.recordEvent('cleanup:teardown-error', { error: String(cleanupError) });
      }
      try {
        await this.#ensureWorkspaceFinalized();
      } catch (cleanupError) {
        this.harnessRuntime.recordEvent('cleanup:finalize-error', { error: String(cleanupError) });
      }
    }
  }

  async #loadAndValidateConfig() {
    this.config = await loadConfig();
    const projectConfigPath = path.join(this.repo, '.harness.json');
    this.projectConfig = {};
    if (existsSync(projectConfigPath)) {
      try {
        this.projectConfig = JSON.parse(await readText(projectConfigPath));
      } catch (error) {
        throw new Error(`Invalid .harness.json: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    const configValidation = validateProjectConfig(this.projectConfig, { harnessConfig: this.config });
    if (!configValidation.valid) {
      throw new Error(`Invalid .harness.json:\n${formatConfigValidationIssues(configValidation)}`);
    }

    this.pipelineSelection = selectPipeline({
      request: this.request,
      requestedPipeline: this.options.pipeline || this.projectConfig.pipeline,
      projectConfig: this.projectConfig,
      harnessConfig: this.config
    });
    this.selected = getPipeline(this.config, this.pipelineSelection.selected);
    this.agent = resolveAgentConfig({ options: this.options, projectConfig: this.projectConfig });
  }

  #resolveRunConfig() {
    this.validationCommands = validationCommandsFromProjectConfig(this.projectConfig);
    this.supervisorConfig = supervisorConfigFromProjectConfig(this.projectConfig);
    this.resources = resourceConfigFromProjectConfig(this.projectConfig);
    this.harnessRuntime = createHarnessRuntime({ projectConfig: this.projectConfig });
    // 저장 산출물(request.txt·manifest)에는 redact된 요청을 쓴다.
    // 정책 판정·agent 전달용 prompt는 원문(raw)을 유지한다.
    this.redactedRequest = this.harnessRuntime.redactText(this.request, { surface: 'request' }).text;
    this.toolConfigs = toolConfigsFromProjectConfig(this.projectConfig);
    this.policy = directRunPolicyFromProjectConfig(this.projectConfig);
    const basePolicyDecision = evaluatePolicy({
      request: this.request,
      policy: this.policy,
      mode: 'direct'
    });
    this.policyDecision = this.options.policyApproved
      ? {
          ...basePolicyDecision,
          allowed: true,
          requiresApproval: false,
          approved: true,
          reason: `Policy approval supplied; original decision: ${basePolicyDecision.reason}`
        }
      : basePolicyDecision;
  }

  async #cachedAgentVersion(stepAgent) {
    const key = `${stepAgent.name}\0${stepAgent.command}\0${JSON.stringify(stepAgent.versionArgs)}`;
    if (!this.agentVersionCache.has(key)) {
      this.agentVersionCache.set(key, await getAgentVersion(stepAgent, {
        skip: this.options.dryRun,
        runtime: this.runtime,
        cwd: this.runtime?.mode === 'docker' ? this.runtime.mounts[0] : process.cwd()
      }));
    }
    return this.agentVersionCache.get(key);
  }

  async #prepareWorkspaceAndRuntime() {
    this.runId = timestampId();
    this.runDir = path.join(harnessRoot, 'runs', this.runId);
    await ensureDir(this.runDir);
    this.workspaceMode = workspaceModeFromOptions(this.options, this.projectConfig);
    this.protectedBranchDecision = await evaluateProtectedBranchPolicy({
      repo: this.repo,
      projectConfig: this.projectConfig,
      policy: this.policy
    });
    this.protectedBranchWriteBlocked = this.protectedBranchDecision.requiresApproval &&
      this.workspaceMode === 'direct' &&
      !this.options.dryRun &&
      !this.options.policyApproved;
    try {
      this.workspace = await prepareWorkspace({
        repo: this.repo,
        runDir: this.runDir,
        mode: this.workspaceMode,
        dryRun: this.options.dryRun
      });
    } catch (error) {
      const failedManifest = {
        schemaVersion: 1,
        runId: this.runId,
        repo: this.repo,
        request: this.redactedRequest,
        pipeline: this.selected.pipelineName,
        dryRun: Boolean(this.options.dryRun),
        workspace: {
          mode: this.workspaceMode,
          originalRepo: this.repo,
          executionRepo: this.repo,
          prepared: false,
          error: error instanceof Error ? error.message : String(error)
        },
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'failed',
        steps: []
      };
      await writeText(path.join(this.runDir, 'request.txt'), this.redactedRequest + '\n');
      await saveManifest(this.runDir, failedManifest);
      throw error;
    }
    this.executionRepo = this.workspace.executionRepo;
    this.runtime = runtimeRunnerFromOptions(this.options, this.projectConfig, {
      repo: this.executionRepo,
      runDir: this.runDir,
      reviewOnly: this.selected.pipelineName === 'review_only'
    });
    if (!this.options.dryRun) {
      assertRuntimeRunnerAvailable(this.runtime);
    }

    this.promptCache = await writePromptCacheArtifact({
      runDir: this.runDir,
      pipeline: {
        pipelineName: this.selected.pipelineName,
        steps: this.selected.pipeline.steps
      },
      projectConfig: this.projectConfig,
      validationCommands: this.validationCommands
    });
  }

  async #buildManifest() {
    this.manifest = {
      schemaVersion: 1,
      runId: this.runId,
      repo: this.repo,
      executionRepo: this.executionRepo,
      request: this.redactedRequest,
      pipeline: this.selected.pipelineName,
      pipelineSelection: this.pipelineSelection,
      dryRun: Boolean(this.options.dryRun),
      agent: {
        provider: this.agent.name,
        command: this.agent.command,
        version: await this.#cachedAgentVersion(this.agent),
        outputMode: this.agent.outputMode,
        defaultTimeoutMs: this.agent.defaultTimeoutMs,
        capabilities: this.agent.capabilities,
        custom: this.agent.custom
      },
      roleAgents: {
        hermes: this.projectConfig.supervisor?.agent || null,
        ...(this.projectConfig.agents || {})
      },
      nodeVersion: process.version,
      projectConfig: this.projectConfig,
      workspace: this.workspace,
      runtime: {
        ...this.runtime,
        contract: runtimeRunnerContract(this.runtime)
      },
      promptCache: this.promptCache,
      policy: {
        mode: 'direct',
        approved: Boolean(this.options.policyApproved),
        config: this.policy,
        decision: this.policyDecision,
        protectedBranch: {
          ...this.protectedBranchDecision,
          writeBlocked: this.protectedBranchWriteBlocked,
          workspaceMode: this.workspaceMode
        }
      },
      trustBoundary: trustBoundarySummary(this.projectConfig),
      validationCommands: this.validationCommands,
      tools: {
        configured: this.toolConfigs.map((tool) => ({
          id: tool.id,
          hasSetup: Boolean(tool.setupCommand),
          hasTeardown: Boolean(tool.teardownCommand),
          timeoutMs: tool.timeoutMs,
          maxLogBytes: tool.maxLogBytes,
          envAllowlist: tool.envAllowlist
        })),
        lifecycle: []
      },
      resources: this.resources,
      supervisor: this.supervisorConfig,
      git: await gitSnapshot(this.executionRepo),
      startedAt: new Date().toISOString(),
      steps: [],
      supervisorDecisions: [],
      pipelineChanges: []
    };
    appendRuntimeSummary(this.manifest, this.harnessRuntime);
    this.manifest.usageSummary = summarizeManifestUsage(this.manifest);
  }

  async #persistAndAnnounce() {
    await writeText(path.join(this.runDir, 'request.txt'), this.redactedRequest + '\n');
    await saveManifest(this.runDir, this.manifest);
    this.harnessRuntime.hook('run:start', {
      runId: this.runId,
      pipeline: this.selected.pipelineName,
      workspaceMode: this.workspaceMode,
      runner: this.runtime.mode
    });

    console.error(`Harness run: ${this.runId}`);
    console.error(`Repo: ${this.repo}`);
    if (this.executionRepo !== this.repo) {
      console.error(`Execution repo: ${this.executionRepo}`);
    }
    console.error(`Pipeline: ${this.selected.pipelineName}`);
    console.error(`Agent: ${this.agent.name} (${this.agent.command})`);
    console.error(`Runner: ${this.runtime.mode}${this.runtime.image ? ` (${this.runtime.image})` : ''}`);
    console.error(`Run dir: ${this.runDir}`);
  }

  async #enforcePolicyGates() {
    if (!this.policyDecision.allowed && !this.options.dryRun) {
      this.manifest.finishedAt = new Date().toISOString();
      this.manifest.status = 'failed';
      this.manifest.failureReason = this.policyDecision.reason;
      await saveManifest(this.runDir, this.manifest);
      throw new Error(`Policy blocked this run: ${this.policyDecision.reason} See ${this.runDir}`);
    }

    if (this.protectedBranchWriteBlocked) {
      this.manifest.finishedAt = new Date().toISOString();
      this.manifest.status = 'failed';
      this.manifest.failureReason = this.protectedBranchDecision.reason;
      await saveManifest(this.runDir, this.manifest);
      throw new Error(`Policy blocked direct writes on protected branch: ${this.protectedBranchDecision.branch}. Use workspaceMode=worktree/patch or approve explicitly. See ${this.runDir}`);
    }
  }

  async #setupTools() {
    if (!this.options.dryRun && this.toolConfigs.length > 0) {
      const setupResults = await runToolLifecycle({
        repo: this.executionRepo,
        runDir: this.runDir,
        tools: this.toolConfigs,
        phase: 'setup',
        runtime: this.runtime,
        redact: this.harnessRuntime.redactText,
        redactStream: this.harnessRuntime.redactStream
      });
      this.manifest.tools.lifecycle.push(...setupResults);
      this.harnessRuntime.state.counters.toolSetups += setupResults.filter((result) => result.status !== 'skipped').length;
      appendRuntimeSummary(this.manifest, this.harnessRuntime);
      await saveManifest(this.runDir, this.manifest);
      const failedSetup = setupResults.find((result) => result.status === 'failed');
      if (failedSetup) {
        throw new Error(`Tool setup failed: ${failedSetup.toolId}. See ${this.runDir}`);
      }
    }
  }

  #initLoopState() {
    this.previousOutputs = '';
    this.activeValidationFailures = [];
    this.validationAfter = new Set(this.selected.pipeline.validationAfter || []);
    this.stepAttempts = {};
    this.stepRetries = {};
    this.validationAttempts = {};
    this.supervisorTurns = 0;
    this.supervisorInstructions = '';
    this.supervisorTerminalStatus = null;
    this.shouldStopAfterReporter = false;
    this.escalatedToSafeFix = this.selected.pipelineName === 'safe_fix';
    this.stepIndex = 0;
  }

  async #saveRuntimeManifest() {
    appendRuntimeSummary(this.manifest, this.harnessRuntime);
    this.manifest.usageSummary = summarizeManifestUsage(this.manifest);
    await saveManifest(this.runDir, this.manifest);
  }

  async #teardownTools() {
    if (this.toolsTornDown || this.options.dryRun || this.toolConfigs.length === 0) {
      return [];
    }
    this.toolsTornDown = true;
    const teardownResults = await runToolLifecycle({
      repo: this.executionRepo,
      runDir: this.runDir,
      tools: this.toolConfigs,
      phase: 'teardown',
      runtime: this.runtime,
      redact: this.harnessRuntime.redactText,
      redactStream: this.harnessRuntime.redactStream
    });
    this.manifest.tools.lifecycle.push(...teardownResults);
    this.harnessRuntime.state.counters.toolTeardowns += teardownResults.filter((result) => result.status !== 'skipped').length;
    return teardownResults;
  }

  async #ensureWorkspaceFinalized() {
    if (this.workspaceFinalized) return;
    this.workspaceFinalized = true;
    this.manifest.workspace = await finalizeWorkspace({ workspace: this.manifest.workspace, runDir: this.runDir });
  }

  async #runAgentWithRetry({ step, baseStep, prompt, promptPath, stepAgent, stepAgentVersion }) {
    const fallbackAgents = this.harnessRuntime.retry.fallbackAgents.map((agentConfig) => resolveAgentConfig({
      options: {},
      projectConfig: {
        agent: agentConfig
      }
    }));
    const candidates = [stepAgent, ...fallbackAgents];
    let lastResult = null;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const candidateVersion = candidateIndex === 0
        ? stepAgentVersion
        : await this.#cachedAgentVersion(candidate);
      const maxAttempts = this.harnessRuntime.retry.agentRetries + 1;

      if (candidateIndex > 0) {
        this.harnessRuntime.state.counters.fallbacks += 1;
        this.harnessRuntime.recordEvent('fallback:agent', {
          stepId: step.id,
          from: candidates[candidateIndex - 1].name,
          to: candidate.name
        });
      }

      for (let retryAttempt = 1; retryAttempt <= maxAttempts; retryAttempt += 1) {
        this.harnessRuntime.assertBudget('agent');
        this.harnessRuntime.hook('step:before', {
          stepId: step.id,
          baseStepId: baseStep.id,
          agent: candidate.name,
          attempt: retryAttempt,
          fallbackIndex: candidateIndex
        });
        const result = await runAgentStep({
          repo: this.executionRepo,
          runDir: this.runDir,
          step,
          prompt,
          promptPath,
          agent: candidate,
          resources: this.resources,
          runtime: this.runtime,
          redact: this.harnessRuntime.redactText,
          redactStream: this.harnessRuntime.redactStream
        });
        result.agentVersion = candidateVersion;
        result.retryAttempt = retryAttempt;
        result.fallbackIndex = candidateIndex;
        const retryDecision = this.harnessRuntime.shouldRetryResult(result, 'agent');
        result.retryable = retryDecision.retryable;
        result.retryReason = retryDecision.reason;
        await appendManifestStep(this.runDir, this.manifest, result);
        this.harnessRuntime.hook('step:after', {
          stepId: step.id,
          status: result.status,
          exitCode: result.exitCode,
          agent: candidate.name,
          attempt: retryAttempt,
          fallbackIndex: candidateIndex
        });
        lastResult = result;

        if (result.exitCode === 0) {
          return result;
        }

        if (retryAttempt < maxAttempts && retryDecision.retryable) {
          this.harnessRuntime.state.counters.retries += 1;
          this.harnessRuntime.recordEvent('retry:agent', {
            stepId: step.id,
            agent: candidate.name,
            nextAttempt: retryAttempt + 1,
            reason: retryDecision.reason
          });
          if (this.harnessRuntime.retry.backoffMs > 0) {
            await sleep(this.harnessRuntime.retry.backoffMs);
          }
        }
      }

      if (lastResult && lastResult.exitCode !== 0 && !lastResult.retryable) {
        return lastResult;
      }
    }

    return lastResult;
  }

  async #runValidationStage({ step, attempt }) {
    const { runDir, harnessRuntime, resources, runtime } = this;
    const repo = this.executionRepo;
    const validationCommands = this.validationCommands;
    const manifest = this.manifest;
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
        previousOutputs: `${this.previousOutputs}\n\n## ${validationStageId}\nNo validation commands configured.`
      };
    }

    const failures = [];
    let nextPreviousOutputs = this.previousOutputs;

    for (const validation of validationCommands) {
      const validationId = validationIdForAttempt(validation, step, attempt);
      let validationResult = null;
      const maxAttempts = harnessRuntime.retry.validationRetries + 1;
      for (let validationAttempt = 1; validationAttempt <= maxAttempts; validationAttempt += 1) {
        harnessRuntime.assertBudget('validation');
        harnessRuntime.hook('validation:before', {
          id: validationId,
          attempt: validationAttempt,
          maxAttempts
        });
        console.error(`\n== validation:${validationId}${validationAttempt > 1 ? ` (attempt ${validationAttempt})` : ''} ==`);
        validationResult = await runValidationCommand({
          repo,
          runDir,
          id: validationAttempt > 1 ? `${validationId}-attempt-${validationAttempt}` : validationId,
          command: validation.command,
          timeoutMs: validation.timeoutMs || resources.validationTimeoutMs,
          maxLogBytes: validation.maxLogBytes || resources.maxLogBytes,
          runtime,
          redact: harnessRuntime.redactText,
          redactStream: harnessRuntime.redactStream
        });
        validationResult.retryAttempt = validationAttempt;
        const retryDecision = harnessRuntime.shouldRetryResult(validationResult, 'validation');
        validationResult.retryable = retryDecision.retryable;
        validationResult.retryReason = retryDecision.reason;
        await appendManifestStep(runDir, manifest, validationResult);
        harnessRuntime.hook('validation:after', {
          id: validationResult.id,
          attempt: validationAttempt,
          status: validationResult.status,
          exitCode: validationResult.exitCode
        });

        if (validationResult.exitCode === 0 || validationAttempt >= maxAttempts || !retryDecision.retryable) {
          break;
        }

        harnessRuntime.state.counters.retries += 1;
        harnessRuntime.recordEvent('retry:validation', {
          id: validationResult.id,
          nextAttempt: validationAttempt + 1,
          reason: retryDecision.reason
        });
        if (harnessRuntime.retry.backoffMs > 0) {
          await sleep(harnessRuntime.retry.backoffMs);
        }
      }

      nextPreviousOutputs += `\n\n## validation:${validationResult.id}\n${validationSummary(validationResult)}`;

      if (validationResult.exitCode !== 0) {
        failures.push(validationResult);
      }
    }

    return {
      failures,
      previousOutputs: harnessRuntime.trimPreviousOutputs(nextPreviousOutputs, {
        stepId: step.id,
        stage: 'validation'
      })
    };
  }

  async #runInspectionStage({ step, attempt }) {
    const { runDir, manifest } = this;
    const repo = this.executionRepo;
    const inspectionId = attempt <= 1 ? `after-${step.id}` : `after-${step.id}-retry-${attempt - 1}`;
    const result = await inspectChanges({
      repo,
      runDir,
      id: inspectionId,
      baselineStatusShort: manifest.git?.statusShort || ''
    });
    await appendManifestStep(runDir, manifest, result);

    return `${this.previousOutputs}\n\n## inspection:${result.id}\n${inspectionSummary(result)}`;
  }

  async #executeSteps() {
    while (this.stepIndex < this.selected.pipeline.steps.length) {
      const baseStep = this.selected.pipeline.steps[this.stepIndex];

      if (!this.supervisorConfig.enabled && baseStep.id === HERMES_STEP_ID) {
        this.stepIndex += 1;
        continue;
      }

      this.stepAttempts[baseStep.id] = (this.stepAttempts[baseStep.id] || 0) + 1;
      const attempt = this.stepAttempts[baseStep.id];
      const step = stepForAttempt(baseStep, attempt);
      const stepAgent = resolveStepAgent({ defaultAgent: this.agent, projectConfig: this.projectConfig, stepId: baseStep.id });
      const stepAgentVersion = await this.#cachedAgentVersion(stepAgent);

      if (baseStep.id === 'reporter') {
        appendRuntimeSummary(this.manifest, this.harnessRuntime);
        this.manifest.usageSummary = summarizeManifestUsage(this.manifest);
        this.previousOutputs = `${this.previousOutputs}\n\n## harness usage summary\n${formatUsageSummary(this.manifest.usageSummary)}`;
      }

      const rawPrompt = await renderPrompt(step, {
        request: this.request,
        repo: this.executionRepo,
        previousOutputs: this.previousOutputs,
        projectConfig: this.projectConfig,
        validationCommands: this.validationCommands,
        supervisorInstructions: this.supervisorInstructions
      });
      const prompt = this.harnessRuntime.redactText(rawPrompt, {
        surface: 'prompt',
        stepId: step.id
      }).text;
      const promptPath = path.join(this.runDir, `${step.id}.prompt.md`);
      await writeText(promptPath, prompt);

      if (this.options.dryRun) {
        this.harnessRuntime.hook('step:dry-run', {
          stepId: step.id,
          agent: stepAgent.name
        });
        console.error(`[dry-run] ${step.id}`);
        await appendManifestStep(this.runDir, this.manifest, {
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
          runtime: this.runtime.mode
        });

        if (this.validationAfter.has(baseStep.id)) {
          const skipped = {
            type: 'validation',
            stepId: `validation:after-${baseStep.id}`,
            status: 'skipped',
            reason: 'dry-run'
          };
          await appendManifestStep(this.runDir, this.manifest, skipped);
          this.previousOutputs += `\n\n## validation after ${step.id}\nSkipped because this was a dry run.`;
        }

        this.stepIndex += 1;
        continue;
      }

      console.error(`\n== ${step.id} ==`);
      const result = await this.#runAgentWithRetry({
        step,
        baseStep,
        prompt,
        promptPath,
        stepAgent,
        stepAgentVersion
      });

      if (existsSync(result.finalPath)) {
        const output = this.harnessRuntime.redactText(await readText(result.finalPath), {
          surface: 'agent.final',
          stepId: step.id
        }).text;
        this.previousOutputs = this.harnessRuntime.trimPreviousOutputs(
          `${this.previousOutputs}\n\n## ${step.id}\n${this.harnessRuntime.trimStepOutput(output, { stepId: step.id })}`,
          { stepId: step.id }
        );
      }

      if (result.exitCode !== 0) {
        this.manifest.finishedAt = new Date().toISOString();
        this.manifest.status = 'failed';
        this.manifest.workspace = await finalizeWorkspace({
          workspace: this.manifest.workspace,
          runDir: this.runDir
        });
        await this.#teardownTools();
        await this.#saveRuntimeManifest();
        throw new Error(`Step failed: ${step.id} (exit ${result.exitCode}). See ${this.runDir}`);
      }

      if (this.validationAfter.has(baseStep.id)) {
        const validationStage = await this.#runValidationStage({
          step: baseStep,
          attempt
        });
        this.previousOutputs = validationStage.previousOutputs;
        this.activeValidationFailures = validationStage.failures;
        this.previousOutputs = await this.#runInspectionStage({
          step: baseStep,
          attempt
        });
        this.previousOutputs = this.harnessRuntime.trimPreviousOutputs(this.previousOutputs, {
          stepId: baseStep.id,
          stage: 'inspection'
        });
      }

      if (baseStep.id === HERMES_STEP_ID && existsSync(result.finalPath)) {
        const handled = await this.#handleSupervisorDecision({ result, step });
        if (handled) {
          continue;
        }
      }

      if (baseStep.id === 'reporter' && existsSync(result.finalPath)) {
        const output = await readText(result.finalPath);
        this.manifest.reporterSummary = {
          ...parseReporterSummary(output),
          stepId: step.id,
          sourcePath: result.finalPath,
          createdAt: new Date().toISOString()
        };
        await this.#saveRuntimeManifest();
      }

      this.stepIndex += 1;
    }
  }

  /**
   * Hermes 감독자 결정을 적용한다. 다음 스텝 인덱스를 스스로 갱신한 분기는 true를
   * 반환해 루프가 continue 하도록 하고, 어떤 분기에도 걸리지 않으면 false를 반환해
   * 기본 흐름(reporter 처리 → stepIndex+=1)으로 폴스루하게 한다.
   */
  async #handleSupervisorDecision({ result, step }) {
    this.supervisorTurns += 1;
    const output = await readText(result.finalPath);
    this.harnessRuntime.hook('hermes:before-decision', {
      stepId: step.id,
      sourcePath: result.finalPath
    });
    const decision = parseSupervisorDecision(output);
    const decisionRecord = {
      ...decision,
      turn: this.supervisorTurns,
      stepId: step.id,
      sourcePath: result.finalPath,
      createdAt: new Date().toISOString()
    };
    this.manifest.supervisorDecisions.push(decisionRecord);
    this.harnessRuntime.hook('hermes:after-decision', {
      nextAction: decision.nextAction,
      status: decision.status,
      turn: this.supervisorTurns
    });
    await this.#saveRuntimeManifest();

    console.error(`Hermes decision: ${decision.nextAction} (${decision.status})`);

    if (decision.nextAction === 'continue') {
      this.supervisorTerminalStatus = decision.status;
      this.stepIndex += 1;
      return true;
    }

    if (decision.nextAction === 'run_validation') {
      const targetStep = findValidationTargetStep(this.selected.pipeline.steps, this.validationAfter, decision.targetStep);
      if (targetStep && this.supervisorTurns < this.supervisorConfig.maxSupervisorTurns) {
        this.validationAttempts[targetStep.id] = (this.validationAttempts[targetStep.id] || this.stepAttempts[targetStep.id] || 0) + 1;
        this.supervisorInstructions = appendSupervisorInstructions('', decision);
        this.previousOutputs = appendSupervisorInstructions(this.previousOutputs, decision);
        const validationStage = await this.#runValidationStage({
          step: targetStep,
          attempt: this.validationAttempts[targetStep.id]
        });
        this.previousOutputs = validationStage.previousOutputs;
        this.activeValidationFailures = validationStage.failures;
        this.stepIndex = findStepIndex(this.selected.pipeline.steps, HERMES_STEP_ID);
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.previousOutputs += `\n\n## hermes validation rerun not performed\n` +
        `targetStep: ${decision.targetStep || '(auto)'}\n` +
        `reason: validation target was unavailable or supervisor turn limit was reached.`;
      this.stepIndex += 1;
      return true;
    }

    if (decision.nextAction === 'escalate_to_safe_fix') {
      if (!this.escalatedToSafeFix && this.config.pipelines.safe_fix && this.supervisorTurns < this.supervisorConfig.maxSupervisorTurns) {
        const previousPipeline = this.selected.pipelineName;
        this.selected = getPipeline(this.config, 'safe_fix');
        this.validationAfter = new Set(this.selected.pipeline.validationAfter || []);
        this.escalatedToSafeFix = true;
        this.supervisorInstructions = appendSupervisorInstructions('', decision);
        this.previousOutputs = appendSupervisorInstructions(this.previousOutputs, decision);
        this.manifest.pipelineChanges.push({
          from: previousPipeline,
          to: this.selected.pipelineName,
          reason: decision.reason,
          instructions: decision.instructions,
          turn: this.supervisorTurns,
          createdAt: new Date().toISOString()
        });
        await this.#saveRuntimeManifest();
        this.stepIndex = 0;
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.previousOutputs += `\n\n## hermes escalation not performed\n` +
        `reason: safe_fix was unavailable, already active, or supervisor turn limit was reached.`;
      this.stepIndex += 1;
      return true;
    }

    if (decision.nextAction === 'stop_failed' || decision.nextAction === 'request_human_review') {
      this.supervisorTerminalStatus = decision.status;
      this.shouldStopAfterReporter = true;
      this.stepIndex += 1;
      return true;
    }

    if (decision.nextAction === 'rerun_step') {
      const targetIndex = findStepIndex(this.selected.pipeline.steps, decision.targetStep);
      const canRerun = targetIndex >= 0 && targetIndex < this.stepIndex && decision.targetStep !== HERMES_STEP_ID;
      const retryCount = this.stepRetries[decision.targetStep] || 0;

      if (canRerun && retryCount < this.supervisorConfig.maxStepRetries && this.supervisorTurns < this.supervisorConfig.maxSupervisorTurns) {
        this.stepRetries[decision.targetStep] = retryCount + 1;
        this.supervisorInstructions = appendSupervisorInstructions('', decision);
        this.previousOutputs = appendSupervisorInstructions(this.previousOutputs, decision);
        this.stepIndex = targetIndex;
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.previousOutputs += `\n\n## hermes rerun not performed\n` +
        `targetStep: ${decision.targetStep || '(none)'}\n` +
        `reason: rerun was not allowed, target was unavailable, or retry limits were reached.`;
      this.stepIndex += 1;
      return true;
    }

    return false;
  }

  async #finalizeRun() {
    this.manifest.finishedAt = new Date().toISOString();
    this.manifest.completedPipeline = this.selected.pipelineName;
    this.manifest.gitAfter = await gitSnapshot(this.executionRepo);
    await this.#ensureWorkspaceFinalized();
    const teardownResults = await this.#teardownTools();
    if (this.supervisorTerminalStatus === 'failed' || this.shouldStopAfterReporter || this.activeValidationFailures.length > 0) {
      this.manifest.status = 'failed';
    } else if (teardownResults.some((result) => result.status === 'failed')) {
      this.manifest.status = 'failed';
      this.manifest.failureReason = 'tool teardown failed';
    } else if (this.supervisorTerminalStatus === 'incomplete') {
      this.manifest.status = 'incomplete';
    } else {
      this.manifest.status = 'succeeded';
    }
    this.manifest.cleanup = await runCleanupHook({
      projectConfig: this.projectConfig,
      currentRunId: this.runId,
      dryRun: this.options.dryRun
    });
    this.harnessRuntime.hook('run:finish', {
      status: this.manifest.status,
      completedPipeline: this.manifest.completedPipeline
    });
    await this.#saveRuntimeManifest();
    console.error(`\nDone. Final report: ${path.join(this.runDir, `${this.selected.pipeline.steps.at(-1).id}.md`)}`);

    if (this.shouldStopAfterReporter) {
      throw new Error(`Hermes stopped the run (${this.supervisorTerminalStatus || 'failed'}). See ${this.runDir}`);
    }

    if (this.activeValidationFailures.length > 0) {
      throw new Error(`Validation failed (${this.activeValidationFailures.length} command(s)). See ${this.runDir}`);
    }
  }
}

export async function runPipeline(options, request) {
  return new PipelineExecutor(options, request).run();
}
