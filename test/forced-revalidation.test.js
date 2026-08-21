import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// validation이 실패한 상태에서 supervisor가 continue를 내면, 하네스는 어차피
// 런을 failed로 끝낸다. 즉 그 continue를 받아주면 복구를 시도조차 하지 않고
// 끝난다 — 실측한 validation 실패 75건이 전부 이 경로였고 복구율이 0%인 이유다.
//
// 하네스가 그 continue를 재검증으로 되돌린다. run당 1회다. 무제한이면
// continue -> 재검증 -> continue 로 루프가 된다.

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * @param failValidationForever true면 재검증도 계속 실패한다(루프 방지 검증용).
 *        false면 두 번째 검증부터 통과한다(복구 경로 검증용).
 */
function makeRepo(name, { failValidationForever, forceRevalidate = true }) {
  const repo = mkdtempSync(path.join(tmpdir(), `harness-revalidate-${name}-`));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);

  // hermes는 언제나 continue를 낸다. 실제 mock 하네스가 그러하며, 이것이
  // 문제의 조합이다.
  writeFileSync(path.join(repo, 'mock-agent.cjs'), `
const fs = require('fs');
const stepId = process.argv[2];
const finalPath = process.argv[3];
const fence = String.fromCharCode(96, 96, 96);
if (stepId.indexOf('hermes') === 0) {
  fs.writeFileSync(finalPath, '# ' + stepId + '\\n\\n' + fence + 'json\\n' + JSON.stringify({
    status: 'success', nextAction: 'continue', targetStep: null,
    reason: 'mock always continues', instructions: 'report'
  }, null, 2) + '\\n' + fence + '\\n');
} else {
  fs.writeFileSync(finalPath, '# ' + stepId + '\\n\\nmock output');
}
`);

  // validation은 호출될 때마다 카운트한다. failValidationForever가 아니면
  // 두 번째 호출부터 통과한다.
  writeFileSync(path.join(repo, 'validate.cjs'), `
const fs = require('fs');
const countPath = '.validation-count';
const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0) + 1;
fs.writeFileSync(countPath, String(count));
const forever = ${failValidationForever ? 'true' : 'false'};
if (forever || count === 1) {
  console.error('validation failed (call ' + count + ')');
  process.exit(1);
}
console.log('validation passed (call ' + count + ')');
`);

  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
    pipeline: 'quick_fix',
    workspaceMode: 'direct',
    protectedBranches: [],
    validationCommands: [{ id: 'check', command: 'node ./validate.cjs' }],
    agent: {
      provider: 'mock', command: 'node', versionArgs: ['--version'], outputMode: 'file',
      args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
    },
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 4,
      maxStepRetries: 1,
      ...(forceRevalidate ? {} : { forceRevalidateOnFailure: false }),
      agent: {
        provider: 'mock-supervisor', command: 'node', versionArgs: ['--version'], outputMode: 'file',
        args: ['./mock-agent.cjs', '{{stepId}}', '{{finalPath}}']
      }
    }
  }, null, 2));

  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

function runHarness(repo) {
  const result = spawnSync('node', [harnessBin, 'run', '--repo', repo, 'revalidation test'], {
    cwd: harnessRoot, encoding: 'utf8'
  });
  const match = result.stderr.match(/Run dir: (.+)/);
  assert.ok(match, `run dir missing:\n${result.stderr}`);
  const manifest = JSON.parse(readFileSync(path.join(match[1].trim(), 'manifest.json'), 'utf8'));
  return { result, manifest };
}

function validationRuns(manifest) {
  return (manifest.steps || []).filter((step) => step.type === 'validation' && step.status !== 'skipped');
}

// ---------------------------------------------------------------------------
// 복구 경로: 첫 검증 실패 -> continue -> 강제 재검증 -> 통과 -> 성공.
// ---------------------------------------------------------------------------
{
  const repo = makeRepo('recovers', { failValidationForever: false });
  const { result, manifest } = runHarness(repo);

  const decisions = manifest.supervisorDecisions || [];
  const overridden = decisions.filter((entry) => entry.overriddenBy);
  assert.equal(overridden.length, 1, 'exactly one continue is overridden');
  assert.equal(overridden[0].overriddenBy.from, 'continue');
  assert.equal(overridden[0].overriddenBy.to, 'run_validation');
  assert.match(overridden[0].overriddenBy.reason, /validation failure/);
  // 뒤집기 전의 원래 결정도 보존되어야 감사 추적이 성립한다.
  assert.equal(overridden[0].status, 'success');

  // 재검증이 실제로 일어났다.
  assert.ok(validationRuns(manifest).length >= 2, 'validation ran again after the override');

  // 재검증이 통과했으므로 런이 성공한다. 이 경로가 기존에는 존재하지 않았다.
  assert.equal(manifest.status, 'succeeded', `run should recover: ${result.stderr.slice(-400)}`);
  assert.equal(result.status, 0);
}

// ---------------------------------------------------------------------------
// 루프 방지: 재검증도 실패하고 continue가 또 나와도 두 번은 뒤집지 않는다.
// ---------------------------------------------------------------------------
{
  const repo = makeRepo('loops', { failValidationForever: true });
  const { result, manifest } = runHarness(repo);

  const overridden = (manifest.supervisorDecisions || []).filter((entry) => entry.overriddenBy);
  assert.equal(overridden.length, 1, 'override happens at most once per run');
  assert.equal(manifest.status, 'failed', 'a run that never validates still fails');
  assert.notEqual(result.status, 0);
  // 무한 반복이 아니라 유한하게 끝났는지 — supervisor 턴이 상한 안에 있다.
  assert.ok((manifest.supervisorDecisions || []).length <= 4, 'decisions stay within the turn budget');
}

// ---------------------------------------------------------------------------
// 옵트아웃: forceRevalidateOnFailure: false면 기존 동작(그대로 failed).
// ---------------------------------------------------------------------------
{
  const repo = makeRepo('optout', { failValidationForever: false, forceRevalidate: false });
  const { manifest } = runHarness(repo);

  assert.equal(
    (manifest.supervisorDecisions || []).filter((entry) => entry.overriddenBy).length,
    0,
    'no override when the feature is disabled'
  );
  assert.equal(validationRuns(manifest).length, 1, 'validation runs only once');
  assert.equal(manifest.status, 'failed');
}

console.log('forced revalidation tests passed');
