import path from 'node:path';
import { writeText } from './fs-utils.js';
import { spawnRuntimeCommand } from './runtime-runner.js';
import { parseProviderUsage } from './usage.js';

const defaultProviders = {
  codex: {
    command: 'codex',
    versionArgs: ['--version'],
    outputMode: 'file',
    defaultTimeoutMs: 10 * 60 * 1000,
    capabilities: {
      outputMode: 'file',
      supportsModel: true,
      supportsSandbox: true,
      requiresOutputFile: true
    },
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
    defaultTimeoutMs: 10 * 60 * 1000,
    capabilities: {
      outputMode: 'stdout',
      supportsModel: true,
      supportsSandbox: false,
      requiresOutputFile: false
    },
    buildArgs({ step, prompt }) {
      const args = ['-p', prompt, '--output-format', 'text'];

      // Map the harness sandbox model onto Claude Code permission flags:
      // write-enabled steps (e.g. coder) may edit files and run package/build
      // commands, while read-only steps keep headless defaults (writes denied).
      if (step.sandbox === 'workspace-write') {
        args.push(
          '--permission-mode',
          'acceptEdits',
          '--allowedTools',
          'Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(mkdir:*),Bash(touch:*),Bash(cp:*),Bash(mv:*)'
        );
      }

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
    defaultTimeoutMs: 10 * 60 * 1000,
    capabilities: {
      outputMode: 'stdout',
      supportsModel: false,
      supportsSandbox: false,
      requiresOutputFile: false
    },
    buildArgs({ prompt }) {
      return ['run', '--prompt', prompt];
    }
  }
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const OUTPUT_MODES = new Set(['file', 'stdout']);

export function knownProviderNames() {
  return Object.keys(defaultProviders);
}

export function providerCapabilities(providerName) {
  const provider = defaultProviders[providerName];
  return provider?.capabilities || null;
}

export function listProviderCapabilities() {
  return Object.fromEntries(
    Object.entries(defaultProviders).map(([name, provider]) => [
      name,
      {
        command: provider.command,
        versionArgs: provider.versionArgs,
        outputMode: provider.outputMode,
        defaultTimeoutMs: provider.defaultTimeoutMs,
        capabilities: provider.capabilities
      }
    ])
  );
}

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

  const outputMode = agentConfig.outputMode || base?.outputMode || 'stdout';
  if (!OUTPUT_MODES.has(outputMode)) {
    throw new Error(`Invalid outputMode "${outputMode}" for agent provider "${providerName}". Available: file, stdout.`);
  }

  if (agentConfig.command !== undefined && String(agentConfig.command).trim().length === 0) {
    throw new Error(`Agent provider "${providerName}" command must be a non-empty string.`);
  }

  return {
    name: providerName,
    command: agentConfig.command || base?.command,
    versionArgs: agentConfig.versionArgs || base?.versionArgs || ['--version'],
    outputMode,
    defaultTimeoutMs: Number(agentConfig.defaultTimeoutMs || base?.defaultTimeoutMs || DEFAULT_TIMEOUT_MS),
    capabilities: {
      ...(base?.capabilities || {}),
      ...(agentConfig.capabilities || {}),
      outputMode
    },
    custom: !base || Boolean(agentConfig.command || agentConfig.args),
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

function appendLimited(current, value, maxBytes) {
  if (Buffer.byteLength(current) >= maxBytes) {
    return { text: current, truncated: true };
  }

  const next = current + value;
  if (Buffer.byteLength(next) <= maxBytes) {
    return { text: next, truncated: false };
  }

  const available = Math.max(0, maxBytes - Buffer.byteLength(current));
  const limited = current + Buffer.from(value).subarray(0, available).toString();
  return { text: limited, truncated: true };
}

function tailText(value, maxBytes = 4096) {
  const buffer = Buffer.from(String(value || ''));
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString();
}

export async function runAgentStep({ repo, runDir, step, prompt, promptPath, agent, resources = {}, runtime = null, redact = null, redactStream = null }) {
  const startedAt = new Date();
  const eventsPath = path.join(runDir, `${step.id}.${agent.name}.stdout.log`);
  const stderrPath = path.join(runDir, `${step.id}.${agent.name}.stderr.log`);
  const finalPath = path.join(runDir, `${step.id}.md`);
  const timeoutMs = Number(step.timeoutMs || resources.agentTimeoutMs || resources.timeoutMs || agent.defaultTimeoutMs || DEFAULT_TIMEOUT_MS);
  const maxLogBytes = Number(step.maxLogBytes || resources.maxLogBytes || DEFAULT_MAX_LOG_BYTES);

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
  let timedOut = false;
  let closed = false;
  let cancelled = false;
  let cancellationSignal = null;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let lastOutputAt = null;
  // 청크 경계 secret 누수를 막기 위해 스트림 redactor(줄 단위)를 사용한다.
  const stdoutRedactor = redactStream
    ? redactStream({ surface: 'agent.stdout', stepId: step.id, agent: agent.name })
    : null;
  const stderrRedactor = redactStream
    ? redactStream({ surface: 'agent.stderr', stepId: step.id, agent: agent.name })
    : null;

  try {
    const child = spawnRuntimeCommand({
      runtime,
      command: agent.command,
      args,
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nTimed out after ${timeoutMs}ms\n`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    }, timeoutMs);

    const cancel = (signal) => {
      cancelled = true;
      cancellationSignal = signal;
      stderr += `\nCancelled by ${signal}\n`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    };
    const onSigint = () => cancel('SIGINT');
    const onSigterm = () => cancel('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    child.stdout.on('data', (chunk) => {
      const value = stdoutRedactor
        ? stdoutRedactor.push(chunk.toString())
        : redact
          ? redact(chunk.toString(), { surface: 'agent.stdout', stepId: step.id, agent: agent.name }).text
          : chunk.toString();
      lastOutputAt = new Date();
      const limited = appendLimited(stdout, value, maxLogBytes);
      stdout = limited.text;
      stdoutTruncated = stdoutTruncated || limited.truncated;
      process.stdout.write(value);
    });

    child.stderr.on('data', (chunk) => {
      const value = stderrRedactor
        ? stderrRedactor.push(chunk.toString())
        : redact
          ? redact(chunk.toString(), { surface: 'agent.stderr', stepId: step.id, agent: agent.name }).text
          : chunk.toString();
      lastOutputAt = new Date();
      const limited = appendLimited(stderr, value, maxLogBytes);
      stderr = limited.text;
      stderrTruncated = stderrTruncated || limited.truncated;
      process.stderr.write(value);
    });

    exitCode = await new Promise((resolve) => {
      child.on('error', (error) => {
        stderr += `${error.message}\n`;
        resolve(1);
      });
      child.on('close', (code) => {
        closed = true;
        clearTimeout(timer);
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        resolve(cancelled ? 130 : timedOut ? 124 : code);
      });
    });
  } catch (error) {
    stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    exitCode = 1;
  }

  // 스트림 redactor에 남은 미완성 줄(carry)을 마스킹해 마저 반영한다.
  if (stdoutRedactor) {
    const tail = stdoutRedactor.flush();
    if (tail) {
      const limited = appendLimited(stdout, tail, maxLogBytes);
      stdout = limited.text;
      stdoutTruncated = stdoutTruncated || limited.truncated;
      process.stdout.write(tail);
    }
  }
  if (stderrRedactor) {
    const tail = stderrRedactor.flush();
    if (tail) {
      const limited = appendLimited(stderr, tail, maxLogBytes);
      stderr = limited.text;
      stderrTruncated = stderrTruncated || limited.truncated;
      process.stderr.write(tail);
    }
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
    outputMode: agent.outputMode,
    capabilities: agent.capabilities,
    customAgent: agent.custom,
    runtime: runtime?.mode || 'local',
    timedOut,
    cancelled,
    cancellationSignal,
    timeoutMs,
    maxLogBytes,
    stdoutTruncated,
    stderrTruncated,
    stderrTail: tailText(stderr),
    usage: parseProviderUsage(`${stdout}\n${stderr}`, { provider: agent.name }),
    lastOutputAt: lastOutputAt ? lastOutputAt.toISOString() : null,
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

export async function getAgentVersion(agent, { skip = false, runtime = null, cwd = process.cwd() } = {}) {
  if (skip) {
    return 'skipped';
  }

  const child = spawnRuntimeCommand({
    runtime,
    command: agent.command,
    args: agent.versionArgs,
    cwd,
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
