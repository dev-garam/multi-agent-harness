import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText } from './fs-utils.js';
import { validationCommandsFromProjectConfig } from './validation.js';

const harnessBin = fileURLToPath(new URL('../bin/harness', import.meta.url));

function mark(status) {
  if (status === 'ok') {
    return 'ok';
  }
  if (status === 'warn') {
    return 'warn';
  }
  return 'fail';
}

async function capture(command, args = [], { cwd = process.cwd(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        exitCode: 124,
        stdout,
        stderr: stderr || `Timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: error.message
      });
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

function printCheck(status, label, detail = '') {
  const suffix = detail ? ` - ${detail}` : '';
  console.log(`[${mark(status)}] ${label}${suffix}`);
}

async function commandVersion(command, args = ['--version']) {
  const result = await capture(command, args);
  const output = (result.stdout || result.stderr).trim().split('\n')[0];
  return {
    ok: result.ok,
    detail: output || 'not available'
  };
}

async function readProjectConfig(repo) {
  const configPath = path.join(repo, '.harness.json');
  if (!existsSync(configPath)) {
    return { configPath, projectConfig: {}, exists: false };
  }

  return {
    configPath,
    projectConfig: JSON.parse(await readText(configPath)),
    exists: true
  };
}

export async function runDoctor({ repo = process.cwd(), agent = null } = {}) {
  const resolvedRepo = path.resolve(repo);
  let hasFailure = false;

  console.log('Harness doctor');
  console.log(`Repo: ${resolvedRepo}`);

  const nodeVersion = await commandVersion('node');
  printCheck(nodeVersion.ok ? 'ok' : 'fail', 'node', nodeVersion.detail);
  hasFailure = hasFailure || !nodeVersion.ok;

  printCheck(existsSync(harnessBin) ? 'ok' : 'fail', 'local harness binary', harnessBin);
  hasFailure = hasFailure || !existsSync(harnessBin);

  const globalHarness = await capture('harness', ['--help']);
  printCheck(globalHarness.ok ? 'ok' : 'warn', 'global harness command', globalHarness.ok ? 'available' : 'run npm link in the harness repo');

  const gitCheck = await capture('git', ['-C', resolvedRepo, 'rev-parse', '--is-inside-work-tree']);
  printCheck(gitCheck.ok ? 'ok' : 'warn', 'target repo git status', gitCheck.ok ? 'inside git worktree' : 'not a git worktree');

  const { configPath, projectConfig, exists } = await readProjectConfig(resolvedRepo);
  printCheck(exists ? 'ok' : 'warn', 'project .harness.json', exists ? configPath : 'not found; defaults will be used');

  const selectedAgent = agent || projectConfig.agent?.provider || projectConfig.agent || 'codex';
  const agentCommands = {
    codex: 'codex',
    claude: 'claude',
    antigravity: 'antigravity'
  };
  const agentCommand = typeof projectConfig.agent === 'object' && projectConfig.agent.command
    ? projectConfig.agent.command
    : agentCommands[selectedAgent] || selectedAgent;
  const agentVersion = await commandVersion(agentCommand);
  printCheck(agentVersion.ok ? 'ok' : 'fail', `selected agent: ${selectedAgent}`, agentVersion.ok ? agentVersion.detail : `${agentCommand} not available`);
  hasFailure = hasFailure || !agentVersion.ok;

  for (const [provider, command] of Object.entries(agentCommands)) {
    if (provider === selectedAgent) {
      continue;
    }
    const version = await commandVersion(command);
    printCheck(version.ok ? 'ok' : 'warn', `optional agent: ${provider}`, version.ok ? version.detail : `${command} not available`);
  }

  const validations = validationCommandsFromProjectConfig(projectConfig);
  printCheck(validations.length > 0 ? 'ok' : 'warn', 'validation commands', validations.length > 0 ? `${validations.length} configured` : 'none configured');

  if (hasFailure) {
    throw new Error('Doctor found required connection problems.');
  }
}
