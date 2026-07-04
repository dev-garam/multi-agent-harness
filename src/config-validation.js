import { knownProviderNames } from './agent.js';

const WORKSPACE_MODES = new Set(['direct', 'worktree', 'patch']);
const OUTPUT_MODES = new Set(['file', 'stdout']);
const RUNNER_MODES = new Set(['local', 'docker']);
const DOCKER_NETWORKS = new Set(['default', 'none', 'host']);
const PIPELINE_SELECTION_MODES = new Set(['deterministic']);

function issue(severity, path, message) {
  return { severity, path, message };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateStringArray(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue('error', path, 'must be an array of strings'));
    return;
  }
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      issues.push(issue('error', `${path}[${index}]`, 'must be a non-empty string'));
    }
  });
}

function validatePositiveNumber(value, path, issues) {
  if (!isPositiveNumber(value)) {
    issues.push(issue('error', path, 'must be a positive number'));
  }
}

function validateAgentConfig(value, path, issues, { allowString = true } = {}) {
  if (typeof value === 'string') {
    if (!allowString || !isNonEmptyString(value)) {
      issues.push(issue('error', path, 'must be a non-empty provider name or an agent object'));
    } else if (!knownProviderNames().includes(value)) {
      issues.push(issue('error', path, `unknown provider "${value}" needs an agent.command`));
    }
    return;
  }

  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be a provider string or an agent object'));
    return;
  }

  if (value.provider !== undefined && !isNonEmptyString(value.provider)) {
    issues.push(issue('error', `${path}.provider`, 'must be a non-empty string'));
  }
  if (value.name !== undefined && !isNonEmptyString(value.name)) {
    issues.push(issue('error', `${path}.name`, 'must be a non-empty string'));
  }
  if (value.command !== undefined && !isNonEmptyString(value.command)) {
    issues.push(issue('error', `${path}.command`, 'must be a non-empty string'));
  }
  const providerName = value.provider || value.name;
  const isUnknownProvider = providerName !== undefined && isNonEmptyString(providerName) && !knownProviderNames().includes(providerName);
  if (isUnknownProvider && !isNonEmptyString(value.command)) {
    issues.push(issue('error', path, `unknown provider "${providerName}" needs agent.command`));
  }
  if (isUnknownProvider && value.args === undefined) {
    issues.push(issue('error', `${path}.args`, `unknown provider "${providerName}" needs args`));
  }
  if (value.outputMode !== undefined && !OUTPUT_MODES.has(value.outputMode)) {
    issues.push(issue('error', `${path}.outputMode`, 'must be one of: file, stdout'));
  }
  if (value.defaultTimeoutMs !== undefined) {
    validatePositiveNumber(value.defaultTimeoutMs, `${path}.defaultTimeoutMs`, issues);
  }
  if (value.versionArgs !== undefined) {
    validateStringArray(value.versionArgs, `${path}.versionArgs`, issues);
  }
  if (value.args !== undefined) {
    if (typeof value.args === 'string') {
      return;
    }
    validateStringArray(value.args, `${path}.args`, issues);
  }
}

function validateRunner(value, path, issues) {
  if (typeof value === 'string') {
    if (!RUNNER_MODES.has(value)) {
      issues.push(issue('error', path, 'must be one of: local, docker'));
    }
    return;
  }

  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be a runner string or object'));
    return;
  }

  if (value.mode !== undefined && !RUNNER_MODES.has(value.mode)) {
    issues.push(issue('error', `${path}.mode`, 'must be one of: local, docker'));
  }

  const mode = value.mode || 'local';
  if (mode === 'docker' && !isNonEmptyString(value.image) && !isNonEmptyString(value.docker?.image)) {
    issues.push(issue('error', `${path}.image`, 'must be set when runner.mode is docker'));
  }
  if (value.image !== undefined && !isNonEmptyString(value.image)) {
    issues.push(issue('error', `${path}.image`, 'must be a non-empty string'));
  }
  if (value.network !== undefined && !DOCKER_NETWORKS.has(value.network)) {
    issues.push(issue('error', `${path}.network`, 'must be one of: default, none, host'));
  }
  if (value.envAllowlist !== undefined) {
    validateStringArray(value.envAllowlist, `${path}.envAllowlist`, issues);
  }
  if (value.mounts !== undefined) {
    validateStringArray(value.mounts, `${path}.mounts`, issues);
  }
  if (value.docker !== undefined) {
    validateDockerRunner(value.docker, `${path}.docker`, issues);
  }
}

function validateDockerRunner(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  if (value.image !== undefined && !isNonEmptyString(value.image)) {
    issues.push(issue('error', `${path}.image`, 'must be a non-empty string'));
  }
  if (value.network !== undefined && !DOCKER_NETWORKS.has(value.network)) {
    issues.push(issue('error', `${path}.network`, 'must be one of: default, none, host'));
  }
  if (value.envAllowlist !== undefined) {
    validateStringArray(value.envAllowlist, `${path}.envAllowlist`, issues);
  }
  if (value.mounts !== undefined) {
    validateStringArray(value.mounts, `${path}.mounts`, issues);
  }
}

function validateValidationCommand(entry, index, issues) {
  const path = `validationCommands[${index}]`;
  if (typeof entry === 'string') {
    if (!isNonEmptyString(entry)) {
      issues.push(issue('error', path, 'must be a non-empty command string'));
    }
    return;
  }

  if (!isPlainObject(entry)) {
    issues.push(issue('error', path, 'must be a command string or object'));
    return;
  }

  if (!isNonEmptyString(entry.command)) {
    issues.push(issue('error', `${path}.command`, 'must be a non-empty string'));
  }
  if (entry.id !== undefined && !isNonEmptyString(entry.id)) {
    issues.push(issue('error', `${path}.id`, 'must be a non-empty string'));
  }
  if (entry.name !== undefined && !isNonEmptyString(entry.name)) {
    issues.push(issue('error', `${path}.name`, 'must be a non-empty string'));
  }
  if (entry.timeoutMs !== undefined) {
    validatePositiveNumber(entry.timeoutMs, `${path}.timeoutMs`, issues);
  }
  if (entry.maxLogBytes !== undefined) {
    validatePositiveNumber(entry.maxLogBytes, `${path}.maxLogBytes`, issues);
  }
}

function validateBoolean(value, path, issues) {
  if (typeof value !== 'boolean') {
    issues.push(issue('error', path, 'must be a boolean'));
  }
}

function validateRedaction(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  if (value.enabled !== undefined) {
    validateBoolean(value.enabled, `${path}.enabled`, issues);
  }
  if (value.mode !== undefined && !['mask', 'hash'].includes(value.mode)) {
    issues.push(issue('error', `${path}.mode`, 'must be one of: mask, hash'));
  }
  if (value.patterns !== undefined) {
    if (!Array.isArray(value.patterns)) {
      issues.push(issue('error', `${path}.patterns`, 'must be an array'));
    } else {
      value.patterns.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          issues.push(issue('error', `${path}.patterns[${index}]`, 'must be an object'));
          return;
        }
        if (entry.id !== undefined && !isNonEmptyString(entry.id)) {
          issues.push(issue('error', `${path}.patterns[${index}].id`, 'must be a non-empty string'));
        }
        if (!isNonEmptyString(entry.pattern)) {
          issues.push(issue('error', `${path}.patterns[${index}].pattern`, 'must be a non-empty string'));
        }
      });
    }
  }
}

function validateContextConfig(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  for (const key of ['maxPreviousOutputBytes', 'maxStepOutputBytes']) {
    if (value[key] !== undefined) {
      validatePositiveNumber(value[key], `${path}.${key}`, issues);
    }
  }
  if (value.summarizer !== undefined) {
    if (!isPlainObject(value.summarizer)) {
      issues.push(issue('error', `${path}.summarizer`, 'must be an object'));
    } else {
      if (value.summarizer.enabled !== undefined) {
        validateBoolean(value.summarizer.enabled, `${path}.summarizer.enabled`, issues);
      }
      if (value.summarizer.mode !== undefined && !['deterministic', 'model'].includes(value.summarizer.mode)) {
        issues.push(issue('error', `${path}.summarizer.mode`, 'must be one of: deterministic, model'));
      }
      for (const key of ['headBytes', 'tailBytes']) {
        if (value.summarizer[key] !== undefined) {
          validatePositiveNumber(value.summarizer[key], `${path}.summarizer.${key}`, issues);
        }
      }
      if (value.summarizer.provider !== undefined && !isNonEmptyString(value.summarizer.provider)) {
        issues.push(issue('error', `${path}.summarizer.provider`, 'must be a non-empty string'));
      }
    }
  }
}

function validateRetryConfig(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  for (const key of ['agentRetries', 'validationRetries']) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 0)) {
      issues.push(issue('error', `${path}.${key}`, 'must be a non-negative integer'));
    }
  }
  if (value.backoffMs !== undefined) {
    if (!Number.isFinite(Number(value.backoffMs)) || Number(value.backoffMs) < 0) {
      issues.push(issue('error', `${path}.backoffMs`, 'must be a non-negative number'));
    }
  }
  if (value.fallbackAgents !== undefined) {
    if (!Array.isArray(value.fallbackAgents)) {
      issues.push(issue('error', `${path}.fallbackAgents`, 'must be an array'));
    } else {
      value.fallbackAgents.forEach((agentConfig, index) => {
        validateAgentConfig(agentConfig, `${path}.fallbackAgents[${index}]`, issues, { allowString: false });
      });
    }
  }
  if (value.retryOnExitCodes !== undefined) {
    if (!Array.isArray(value.retryOnExitCodes)) {
      issues.push(issue('error', `${path}.retryOnExitCodes`, 'must be an array'));
    } else {
      value.retryOnExitCodes.forEach((entry, index) => {
        if (!Number.isInteger(entry) || entry < 0) {
          issues.push(issue('error', `${path}.retryOnExitCodes[${index}]`, 'must be a non-negative integer'));
        }
      });
    }
  }
  if (value.retryOnStderrPatterns !== undefined) {
    validateStringArray(value.retryOnStderrPatterns, `${path}.retryOnStderrPatterns`, issues);
  }
}

function validateBudgetConfig(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  for (const key of ['maxAgentSteps', 'maxProviderCalls', 'maxValidationCommands', 'maxRuntimeMs']) {
    if (value[key] !== undefined) {
      validatePositiveNumber(value[key], `${path}.${key}`, issues);
    }
  }
}

function validateTools(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue('error', path, 'must be an array'));
    return;
  }
  value.forEach((tool, index) => {
    const toolPath = `${path}[${index}]`;
    if (!isPlainObject(tool)) {
      issues.push(issue('error', toolPath, 'must be an object'));
      return;
    }
    if (tool.id !== undefined && !isNonEmptyString(tool.id)) {
      issues.push(issue('error', `${toolPath}.id`, 'must be a non-empty string'));
    }
    if (tool.name !== undefined && !isNonEmptyString(tool.name)) {
      issues.push(issue('error', `${toolPath}.name`, 'must be a non-empty string'));
    }
    for (const key of ['setupCommand', 'teardownCommand']) {
      if (tool[key] !== undefined && !isNonEmptyString(tool[key])) {
        issues.push(issue('error', `${toolPath}.${key}`, 'must be a non-empty string'));
      }
    }
    for (const key of ['timeoutMs', 'maxLogBytes']) {
      if (tool[key] !== undefined) {
        validatePositiveNumber(tool[key], `${toolPath}.${key}`, issues);
      }
    }
    if (tool.envAllowlist !== undefined) {
      validateStringArray(tool.envAllowlist, `${toolPath}.envAllowlist`, issues);
    }
  });
}

function validatePipelineSelection(value, path, issues, { harnessConfig = null } = {}) {
  if (!isPlainObject(value)) {
    issues.push(issue('error', path, 'must be an object'));
    return;
  }
  if (value.mode !== undefined && !PIPELINE_SELECTION_MODES.has(value.mode)) {
    issues.push(issue('error', `${path}.mode`, 'must be one of: deterministic'));
  }
  if (value.defaultPipeline !== undefined) {
    if (!isNonEmptyString(value.defaultPipeline)) {
      issues.push(issue('error', `${path}.defaultPipeline`, 'must be a non-empty string'));
    } else if (harnessConfig?.pipelines && !harnessConfig.pipelines[value.defaultPipeline]) {
      const names = Object.keys(harnessConfig.pipelines).join(', ');
      issues.push(issue('error', `${path}.defaultPipeline`, `unknown pipeline "${value.defaultPipeline}". Available: ${names}`));
    }
  }
  for (const key of ['riskThreshold', 'complexityThreshold']) {
    if (value[key] !== undefined) {
      validatePositiveNumber(value[key], `${path}.${key}`, issues);
    }
  }
}

export function validateProjectConfig(projectConfig = {}, { harnessConfig = null } = {}) {
  const issues = [];

  if (!isPlainObject(projectConfig)) {
    return {
      valid: false,
      errors: [issue('error', '$', 'must be a JSON object')],
      warnings: []
    };
  }

  if (projectConfig.pipeline !== undefined) {
    if (!isNonEmptyString(projectConfig.pipeline)) {
      issues.push(issue('error', 'pipeline', 'must be a non-empty string'));
    } else if (projectConfig.pipeline !== 'auto' && harnessConfig?.pipelines && !harnessConfig.pipelines[projectConfig.pipeline]) {
      const names = Object.keys(harnessConfig.pipelines).join(', ');
      issues.push(issue('error', 'pipeline', `unknown pipeline "${projectConfig.pipeline}". Available: auto, ${names}`));
    }
  }

  if (projectConfig.pipelineSelection !== undefined) {
    validatePipelineSelection(projectConfig.pipelineSelection, 'pipelineSelection', issues, { harnessConfig });
  }

  const workspaceMode = projectConfig.workspaceMode ?? projectConfig.workspace?.mode;
  if (workspaceMode !== undefined && !WORKSPACE_MODES.has(workspaceMode)) {
    issues.push(issue('error', projectConfig.workspaceMode !== undefined ? 'workspaceMode' : 'workspace.mode', 'must be one of: direct, worktree, patch'));
  }

  if (projectConfig.agent !== undefined) {
    validateAgentConfig(projectConfig.agent, 'agent', issues);
  }

  if (projectConfig.runner !== undefined) {
    validateRunner(projectConfig.runner, 'runner', issues);
  }
  if (projectConfig.dockerRunner !== undefined) {
    validateDockerRunner(projectConfig.dockerRunner, 'dockerRunner', issues);
  }
  if (projectConfig.runtime !== undefined) {
    if (!isPlainObject(projectConfig.runtime)) {
      issues.push(issue('error', 'runtime', 'must be an object'));
    } else {
      if (projectConfig.runtime.runner !== undefined) {
        validateRunner(projectConfig.runtime.runner, 'runtime.runner', issues);
      }
      if (projectConfig.runtime.docker !== undefined) {
        validateDockerRunner(projectConfig.runtime.docker, 'runtime.docker', issues);
      }
    }
  }

  if (projectConfig.agents !== undefined) {
    if (!isPlainObject(projectConfig.agents)) {
      issues.push(issue('error', 'agents', 'must be an object keyed by step id'));
    } else {
      for (const [stepId, agentConfig] of Object.entries(projectConfig.agents)) {
        validateAgentConfig(agentConfig, `agents.${stepId}`, issues, { allowString: false });
      }
    }
  }

  for (const commandName of ['buildCommand', 'testCommand']) {
    if (projectConfig[commandName] !== undefined && projectConfig[commandName] !== '' && !isNonEmptyString(projectConfig[commandName])) {
      issues.push(issue('error', commandName, 'must be a string command'));
    }
  }

  if (projectConfig.validationCommands !== undefined) {
    if (!Array.isArray(projectConfig.validationCommands)) {
      issues.push(issue('error', 'validationCommands', 'must be an array'));
    } else {
      projectConfig.validationCommands.forEach((entry, index) => validateValidationCommand(entry, index, issues));
    }
  }

  if (projectConfig.resources !== undefined) {
    if (!isPlainObject(projectConfig.resources)) {
      issues.push(issue('error', 'resources', 'must be an object'));
    } else {
      for (const key of ['agentTimeoutMs', 'validationTimeoutMs', 'maxLogBytes']) {
        if (projectConfig.resources[key] !== undefined) {
          validatePositiveNumber(projectConfig.resources[key], `resources.${key}`, issues);
        }
      }
    }
  }

  if (projectConfig.redaction !== undefined) {
    validateRedaction(projectConfig.redaction, 'redaction', issues);
  }

  if (projectConfig.context !== undefined) {
    validateContextConfig(projectConfig.context, 'context', issues);
  }

  if (projectConfig.retry !== undefined) {
    validateRetryConfig(projectConfig.retry, 'retry', issues);
  }

  if (projectConfig.budget !== undefined) {
    validateBudgetConfig(projectConfig.budget, 'budget', issues);
  }

  if (projectConfig.tools !== undefined) {
    validateTools(projectConfig.tools, 'tools', issues);
  }

  if (projectConfig.supervisor !== undefined) {
    if (!isPlainObject(projectConfig.supervisor)) {
      issues.push(issue('error', 'supervisor', 'must be an object'));
    } else {
      if (projectConfig.supervisor.enabled !== undefined) {
        validateBoolean(projectConfig.supervisor.enabled, 'supervisor.enabled', issues);
      }
      for (const key of ['maxSupervisorTurns', 'maxStepRetries']) {
        if (projectConfig.supervisor[key] !== undefined && (!Number.isInteger(projectConfig.supervisor[key]) || projectConfig.supervisor[key] < 0)) {
          issues.push(issue('error', `supervisor.${key}`, 'must be a non-negative integer'));
        }
      }
      if (projectConfig.supervisor.agent !== undefined) {
        validateAgentConfig(projectConfig.supervisor.agent, 'supervisor.agent', issues, { allowString: false });
      }
    }
  }

  if (projectConfig.cleanup !== undefined) {
    if (!isPlainObject(projectConfig.cleanup)) {
      issues.push(issue('error', 'cleanup', 'must be an object'));
    } else {
      for (const key of ['enabled', 'dryRun']) {
        if (projectConfig.cleanup[key] !== undefined) {
          validateBoolean(projectConfig.cleanup[key], `cleanup.${key}`, issues);
        }
      }
      for (const key of ['days', 'keep']) {
        if (projectConfig.cleanup[key] !== undefined) {
          validatePositiveNumber(projectConfig.cleanup[key], `cleanup.${key}`, issues);
        }
      }
    }
  }

  if (projectConfig.configSuggestions !== undefined) {
    if (!isPlainObject(projectConfig.configSuggestions)) {
      issues.push(issue('error', 'configSuggestions', 'must be an object'));
    } else {
      if (projectConfig.configSuggestions.enabled !== undefined) {
        validateBoolean(projectConfig.configSuggestions.enabled, 'configSuggestions.enabled', issues);
      }
      if (projectConfig.configSuggestions.mode !== undefined && projectConfig.configSuggestions.mode !== 'ask') {
        issues.push(issue('error', 'configSuggestions.mode', 'must be ask'));
      }
    }
  }

  const policy = projectConfig.policy;
  if (policy !== undefined) {
    if (!isPlainObject(policy)) {
      issues.push(issue('error', 'policy', 'must be an object'));
    } else {
      for (const key of ['allowAutonomousRun', 'allowEdits', 'allowDestructiveCommands', 'enforceApprovalForDirectRun']) {
        if (policy[key] !== undefined) {
          validateBoolean(policy[key], `policy.${key}`, issues);
        }
      }
      for (const key of ['protectedBranches', 'requireApprovalFor']) {
        if (policy[key] !== undefined) {
          validateStringArray(policy[key], `policy.${key}`, issues);
        }
      }
    }
  }

  if (projectConfig.protectedBranches !== undefined) {
    validateStringArray(projectConfig.protectedBranches, 'protectedBranches', issues);
  }

  if (!projectConfig.validationCommands && !projectConfig.buildCommand && !projectConfig.testCommand) {
    issues.push(issue('warn', 'validationCommands', 'no validation commands configured'));
  }

  const errors = issues.filter((entry) => entry.severity === 'error');
  const warnings = issues.filter((entry) => entry.severity === 'warn');
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function formatConfigValidationIssues(result) {
  return [...result.errors, ...result.warnings]
    .map((entry) => `- ${entry.severity}: ${entry.path}: ${entry.message}`)
    .join('\n');
}
