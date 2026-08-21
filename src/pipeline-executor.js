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
import { evaluateChangeRisk, evaluatePolicy, evaluateProtectedBranchPolicy, policyFromProjectConfig } from './policy.js';
import { carryUncommittedFromConfig, finalizeWorkspace, prepareWorkspace, workspaceModeFromOptions, workspaceModeIsExplicit } from './workspace.js';
import { parseReporterSummary } from './reporter-summary.js';
import { classifyFailure, formatFailure } from './failure.js';
import { continuationRecord, formatContinuationContext, loadContinuation } from './continuation.js';
import { buildDeterministicReport, reporterModeFromProjectConfig } from './reporter-deterministic.js';
import { appendSupervisorInstructions, parseSupervisorDecision, supervisorInstructionsSection } from './supervisor.js';
import { gitSnapshot } from './git.js';
import { resourceConfigFromProjectConfig } from './resources.js';
import { appendManifestStep, saveManifest } from './manifest.js';
import { formatConfigValidationIssues, validateProjectConfig } from './config-validation.js';
import { assertRuntimeRunnerAvailable, runtimeRunnerContract, runtimeRunnerFromOptions } from './runtime-runner.js';
import { appendRuntimeSummary, createHarnessRuntime } from './middleware.js';
import { runToolLifecycle, toolConfigsFromProjectConfig } from './tools.js';
import { writePromptCacheArtifact } from './prompt-cache.js';
import { selectPipeline } from './pipeline-selection.js';
import { ContextLedger, contextSelectionFromProjectConfig } from './context-ledger.js';
import { billingModeFromProjectConfig, formatUsageSummary, summarizeManifestUsage } from './usage.js';

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

  const escalation = supervisor.escalation || {};
  return {
    enabled: supervisor.enabled !== false,
    maxSupervisorTurns,
    maxStepRetries,
    escalation: {
      // 안전 기본값: 기존처럼 승격 시 파이프라인을 처음부터 다시 돈다.
      skipCompletedSteps: escalation.skipCompletedSteps === true
    },
    // validation이 실패한 상태에서 supervisor가 continue를 내면 재검증을 한 번
    // 강제한다. 명시적으로 false를 준 경우에만 끈다.
    forceRevalidateOnFailure: supervisor.forceRevalidateOnFailure !== false
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
    // C2b 하드 블록(옵트인): 실제 diff가 승인을 요구하면 런을 완료로 진행시키지 않는다.
    this.blockOnChangeRisk = policyFromProjectConfig(this.projectConfig).blockOnChangeRisk === true;
    // 쓰기 스텝이 돌았는데 변경 0건이면 런을 차단한다(옵트인).
    this.blockOnNoChanges = policyFromProjectConfig(this.projectConfig).blockOnNoChanges === true;
    // reporter를 LLM 대신 manifest 기반 결정론 생성으로 만들지(옵트인).
    this.reporterMode = reporterModeFromProjectConfig(this.projectConfig);
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
    // 이어받기: 이전 run의 변경과 맥락을 가져온다. 실행 중 스텝에 끼어들 수는
    // 없지만, 끝난 run 위에 다음 지시를 쌓을 수는 있다.
    this.continuation = this.options.continueFrom
      ? await loadContinuation(this.options.continueFrom)
      : null;
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
        dryRun: this.options.dryRun,
        carryUncommitted: carryUncommittedFromConfig(this.options, this.projectConfig),
        explicitMode: workspaceModeIsExplicit(this.options, this.projectConfig),
        basePatchPath: this.continuation?.patchPath || null
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
    // 기본 격리가 불가능해 direct로 내려갔다면 실제 모드를 반영한다. 이후의
    // 보호 브랜치 판단 등이 실제 실행 방식과 어긋나면 안 된다.
    if (this.workspace.fallbackFrom) {
      this.workspaceMode = this.workspace.mode;
      console.error(
        `Workspace: fell back to ${this.workspace.mode} (${this.workspace.fallbackReason})`
      );
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
        custom: this.agent.custom,
        // 사용자가 선언한 과금 모델. 하네스는 요금제를 알 수 없으므로 기본은 unknown이고,
        // 비용 표기는 그때 환산값임을 드러낸다.
        billing: billingModeFromProjectConfig(this.projectConfig)
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
      continuedFrom: this.continuation
        ? continuationRecord(this.continuation, { patchApplied: this.workspace.basePatchApplied === true })
        : null,
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
    if (this.continuation) {
      const applied = this.manifest.continuedFrom?.patchApplied;
      console.error(
        `Continuing from: ${this.continuation.runId}`
          + (applied ? ' (previous changes carried into this workspace)' : ' (context only, no patch carried)')
      );
    }
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
    // 컨텍스트는 누적 문자열이 아니라 섹션 원장으로 관리한다. 선별이 꺼져 있으면
    // render() 결과가 기존 누적 문자열과 바이트 동일하다.
    this.context = new ContextLedger({
      selection: contextSelectionFromProjectConfig(this.projectConfig)
    });
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
    // 승격 시 이미 끝낸 작업을 다시 돌리지 않기 위해 실행한 base step을 기록한다.
    this.executedSteps = new Set();
    // 잘못된 continue를 재검증으로 되돌리는 것은 run당 1회다. 무제한이면
    // continue -> 재검증 -> continue -> ... 로 루프가 된다.
    this.forcedRevalidations = 0;
    // 이어받은 맥락을 첫 스텝부터 볼 수 있게 원장 맨 앞에 넣는다.
    if (this.continuation) {
      this.context.push({
        kind: 'note',
        text: formatContinuationContext(this.continuation)
      });
    }
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
        // 실제 소모량을 누적한다. 다음 스텝 시작 시 budget 상한 검사에 쓰인다.
        this.harnessRuntime.recordUsage(result.usage);
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
      this.context.push({
        kind: 'validation',
        baseStepId: step.id,
        stepId: validationStageId,
        text: `## ${validationStageId}\nNo validation commands configured.`
      });
      return { failures: [] };
    }

    const failures = [];

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

      this.context.push({
        kind: 'validation',
        baseStepId: step.id,
        stepId: validationResult.id,
        text: `## validation:${validationResult.id}\n${validationSummary(validationResult)}`
      });

      if (validationResult.exitCode !== 0) {
        failures.push(validationResult);
      }
    }

    return { failures };
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
    // C2b: 실제 diff에 근거해 승인 필요 여부를 판정(위험 경로 변경·secret 노출).
    // 키워드 텍스트가 아니라 변경 자체를 본다. 추가만 하며 제어 흐름은 바꾸지 않고
    // manifest·supervisor 컨텍스트에 노출한다.
    const changeRisk = evaluateChangeRisk({ inspection: result, policy: policyFromProjectConfig(this.projectConfig) });
    result.policyAssessment = changeRisk;
    // 하드 블록 게이트가 참조할 최신 변경 위험 판정을 보관.
    this.changeRiskAssessment = { step: step.id, ...changeRisk };
    await appendManifestStep(runDir, manifest, result);

    // 쓰기 스텝이 돌았는데 변경이 0건이면 이상 신호다. validation은 통과할 수 있다
    // (빌드가 기존 상태로 성공). 실제 run에서 hermes가 "build 통과는 기존 스캐폴드
    // 확인일 뿐 성공 근거 아님"이라며 stop_failed를 낸 사례가 있고, 그 판단의 근거는
    // 이미 manifest에 있었다. LLM을 부르기 전에 결정론적으로 잡을 수 있는 신호다.
    const writeStepRan = this.executedSteps.has('coder');
    const changedCount = Array.isArray(result.changedFiles) ? result.changedFiles.length : 0;
    this.noChangeAssessment = {
      step: step.id,
      writeStepRan,
      changedFiles: changedCount,
      // dry-run은 애초에 아무것도 실행하지 않으므로 신호로 삼지 않는다.
      suspicious: writeStepRan && changedCount === 0 && !this.options.dryRun
    };
    result.noChangeAssessment = this.noChangeAssessment;

    const assessmentLine = changeRisk.requiresApproval
      ? `policyAssessment: requires human approval\n${changeRisk.reasons.map((reason) => `- ${reason}`).join('\n')}`
      : 'policyAssessment: no additional approval required';
    const noChangeLine = this.noChangeAssessment.suspicious
      ? '\nchangeAssessment: write step ran but produced no changes. Validation success here does not prove the request was implemented.'
      : '';
    this.context.push({
      kind: 'inspection',
      baseStepId: step.id,
      stepId: result.id,
      text: `## inspection:${result.id}\n${inspectionSummary(result)}\n${assessmentLine}${noChangeLine}`
    });
  }

  // C2b 하드 블록: inspection이 실제 diff에서 승인 필요를 판정했고, 옵트인
  // (policy.blockOnChangeRisk)이며, 명시 승인(--policy-approved)이 없고 dry-run이
  // 아니면 런을 차단한다. 하네스는 자동 커밋/머지하지 않으므로 '차단'은 남은
  // 스텝을 멈추고 런을 실패로 종료해 완료 신호를 주지 않는 것을 뜻한다. 격리
  // 모드의 변경은 changes.patch로 보존되어 검토 가능하다.
  async #enforceChangeRiskGate({ step }) {
    const assessment = this.changeRiskAssessment;
    if (!assessment?.requiresApproval) {
      return;
    }
    if (this.options.dryRun || this.options.policyApproved || !this.blockOnChangeRisk) {
      return;
    }

    const reasonText = assessment.reasons.join('; ');
    this.manifest.finishedAt = new Date().toISOString();
    this.manifest.status = 'failed';
    this.manifest.failureReason = `Change-risk policy blocked the run after ${step.id}: ${reasonText}`;
    this.manifest.policyBlock = { kind: 'change-risk', step: step.id, reasons: assessment.reasons };
    this.manifest.workspace = await finalizeWorkspace({
      workspace: this.manifest.workspace,
      runDir: this.runDir
    });
    await this.#teardownTools();
    await this.#saveRuntimeManifest();
    const reviewTarget = this.manifest.workspace?.patchPath || this.runDir;
    throw new Error(
      `Policy blocked this run: risky change detected after ${step.id} (${reasonText}). `
      + `Review ${reviewTarget}, then re-run with --policy-approved to proceed.`
    );
  }

  /**
   * 변경 0건 하드 게이트(옵트인). 쓰기 스텝이 돌았는데 아무것도 바뀌지 않았다면
   * 요청이 이행되지 않은 것이다. validation은 이 경우에도 통과할 수 있으므로
   * (기존 상태로 빌드 성공) validation 결과만으로는 잡히지 않는다.
   *
   * 기본은 off다. coder가 "이미 고쳐져 있어 변경할 게 없다"고 정당하게 판단하는
   * 경우가 있고, 그때는 hermes가 맥락을 보고 판단하는 편이 낫다. 켜면 hermes를
   * 호출하기 전에 런을 끝내므로 provider 호출도 아낀다.
   */
  async #enforceNoChangeGate({ step }) {
    if (!this.noChangeAssessment?.suspicious || !this.blockOnNoChanges) {
      return;
    }
    if (this.options.dryRun || this.options.policyApproved) {
      return;
    }

    const reason = `write step ran but produced no changes after ${step.id}`;
    this.manifest.finishedAt = new Date().toISOString();
    this.manifest.status = 'failed';
    this.manifest.failureReason = `No-change policy blocked the run: ${reason}.`;
    this.manifest.policyBlock = { kind: 'no-change', step: step.id, changedFiles: 0 };
    this.manifest.workspace = await finalizeWorkspace({
      workspace: this.manifest.workspace,
      runDir: this.runDir
    });
    await this.#teardownTools();
    await this.#saveRuntimeManifest();
    throw new Error(
      `Policy blocked this run: ${reason}. The request appears unimplemented even though validation may have passed. `
      + `Review ${this.runDir}, then re-run with --policy-approved if this is expected.`
    );
  }

  /**
   * manifest만으로 최종 보고서를 만든다(LLM 호출 없음).
   *
   * agent reporter와 같은 산출물 계약을 지킨다: `<stepId>.md` 파일과
   * manifest.reporterSummary. 다만 provider를 호출하지 않으므로 usage는 0이다.
   */
  async #runDeterministicReporter({ step }) {
    const startedAt = new Date();
    const finalPath = path.join(this.runDir, `${step.id}.md`);
    const report = buildDeterministicReport({ manifest: this.manifest, request: this.request });
    const markdown = this.harnessRuntime.redactText(report.markdown, {
      surface: 'reporter.deterministic',
      stepId: step.id
    }).text;
    await writeText(finalPath, markdown);
    const finishedAt = new Date();

    await appendManifestStep(this.runDir, this.manifest, {
      type: 'agent',
      stepId: step.id,
      status: 'succeeded',
      exitCode: 0,
      agent: 'harness',
      command: '(deterministic)',
      generator: 'deterministic',
      runtime: this.runtime.mode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      finalPath
    });

    this.manifest.reporterSummary = {
      ...report.summary,
      valid: true,
      schemaErrors: [],
      generator: 'deterministic',
      stepId: step.id,
      sourcePath: finalPath,
      createdAt: new Date().toISOString()
    };
    this.harnessRuntime.recordEvent('reporter:deterministic', {
      stepId: step.id,
      status: report.summary.status,
      changedFiles: report.summary.changedFiles.length,
      risks: report.summary.risks.length
    });
    await this.#saveRuntimeManifest();
    console.error(`\n== ${step.id} (deterministic) ==`);
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
      // stepForAttempt는 attempt<=1이면 원본을 그대로 돌려주므로 복사해서 쓴다.
      // 파이프라인 정의를 실행 중에 변형하면 안 된다.
      const step = { ...stepForAttempt(baseStep, attempt) };
      const stepAgent = resolveStepAgent({ defaultAgent: this.agent, projectConfig: this.projectConfig, stepId: baseStep.id });
      // 설정에서 온 모델을 step에 반영한다. 파이프라인 정의에 model이 있으면 그것이 우선.
      if (!step.model && stepAgent.model) {
        step.model = stepAgent.model;
      }
      const stepAgentVersion = await this.#cachedAgentVersion(stepAgent);

      if (baseStep.id === 'reporter') {
        appendRuntimeSummary(this.manifest, this.harnessRuntime);
        this.manifest.usageSummary = summarizeManifestUsage(this.manifest);
        this.context.push({
          kind: 'usage',
          baseStepId: baseStep.id,
          text: `## harness usage summary\n${formatUsageSummary(this.manifest.usageSummary, { billing: this.manifest.agent.billing })}`
        });
      }

      const contextStats = this.context.stats(baseStep.id);
      if (contextStats.applied) {
        this.harnessRuntime.recordEvent('context:selection', contextStats);
      }
      // reporter가 결정론 모드면 provider를 호출하지 않는다. usage summary는 바로
      // 위에서 갱신됐으므로 보고서에 그대로 실린다.
      if (baseStep.id === 'reporter' && this.reporterMode === 'deterministic' && !this.options.dryRun) {
        this.executedSteps.add(baseStep.id);
        await this.#runDeterministicReporter({ step });
        this.stepIndex += 1;
        continue;
      }

      // reporter가 결정론이면 hermes 산문의 소비자가 없다. 평가 지시는 그대로 두고
      // 출력 형식만 압축한 프롬프트로 바꿔 output 토큰을 줄인다(실측에서 hermes
      // output이 coder의 7배였다). 추론 깊이는 건드리지 않는다.
      const promptStep = baseStep.id === HERMES_STEP_ID && this.reporterMode === 'deterministic'
        ? { ...step, prompt: 'prompts/hermes-concise.md' }
        : step;
      const rawPrompt = await renderPrompt(promptStep, {
        request: this.request,
        repo: this.executionRepo,
        previousOutputs: this.harnessRuntime.trimPreviousOutputs(
          this.context.render(baseStep.id),
          { stepId: baseStep.id, stage: 'prompt' }
        ),
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
          this.context.push({
            kind: 'validation',
            baseStepId: baseStep.id,
            text: `## validation after ${step.id}\nSkipped because this was a dry run.`
          });
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
        this.context.push({
          kind: 'agent',
          baseStepId: baseStep.id,
          stepId: step.id,
          text: `## ${step.id}\n${this.harnessRuntime.trimStepOutput(output, { stepId: step.id })}`
        });
      }

      if (result.exitCode !== 0) {
        // 실패를 유형으로 남긴다. "exit 1"만으로는 사용자가 다음에 뭘 해야 할지 알 수 없다.
        const failure = classifyFailure(result);
        this.manifest.finishedAt = new Date().toISOString();
        this.manifest.status = 'failed';
        this.manifest.failure = { stepId: step.id, ...failure };
        this.manifest.failureReason = failure ? `${failure.kind}: ${failure.summary}` : null;
        this.manifest.workspace = await finalizeWorkspace({
          workspace: this.manifest.workspace,
          runDir: this.runDir
        });
        await this.#teardownTools();
        await this.#saveRuntimeManifest();
        throw new Error(formatFailure({ stepId: step.id, runDir: this.runDir, failure }));
      }

      this.executedSteps.add(baseStep.id);

      if (this.validationAfter.has(baseStep.id)) {
        const validationStage = await this.#runValidationStage({
          step: baseStep,
          attempt
        });
        this.activeValidationFailures = validationStage.failures;
        await this.#runInspectionStage({
          step: baseStep,
          attempt
        });
        await this.#enforceChangeRiskGate({ step: baseStep });
        await this.#enforceNoChangeGate({ step: baseStep });
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
   * 검증 실패 상태의 continue를 재검증으로 되돌린다.
   *
   * supervisor가 continue를 내도 하네스는 activeValidationFailures가 남아 있으면
   * 런을 failed로 끝낸다. 즉 이 조합에서는 supervisor의 판단이 반영되지도 않고
   * 복구도 일어나지 않는다 — 실측한 validation 실패 75건이 전부 이 경로였고
   * 복구율이 0%인 이유다.
   *
   * 재검증 기회를 한 번 준다. run당 1회로 제한하는 이유는 명확하다: 무제한이면
   * continue -> 재검증 -> continue 로 루프가 된다. 두 번째 continue는 그대로 둔다.
   */
  #overrideUnsafeContinue(decision) {
    if (decision.nextAction !== 'continue') {
      return null;
    }
    if (!this.supervisorConfig.forceRevalidateOnFailure) {
      return null;
    }
    if (this.activeValidationFailures.length === 0) {
      return null;
    }
    if (this.forcedRevalidations > 0) {
      return null;
    }
    // supervisor 턴 예산이 남아 있어야 재검증 후 다시 판단할 수 있다.
    if (this.supervisorTurns >= this.supervisorConfig.maxSupervisorTurns) {
      return null;
    }
    const targetStep = findValidationTargetStep(this.selected.pipeline.steps, this.validationAfter, null);
    if (!targetStep) {
      return null;
    }

    this.forcedRevalidations += 1;
    return {
      from: 'continue',
      to: 'run_validation',
      targetStep: targetStep.id,
      reason: `${this.activeValidationFailures.length} validation failure(s) still open`,
      attempt: this.forcedRevalidations
    };
  }

  /**
   * safe_fix로 승격할 때 어디서부터 이어갈지 정한다.
   *
   * 승격의 의미는 "검증을 보강한다"이다. 이미 코드를 쓴 뒤라면 계획·구현을 다시
   * 할 이유가 없고, 그 뒤에 이미 끝낸 검증 단계도 반복할 필요가 없다. 그래서
   * coder 이후부터 시작하되, 연속으로 이미 실행한 스텝은 더 건너뛴다.
   * (code_fix에서 승격하면 실제로 추가되는 것은 verifier 하나뿐이다.)
   *
   * 아직 쓰기 스텝이 없었다면(review_only 등) 승격은 "수정이 필요하다"는 뜻이므로
   * 처음부터 실행한다. hermes와 reporter는 새 증거로 다시 판단해야 하므로 항상 돈다.
   */
  #escalationResumePlan() {
    const steps = this.selected.pipeline.steps;
    if (!this.supervisorConfig.escalation.skipCompletedSteps) {
      return { index: 0, skipped: [] };
    }

    const coderIndex = steps.findIndex((step) => step.id === 'coder');
    if (coderIndex < 0 || !this.executedSteps.has('coder')) {
      return { index: 0, skipped: [] };
    }

    const skipped = steps.slice(0, coderIndex + 1).map((step) => step.id);
    let index = coderIndex + 1;
    while (index < steps.length) {
      const stepId = steps[index].id;
      if (stepId === HERMES_STEP_ID || stepId === 'reporter') {
        break;
      }
      if (!this.executedSteps.has(stepId)) {
        break;
      }
      skipped.push(stepId);
      index += 1;
    }

    return { index, skipped };
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
    // validation이 실패했는데 continue가 나오면 그대로 두지 않는다. 하네스는
    // 어차피 검증 실패를 failed로 처리하므로, continue를 받아주면 복구를
    // 시도조차 하지 않고 끝난다(실측 75건 전부 이 경로였다). 재검증 기회를
    // 한 번 주고, 그래도 continue가 나오면 그때는 그대로 둔다.
    const overridden = this.#overrideUnsafeContinue(decision);
    if (overridden) {
      decisionRecord.overriddenBy = overridden;
      decision.nextAction = overridden.to;
      decision.targetStep = overridden.targetStep;
      console.error(`Harness override: continue -> ${overridden.to} (${overridden.reason})`);
    }

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
        this.context.push({ kind: 'supervisor', text: supervisorInstructionsSection(decision) });
        const validationStage = await this.#runValidationStage({
          step: targetStep,
          attempt: this.validationAttempts[targetStep.id]
        });
        this.activeValidationFailures = validationStage.failures;
        this.stepIndex = findStepIndex(this.selected.pipeline.steps, HERMES_STEP_ID);
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.context.push({
        kind: 'note',
        text: `## hermes validation rerun not performed\n` +
          `targetStep: ${decision.targetStep || '(auto)'}\n` +
          `reason: validation target was unavailable or supervisor turn limit was reached.`
      });
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
        this.context.push({ kind: 'supervisor', text: supervisorInstructionsSection(decision) });
        const resume = this.#escalationResumePlan();
        this.manifest.pipelineChanges.push({
          from: previousPipeline,
          to: this.selected.pipelineName,
          reason: decision.reason,
          instructions: decision.instructions,
          turn: this.supervisorTurns,
          createdAt: new Date().toISOString(),
          resumeStepIndex: resume.index,
          skippedSteps: resume.skipped
        });
        if (resume.skipped.length > 0) {
          this.harnessRuntime.recordEvent('escalation:resume', {
            from: previousPipeline,
            to: this.selected.pipelineName,
            resumeStepIndex: resume.index,
            skippedSteps: resume.skipped
          });
        }
        await this.#saveRuntimeManifest();
        this.stepIndex = resume.index;
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.context.push({
        kind: 'note',
        text: `## hermes escalation not performed\n` +
          `reason: safe_fix was unavailable, already active, or supervisor turn limit was reached.`
      });
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
        this.context.push({ kind: 'supervisor', text: supervisorInstructionsSection(decision) });
        this.stepIndex = targetIndex;
        return true;
      }

      this.supervisorTerminalStatus = 'incomplete';
      this.shouldStopAfterReporter = true;
      this.context.push({
        kind: 'note',
        text: `## hermes rerun not performed\n` +
          `targetStep: ${decision.targetStep || '(none)'}\n` +
          `reason: rerun was not allowed, target was unavailable, or retry limits were reached.`
      });
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
