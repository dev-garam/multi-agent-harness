import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRun, formatApplyResult } from '../src/apply.js';
import { harnessRoot } from '../src/fs-utils.js';

// harness apply: 격리 실행(worktree/patch)의 결과를 원본에 적용한다.
//
// 파일을 실제로 바꾸는 되돌리기 어려운 작업이므로 안전장치가 핵심이다:
// dirty repo 거부, 적용 전 --check 검증, direct 모드 거부.

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-apply-repo-'));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# apply test\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

/** runs/ 아래에 격리 run 하나를 흉내낸다(실제 하네스 실행 없이). */
function seedRun(runId, { repo, patch, mode = 'patch', isolated = true }) {
  const runDir = path.join(harnessRoot, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const patchPath = path.join(runDir, 'changes.patch');
  if (patch !== null) {
    writeFileSync(patchPath, patch);
  }
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId,
    repo,
    status: 'succeeded',
    finishedAt: new Date(0).toISOString(),
    workspace: { mode, isolated, originalRepo: repo, patchPath: patch === null ? undefined : patchPath }
  }, null, 2));
  return { runDir, patchPath };
}

const NEW_FILE_PATCH = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+hello world
`;

const stamp = `2099-01-01_00000${process.pid % 10}`;
const runIds = [`${stamp}_001`, `${stamp}_002`, `${stamp}_003`, `${stamp}_004`];
const repos = [];

function cleanup() {
  for (const runId of runIds) {
    rmSync(path.join(harnessRoot, 'runs', runId), { recursive: true, force: true });
  }
  for (const repo of repos) {
    rmSync(repo, { recursive: true, force: true });
  }
}

try {
  // -------------------------------------------------------------------------
  // 정상 경로: clean repo에 새 파일이 적용된다.
  // -------------------------------------------------------------------------
  const repo = makeRepo();
  repos.push(repo);
  seedRun(runIds[0], { repo, patch: NEW_FILE_PATCH });

  const dry = await applyRun({ runId: runIds[0], dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.deepEqual(dry.files, ['added.txt']);
  assert.equal(existsSync(path.join(repo, 'added.txt')), false, 'dry-run must not write');

  const applied = await applyRun({ runId: runIds[0] });
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.files, ['added.txt']);
  assert.equal(readFileSync(path.join(repo, 'added.txt'), 'utf8'), 'hello world\n');
  assert.match(formatApplyResult(applied), /Applied 1 file\(s\)/);

  // -------------------------------------------------------------------------
  // 안전장치: 원본이 dirty하면 멈춘다. 적용 결과가 기존 변경과 섞이면
  // 무엇이 하네스가 만든 것인지 구분할 수 없게 된다.
  // -------------------------------------------------------------------------
  const dirtyRepo = makeRepo();
  repos.push(dirtyRepo);
  writeFileSync(path.join(dirtyRepo, 'README.md'), '# modified\n');
  seedRun(runIds[1], { repo: dirtyRepo, patch: NEW_FILE_PATCH });

  await assert.rejects(
    () => applyRun({ runId: runIds[1] }),
    /uncommitted change\(s\)/
  );
  assert.equal(existsSync(path.join(dirtyRepo, 'added.txt')), false, 'must not apply to a dirty repo');

  // dry-run은 dirty해도 막지 않는다. 아무것도 쓰지 않으므로 섞일 위험이 없다.
  const dirtyDry = await applyRun({ runId: runIds[1], dryRun: true });
  assert.equal(dirtyDry.status, 'dry-run');
  assert.equal(dirtyDry.dirtyFiles, 1, 'dry-run reports how dirty the target is');
  assert.equal(existsSync(path.join(dirtyRepo, 'added.txt')), false, 'dry-run still must not write');

  // --force로 진행할 수 있다.
  const forced = await applyRun({ runId: runIds[1], force: true });
  assert.equal(forced.status, 'applied');
  assert.equal(existsSync(path.join(dirtyRepo, 'added.txt')), true);

  // -------------------------------------------------------------------------
  // 안전장치: direct 모드 run은 적용 대상이 아니다(이미 원본에 쓰였다).
  // -------------------------------------------------------------------------
  const directRepo = makeRepo();
  repos.push(directRepo);
  seedRun(runIds[2], { repo: directRepo, patch: NEW_FILE_PATCH, mode: 'direct', isolated: false });
  await assert.rejects(
    () => applyRun({ runId: runIds[2] }),
    /already written to the repo/
  );

  // -------------------------------------------------------------------------
  // 빈 patch: 변경이 없었던 run은 실패가 아니라 empty로 보고한다.
  // -------------------------------------------------------------------------
  const emptyRepo = makeRepo();
  repos.push(emptyRepo);
  seedRun(runIds[3], { repo: emptyRepo, patch: '' });
  const empty = await applyRun({ runId: runIds[3] });
  assert.equal(empty.status, 'empty');
  assert.match(formatApplyResult(empty), /produced no changes/);

  // 존재하지 않는 run.
  await assert.rejects(() => applyRun({ runId: '2099-12-31_235959_999' }), /Run not found/);
} finally {
  cleanup();
}

console.log('apply command tests passed');
