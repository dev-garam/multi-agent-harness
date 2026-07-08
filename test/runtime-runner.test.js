import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  dockerCommandArgs,
  resolveCommandPath,
  runtimeRunnerContract,
  runtimeRunnerFromOptions,
  spawnRuntimeCommand
} from '../src/runtime-runner.js';

const local = runtimeRunnerFromOptions({}, {}, {
  repo: '/tmp/repo',
  runDir: '/tmp/run'
});
assert.equal(local.mode, 'local');
assert.equal(runtimeRunnerContract(local).processIsolation, 'none');

const docker = runtimeRunnerFromOptions({
  runner: 'docker',
  runnerImage: 'node:22'
}, {
  runner: {
    network: 'none',
    envAllowlist: ['HARNESS_TOKEN']
  }
}, {
  repo: '/tmp/repo',
  runDir: '/tmp/run'
});
assert.equal(docker.mode, 'docker');
assert.equal(docker.image, 'node:22');
assert.equal(docker.network, 'none');
assert.deepEqual(docker.mounts, ['/tmp/repo', '/tmp/run']);
const dockerContract = runtimeRunnerContract(docker);
assert.equal(dockerContract.processIsolation, 'container');
assert.equal(dockerContract.envPolicy, 'only envAllowlist keys are passed with --env');

const args = dockerCommandArgs(docker, {
  command: 'node',
  args: ['script.js'],
  cwd: '/tmp/repo'
});
assert.deepEqual(args.slice(0, 8), [
  'run',
  '--rm',
  '--network',
  'none',
  '--volume',
  '/tmp/repo:/tmp/repo',
  '--volume',
  '/tmp/run:/tmp/run'
]);
assert.deepEqual(args.slice(-3), ['node:22', 'node', 'script.js']);

process.env.HARNESS_TOKEN = 'token';
process.env.OTHER_TOKEN = 'other';
const restrictedArgs = dockerCommandArgs(docker, {
  command: 'node',
  args: ['script.js'],
  cwd: '/tmp/repo',
  envAllowlist: ['HARNESS_TOKEN']
});
assert.ok(restrictedArgs.includes('--env'));
assert.ok(restrictedArgs.includes('HARNESS_TOKEN'));
assert.equal(restrictedArgs.includes('OTHER_TOKEN'), false);

assert.throws(() => runtimeRunnerFromOptions({ runner: 'docker' }, {}, {
  repo: '/tmp/repo',
  runDir: '/tmp/run'
}), /requires --runner-image/);

assert.throws(() => runtimeRunnerFromOptions({ runner: 'podman' }, {}, {
  repo: '/tmp/repo',
  runDir: '/tmp/run'
}), /Invalid runner/);

// --- agent 실행 견고성: 바이너리 해석 ---
const binDir = mkdtempSync(path.join(tmpdir(), 'harness-bin-'));
const fakeBin = path.join(binDir, 'faketool');
writeFileSync(fakeBin, '#!/bin/sh\necho hi\n');
chmodSync(fakeBin, 0o755);

// bare 이름을 PATH에서 절대경로로 해석
assert.equal(
  resolveCommandPath('faketool', { PATH: binDir }),
  fakeBin,
  'bare command resolves to absolute path on PATH'
);

// PATH에 없어도 흔한 설치 위치(HOME/bin 등)에서 탐색
const homeDir = mkdtempSync(path.join(tmpdir(), 'harness-home-'));
const homeBin = path.join(homeDir, 'bin');
mkdirSync(homeBin, { recursive: true });
const homeTool = path.join(homeBin, 'hometool');
writeFileSync(homeTool, '#!/bin/sh\necho hi\n');
chmodSync(homeTool, 0o755);
assert.equal(
  resolveCommandPath('hometool', { PATH: '/nonexistent-dir-xyz', HOME: homeDir }),
  homeTool,
  'command resolves via common install dir when absent from PATH'
);

// 어디에도 없으면 null
assert.equal(
  resolveCommandPath('definitely-missing-binary-xyz', { PATH: binDir, HOME: homeDir }),
  null,
  'missing command resolves to null'
);

// 존재하지 않는 절대경로는 null
assert.equal(
  resolveCommandPath('/no/such/absolute/bin', {}),
  null,
  'missing absolute path resolves to null'
);

// 존재하는 절대경로는 그대로 반환
assert.equal(resolveCommandPath(fakeBin, {}), fakeBin, 'existing absolute path is returned');

// spawnRuntimeCommand(local)는 해석 실패 시 명확한 에러로 즉시 실패
assert.throws(
  () => spawnRuntimeCommand({
    runtime: { mode: 'local' },
    command: 'definitely-missing-binary-xyz',
    args: [],
    env: { PATH: binDir, HOME: homeDir }
  }),
  /was not found on PATH or common install directories/,
  'unresolvable local command fails fast with an actionable error'
);

console.log('runtime runner tests passed');
