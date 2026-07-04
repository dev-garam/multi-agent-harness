import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readText, runCapture, writeText } from './fs-utils.js';

const DEFAULT_AGENT = 'codex';
const DEFAULT_PIPELINE = 'auto';
const DEFAULT_PIPELINE_SELECTION = {
  mode: 'deterministic',
  defaultPipeline: 'quick_fix'
};
const DEFAULT_CLEANUP_KEEP = 20;
const DEFAULT_CONTEXT = {
  maxPreviousOutputBytes: 65536,
  maxStepOutputBytes: 32768,
  summarizer: {
    enabled: true,
    mode: 'deterministic'
  }
};
const DEFAULT_RETRY = {
  agentRetries: 0,
  validationRetries: 1,
  backoffMs: 1000,
  retryOnExitCodes: [124],
  retryOnStderrPatterns: ['rate limit', 'timeout', 'temporarily unavailable']
};
const DEFAULT_BUDGET = {
  maxAgentSteps: 8,
  maxProviderCalls: 8,
  maxValidationCommands: 12,
  maxRuntimeMs: 900000
};
const SCRIPT_VALIDATIONS = ['lint', 'typecheck', 'check'];
const ROUTING_MARKER_START = '<!-- harness-routing:start -->';
const ROUTING_MARKER_END = '<!-- harness-routing:end -->';
const ROUTING_TARGETS = {
  codex: {
    filePath: 'AGENTS.md',
    label: 'Codex'
  },
  antigravity: {
    filePath: 'AGENTS.md',
    label: 'Antigravity'
  },
  claude: {
    filePath: 'CLAUDE.md',
    label: 'Claude Code'
  },
  gemini: {
    filePath: 'GEMINI.md',
    label: 'Gemini CLI'
  },
  cursor: {
    filePath: '.cursor/rules/harness-routing.mdc',
    label: 'Cursor'
  }
};
const ROUTING_TARGET_SELECTIONS = {
  1: ['codex'],
  2: ['claude'],
  3: ['gemini', 'antigravity'],
  4: ['cursor']
};
let pipedAnswers = null;

function packageManagerForRepo(repo) {
  if (existsSync(path.join(repo, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(path.join(repo, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(path.join(repo, 'bun.lock')) || existsSync(path.join(repo, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

function runScriptCommand(packageManager, scriptName) {
  return `${packageManager} run ${scriptName}`;
}

function isDefaultNpmTest(script) {
  return /no test specified/i.test(script) || /exit 1/.test(script);
}

async function readPackageScripts(repo) {
  const packagePath = path.join(repo, 'package.json');
  if (!existsSync(packagePath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(await readText(packagePath));
    return packageJson.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts
      : {};
  } catch {
    return {};
  }
}

function validationConfigFromScripts(repo, scripts) {
  if (!scripts) {
    return {
      packageManager: null,
      buildCommand: '',
      testCommand: '',
      validationCommands: [],
      detectedScripts: []
    };
  }

  const packageManager = packageManagerForRepo(repo);
  const detectedScripts = Object.keys(scripts);
  const buildCommand = scripts.build ? runScriptCommand(packageManager, 'build') : '';
  const testCommand = scripts.test && !isDefaultNpmTest(scripts.test)
    ? runScriptCommand(packageManager, 'test')
    : '';
  const validationCommands = SCRIPT_VALIDATIONS
    .filter((scriptName) => scripts[scriptName])
    .map((scriptName) => ({
      id: scriptName,
      command: runScriptCommand(packageManager, scriptName)
    }));

  return {
    packageManager,
    buildCommand,
    testCommand,
    validationCommands,
    detectedScripts
  };
}

async function gitValue(repo, args) {
  const result = await runCapture('git', ['-C', repo, ...args], { cwd: repo });
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout.trim();
}

async function gitBranchExists(repo, branchName) {
  const result = await runCapture('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repo });
  if (result.exitCode === 0) {
    return true;
  }
  const remoteResult = await runCapture('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branchName}`], { cwd: repo });
  return remoteResult.exitCode === 0;
}

async function gitCurrentBranch(repo) {
  return await gitValue(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ||
    await gitValue(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

async function gitRemoteHeadBranch(repo) {
  const remoteHead = await gitValue(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return remoteHead.replace(/^origin\//, '');
}

async function gitHasAnyBranch(repo) {
  const result = await runCapture('git', ['-C', repo, 'show-ref', '--heads', '--quiet'], { cwd: repo });
  return result.exitCode === 0;
}

async function protectedBranchesForRepo(repo) {
  const branches = [];

  if (existsSync(path.join(repo, '.git'))) {
    for (const candidate of ['main', 'master']) {
      if (await gitBranchExists(repo, candidate)) {
        branches.push(candidate);
        break;
      }
    }
  }

  const remoteHead = await gitRemoteHeadBranch(repo);
  const currentBranch = await gitCurrentBranch(repo);
  for (const candidate of [remoteHead, currentBranch]) {
    if (['main', 'master', 'production'].includes(candidate) && !branches.includes(candidate)) {
      branches.push(candidate);
    }
  }

  if (branches.length === 0) {
    const fallbackBranch = remoteHead || currentBranch;
    if (fallbackBranch && fallbackBranch !== 'HEAD' && await gitHasAnyBranch(repo)) {
      branches.push(fallbackBranch);
    } else {
      branches.push('main');
    }
  }
  branches.push('production');
  return [...new Set(branches.filter(Boolean))];
}

function summaryLines({ configPath, created, config, inference }) {
  const lines = [
    `Project harness config: ${configPath}`,
    created ? 'Created .harness.json with detected project defaults.' : 'Existing .harness.json kept unchanged.'
  ];

  if (!created) {
    return lines;
  }

  lines.push(`Pipeline: ${config.pipeline}`);
  lines.push(`Agent: ${config.agent.provider}`);
  lines.push(`Runner: ${config.runner.mode}`);
  lines.push(`Protected branches: ${config.protectedBranches.join(', ')}`);

  if (inference.packageManager) {
    lines.push(`Detected package manager: ${inference.packageManager}`);
    lines.push(`Detected package scripts: ${inference.detectedScripts.length > 0 ? inference.detectedScripts.join(', ') : '(none)'}`);
  } else {
    lines.push('Detected package scripts: none (package.json not found)');
  }

  lines.push(`Build command: ${config.buildCommand || '(not detected)'}`);
  lines.push(`Test command: ${config.testCommand || '(not detected)'}`);
  lines.push(`Validation commands: ${config.validationCommands.length > 0 ? config.validationCommands.map((entry) => entry.command).join(', ') : '(none detected)'}`);

  if (!config.buildCommand && !config.testCommand && config.validationCommands.length === 0) {
    lines.push('Next: edit .harness.json and add buildCommand/testCommand/validationCommands for this project.');
  } else {
    lines.push('Next: review .harness.json, then run harness doctor --repo <path>.');
  }

  return lines;
}

function routingInstructions() {
  return [
    '## Harness Routing',
    '',
    '사용자가 "하네스로", "하네스를 활용해서", "하네스 태워서", "검증까지", "auto로", "quick_fix로", "code_fix로", "safe_fix로", "review_only로"라고 말하면 직접 파일을 수정하지 말고 먼저 하네스를 실행한다.',
    '',
    '실행 전 연결 상태를 확인한다.',
    '',
    '```sh',
    'harness doctor --repo . --agent codex',
    '```',
    '',
    '기본 실행은 프로젝트의 `.harness.json` 설정을 따른다.',
    '',
    '```sh',
    'harness run --repo . "<사용자 요청>"',
    '```',
    '',
    '사용자가 특정 파이프라인을 명시한 경우에만 `--pipeline`을 붙인다.',
    '',
    '```sh',
    'harness run --repo . --pipeline safe_fix "<사용자 요청>"',
    '```',
    '',
    '하네스 실행 후에는 `runs/<runId>/manifest.json`과 reporter 산출물을 확인해 요약한다. 가능한 경우 `pipelineSelection`과 `usageSummary`도 함께 보고한다.'
  ].join('\n');
}

function cursorRoutingInstructions() {
  return [
    '---',
    'description: Route explicit harness requests through the project harness',
    'alwaysApply: true',
    '---',
    '',
    routingInstructions()
  ].join('\n');
}

function routingBlockForFile(filePath) {
  const instructions = filePath.endsWith('.mdc')
    ? cursorRoutingInstructions()
    : routingInstructions();
  return `${ROUTING_MARKER_START}\n${instructions}\n${ROUTING_MARKER_END}`;
}

function normalizeRoutingTargets(value) {
  if (!value || value === true) {
    return ['codex'];
  }

  const entries = String(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const names = entries.flatMap((entry) => ROUTING_TARGET_SELECTIONS[entry] || [entry]);

  const expanded = names.includes('all')
    ? Object.keys(ROUTING_TARGETS)
    : names;
  const invalid = expanded.filter((name) => !ROUTING_TARGETS[name]);
  if (invalid.length > 0) {
    throw new Error(`Unsupported agent routing target: ${invalid.join(', ')}`);
  }

  const seenFiles = new Set();
  return expanded.filter((name) => {
    const target = ROUTING_TARGETS[name];
    if (seenFiles.has(target.filePath)) {
      return false;
    }
    seenFiles.add(target.filePath);
    return true;
  });
}

async function askRoutingTargets(rl = null) {
  const answer = await askQuestion([
    'Select routing targets:',
    '  1. Codex (AGENTS.md)',
    '  2. Claude Code (CLAUDE.md)',
    '  3. Gemini / Antigravity (GEMINI.md + AGENTS.md)',
    '  4. Cursor (.cursor/rules/harness-routing.mdc)',
    'Enter numbers separated by comma [1]: '
  ].join('\n'), rl);
  const selected = answer.trim() || '1';
  return normalizeRoutingTargets(selected).join(',');
}

function replaceRoutingBlock(text, block) {
  const start = text.indexOf(ROUTING_MARKER_START);
  const end = text.indexOf(ROUTING_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const afterEnd = end + ROUTING_MARKER_END.length;
  return `${text.slice(0, start).trimEnd()}\n\n${block}\n\n${text.slice(afterEnd).trimStart()}`.trimEnd() + '\n';
}

function removeRoutingBlock(text) {
  const start = text.indexOf(ROUTING_MARKER_START);
  const end = text.indexOf(ROUTING_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const afterEnd = end + ROUTING_MARKER_END.length;
  return `${text.slice(0, start).trimEnd()}\n\n${text.slice(afterEnd).trimStart()}`.trimEnd() + '\n';
}

async function updateRoutingFile(repo, targetName, { reset = false, remove = false } = {}) {
  const target = ROUTING_TARGETS[targetName];
  const absolutePath = path.join(repo, target.filePath);
  const exists = existsSync(absolutePath);
  const previous = exists ? await readText(absolutePath) : '';

  if (remove) {
    if (!exists) {
      return {
        filePath: absolutePath,
        action: 'missing',
        message: `Routing file not found: ${target.filePath}`
      };
    }

    const removed = removeRoutingBlock(previous);
    if (removed === null) {
      return {
        filePath: absolutePath,
        action: 'unchanged',
        message: `No harness routing block found in ${target.filePath}.`
      };
    }

    if (target.filePath.endsWith('.mdc') && removed.trim() === '') {
      await rm(absolutePath, { force: true });
      return {
        filePath: absolutePath,
        action: 'removed',
        message: `Removed harness routing file: ${target.filePath}`
      };
    }

    await writeText(absolutePath, removed);
    return {
      filePath: absolutePath,
      action: 'removed',
      message: `Removed harness routing block from ${target.filePath}.`
    };
  }

  const block = routingBlockForFile(target.filePath);
  if (!exists) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const title = target.filePath.endsWith('.mdc') ? '' : `# ${path.basename(target.filePath)}\n\n`;
    await writeText(absolutePath, `${title}${block}\n`);
    return {
      filePath: absolutePath,
      action: 'created',
      message: `Created ${target.filePath} harness routing for ${target.label}.`
    };
  }

  const replaced = replaceRoutingBlock(previous, block);
  if (replaced !== null) {
    if (!reset) {
      return {
        filePath: absolutePath,
        action: 'unchanged',
        message: `Existing harness routing kept in ${target.filePath}.`
      };
    }
    await writeText(absolutePath, replaced);
    return {
      filePath: absolutePath,
      action: 'reset',
      message: `Reset harness routing block in ${target.filePath}.`
    };
  }

  await writeText(absolutePath, `${previous.trimEnd()}\n\n${block}\n`);
  return {
    filePath: absolutePath,
    action: 'appended',
    message: `Appended harness routing block to ${target.filePath}.`
  };
}

async function applyAgentRouting(repo, { targets, reset = false, remove = false } = {}) {
  if (!targets) {
    return [];
  }

  const normalizedTargets = normalizeRoutingTargets(targets);
  const results = [];
  for (const targetName of normalizedTargets) {
    results.push(await updateRoutingFile(repo, targetName, { reset, remove }));
  }
  return results;
}

function defaultRuntimeConfig({ validation, protectedBranches }) {
  return {
    pipeline: DEFAULT_PIPELINE,
    pipelineSelection: DEFAULT_PIPELINE_SELECTION,
    agent: {
      provider: DEFAULT_AGENT
    },
    testCommand: validation.testCommand,
    buildCommand: validation.buildCommand,
    validationCommands: validation.validationCommands,
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 2,
      maxStepRetries: 0
    },
    redaction: {
      enabled: true,
      mode: 'mask'
    },
    context: DEFAULT_CONTEXT,
    retry: DEFAULT_RETRY,
    budget: DEFAULT_BUDGET,
    cleanup: {
      enabled: false,
      days: 7,
      keep: DEFAULT_CLEANUP_KEEP
    },
    runner: {
      mode: 'local'
    },
    protectedBranches
  };
}

function coreRuntimeConfig({ protectedBranches }) {
  return {
    pipeline: DEFAULT_PIPELINE,
    pipelineSelection: DEFAULT_PIPELINE_SELECTION,
    agent: {
      provider: DEFAULT_AGENT
    },
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 2,
      maxStepRetries: 0
    },
    redaction: {
      enabled: true,
      mode: 'mask'
    },
    context: DEFAULT_CONTEXT,
    retry: DEFAULT_RETRY,
    budget: DEFAULT_BUDGET,
    cleanup: {
      enabled: false,
      days: 7,
      keep: DEFAULT_CLEANUP_KEEP
    },
    runner: {
      mode: 'local'
    },
    protectedBranches
  };
}

async function detectProjectDefaults(repo) {
  const scripts = await readPackageScripts(repo);
  const validation = validationConfigFromScripts(repo, scripts);
  const protectedBranches = await protectedBranchesForRepo(repo);
  return {
    config: defaultRuntimeConfig({ validation, protectedBranches }),
    inference: validation
  };
}

function normalizeValidationCommand(entry) {
  if (typeof entry === 'string') {
    return {
      id: entry,
      command: entry
    };
  }
  return entry || {};
}

function addSuggestion(suggestions, path, action, detail) {
  suggestions.push({ path, action, detail });
}

function refreshProjectConfig(current, detected) {
  const next = JSON.parse(JSON.stringify(current));
  const suggestions = [];

  if (!next.pipeline) {
    next.pipeline = detected.pipeline;
    addSuggestion(suggestions, 'pipeline', 'add', detected.pipeline);
  }

  if (!next.agent) {
    next.agent = detected.agent;
    addSuggestion(suggestions, 'agent.provider', 'add', detected.agent.provider);
  }

  if (!next.pipelineSelection) {
    next.pipelineSelection = DEFAULT_PIPELINE_SELECTION;
    addSuggestion(suggestions, 'pipelineSelection', 'add', 'deterministic auto pipeline selection');
  }

  if (!next.buildCommand && detected.buildCommand) {
    next.buildCommand = detected.buildCommand;
    addSuggestion(suggestions, 'buildCommand', 'add', detected.buildCommand);
  }

  if (!next.testCommand && detected.testCommand) {
    next.testCommand = detected.testCommand;
    addSuggestion(suggestions, 'testCommand', 'add', detected.testCommand);
  }

  const existingValidation = Array.isArray(next.validationCommands)
    ? next.validationCommands.map(normalizeValidationCommand)
    : [];
  if (!Array.isArray(next.validationCommands)) {
    next.validationCommands = [];
    addSuggestion(suggestions, 'validationCommands', 'add', '[]');
  }

  const existingIds = new Set(existingValidation.map((entry) => entry.id).filter(Boolean));
  const existingCommands = new Set(existingValidation.map((entry) => entry.command).filter(Boolean));
  for (const command of detected.validationCommands) {
    if (!existingIds.has(command.id) && !existingCommands.has(command.command)) {
      next.validationCommands.push(command);
      addSuggestion(suggestions, `validationCommands.${command.id}`, 'add', command.command);
    }
  }

  if (!next.supervisor) {
    next.supervisor = detected.supervisor;
    addSuggestion(suggestions, 'supervisor', 'add', 'default Hermes supervisor settings');
  }

  if (!next.cleanup) {
    next.cleanup = detected.cleanup;
    addSuggestion(suggestions, 'cleanup', 'add', 'disabled cleanup defaults');
  }

  if (!next.runner) {
    next.runner = detected.runner;
    addSuggestion(suggestions, 'runner.mode', 'add', detected.runner.mode);
  }

  if (!next.redaction) {
    next.redaction = {
      enabled: true,
      mode: 'mask'
    };
    addSuggestion(suggestions, 'redaction', 'add', 'mask mode defaults');
  }

  if (!next.context) {
    next.context = DEFAULT_CONTEXT;
    addSuggestion(suggestions, 'context', 'add', 'conservative context limits');
  }

  if (!next.retry) {
    next.retry = DEFAULT_RETRY;
    addSuggestion(suggestions, 'retry', 'add', 'validation-only retry defaults');
  }

  if (!next.budget) {
    next.budget = DEFAULT_BUDGET;
    addSuggestion(suggestions, 'budget', 'add', 'conservative provider call budget');
  }

  const currentBranches = Array.isArray(next.protectedBranches) ? next.protectedBranches : [];
  const detectedBranches = detected.protectedBranches || [];
  if (currentBranches.length === 0 && detectedBranches.length > 0) {
    next.protectedBranches = detectedBranches;
    addSuggestion(suggestions, 'protectedBranches', 'add', detectedBranches.join(', '));
  } else if (detectedBranches.length > 0 && currentBranches.join('\0') !== detectedBranches.join('\0')) {
    next.protectedBranches = detectedBranches;
    addSuggestion(suggestions, 'protectedBranches', 'replace', `${currentBranches.join(', ') || '(none)'} -> ${detectedBranches.join(', ')}`);
  }

  return { next, suggestions };
}

function refreshSummaryLines({ configPath, suggestions, applied, declined = false }) {
  const lines = [
    `Project harness config: ${configPath}`
  ];

  if (suggestions.length === 0) {
    lines.push('No suggested .harness.json updates.');
    return lines;
  }

  lines.push(applied ? 'Applied suggested .harness.json updates:' : 'Suggested .harness.json updates:');
  for (const suggestion of suggestions) {
    const prefix = suggestion.action === 'replace' ? '~' : '+';
    lines.push(`${prefix} ${suggestion.path}: ${suggestion.detail}`);
  }

  if (declined) {
    lines.push('Skipped applying suggested .harness.json updates.');
  } else if (!applied) {
    lines.push('Run with --refresh --apply to update .harness.json.');
  }

  return lines;
}

function readPipedAnswer(question) {
  process.stdout.write(question);
  if (!pipedAnswers) {
    let input = '';
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      input = '';
    }
    pipedAnswers = input.split(/\r?\n/);
  }
  return pipedAnswers.shift() || '';
}

async function askQuestion(question, rl = null) {
  if (!process.stdin.isTTY) {
    return readPipedAnswer(question);
  }
  if (rl) {
    return rl.question(question);
  }
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

async function confirm(question, rl = null, { defaultValue = false } = {}) {
  const answer = await askQuestion(question, rl);
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ['y', 'yes'].includes(normalized);
}

function shouldAskInteractively(interactive) {
  return interactive || (process.stdin.isTTY && process.stdout.isTTY);
}

async function refreshExistingConfig(repo, configPath, { interactive = false, apply = false, rl = null } = {}) {
  const current = JSON.parse(await readText(configPath));
  const scripts = await readPackageScripts(repo);
  const validation = validationConfigFromScripts(repo, scripts);
  const protectedBranches = await protectedBranchesForRepo(repo);
  const detected = defaultRuntimeConfig({ validation, protectedBranches });
  const refreshed = refreshProjectConfig(current, detected);
  let shouldApply = apply;
  let declined = false;

  if (interactive && refreshed.suggestions.length > 0 && !apply) {
    console.log(refreshSummaryLines({
      configPath,
      suggestions: refreshed.suggestions,
      applied: false
    }).join('\n'));
    shouldApply = await confirm('Apply suggested .harness.json updates? [y/N] ', rl);
    declined = !shouldApply;
  }

  if (shouldApply && refreshed.suggestions.length > 0) {
    await writeText(configPath, JSON.stringify(refreshed.next, null, 2) + '\n');
  }

  return {
    configPath,
    created: false,
    refreshed: true,
    applied: shouldApply,
    suggestions: refreshed.suggestions,
    output: interactive && shouldApply
      ? [
          `Project harness config: ${configPath}`,
          'Applied suggested .harness.json updates.'
        ]
      : refreshSummaryLines({
          configPath,
          suggestions: refreshed.suggestions,
          applied: shouldApply && refreshed.suggestions.length > 0,
          declined
        })
  };
}

async function writeConfigSuggestionPreference(configPath, enabled) {
  const config = JSON.parse(await readText(configPath));
  config.configSuggestions = enabled
    ? {
        enabled: true,
        mode: 'ask'
      }
    : {
        enabled: false
      };
  await writeText(configPath, JSON.stringify(config, null, 2) + '\n');
  return config.configSuggestions;
}

async function runInteractiveOnboarding(repo, configPath, output, rl) {
  const allowFutureSuggestions = await confirm('Allow the harness to ask before adding helpful config during future work? [Y/n] ', rl, { defaultValue: true });
  const preference = await writeConfigSuggestionPreference(configPath, allowFutureSuggestions);
  output.push(allowFutureSuggestions
    ? 'Future config suggestions: enabled (mode: ask).'
    : 'Future config suggestions: disabled.');

  const installRouting = await confirm('Install harness routing rules for coding agents? [Y/n] ', rl, { defaultValue: true });
  if (installRouting) {
    const routingTargets = await askRoutingTargets(rl);
    const routingResults = await applyAgentRouting(repo, {
      targets: routingTargets,
      reset: false,
      remove: false
    });
    output.push('Agent routing files:');
    for (const routingResult of routingResults) {
      output.push(`- ${routingResult.message}`);
    }
  } else {
    const routingResults = await applyAgentRouting(repo, {
      targets: 'all',
      reset: false,
      remove: true
    });
    const removedResults = routingResults.filter((result) => result.action === 'removed');
    output.push('Agent routing files: disabled.');
    if (removedResults.length > 0) {
      for (const routingResult of removedResults) {
        output.push(`- ${routingResult.message}`);
      }
    } else {
      output.push('- No harness routing blocks found to remove.');
    }
  }

  return preference;
}

async function runInteractiveExistingConfig(repo, configPath, rl) {
  const output = [
    `Project harness config: ${configPath}`
  ];
  const shouldReset = await confirm('Existing .harness.json found. Reset it from scratch? [y/N] ', rl);
  const shouldAddRecommended = await confirm('Add recommended default fields to .harness.json? [Y/n] ', rl, { defaultValue: true });

  if (shouldReset) {
    const detected = await detectProjectDefaults(repo);
    const resetConfig = shouldAddRecommended
      ? detected.config
      : coreRuntimeConfig({ protectedBranches: detected.config.protectedBranches });
    await writeText(configPath, JSON.stringify(resetConfig, null, 2) + '\n');
    output.push(shouldAddRecommended
      ? 'Reset .harness.json with newly detected defaults.'
      : 'Reset .harness.json with core defaults.');
  } else {
    if (shouldAddRecommended) {
      const refreshed = await refreshExistingConfig(repo, configPath, { interactive: false, apply: true });
      output.push(...refreshed.output.slice(1));
    } else {
      output.push('Kept existing .harness.json fields unchanged.');
    }
  }

  const preference = await runInteractiveOnboarding(repo, configPath, output, rl);

  return {
    configPath,
    created: false,
    interactive: true,
    configSuggestions: preference,
    output
  };
}

async function withAgentRouting(result, repo, { agentRouting = null, resetAgentRouting = false, removeAgentRouting = false } = {}) {
  const targets = removeAgentRouting
    ? (agentRouting || 'codex')
    : agentRouting;
  const routingResults = await applyAgentRouting(repo, {
    targets,
    reset: resetAgentRouting,
    remove: removeAgentRouting
  });

  if (routingResults.length === 0) {
    return result;
  }

  result.agentRouting = routingResults;
  result.output.push('Agent routing files:');
  for (const routingResult of routingResults) {
    result.output.push(`- ${routingResult.message}`);
  }
  return result;
}

export async function initProjectConfig(repo, {
  refresh = false,
  interactive = false,
  apply = false,
  agentRouting = null,
  resetAgentRouting = false,
  removeAgentRouting = false
} = {}) {
  const configPath = path.join(repo, '.harness.json');
  if (existsSync(configPath)) {
    if (refresh) {
      const result = await refreshExistingConfig(repo, configPath, { interactive, apply });
      return withAgentRouting(result, repo, { agentRouting, resetAgentRouting, removeAgentRouting });
    }

    const shouldAskForRefresh = shouldAskInteractively(interactive);
    if (shouldAskForRefresh) {
      const rl = process.stdin.isTTY
        ? createInterface({
            input: process.stdin,
            output: process.stdout
          })
        : null;
      try {
        const result = await runInteractiveExistingConfig(repo, configPath, rl);
        return withAgentRouting(result, repo, { agentRouting, resetAgentRouting, removeAgentRouting });
      } finally {
        if (rl) {
          rl.close();
        }
      }
    }

    return withAgentRouting({
      configPath,
      created: false,
      output: summaryLines({ configPath, created: false })
    }, repo, { agentRouting, resetAgentRouting, removeAgentRouting });
  }

  const detected = await detectProjectDefaults(repo);
  const config = detected.config;

  await writeText(configPath, JSON.stringify(config, null, 2) + '\n');

  const result = {
    configPath,
    created: true,
    config,
    inference: detected.inference,
    output: summaryLines({
      configPath,
      created: true,
      config,
      inference: detected.inference
    })
  };

  const shouldRunOnboarding = shouldAskInteractively(interactive) &&
    !agentRouting &&
    !resetAgentRouting &&
    !removeAgentRouting;
  if (shouldRunOnboarding) {
    const rl = process.stdin.isTTY
      ? createInterface({
          input: process.stdin,
          output: process.stdout
        })
      : null;
    try {
      const preference = await runInteractiveOnboarding(repo, configPath, result.output, rl);
      result.interactive = true;
      result.configSuggestions = preference;
      return result;
    } finally {
      if (rl) {
        rl.close();
      }
    }
  }

  return withAgentRouting(result, repo, { agentRouting, resetAgentRouting, removeAgentRouting });
}
