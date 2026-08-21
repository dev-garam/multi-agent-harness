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
    // buildArgs가 실제로 사용하는 CLI 플래그. provider CLI가 업데이트되면서
    // 플래그가 사라지거나 이름이 바뀌면 런은 알 수 없는 인자 오류로 실패한다.
    // doctor가 --help로 존재를 확인해 그 전에 잡는다(버전 숫자보다 직접적이다).
    contract: {
      helpArgs: ['exec', '--help'],
      requiredFlags: ['--cd', '--sandbox', '--json', '--output-last-message']
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
    stdoutFormat: 'json',
    defaultTimeoutMs: 10 * 60 * 1000,
    capabilities: {
      outputMode: 'stdout',
      stdoutFormat: 'json',
      supportsModel: true,
      supportsSandbox: false,
      requiresOutputFile: false
    },
    contract: {
      helpArgs: ['--help'],
      // --output-format json은 usage/비용 측정의 전제라 특히 중요하다.
      requiredFlags: ['-p', '--output-format', '--permission-mode', '--allowedTools']
    },
    // `--output-format json`은 stdout을 단일 JSON 문서로 만든다. 최종 텍스트는
    // result 필드에 들어가고, usage(캐시 토큰 포함)와 total_cost_usd가 함께 실린다.
    // text 모드에서는 이 소비 정보가 아예 출력되지 않아 측정이 불가능하다.
    // 파싱에 실패하면 null을 반환해 호출부가 stdout 원문으로 폴백하게 한다.
    extractFinalOutput(stdout) {
      const trimmed = String(stdout || '').trim();
      if (!trimmed.startsWith('{')) {
        return null;
      }
      try {
        const parsed = JSON.parse(trimmed);
        return typeof parsed.result === 'string' ? parsed.result : null;
      } catch {
        return null;
      }
    },
    buildArgs({ step, prompt }) {
      const args = ['-p', prompt, '--output-format', 'json'];

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
    contract: {
      helpArgs: ['--help'],
      requiredFlags: ['--prompt']
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

/**
 * provider가 선언한 CLI 인자 계약(도움말 인자 + 필수 플래그)을 돌려준다.
 * 내장 adapter가 아니면 null.
 */
export function providerContract(providerName) {
  return defaultProviders[providerName]?.contract || null;
}

/**
 * --help 출력에서 필수 플래그의 누락을 찾는다(순수 함수).
 *
 * null을 반환하면 "검사 대상 아님"이다: 계약이 없는 커스텀 provider이거나
 * 도움말을 읽지 못한 경우. 빈 배열은 "전부 존재"를 뜻한다.
 */
export function missingContractFlags(providerName, helpText) {
  const contract = providerContract(providerName);
  if (!contract || helpText === null || helpText === undefined || String(helpText).trim() === '') {
    return null;
  }
  const text = String(helpText);
  return contract.requiredFlags.filter((flag) => !text.includes(flag));
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
        capabilities: provider.capabilities,
        contract: provider.contract || null
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
    stdoutFormat: agentConfig.stdoutFormat || base?.stdoutFormat || null,
    defaultTimeoutMs: Number(agentConfig.defaultTimeoutMs || base?.defaultTimeoutMs || DEFAULT_TIMEOUT_MS),
    capabilities: {
      ...(base?.capabilities || {}),
      ...(agentConfig.capabilities || {}),
      outputMode
    },
    custom: !base || Boolean(agentConfig.command || agentConfig.args),
    // 역할/에이전트 단위 모델 지정. buildArgs는 step.model을 보므로 실행부에서
    // step에 주입된다. 파이프라인 정의(config/pipelines.json)의 model이 우선한다.
    model: agentConfig.model || null,
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

/** 경과 시간을 사람이 읽기 좋게. 분 단위가 넘어가면 분+초로 쓴다. */
function formatElapsed(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * agent가 도는 동안 살아있음을 알린다.
 *
 * provider CLI는 비대화형(-p) 모드에서 완료 전까지 stdout을 내보내지 않는다.
 * 실측한 run에서 coder 한 스텝이 204초였는데 그 동안 화면에 아무것도 나오지
 * 않는다. 죽은 것인지 도는 것인지 구분되지 않는 것이 문제다.
 *
 * timeout이 가까워지면 남은 시간을 함께 알린다. 기다릴지 끊을지 판단할 수 있어야 한다.
 */
function startProgressReporter({ stepId, startedAt, timeoutMs, intervalMs, getLastOutputAt }) {
  if (!intervalMs || intervalMs <= 0) {
    return () => {};
  }

  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt.getTime();
    const remaining = timeoutMs - elapsed;
    const lastOutputAt = getLastOutputAt();
    const detail = lastOutputAt
      ? `last output ${formatElapsed(Date.now() - lastOutputAt.getTime())} ago`
      : 'no output yet';
    // 남은 시간이 한 주기 안쪽이면 그것을 먼저 알린다.
    const suffix = remaining <= intervalMs * 2 && remaining > 0
      ? `, timeout in ${formatElapsed(remaining)}`
      : '';
    process.stderr.write(`  ... ${stepId} running ${formatElapsed(elapsed)} (${detail}${suffix})\n`);
  }, intervalMs);
  timer.unref();

  return () => clearTimeout(timer) || clearInterval(timer);
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
  const stopProgress = startProgressReporter({
    stepId: step.id,
    startedAt,
    timeoutMs,
    intervalMs: Number(step.progressIntervalMs ?? resources.progressIntervalMs ?? 0),
    getLastOutputAt: () => lastOutputAt
  });
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
  } finally {
    // 어떤 경로로 끝나도 타이머를 멈춘다.
    stopProgress();
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
  // stdout 모드 provider가 구조화 출력을 쓰면(claude --output-format json) 최종
  // 텍스트만 뽑아 finalPath에 남긴다. 그러지 않으면 JSON 래퍼가 통째로 다음 스텝
  // 프롬프트(previousOutputs)에 실려 오히려 컨텍스트를 부풀린다.
  // 추출 실패 시 stdout 원문을 그대로 남긴다(안전한 폴백).
  let finalOutputExtracted = false;
  if (agent.outputMode === 'stdout') {
    const extracted = typeof agent.base?.extractFinalOutput === 'function'
      ? agent.base.extractFinalOutput(stdout)
      : null;
    finalOutputExtracted = extracted !== null && extracted !== undefined;
    await writeText(finalPath, finalOutputExtracted ? extracted : stdout);
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
    stdoutFormat: agent.stdoutFormat || null,
    finalOutputExtracted,
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
