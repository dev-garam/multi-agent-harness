import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readText, runCapture, writeText } from './fs-utils.js';

const DEFAULT_AGENT = 'codex';
const DEFAULT_PIPELINE = 'code_fix';
const DEFAULT_CLEANUP_KEEP = 20;
const SCRIPT_VALIDATIONS = ['lint', 'typecheck', 'check'];
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

function defaultRuntimeConfig({ validation, protectedBranches }) {
  return {
    pipeline: DEFAULT_PIPELINE,
    agent: {
      provider: DEFAULT_AGENT
    },
    testCommand: validation.testCommand,
    buildCommand: validation.buildCommand,
    validationCommands: validation.validationCommands,
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 3,
      maxStepRetries: 1
    },
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
    agent: {
      provider: DEFAULT_AGENT
    },
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 3,
      maxStepRetries: 1
    },
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

async function confirm(question, rl = null) {
  const answer = await askQuestion(question, rl);
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
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

async function runInteractiveExistingConfig(repo, configPath, rl) {
  const output = [
    `Project harness config: ${configPath}`
  ];
  const shouldReset = await confirm('Existing .harness.json found. Reset it from scratch? [y/N] ', rl);
  const shouldAddRecommended = await confirm('Add recommended default fields to .harness.json? [y/N] ', rl);

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

  const allowFutureSuggestions = await confirm('Allow the harness to ask before adding helpful config during future work? [y/N] ', rl);
  const preference = await writeConfigSuggestionPreference(configPath, allowFutureSuggestions);
  output.push(allowFutureSuggestions
    ? 'Future config suggestions: enabled (mode: ask).'
    : 'Future config suggestions: disabled.');

  return {
    configPath,
    created: false,
    interactive: true,
    configSuggestions: preference,
    output
  };
}

export async function initProjectConfig(repo, { refresh = false, interactive = false, apply = false } = {}) {
  const configPath = path.join(repo, '.harness.json');
  if (existsSync(configPath)) {
    if (refresh) {
      return refreshExistingConfig(repo, configPath, { interactive, apply });
    }

    const shouldAskForRefresh = interactive || (process.stdin.isTTY && process.stdout.isTTY);
    if (shouldAskForRefresh) {
      const rl = process.stdin.isTTY
        ? createInterface({
            input: process.stdin,
            output: process.stdout
          })
        : null;
      try {
        return await runInteractiveExistingConfig(repo, configPath, rl);
      } finally {
        if (rl) {
          rl.close();
        }
      }
    }

    return {
      configPath,
      created: false,
      output: summaryLines({ configPath, created: false })
    };
  }

  const detected = await detectProjectDefaults(repo);
  const config = detected.config;

  await writeText(configPath, JSON.stringify(config, null, 2) + '\n');

  return {
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
}
