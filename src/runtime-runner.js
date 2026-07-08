import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const RUNNER_MODES = new Set(['local', 'docker']);
const DOCKER_NETWORKS = new Set(['default', 'none', 'host']);

function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH가 최소한으로 설정된 환경(IDE/cron 등)에서도 agent 바이너리를 찾도록
// 흔한 설치 위치를 PATH 뒤에 덧붙여 탐색한다.
function commonBinDirs(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    home && path.join(home, '.local', 'bin'),
    home && path.join(home, '.npm-global', 'bin'),
    home && path.join(home, '.volta', 'bin'),
    home && path.join(home, 'bin')
  ].filter(Boolean);
}

// command를 실행 가능한 절대 경로로 해석한다.
// - 경로 구분자를 포함하면(명시 경로) 그대로 두되, 절대경로가 존재하지 않으면 null.
// - bare 이름이면 PATH + 흔한 설치 위치에서 탐색해 절대경로를 돌려주고, 없으면 null.
export function resolveCommandPath(command, env = process.env) {
  if (!command || typeof command !== 'string') {
    return null;
  }
  if (command.includes('/')) {
    if (path.isAbsolute(command) && !isExecutableFile(command)) {
      return null;
    }
    return command;
  }

  const searchDirs = [
    ...(env.PATH ? env.PATH.split(path.delimiter) : []),
    ...commonBinDirs(env)
  ].filter(Boolean);

  const seen = new Set();
  for (const dir of searchDirs) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

// 해석된 바이너리의 디렉터리를 자식 PATH 앞에 붙여, agent가 자기 subprocess를
// 호출할 때도 같은 위치를 찾도록 한다.
function withResolvedDirOnPath(env, resolvedCommand) {
  if (!path.isAbsolute(resolvedCommand)) {
    return env;
  }
  const dir = path.dirname(resolvedCommand);
  const current = env.PATH ? env.PATH.split(path.delimiter) : [];
  if (current.includes(dir)) {
    return env;
  }
  return { ...env, PATH: [dir, ...current].join(path.delimiter) };
}

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

  const repo = context.repo ? path.resolve(context.repo) : null;
  const reviewOnly = context.reviewOnly === true;
  const hardening = dockerHardening({ configuredObject, dockerConfig, reviewOnly });

  return {
    mode: 'docker',
    description: `docker image ${image}`,
    image,
    network,
    repo,
    reviewOnly,
    hardening,
    envAllowlist: asArray(configuredObject.envAllowlist || dockerConfig.envAllowlist),
    mounts: uniqueAbsolutePaths([
      context.repo,
      context.runDir,
      ...asArray(configuredObject.mounts || dockerConfig.mounts)
    ])
  };
}

// 컨테이너 하드닝 정책을 설정 + 파이프라인 맥락에서 도출한다.
// - user: 기본 host uid:gid(바인드마운트 소유권 정합). "root"/false로 옵트아웃, 문자열로 지정 가능.
// - readOnlyRootfs / repoReadOnly: review_only는 쓰기가 없어 기본 잠금.
//   일반 파이프라인은 코드 편집이 필요하므로 기본 해제(명시 설정이 항상 우선).
function dockerHardening({ configuredObject, dockerConfig, reviewOnly }) {
  const explicit = { ...dockerConfig, ...configuredObject };

  let user = null;
  const userSetting = explicit.user;
  if (userSetting === false || userSetting === 'root') {
    user = null;
  } else if (typeof userSetting === 'string' && userSetting.trim()) {
    user = userSetting.trim();
  } else if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    user = `${process.getuid()}:${process.getgid()}`;
  }

  const readOnlyRootfs = typeof explicit.readOnly === 'boolean' ? explicit.readOnly : reviewOnly;
  const repoReadOnly = typeof explicit.repoReadOnly === 'boolean' ? explicit.repoReadOnly : reviewOnly;

  return { user, readOnlyRootfs, repoReadOnly };
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

  const hardening = runtime.hardening || {};
  return {
    mode: 'docker',
    processIsolation: 'container',
    filesystem: 'explicit bind mounts',
    envPolicy: 'only envAllowlist keys are passed with --env',
    network: runtime.network || 'default',
    mounts: runtime.mounts || [],
    envAllowlist: runtime.envAllowlist || [],
    user: hardening.user || 'container default (root)',
    readOnlyRootfs: hardening.readOnlyRootfs === true,
    repoReadOnly: hardening.repoReadOnly === true,
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
  const hardening = runtime.hardening || {};

  if (hardening.user) {
    dockerArgs.push('--user', hardening.user);
  }
  if (hardening.readOnlyRootfs) {
    // rootfs를 읽기전용으로 잠그되, 도구가 쓰는 스크래치 공간은 tmpfs로 제공.
    dockerArgs.push('--read-only', '--tmpfs', '/tmp');
  }

  if (runtime.network && runtime.network !== 'default') {
    dockerArgs.push('--network', runtime.network);
  }

  for (const mount of runtime.mounts || []) {
    const readOnly = hardening.repoReadOnly && runtime.repo && mount === runtime.repo;
    dockerArgs.push('--volume', readOnly ? `${mount}:${mount}:ro` : `${mount}:${mount}`);
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
    const baseEnv = env || buildAllowedEnv(envAllowlist);
    const resolved = resolveCommandPath(command, baseEnv);
    if (resolved === null) {
      // ENOENT를 자식 프로세스 error 이벤트로 늦게 흘리는 대신, 여기서
      // 실행 가능한 메시지로 즉시 실패시킨다(호출부는 이미 try/catch로 처리).
      throw new Error(
        `Agent command "${command}" was not found on PATH or common install directories. ` +
        'Install it, add its directory to PATH, or set agent.command to an absolute path.'
      );
    }
    return spawn(resolved, args, {
      cwd,
      env: withResolvedDirOnPath(baseEnv, resolved),
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
