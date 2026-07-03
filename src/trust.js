import { existsSync } from 'node:fs';
import path from 'node:path';
import { readText } from './fs-utils.js';
import { validationCommandsFromProjectConfig } from './validation.js';

const REQUIRED_GITIGNORE_PATTERNS = [
  'runs/',
  '.harness/',
  '.env',
  '.env.*'
];

function includesGitignorePattern(text, pattern) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === pattern);
}

export async function inspectHarnessGitignore(root) {
  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return {
      status: 'warn',
      path: gitignorePath,
      missing: REQUIRED_GITIGNORE_PATTERNS,
      message: '.gitignore is missing; runtime logs and local state may be committed accidentally.'
    };
  }

  const text = await readText(gitignorePath);
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter((pattern) => !includesGitignorePattern(text, pattern));
  return {
    status: missing.length === 0 ? 'ok' : 'warn',
    path: gitignorePath,
    missing,
    message: missing.length === 0
      ? 'runtime output and common env files are ignored'
      : `missing ignore patterns: ${missing.join(', ')}`
  };
}

export function trustBoundaryWarnings(projectConfig = {}) {
  const warnings = [
    {
      id: 'local-first-execution',
      severity: 'info',
      message: 'Harness runs agent and validation commands on the local machine unless an external runner isolates them.'
    },
    {
      id: 'trusted-repo-required',
      severity: 'warning',
      message: 'Do not run this harness against repos or .harness.json files you do not trust.'
    },
    {
      id: 'logs-may-contain-sensitive-data',
      severity: 'warning',
      message: 'Run artifacts may contain prompts, absolute paths, stdout/stderr, diffs, or secrets from tools.'
    }
  ];

  const validationCommands = validationCommandsFromProjectConfig(projectConfig);
  if (validationCommands.length > 0) {
    warnings.push({
      id: 'validation-commands-execute-shell',
      severity: 'warning',
      message: 'Configured validation commands execute through the local shell.',
      commands: validationCommands.map((entry) => ({
        id: entry.id,
        command: entry.command
      }))
    });
  }

  const agentConfig = typeof projectConfig.agent === 'object' ? projectConfig.agent : null;
  if (agentConfig?.command || agentConfig?.args) {
    warnings.push({
      id: 'custom-agent-command',
      severity: 'warning',
      message: 'Custom agent command/args execute as a local child process.',
      command: agentConfig.command || null
    });
  }

  return warnings;
}

export function trustBoundarySummary(projectConfig = {}) {
  return {
    executionModel: 'local-first',
    trustedInputs: [
      'target repository contents',
      '.harness.json',
      'configured agent commands',
      'configured validation commands'
    ],
    notGuaranteed: [
      'correctness of agent output',
      'strong sandboxing by the harness process',
      'secret redaction from run artifacts',
      'safety of arbitrary commands'
    ],
    warnings: trustBoundaryWarnings(projectConfig)
  };
}
