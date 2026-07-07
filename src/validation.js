import path from 'node:path';
import { writeText } from './fs-utils.js';
import { spawnRuntimeShell } from './runtime-runner.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'command';
}

export function validationCommandsFromProjectConfig(projectConfig = {}) {
  const commands = [];

  if (projectConfig.buildCommand) {
    commands.push({ id: 'build', command: projectConfig.buildCommand });
  }

  if (projectConfig.testCommand) {
    commands.push({ id: 'test', command: projectConfig.testCommand });
  }

  if (Array.isArray(projectConfig.validationCommands)) {
    projectConfig.validationCommands.forEach((entry, index) => {
      if (typeof entry === 'string') {
        commands.push({ id: `validation-${index + 1}`, command: entry });
        return;
      }

      if (entry && typeof entry === 'object' && entry.command) {
        commands.push({
          id: entry.id || slug(entry.name || entry.command),
          command: entry.command,
          timeoutMs: entry.timeoutMs,
          maxLogBytes: entry.maxLogBytes
        });
      }
    });
  }

  return commands;
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

export async function runValidationCommand({ repo, runDir, id, command, timeoutMs = DEFAULT_TIMEOUT_MS, maxLogBytes = DEFAULT_MAX_LOG_BYTES, runtime = null, redact = null, redactStream = null }) {
  const startedAt = new Date();
  const safeId = slug(id);
  const stdoutPath = path.join(runDir, `validation-${safeId}.stdout.log`);
  const stderrPath = path.join(runDir, `validation-${safeId}.stderr.log`);

  const child = spawnRuntimeShell({
    runtime,
    command,
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let closed = false;
  let cancelled = false;
  let cancellationSignal = null;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let lastOutputAt = null;
  const stdoutRedactor = redactStream
    ? redactStream({ surface: 'validation.stdout', id: safeId })
    : null;
  const stderrRedactor = redactStream
    ? redactStream({ surface: 'validation.stderr', id: safeId })
    : null;

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
        ? redact(chunk.toString(), { surface: 'validation.stdout', id: safeId }).text
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
        ? redact(chunk.toString(), { surface: 'validation.stderr', id: safeId }).text
        : chunk.toString();
    lastOutputAt = new Date();
    const limited = appendLimited(stderr, value, maxLogBytes);
    stderr = limited.text;
    stderrTruncated = stderrTruncated || limited.truncated;
    process.stderr.write(value);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      resolve(cancelled ? 130 : timedOut ? 124 : code);
    });
  });

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

  const finishedAt = new Date();
  await writeText(stdoutPath, stdout);
  await writeText(stderrPath, stderr);

  return {
    type: 'validation',
    stepId: `validation:${safeId}`,
    id: safeId,
    command,
    runtime: runtime?.mode || 'local',
    status: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    timedOut,
    cancelled,
    cancellationSignal,
    timeoutMs,
    maxLogBytes,
    stdoutTruncated,
    stderrTruncated,
    stderrTail: tailText(stderr),
    lastOutputAt: lastOutputAt ? lastOutputAt.toISOString() : null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stdoutPath,
    stderrPath
  };
}
