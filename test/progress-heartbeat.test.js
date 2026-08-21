import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resourceConfigFromProjectConfig } from '../src/resources.js';

// provider CLI는 비대화형(-p) 모드에서 완료 전까지 stdout을 내보내지 않는다.
// 실측한 run에서 coder 한 스텝이 204초였고 그 동안 화면에 아무것도 나오지 않는다.
// 죽은 것인지 도는 것인지 구분되지 않는 것이 문제다.

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

// 기본 간격은 30초. 짧은 스텝에는 아무것도 찍히지 않아야 한다.
assert.equal(resourceConfigFromProjectConfig({}).progressIntervalMs, 30 * 1000);
assert.equal(
  resourceConfigFromProjectConfig({ resources: { progressIntervalMs: 5000 } }).progressIntervalMs,
  5000
);
// 0은 "끄기"다. 기본값으로 되돌아가면 안 된다.
assert.equal(resourceConfigFromProjectConfig({ resources: { progressIntervalMs: 0 } }).progressIntervalMs, 0);

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function makeRepo({ agentMs, timeoutMs, intervalMs }) {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-heartbeat-'));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  // 출력 없이 조용히 도는 agent. 실제 provider CLI의 동작을 흉내낸다.
  writeFileSync(path.join(repo, 'mock-agent.cjs'), `
const fs = require('fs');
setTimeout(() => { fs.writeFileSync(process.argv[3], '# done'); process.exit(0); }, ${agentMs});
`);
  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
    pipeline: 'quick_fix',
    protectedBranches: [],
    resources: { progressIntervalMs: intervalMs, agentTimeoutMs: timeoutMs },
    agent: {
      provider: 'mock', command: 'node', versionArgs: ['--version'], outputMode: 'file',
      args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
    },
    supervisor: { enabled: false }
  }, null, 2));
  writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

function run(repo) {
  return spawnSync('node', [harnessBin, 'run', '--repo', repo, 'heartbeat test'], {
    cwd: harnessRoot, encoding: 'utf8'
  });
}

const repos = [];
try {
  // -------------------------------------------------------------------------
  // 조용히 도는 스텝에 진행 표시가 나온다.
  // -------------------------------------------------------------------------
  {
    const repo = makeRepo({ agentMs: 3000, timeoutMs: 30000, intervalMs: 1000 });
    repos.push(repo);
    const result = run(repo);
    const beats = result.stderr.split('\n').filter((line) => /^\s+\.\.\. coder running /.test(line));
    assert.ok(beats.length >= 2, `expected progress lines, got:\n${result.stderr.slice(-500)}`);
    // 살아있다는 것과 아직 출력이 없다는 것을 함께 알린다.
    assert.match(beats[0], /no output yet/);
    // 경과 시간이 늘어난다(멈춘 화면과 구분되어야 한다).
    assert.match(beats[0], /running \d+s/);
  }

  // -------------------------------------------------------------------------
  // timeout이 가까우면 남은 시간을 알린다. 기다릴지 끊을지 판단할 수 있어야 한다.
  // -------------------------------------------------------------------------
  {
    const repo = makeRepo({ agentMs: 30000, timeoutMs: 6000, intervalMs: 1000 });
    repos.push(repo);
    const result = run(repo);
    assert.match(result.stderr, /timeout in \d+s/, 'warns before the deadline');
    // timeout으로 죽으면 실패 분류가 이어받는다.
    assert.match(result.stderr, /Step failed: coder \(timeout, exit 124\)/);
    assert.notEqual(result.status, 0);
  }

  // -------------------------------------------------------------------------
  // 끄면 아무것도 찍히지 않는다. 로그로 넘길 때 노이즈가 되지 않아야 한다.
  // -------------------------------------------------------------------------
  {
    const repo = makeRepo({ agentMs: 2500, timeoutMs: 30000, intervalMs: 0 });
    repos.push(repo);
    const result = run(repo);
    assert.equal(
      /\.\.\. coder running /.test(result.stderr),
      false,
      'progressIntervalMs: 0 disables the reporter'
    );
    assert.equal(result.status, 0, 'the run still succeeds');
  }
} finally {
  for (const repo of repos) {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log('progress heartbeat tests passed');
