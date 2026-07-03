import assert from 'node:assert/strict';
import {
  dockerCommandArgs,
  runtimeRunnerContract,
  runtimeRunnerFromOptions
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

console.log('runtime runner tests passed');
