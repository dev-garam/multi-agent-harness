import path from 'node:path';
import { writeText } from './fs-utils.js';
import { spawnRuntimeShell } from './runtime-runner.js';

const DEFAULT_TOOL_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 512 * 1024;

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'tool';
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
  return {
    text: current + Buffer.from(value).subarray(0, available).toString(),
    truncated: true
  };
}

export function toolConfigsFromProjectConfig(projectConfig = {}) {
  return Array.isArray(projectConfig.tools)
    ? projectConfig.tools
      .filter((tool) => tool && typeof tool === 'object')
      .map((tool, index) => ({
        id: tool.id || tool.name || `tool-${index + 1}`,
        setupCommand: tool.setupCommand || '',
        teardownCommand: tool.teardownCommand || '',
        timeoutMs: tool.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
        maxLogBytes: tool.maxLogBytes || DEFAULT_MAX_LOG_BYTES,
        envAllowlist: Array.isArray(tool.envAllowlist) ? tool.envAllowlist : []
      }))
    : [];
}

function envAllowlistForTool(runtime, tool) {
  if (!tool.envAllowlist || tool.envAllowlist.length === 0) {
    return null;
  }
  if (runtime?.mode === 'docker' && Array.isArray(runtime.envAllowlist) && runtime.envAllowlist.length > 0) {
    return runtime.envAllowlist.filter((key) => tool.envAllowlist.includes(key));
  }
  return tool.envAllowlist;
}

async function runToolCommand({ repo, runDir, tool, phase, command, runtime = null, redact = null, redactStream = null }) {
  const startedAt = new Date();
  const safeId = slug(`${tool.id}-${phase}`);
  const stdoutPath = path.join(runDir, `tool-${safeId}.stdout.log`);
  const stderrPath = path.join(runDir, `tool-${safeId}.stderr.log`);
  const child = spawnRuntimeShell({
    runtime,
    command,
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    envAllowlist: envAllowlistForTool(runtime, tool)
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let closed = false;
  const stdoutRedactor = redactStream
    ? redactStream({ surface: 'tool.stdout', tool: tool.id, phase })
    : null;
  const stderrRedactor = redactStream
    ? redactStream({ surface: 'tool.stderr', tool: tool.id, phase })
    : null;

  const timer = setTimeout(() => {
    timedOut = true;
    stderr += `\nTimed out after ${tool.timeoutMs}ms\n`;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!closed) {
        child.kill('SIGKILL');
      }
    }, 1000).unref();
  }, tool.timeoutMs);

  child.stdout.on('data', (chunk) => {
    const value = stdoutRedactor
      ? stdoutRedactor.push(chunk.toString())
      : redact ? redact(chunk.toString(), { surface: 'tool.stdout', tool: tool.id, phase }).text : chunk.toString();
    const limited = appendLimited(stdout, value, tool.maxLogBytes);
    stdout = limited.text;
    stdoutTruncated = stdoutTruncated || limited.truncated;
    process.stdout.write(value);
  });

  child.stderr.on('data', (chunk) => {
    const value = stderrRedactor
      ? stderrRedactor.push(chunk.toString())
      : redact ? redact(chunk.toString(), { surface: 'tool.stderr', tool: tool.id, phase }).text : chunk.toString();
    const limited = appendLimited(stderr, value, tool.maxLogBytes);
    stderr = limited.text;
    stderrTruncated = stderrTruncated || limited.truncated;
    process.stderr.write(value);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      resolve(timedOut ? 124 : code);
    });
  });

  if (stdoutRedactor) {
    const tail = stdoutRedactor.flush();
    if (tail) {
      const limited = appendLimited(stdout, tail, tool.maxLogBytes);
      stdout = limited.text;
      stdoutTruncated = stdoutTruncated || limited.truncated;
      process.stdout.write(tail);
    }
  }
  if (stderrRedactor) {
    const tail = stderrRedactor.flush();
    if (tail) {
      const limited = appendLimited(stderr, tail, tool.maxLogBytes);
      stderr = limited.text;
      stderrTruncated = stderrTruncated || limited.truncated;
      process.stderr.write(tail);
    }
  }

  const finishedAt = new Date();
  await writeText(stdoutPath, stdout);
  await writeText(stderrPath, stderr);

  return {
    type: 'tool',
    toolId: tool.id,
    phase,
    command,
    runtime: runtime?.mode || 'local',
    status: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    timedOut,
    timeoutMs: tool.timeoutMs,
    maxLogBytes: tool.maxLogBytes,
    envAllowlist: tool.envAllowlist,
    stdoutTruncated,
    stderrTruncated,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stdoutPath,
    stderrPath
  };
}

export async function runToolLifecycle({ repo, runDir, tools, phase, runtime = null, redact = null, redactStream = null }) {
  const results = [];
  for (const tool of tools) {
    const command = phase === 'setup' ? tool.setupCommand : tool.teardownCommand;
    if (!command) {
      results.push({
        type: 'tool',
        toolId: tool.id,
        phase,
        status: 'skipped',
        reason: `no ${phase} command configured`
      });
      continue;
    }
    results.push(await runToolCommand({
      repo,
      runDir,
      tool,
      phase,
      command,
      runtime,
      redact,
      redactStream
    }));
  }
  return results;
}
