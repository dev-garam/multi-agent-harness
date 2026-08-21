import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { carryUncommittedFromConfig, prepareWorkspace } from '../src/workspace.js';

// worktree는 HEAD 기준으로 만들어지므로 작업 중인 변경이 보이지 않는다.
// 뭔가 고치다가 일부를 하네스에 맡기는 흐름에서는 이게 정면으로 걸리므로,
// workspace.carryUncommitted로 그 변경을 격리 워크스페이스에 옮길 수 있다.
//
// 가장 중요한 계약 두 가지:
//  - 원본 repo를 절대 건드리지 않는다(인덱스 포함).
//  - gitignore된 것은 옮기지 않는다. node_modules가 딸려오면 재앙이다.

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-carry-'));
  const init = spawnSync('git', ['init', '-b', 'work'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) {
    git(['init'], repo);
    git(['checkout', '-b', 'work'], repo);
  }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(path.join(repo, 'note.txt'), 'line A\n');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored/\nsecret.txt\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

const cleanupPaths = [];
function runDirFor(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `harness-carry-run-${name}-`));
  cleanupPaths.push(dir);
  return dir;
}

try {
  // -------------------------------------------------------------------------
  // 설정 해석: 기본 on. 격리가 기본인 이상 작업 중 변경이 보이지 않으면
  // "왜 내 수정이 반영 안 되지"가 되어 격리 자체를 못 쓰게 된다. 두 기본값은 짝이다.
  // -------------------------------------------------------------------------
  assert.equal(carryUncommittedFromConfig({}, {}), true);
  assert.equal(carryUncommittedFromConfig({}, { workspace: {} }), true);
  assert.equal(carryUncommittedFromConfig({}, { workspace: { carryUncommitted: true } }), true);
  // 명시적으로 끌 수 있다.
  assert.equal(carryUncommittedFromConfig({}, { workspace: { carryUncommitted: false } }), false);
  // true가 아닌 값은 켜지 않는다(오타가 조용히 통과하지 않게).
  assert.equal(carryUncommittedFromConfig({}, { workspace: { carryUncommitted: 'yes' } }), false);
  // CLI 옵션이 설정보다 우선한다(양방향).
  assert.equal(carryUncommittedFromConfig({ carryUncommitted: true }, { workspace: { carryUncommitted: false } }), true);
  assert.equal(
    carryUncommittedFromConfig({ carryUncommitted: false }, { workspace: { carryUncommitted: true } }),
    false
  );

  // -------------------------------------------------------------------------
  // carryUncommitted를 끄면 worktree는 HEAD만 본다.
  // -------------------------------------------------------------------------
  const plainRepo = makeRepo();
  cleanupPaths.push(plainRepo);
  writeFileSync(path.join(plainRepo, 'note.txt'), 'line A\nline B\n');
  const plainRun = runDirFor('plain');
  const plain = await prepareWorkspace({ repo: plainRepo, runDir: plainRun, mode: 'worktree' });
  assert.equal(readFileSync(path.join(plain.executionRepo, 'note.txt'), 'utf8'), 'line A\n');
  assert.equal(plain.carriedUncommitted.attempted, false);
  git(['worktree', 'remove', '--force', plain.executionRepo], plainRepo);

  // -------------------------------------------------------------------------
  // carryUncommitted: 작업 중 변경과 새 파일이 함께 옮겨진다.
  // -------------------------------------------------------------------------
  const repo = makeRepo();
  cleanupPaths.push(repo);
  writeFileSync(path.join(repo, 'note.txt'), 'line A\nline B — work in progress\n');
  writeFileSync(path.join(repo, 'new-file.txt'), 'draft\n');
  mkdirSync(path.join(repo, 'nested'), { recursive: true });
  writeFileSync(path.join(repo, 'nested', 'deep.txt'), 'nested draft\n');
  // gitignore 대상. 이것들이 따라오면 안 된다.
  mkdirSync(path.join(repo, 'ignored'), { recursive: true });
  writeFileSync(path.join(repo, 'ignored', 'junk.txt'), 'junk\n');
  writeFileSync(path.join(repo, 'secret.txt'), 'do not carry\n');
  // 일부는 staged 상태로 둔다(커밋은 안 함).
  git(['add', 'new-file.txt'], repo);

  const indexBefore = git(['status', '--porcelain'], repo);

  const runDir = runDirFor('carry');
  const workspace = await prepareWorkspace({
    repo, runDir, mode: 'worktree', carryUncommitted: true
  });
  const wt = workspace.executionRepo;

  assert.equal(
    readFileSync(path.join(wt, 'note.txt'), 'utf8'),
    'line A\nline B — work in progress\n',
    'tracked modification must be carried'
  );
  assert.equal(readFileSync(path.join(wt, 'new-file.txt'), 'utf8'), 'draft\n', 'staged-but-uncommitted file carried');
  assert.equal(readFileSync(path.join(wt, 'nested', 'deep.txt'), 'utf8'), 'nested draft\n', 'nested untracked carried');

  // gitignore된 것은 오지 않는다.
  assert.equal(existsSync(path.join(wt, 'ignored', 'junk.txt')), false, 'gitignored dir must not be carried');
  assert.equal(existsSync(path.join(wt, 'secret.txt')), false, 'gitignored file must not be carried');

  // 원본은 그대로다. 인덱스도 건드리지 않는다.
  assert.equal(git(['status', '--porcelain'], repo), indexBefore, 'the original repo must be untouched');
  assert.equal(readFileSync(path.join(repo, 'note.txt'), 'utf8'), 'line A\nline B — work in progress\n');

  assert.equal(workspace.carriedUncommitted.status, 'succeeded');
  // staged된 new-file.txt는 `git diff HEAD`에 잡히므로 tracked 쪽으로 넘어간다.
  // 순수 untracked는 nested/deep.txt 하나다. 두 경로가 함께 동작해야 전부 옮겨진다.
  assert.equal(workspace.carriedUncommitted.tracked, 2, 'note.txt(modified) + new-file.txt(staged)');
  assert.equal(workspace.carriedUncommitted.untracked, 1, 'nested/deep.txt only');

  git(['worktree', 'remove', '--force', wt], repo);

  // -------------------------------------------------------------------------
  // 옮길 것이 없으면 조용히 성공한다(빈 diff, untracked 없음).
  // -------------------------------------------------------------------------
  const cleanRepo = makeRepo();
  cleanupPaths.push(cleanRepo);
  const cleanRun = runDirFor('clean');
  const cleanWorkspace = await prepareWorkspace({
    repo: cleanRepo, runDir: cleanRun, mode: 'worktree', carryUncommitted: true
  });
  assert.equal(cleanWorkspace.carriedUncommitted.status, 'succeeded');
  assert.equal(cleanWorkspace.carriedUncommitted.tracked, 0);
  assert.equal(cleanWorkspace.carriedUncommitted.untracked, 0);
  git(['worktree', 'remove', '--force', cleanWorkspace.executionRepo], cleanRepo);
} finally {
  for (const target of cleanupPaths) {
    rmSync(target, { recursive: true, force: true });
  }
}

console.log('workspace carry tests passed');
