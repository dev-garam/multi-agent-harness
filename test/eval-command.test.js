import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const repo = mkdtempSync(path.join(tmpdir(), 'harness-eval-command-'));

writeFileSync(path.join(repo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  },
  testCommand: 'npm test',
  protectedBranches: ['main', 'production'],
  redaction: {
    enabled: true
  },
  budget: {
    maxAgentSteps: 10
  }
}, null, 2));

const run = spawnSync('node', [harnessBin, 'eval', '--repo', repo], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(run.status, 0, run.stderr);
assert.match(run.stdout, /Harness eval/);
assert.match(run.stdout, /project-config-schema/);
assert.match(run.stdout, /Status: passed/);

const json = spawnSync('node', [harnessBin, 'eval', '--repo', repo, '--json'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(json.status, 0, json.stderr);
const parsed = JSON.parse(json.stdout);
assert.equal(parsed.status, 'passed');
assert.ok(parsed.checks.some((entry) => entry.id === 'budget-policy' && entry.status === 'pass'));
assert.deepEqual(parsed.recommendations, []);
assert.ok(existsSync(parsed.reportPath));

const fixtureRepo = path.join(harnessRoot, 'test', 'fixtures', 'eval-ready');
const fixtureJson = spawnSync('node', [harnessBin, 'eval', '--repo', fixtureRepo, '--json'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(fixtureJson.status, 0, fixtureJson.stderr);
const fixtureParsed = JSON.parse(fixtureJson.stdout);
assert.equal(fixtureParsed.status, 'passed');
assert.equal(fixtureParsed.score.failed, 0);
assert.equal(fixtureParsed.score.warned, 0);
assert.equal(fixtureParsed.score.score, 1);
assert.deepEqual(fixtureParsed.recommendations, []);

// B4: golden scenario regression — eval measures judgment quality, not just readiness.
// Pipeline-selection golden cases run and pass.
const pipelineCases = fixtureParsed.checks.filter((entry) => entry.id.startsWith('pipeline-case:'));
assert.ok(pipelineCases.length >= 5, 'pipeline golden cases should run');
assert.ok(pipelineCases.every((entry) => entry.status === 'pass'), 'all pipeline golden cases pass');
assert.ok(
  fixtureParsed.checks.some((entry) => entry.id === 'pipeline-case:review-only' && entry.status === 'pass'),
  'review-only selection is fixed as golden'
);

// Supervisor decision golden cases run and pass — including safe collapse to human review.
const supervisorCases = fixtureParsed.checks.filter((entry) => entry.id.startsWith('supervisor-case:'));
assert.ok(supervisorCases.length >= 3, 'supervisor golden cases should run');
assert.ok(supervisorCases.every((entry) => entry.status === 'pass'), 'all supervisor golden cases pass');
assert.ok(
  fixtureParsed.checks.some(
    (entry) => entry.id === 'supervisor-case:unparseable-collapses-to-human-review' && entry.status === 'pass'
  ),
  'unparseable supervisor output safely collapses to human review'
);

// A regressed golden case fails eval and surfaces a recommendation (not just readiness).
const regressRepo = mkdtempSync(path.join(tmpdir(), 'harness-eval-regress-'));
writeFileSync(path.join(regressRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: { provider: 'codex' },
  testCommand: 'npm test',
  protectedBranches: ['main'],
  redaction: { enabled: true },
  budget: { maxAgentSteps: 10 }
}, null, 2));
writeFileSync(path.join(regressRepo, '.harness-eval.json'), JSON.stringify({
  pipelineCases: [
    { id: 'wrong-expectation', request: 'README 문구를 정리해줘', expected: { selected: 'safe_fix' } }
  ]
}, null, 2));
const regress = spawnSync('node', [harnessBin, 'eval', '--repo', regressRepo, '--json'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(regress.status, 0, regress.stderr);
const regressParsed = JSON.parse(regress.stdout);
assert.equal(regressParsed.status, 'failed', 'a regressed golden case fails the eval');
assert.ok(
  regressParsed.checks.some((entry) => entry.id === 'pipeline-case:wrong-expectation' && entry.status === 'fail'),
  'regressed pipeline case is reported as fail'
);
assert.ok(
  regressParsed.recommendations.some((entry) => entry.includes('wrong-expectation')),
  'regression surfaces a recommendation'
);

console.log('eval command tests passed');
