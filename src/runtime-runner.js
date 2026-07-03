import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const RUNNER_MODES = new Set(['local', 'docker']);
const DOCKER_NETWORKS = new Set(['default', 'none', 'host']);

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function uniqueAbsolutePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((entry) => path.resolve(entry)))];
}

function buildAllowedEnv(keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return process.env;
  }

  const alwaysKeep = ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP'];
  const env = {};
  for (const key of [...alwaysKeep, ...keys]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runnerObject(projectConfig = {}) {
  if (projectConfig.runner !== undefined) {
    return projectConfig.runner;
  }
  if (projectConfig.runtime?.runner !== undefined) {
    return projectConfig.runtime.runner;
  }
  return undefined;
}

export function runtimeRunnerFromOptions(options = {}, projectConfig = {}, context = {}) {
  const configured = runnerObject(projectConfig);
  const configuredObject = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured
    : {};
  const dockerConfig = {
    ...(projectConfig.dockerRunner || {}),
    ...(projectConfig.runtime?.docker || {}),
    ...(configuredObject.docker || {})
  };
  const mode = options.runner || configuredObject.mode || configured || 'local';
  const normalizedMode = String(mode).toLowerCase();

  if (!RUNNER_MODES.has(normalizedMode)) {
    throw new Error(`Invalid runner "${mode}". Available: local, docker.`);
  }

  if (normalizedMode === 'local') {
    return {
      mode: 'local',
      description: 'local child process',
      envAllowlist: []
    };
  }

  const image = options.runnerImage || configuredObject.image || dockerConfig.image;
  if (!image || typeof image !== 'string') {
    throw new Error('Docker runner requires --runner-image <image> or runner.image in .harness.json.');
  }

  const network = configuredObject.network || dockerConfig.network || 'default';
  if (!DOCKER_NETWORKS.has(network)) {
    throw new Error('Docker runner network must be one of: default, none, host.');
  }

  return {
    mode: 'docker',
    description: `docker image ${image}`,
    image,
    network,
    envAllowlist: asArray(configuredObject.envAllowlist || dockerConfig.envAllowlist),
    mounts: uniqueAbsolutePaths([
      context.repo,
      context.runDir,
      ...asArray(configuredObject.mounts || dockerConfig.mounts)
    ])
  };
}

export function runtimeRunnerContract(runtime) {
  if (!runtime || runtime.mode === 'local') {
    return {
      mode: 'local',
      processIsolation: 'none',
      filesystem: 'host working tree',
      envPolicy: 'inherits process.env unless command/tool envAllowlist is set',
      shell: 'host shell'
    };
  }

  return {
    mode: 'docker',
    processIsolation: 'container',
    filesystem: 'explicit bind mounts',
    envPolicy: 'only envAllowlist keys are passed with --env',
    network: runtime.network || 'default',
    mounts: runtime.mounts || [],
    envAllowlist: runtime.envAllowlist || [],
    shell: 'container sh -lc for shell commands'
  };
}

export function assertRuntimeRunnerAvailable(runtime) {
  if (!runtime || runtime.mode === 'local') {
    return;
  }

  const result = spawnSync('docker', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || 'docker command is not available';
    throw new Error(`Docker runner is selected but Docker is not available: ${detail}`);
  }
}

export function dockerCommandArgs(runtime, { command, args = [], cwd, envAllowlist = null }) {
  const dockerArgs = ['run', '--rm'];

  if (runtime.network && runtime.network !== 'default') {
    dockerArgs.push('--network', runtime.network);
  }

  for (const mount of runtime.mounts || []) {
    dockerArgs.push('--volume', `${mount}:${mount}`);
  }

  for (const key of envAllowlist || runtime.envAllowlist || []) {
    if (process.env[key] !== undefined) {
      dockerArgs.push('--env', key);
    }
  }

  if (cwd) {
    dockerArgs.push('--workdir', cwd);
  }

  dockerArgs.push(runtime.image, command, ...args);
  return dockerArgs;
}

export function spawnRuntimeCommand({ runtime, command, args = [], cwd, stdio = ['ignore', 'pipe', 'pipe'], env = null, envAllowlist = null }) {
  if (!runtime || runtime.mode === 'local') {
    return spawn(command, args, {
      cwd,
      env: env || buildAllowedEnv(envAllowlist),
      stdio
    });
  }

  return spawn('docker', dockerCommandArgs(runtime, { command, args, cwd, envAllowlist }), {
    cwd,
    env: process.env,
    stdio
  });
}

export function spawnRuntimeShell({ runtime, command, cwd, stdio = ['ignore', 'pipe', 'pipe'], env = null, envAllowlist = null }) {
  if (!runtime || runtime.mode === 'local') {
    return spawn(command, {
      cwd,
      env: env || buildAllowedEnv(envAllowlist),
      shell: true,
      stdio
    });
  }

  return spawnRuntimeCommand({
    runtime,
    command: 'sh',
    args: ['-lc', command],
    cwd,
    stdio,
    envAllowlist
  });
}
