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
// 하드닝: --user(host uid:gid) 다음에 network·volume 순서.
assert.equal(args[0], 'run');
assert.equal(args[1], '--rm');
assert.equal(args[2], '--user');
assert.match(args[3], /^\d+:\d+$/, '--user is host uid:gid');
const netIdx = args.indexOf('--network');
assert.deepEqual(args.slice(netIdx, netIdx + 8), [
  '--network',
  'none',
  '--volume',
  '/tmp/repo:/tmp/repo',
  '--volume',
  '/tmp/run:/tmp/run',
  '--workdir',
  '/tmp/repo'
]);
assert.deepEqual(args.slice(-3), ['node:22', 'node', 'script.js']);
// 일반 파이프라인은 rootfs·repo 잠금 없음 (코드 편집 필요).
assert.equal(args.includes('--read-only'), false);
assert.equal(args.includes('/tmp/repo:/tmp/repo:ro'), false);

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

// --- C4b: review_only 파이프라인은 repo :ro + --read-only rootfs로 잠근다 ---
const reviewDocker = runtimeRunnerFromOptions({ runner: 'docker', runnerImage: 'node:22' }, {}, {
  repo: '/tmp/repo',
  runDir: '/tmp/run',
  reviewOnly: true
});
assert.equal(reviewDocker.hardening.readOnlyRootfs, true);
assert.equal(reviewDocker.hardening.repoReadOnly, true);
const reviewArgs = dockerCommandArgs(reviewDocker, { command: 'node', args: [], cwd: '/tmp/repo' });
assert.ok(reviewArgs.includes('--read-only'), 'review_only locks rootfs read-only');
assert.deepEqual(reviewArgs.slice(reviewArgs.indexOf('--read-only'), reviewArgs.indexOf('--read-only') + 3), ['--read-only', '--tmpfs', '/tmp']);
assert.ok(reviewArgs.includes('/tmp/repo:/tmp/repo:ro'), 'review_only mounts repo read-only');
assert.ok(reviewArgs.includes('/tmp/run:/tmp/run'), 'run dir stays writable for artifacts');
const reviewContract = runtimeRunnerContract(reviewDocker);
assert.equal(reviewContract.readOnlyRootfs, true);
assert.equal(reviewContract.repoReadOnly, true);

// user 옵트아웃: runner.docker.user "root" 이면 --user 미포함
const rootDocker = runtimeRunnerFromOptions({ runner: 'docker', runnerImage: 'node:22' }, {
  runner: { user: 'root' }
}, { repo: '/tmp/repo', runDir: '/tmp/run' });
assert.equal(rootDocker.hardening.user, null);
assert.equal(dockerCommandArgs(rootDocker, { command: 'node', args: [] }).includes('--user'), false);

// 명시 uid:gid 지정
const customUser = runtimeRunnerFromOptions({ runner: 'docker', runnerImage: 'node:22' }, {
  runner: { docker: { user: '1000:1000' } }
}, { repo: '/tmp/repo', runDir: '/tmp/run' });
assert.equal(customUser.hardening.user, '1000:1000');

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
