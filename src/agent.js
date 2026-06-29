import { spawn } from 'node:child_process';
import path from 'node:path';
import { writeText } from './fs-utils.js';

const defaultProviders = {
  codex: {
    command: 'codex',
    versionArgs: ['--version'],
    outputMode: 'file',
    buildArgs({ repo, step, prompt, finalPath }) {
      const args = [
        'exec',
        '--cd',
        repo,
        '--sandbox',
        step.sandbox || 'read-only',
        '--json',
        '--output-last-message',
        finalPath
      ];

      if (step.model) {
        args.push('--model', step.model);
      }

      args.push(prompt);
      return args;
    }
  },
  claude: {
    command: 'claude',
    versionArgs: ['--version'],
    outputMode: 'stdout',
    buildArgs({ step, prompt }) {
      const args = ['-p', prompt, '--output-format', 'text'];

      if (step.model) {
        args.push('--model', step.model);
      }

      return args;
    }
  },
  antigravity: {
    command: 'antigravity',
    versionArgs: ['--version'],
    outputMode: 'stdout',
    buildArgs({ prompt }) {
      return ['run', '--prompt', prompt];
    }
  }
};

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function replacePlaceholders(value, context) {
  return String(value)
    .replaceAll('{{repo}}', context.repo)
    .replaceAll('{{prompt}}', context.prompt)
    .replaceAll('{{promptPath}}', context.promptPath)
    .replaceAll('{{finalPath}}', context.finalPath)
    .replaceAll('{{stepId}}', context.step.id);
}

function providerFromConfig(agentConfig = {}) {
  const providerName = agentConfig.provider || agentConfig.name || 'codex';
  const base = defaultProviders[providerName];

  if (!base && !agentConfig.command) {
    const names = Object.keys(defaultProviders).join(', ');
    throw new Error(`Unknown agent provider "${providerName}". Available: ${names}, or configure agent.command.`);
  }

  return {
    name: providerName,
    command: agentConfig.command || base.command,
    versionArgs: agentConfig.versionArgs || base.versionArgs || ['--version'],
    outputMode: agentConfig.outputMode || base.outputMode || 'stdout',
    args: agentConfig.args,
    base
  };
}

export function resolveAgentConfig({ options = {}, projectConfig = {} } = {}) {
  const projectAgent = typeof projectConfig.agent === 'string'
    ? { provider: projectConfig.agent }
    : projectConfig.agent || {};
  const provider = options.agent || projectAgent.provider || projectAgent.name || 'codex';

  return providerFromConfig({
    ...projectAgent,
    provider
  });
}

export async function runAgentStep({ repo, runDir, step, prompt, promptPath, agent }) {
  const startedAt = new Date();
  const eventsPath = path.join(runDir, `${step.id}.${agent.name}.stdout.log`);
  const stderrPath = path.join(runDir, `${step.id}.${agent.name}.stderr.log`);
  const finalPath = path.join(runDir, `${step.id}.md`);

  const context = { repo, step, prompt, promptPath, finalPath };
  const args = agent.args
    ? asArray(agent.args).map((arg) => replacePlaceholders(arg, context))
    : agent.base?.buildArgs(context);

  if (!args) {
    throw new Error(`Agent provider "${agent.name}" needs args in .harness.json because it has no built-in adapter.`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const child = spawn(agent.command, args, {
      cwd: repo,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      stdout += value;
      process.stdout.write(value);
    });

    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(value);
    });

    exitCode = await new Promise((resolve) => {
      child.on('error', (error) => {
        stderr += `${error.message}\n`;
        resolve(1);
      });
      child.on('close', resolve);
    });
  } catch (error) {
    stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    exitCode = 1;
  }

  await writeText(eventsPath, stdout);
  await writeText(stderrPath, stderr);
  if (agent.outputMode === 'stdout') {
    await writeText(finalPath, stdout);
  }
  const finishedAt = new Date();

  return {
    type: 'agent',
    stepId: step.id,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    agent: agent.name,
    command: agent.command,
    sandbox: step.sandbox || 'read-only',
    approval: step.approval || 'never',
    model: step.model || null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    eventsPath,
    stderrPath,
    finalPath
  };
}

export async function getAgentVersion(agent, { skip = false } = {}) {
  if (skip) {
    return 'skipped';
  }

  const child = spawn(agent.command, agent.versionArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', resolve);
  });

  if (exitCode !== 0) {
    return stderr.trim() || 'unknown';
  }

  return stdout.trim() || 'unknown';
}
