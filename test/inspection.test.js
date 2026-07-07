import assert from 'node:assert/strict';
import {
  SECRET_PATTERNS,
  RISKY_FILE_PATTERNS,
  detectRiskyFiles,
  inspectionSummary
} from '../src/inspection.js';

// 탐지 로직은 순수한 정규식/함수로 검증한다. 디스크 읽기나 git 실행 같은
// 파일시스템 부작용이 있는 scanSecrets/inspectChanges는 다루지 않는다.

function matchesAnySecret(text) {
  return SECRET_PATTERNS.some((rule) => rule.pattern.test(text));
}

// ---------------------------------------------------------------------------
// SECRET_PATTERNS — 알려진 secret은 탐지, 일반 문자열은 미탐지.
// ---------------------------------------------------------------------------
const knownSecrets = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'api_key = "abcdef0123456789"',
  'password: "supersecretvalue"',
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'
];
for (const secret of knownSecrets) {
  assert.equal(matchesAnySecret(secret), true, `secret로 탐지되어야 한다: ${secret}`);
}

const benignStrings = [
  'const x = 1;',
  'hello world',
  'let total = a + b;',
  'return items.length;'
];
for (const text of benignStrings) {
  assert.equal(matchesAnySecret(text), false, `secret이 아니어야 한다: ${text}`);
}

// 각 규칙은 id와 정규식 pattern을 가진다.
for (const rule of SECRET_PATTERNS) {
  assert.equal(typeof rule.id, 'string');
  assert.ok(rule.pattern instanceof RegExp);
}

// ---------------------------------------------------------------------------
// detectRiskyFiles / RISKY_FILE_PATTERNS — 위험 경로는 탐지, 일반 경로는 미탐지.
// ---------------------------------------------------------------------------
for (const rule of RISKY_FILE_PATTERNS) {
  assert.equal(typeof rule.id, 'string');
  assert.ok(rule.pattern instanceof RegExp);
}

const riskyFiles = [
  { path: '.env', status: 'M' },
  { path: 'package.json', status: 'M' },
  { path: 'migrations/001_init.sql', status: 'A' },
  { path: 'src/auth/session.js', status: 'M' }
];
const riskyFindings = detectRiskyFiles(riskyFiles);

// 위험 파일 4개가 모두 탐지된다.
const riskyPaths = new Set(riskyFindings.map((finding) => finding.path));
for (const file of riskyFiles) {
  assert.ok(riskyPaths.has(file.path), `위험 파일로 탐지되어야 한다: ${file.path}`);
}

// 탐지 결과는 ruleId/path/status 필드를 갖고, ruleId는 알려진 규칙 id에 속한다.
const knownRuleIds = new Set(RISKY_FILE_PATTERNS.map((rule) => rule.id));
for (const finding of riskyFindings) {
  assert.equal(typeof finding.ruleId, 'string');
  assert.ok(knownRuleIds.has(finding.ruleId));
  assert.equal(typeof finding.path, 'string');
  assert.ok('status' in finding);
}

// 일반 경로는 어떤 위험 규칙에도 걸리지 않는다.
const safeFiles = [
  { path: 'src/utils/math.js', status: 'M' },
  { path: 'README.md', status: 'M' },
  { path: 'docs/guide.txt', status: 'A' }
];
assert.deepEqual(detectRiskyFiles(safeFiles), []);

// ---------------------------------------------------------------------------
// inspectionSummary — 순수 포맷터(부작용 없음).
// ---------------------------------------------------------------------------
assert.equal(
  inspectionSummary({ status: 'skipped', reason: 'not a git work tree' }),
  'status: skipped\nreason: not a git work tree'
);

const summary = inspectionSummary({
  status: 'succeeded',
  changedFiles: [{ path: 'a.js' }],
  riskyFiles: [],
  secretFindings: [],
  diffStatPath: '/run/inspection.diffstat.log',
  detailsPath: '/run/inspection.json'
});
assert.ok(summary.includes('status: succeeded'));
assert.ok(summary.includes('changedFiles: 1'));
assert.ok(summary.includes('riskyFiles: 0'));
assert.ok(summary.includes('secretFindings: 0'));
assert.ok(summary.includes('diffStatPath: /run/inspection.diffstat.log'));
assert.ok(summary.includes('detailsPath: /run/inspection.json'));

console.log('inspection tests passed');
