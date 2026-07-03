import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');

function runHarness(args) {
  const result = spawnSync('node', [harnessBin, ...args], {
    cwd: harnessRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function runGit(args, repo) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `git failed: ${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout.trim();
}

function initMainBranch(repo) {
  const init = spawnSync('git', ['init', '-b', 'main'], {
    cwd: repo,
    encoding: 'utf8'
  });
  if (init.status !== 0) {
    runGit(['init'], repo);
    runGit(['checkout', '-b', 'main'], repo);
  }
  assert.equal(runGit(['branch', '--show-current'], repo), 'main');
}

const status = runHarness(['hermes', 'status', '--limit', '3']);
assert.match(status, /Hermes status/);
assert.match(status, /Runs:/);
assert.match(status, /Run statuses:/);

const safePlan = runHarness(['hermes', 'plan', '인증 로직을 안전하게 수정해줘']);
assert.match(safePlan, /Hermes plan/);
assert.match(safePlan, /Recommended pipeline: safe_fix/);
assert.match(safePlan, /Decision JSON:/);

const reviewPlan = runHarness(['hermes', 'plan', '이번 변경을 리뷰해줘']);
assert.match(reviewPlan, /Recommended pipeline: review_only/);

const tick = runHarness(['hermes', 'tick']);
assert.match(tick, /Hermes tick/);
assert.match(tick, /No pending tasks|Task:/);

function writeMockAgent(repo, extraConfig = {}) {
  const mockPath = path.join(repo, 'mock-agent.cjs');
  writeFileSync(mockPath, `
const fs = require('fs');
const stepId = process.argv[2];
const finalPath = process.argv[3];
const fence = String.fromCharCode(96, 96, 96);
let body = '# ' + stepId + '\\n\\nmock output';
if (stepId.startsWith('hermes')) {
  body = '# ' + stepId + '\\n\\n' + fence + 'json\\n' + JSON.stringify({
    status: 'success',
    nextAction: 'continue',
    targetStep: null,
    reason: 'mock ok',
    instructions: 'report success'
  }, null, 2) + '\\n' + fence + '\\n';
}
fs.writeFileSync(finalPath, body);
`);
  writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
    pipeline: 'quick_fix',
    agent: {
      provider: 'mock',
      command: 'node',
      versionArgs: ['--version'],
      outputMode: 'file',
      args: [mockPath, '{{stepId}}', '{{finalPath}}']
    },
    supervisor: {
      enabled: true,
      maxSupervisorTurns: 2,
      maxStepRetries: 0
    },
    ...extraConfig
  }, null, 2));
}

const queueRoot = path.join(harnessRoot, '.harness', 'queue');
const memoryRoot = path.join(harnessRoot, '.harness', 'memory');
const feedbackRoot = path.join(harnessRoot, '.harness', 'feedback');
const promotionRoot = path.join(harnessRoot, '.harness', 'promotions');
const reportRoot = path.join(harnessRoot, '.harness', 'reports');
rmSync(queueRoot, { recursive: true, force: true });
rmSync(memoryRoot, { recursive: true, force: true });
rmSync(feedbackRoot, { recursive: true, force: true });
rmSync(promotionRoot, { recursive: true, force: true });
rmSync(reportRoot, { recursive: true, force: true });

const repo = mkdtempSync(path.join(tmpdir(), 'harness-hermes-task-'));
writeMockAgent(repo);

const enqueue = runHarness(['hermes', 'enqueue', '--repo', repo, '--pipeline', 'quick_fix', '--agent', 'mock', '큐 작업을 처리해줘']);
assert.match(enqueue, /Hermes enqueue/);
assert.match(enqueue, /Status: pending/);

const queueBefore = runHarness(['hermes', 'queue']);
assert.match(queueBefore, /pending: 1/);

const tickTask = runHarness(['hermes', 'tick']);
assert.match(tickTask, /Hermes tick/);
assert.match(tickTask, /Status: done/);
assert.match(tickTask, /Run: /);
assert.match(tickTask, /Report: /);
const runId = tickTask.match(/Run: ([^\n]+)/)?.[1].trim();
assert.ok(runId);

const queueAfter = runHarness(['hermes', 'queue']);
assert.match(queueAfter, /pending: 0/);
assert.match(queueAfter, /done: 1/);

const memoryRebuild = runHarness(['hermes', 'memory', 'rebuild']);
assert.match(memoryRebuild, /Hermes memory rebuild/);
assert.match(memoryRebuild, /Indexed runs: /);

const memorySearch = runHarness(['hermes', 'memory', 'search', '큐 작업']);
assert.match(memorySearch, /Hermes memory search/);
assert.match(memorySearch, /Matches: /);

const statusAfterMemory = runHarness(['hermes', 'status', '--limit', '3']);
assert.match(statusAfterMemory, /Memory: .*indexed runs/);

const memoryPlan = runHarness(['hermes', 'plan', '--repo', repo, '큐 작업을 다시 처리해줘']);
assert.match(memoryPlan, /Source: memory-backed/);
assert.match(memoryPlan, /Memory evidence:/);
assert.match(memoryPlan, /similar run/);

const feedback = runHarness(['hermes', 'feedback', '--run', runId, '--rating', 'bad', '불필요하게 승격함']);
assert.match(feedback, /Hermes feedback/);
assert.match(feedback, /Rating: bad/);

runHarness(['hermes', 'memory', 'rebuild']);
const feedbackSearch = runHarness(['hermes', 'memory', 'search', '큐 작업']);
assert.match(feedbackSearch, /feedback=bad/);

const feedbackPlan = runHarness(['hermes', 'plan', '--repo', repo, '큐 작업을 다시 처리해줘']);
assert.match(feedbackPlan, /bad_feedback/);

const promoteDryRun = runHarness(['hermes', 'promote', '--dry-run']);
assert.match(promoteDryRun, /Hermes promote/);
assert.match(promoteDryRun, /Mode: dry-run/);
assert.match(promoteDryRun, /Proposals: /);

const promoteApply = runHarness(['hermes', 'promote', '--apply']);
assert.match(promoteApply, /Hermes promote/);
assert.match(promoteApply, /Mode: apply/);
assert.match(promoteApply, /Promotion record: /);
assert.match(promoteApply, /Patch artifacts: /);
assert.match(promoteApply, /\.patch/);
assert.match(promoteApply, /\.harness\.json/);

const report = runHarness(['hermes', 'report']);
assert.match(report, /Hermes report/);
assert.match(report, /Path: /);

runHarness(['hermes', 'enqueue', '--repo', repo, '--pipeline', 'quick_fix', '--agent', 'mock', '데이터베이스 전체 삭제']);
const blockedTick = runHarness(['hermes', 'tick']);
assert.match(blockedTick, /Status: approval_pending/);
assert.match(blockedTick, /Policy requires human approval/);
assert.match(blockedTick, /Report: /);
const approvalTaskId = blockedTick.match(/Task: ([^\n]+)/)?.[1].trim();
assert.ok(approvalTaskId);

const queueWithApproval = runHarness(['hermes', 'queue']);
assert.match(queueWithApproval, /approval_pending: 1/);

const approve = runHarness(['hermes', 'approve', '--task', approvalTaskId, '위험성을 확인했고 실행 승인']);
assert.match(approve, /Hermes approve/);
assert.match(approve, /Status: pending/);

const approvedTick = runHarness(['hermes', 'tick']);
assert.match(approvedTick, /Status: done/);
assert.match(approvedTick, /Run: /);

runHarness(['hermes', 'enqueue', '--repo', repo, '--pipeline', 'quick_fix', '--agent', 'mock', '데이터베이스 전체 삭제']);
const rejectTick = runHarness(['hermes', 'tick']);
assert.match(rejectTick, /Status: approval_pending/);
const rejectTaskId = rejectTick.match(/Task: ([^\n]+)/)?.[1].trim();
assert.ok(rejectTaskId);

const reject = runHarness(['hermes', 'reject', '--task', rejectTaskId, '위험해서 실행하지 않음']);
assert.match(reject, /Hermes reject/);
assert.match(reject, /Status: rejected/);

const queueAfterReject = runHarness(['hermes', 'queue']);
assert.match(queueAfterReject, /rejected: 1/);

const protectedRepo = mkdtempSync(path.join(tmpdir(), 'harness-hermes-protected-'));
delete process.env.HERMES_TEST_WEBHOOK_URL_MISSING;
writeMockAgent(protectedRepo, {
  hermes: {
    notifications: {
      channels: [
        {
          name: 'harness-alerts',
          type: 'webhook',
          urlEnv: 'HERMES_TEST_WEBHOOK_URL_MISSING',
          events: ['tick.failed']
        }
      ]
    }
  }
});
initMainBranch(protectedRepo);
runHarness(['hermes', 'enqueue', '--repo', protectedRepo, '--pipeline', 'quick_fix', '--agent', 'mock', '보호 브랜치 정책 확인']);
const protectedTick = runHarness(['hermes', 'tick']);
assert.match(protectedTick, /Status: approval_pending/);
assert.match(protectedTick, /protected branch: main/);
assert.match(protectedTick, /Run: \(none\)/);
assert.match(protectedTick, /Notifications: skipped/);

console.log('hermes command tests passed');
