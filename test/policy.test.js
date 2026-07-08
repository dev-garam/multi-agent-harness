import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultPolicy,
  evaluateChangeRisk,
  evaluatePolicy,
  evaluateProtectedBranchPolicy
} from '../src/policy.js';

// C2b: diff·명령 allowlist 기반 판정 + detached HEAD 처리.
// 원칙 — additive. approval을 추가만 하고 기존 게이트를 완화하지 않는다.

// --- 기존 텍스트 게이트 회귀(변경 없음 확인) ---
assert.equal(evaluatePolicy({ request: 'README 문구 정리', mode: 'direct' }).requiresApproval, false);
assert.equal(evaluatePolicy({ request: '데이터베이스 전체 삭제', mode: 'direct' }).requiresApproval, true);

// --- evaluateChangeRisk: diff 근거 ---
// 위험 경로(migration) 변경 → 승인
const migrationRisk = evaluateChangeRisk({
  inspection: { riskyFiles: [{ ruleId: 'migration', path: 'db/migrations/001.sql' }], secretFindings: [] }
});
assert.equal(migrationRisk.requiresApproval, true);
assert.match(migrationRisk.reasons[0], /migration/);

// 위험하지 않은 경로 → 승인 불필요
const benignRisk = evaluateChangeRisk({
  inspection: { riskyFiles: [{ ruleId: 'dependency-manifest', path: 'package.json' }], secretFindings: [] }
});
assert.equal(benignRisk.requiresApproval, false, 'non-gated risky rule does not force approval by default');

// secret 노출 → 승인
const secretRisk = evaluateChangeRisk({
  inspection: { riskyFiles: [], secretFindings: [{ ruleId: 'bearer-token', path: 'src/x.js' }] }
});
assert.equal(secretRisk.requiresApproval, true);
assert.match(secretRisk.reasons[0], /secret/);

// inspection 없음 → 승인 불필요
assert.equal(evaluateChangeRisk({}).requiresApproval, false);

// --- evaluateChangeRisk: 명령 allowlist ---
// destructive 명령이 allowlist에 없으면 승인
const destructiveCmd = evaluateChangeRisk({ commands: ['rm -rf build', 'npm test'] });
assert.equal(destructiveCmd.requiresApproval, true);
assert.match(destructiveCmd.reasons[0], /rm -rf build/);

// allowlist에 있으면 통과
const allowlisted = evaluateChangeRisk({
  commands: ['rm -rf build'],
  policy: { ...defaultPolicy(), allowedCommands: ['rm -rf build'] }
});
assert.equal(allowlisted.requiresApproval, false, 'allowlisted destructive command is permitted');

// 안전 명령은 승인 불필요
assert.equal(evaluateChangeRisk({ commands: ['npm run build', 'git status'] }).requiresApproval, false);

// git push --force 감지
assert.equal(evaluateChangeRisk({ commands: ['git push --force origin main'] }).requiresApproval, true);

// --- detached HEAD fail-safe ---
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const repo = mkdtempSync(path.join(tmpdir(), 'harness-policy-detached-'));
const init = spawnSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
if (init.status !== 0) {
  git(['init'], repo);
  git(['checkout', '-b', 'main'], repo);
}
git(['config', 'user.email', 'test@example.com'], repo);
git(['config', 'user.name', 'test'], repo);
writeFileSync(path.join(repo, 'a.txt'), 'one\n');
git(['add', '.'], repo);
git(['commit', '-m', 'first'], repo);
writeFileSync(path.join(repo, 'a.txt'), 'two\n');
git(['commit', '-am', 'second'], repo);

const projectConfig = { protectedBranches: ['main'] };

// main(보호 브랜치) → 승인
const onMain = await evaluateProtectedBranchPolicy({ repo, projectConfig });
assert.equal(onMain.requiresApproval, true);
assert.equal(onMain.branch, 'main');

// 비보호 브랜치 → 허용
git(['checkout', '-b', 'feature/x'], repo);
const onFeature = await evaluateProtectedBranchPolicy({ repo, projectConfig });
assert.equal(onFeature.requiresApproval, false, 'non-protected branch allowed');

// detached HEAD → fail-safe 승인
const firstCommit = git(['rev-parse', 'HEAD~1'], repo);
git(['checkout', firstCommit], repo);
assert.equal(git(['branch', '--show-current'], repo), '', 'sanity: HEAD is detached');
const detached = await evaluateProtectedBranchPolicy({ repo, projectConfig });
assert.equal(detached.detached, true);
assert.equal(detached.requiresApproval, true, 'detached HEAD fails safe to approval');
assert.match(detached.reason, /detached/i);
assert.equal(detached.gitAvailable, true);

console.log('policy tests passed');
