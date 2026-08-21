import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessRoot, readText } from './fs-utils.js';
import { validationCommandsFromProjectConfig } from './validation.js';
import { inspectHarnessGitignore, trustBoundaryWarnings } from './trust.js';
import { formatConfigValidationIssues, validateProjectConfig } from './config-validation.js';
import { loadConfig } from './config.js';
import { listProviderCapabilities, missingContractFlags, providerContract, resolveAgentConfig } from './agent.js';
import { assertRuntimeRunnerAvailable, runtimeRunnerFromOptions } from './runtime-runner.js';
import { runHarnessEval } from './eval.js';

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

/**
 * provider CLI가 하네스가 실제로 쓰는 플래그를 여전히 제공하는지 --help로 확인한다.
 *
 * provider CLI는 버전에 따라 인자가 바뀐다. 버전 숫자를 핀으로 박는 것보다
 * 사용하는 플래그의 존재를 직접 확인하는 편이 고장을 정확히 잡는다.
 * 커스텀 command/args를 쓰는 provider는 내장 buildArgs를 타지 않으므로 건너뛴다.
 */
async function checkProviderContract(providerName, command, { custom = false } = {}) {
  const contract = providerContract(providerName);
  if (!contract || custom) {
    return { status: 'skipped', detail: custom ? 'custom command/args' : 'no built-in contract' };
  }

  const help = await capture(command, contract.helpArgs);
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  const missing = missingContractFlags(providerName, helpText);
  if (missing === null) {
    return { status: 'unknown', detail: `could not read \`${command} ${contract.helpArgs.join(' ')}\`` };
  }
  if (missing.length > 0) {
    return {
      status: 'fail',
      detail: `missing CLI flags: ${missing.join(', ')}. The provider CLI may have changed its arguments.`
    };
  }
  return { status: 'ok', detail: `${contract.requiredFlags.length} required flag(s) present` };
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

  const harnessConfig = await loadConfig();
  const configValidation = validateProjectConfig(projectConfig, { harnessConfig });
  printCheck(configValidation.valid ? configValidation.warnings.length > 0 ? 'warn' : 'ok' : 'fail', 'project config validation',
    configValidation.errors.length > 0
      ? `${configValidation.errors.length} error(s)`
      : configValidation.warnings.length > 0
        ? `${configValidation.warnings.length} warning(s)`
        : 'ok');
  if (configValidation.errors.length > 0 || configValidation.warnings.length > 0) {
    console.log(formatConfigValidationIssues(configValidation));
  }
  hasFailure = hasFailure || !configValidation.valid;

  let selectedRuntime = null;
  let selectedAgent = null;
  try {
    selectedAgent = resolveAgentConfig({
      options: agent ? { agent } : {},
      projectConfig
    });
    const agentVersion = await commandVersion(selectedAgent.command, selectedAgent.versionArgs);
    printCheck(agentVersion.ok ? 'ok' : 'fail', `selected agent: ${selectedAgent.name}`, agentVersion.ok ? agentVersion.detail : `${selectedAgent.command} not available`);
    printCheck('ok', 'selected agent contract',
      `output=${selectedAgent.outputMode}, defaultTimeoutMs=${selectedAgent.defaultTimeoutMs}, custom=${selectedAgent.custom}`);
    hasFailure = hasFailure || !agentVersion.ok;

    if (agentVersion.ok) {
      const cliContract = await checkProviderContract(selectedAgent.name, selectedAgent.command, {
        custom: selectedAgent.custom
      });
      printCheck(
        cliContract.status === 'fail' ? 'fail' : cliContract.status === 'ok' ? 'ok' : 'warn',
        `selected agent CLI flags: ${selectedAgent.name}`,
        cliContract.detail
      );
      hasFailure = hasFailure || cliContract.status === 'fail';
    }
  } catch (error) {
    printCheck('fail', 'selected agent', error instanceof Error ? error.message : String(error));
    hasFailure = true;
  }

  for (const [provider, contract] of Object.entries(listProviderCapabilities())) {
    if (provider === selectedAgent?.name) {
      continue;
    }
    const version = await commandVersion(contract.command, contract.versionArgs);
    printCheck(version.ok ? 'ok' : 'warn', `optional agent: ${provider}`,
      version.ok ? `${version.detail}; output=${contract.outputMode}` : `${contract.command} not available`);
    if (version.ok) {
      const cliContract = await checkProviderContract(provider, contract.command);
      if (cliContract.status !== 'ok') {
        printCheck(cliContract.status === 'fail' ? 'warn' : 'warn', `optional agent CLI flags: ${provider}`, cliContract.detail);
      }
    }
  }

  try {
    selectedRuntime = runtimeRunnerFromOptions({}, projectConfig, {
      repo: resolvedRepo,
      runDir: path.join(harnessRoot, 'runs', '.doctor')
    });
    if (selectedRuntime.mode === 'docker') {
      try {
        assertRuntimeRunnerAvailable(selectedRuntime);
        printCheck('ok', 'runtime runner', `${selectedRuntime.description}, network=${selectedRuntime.network}`);
      } catch (error) {
        printCheck('fail', 'runtime runner', error instanceof Error ? error.message : String(error));
        hasFailure = true;
      }
    } else {
      printCheck('ok', 'runtime runner', selectedRuntime.description);
    }
  } catch (error) {
    printCheck('fail', 'runtime runner', error instanceof Error ? error.message : String(error));
    hasFailure = true;
  }

  const validations = validationCommandsFromProjectConfig(projectConfig);
  printCheck(validations.length > 0 ? 'ok' : 'warn', 'validation commands', validations.length > 0 ? `${validations.length} configured` : 'none configured');

  if (validations.length > 0) {
    const validationRuntime = selectedRuntime?.mode === 'docker'
      ? 'configured Docker runner'
      : 'local shell';
    printCheck('warn', 'validation command trust boundary', `configured commands execute through the ${validationRuntime}`);
  }

  const customAgent = selectedAgent?.custom;
  if (customAgent) {
    printCheck('warn', 'custom agent trust boundary', 'custom command/args execute through the selected runtime runner');
  }

  const trustWarnings = trustBoundaryWarnings(projectConfig).filter((entry) => entry.severity === 'warning');
  printCheck(trustWarnings.length > 0 ? 'warn' : 'ok', 'trust boundary warnings', trustWarnings.length > 0 ? `${trustWarnings.length} warning(s); see docs/security-model.md` : 'none');

  const gitignore = await inspectHarnessGitignore(harnessRoot);
  printCheck(gitignore.status, 'harness .gitignore runtime exclusions', gitignore.message);

  try {
    const evalResult = JSON.parse(await runHarnessEval({ repo: resolvedRepo, json: true }));
    const evalStatus = evalResult.status === 'passed'
      ? evalResult.score.warned > 0 ? 'warn' : 'ok'
      : 'fail';
    printCheck(evalStatus, 'harness eval readiness',
      `${evalResult.status}; score=${evalResult.score.passed}/${evalResult.score.total}; warnings=${evalResult.score.warned}; report=${evalResult.reportPath}`);
    hasFailure = hasFailure || evalResult.status !== 'passed';
  } catch (error) {
    printCheck('fail', 'harness eval readiness', error instanceof Error ? error.message : String(error));
    hasFailure = true;
  }

  if (hasFailure) {
    throw new Error('Doctor found required connection problems.');
  }
}
