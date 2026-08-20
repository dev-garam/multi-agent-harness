import assert from 'node:assert/strict';
import {
  SECRET_PATTERNS,
  RISKY_FILE_PATTERNS,
  detectRiskyFiles,
  inspectionSummary,
  parseStatusShort
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

// ---------------------------------------------------------------------------
// parseStatusShort — `git status --short`는 XY(2칸) + 공백 + 경로 형식이라
// 선행 공백이 의미를 갖는다. 원문의 선행 공백이 잘리면 첫 줄 경로가 한 글자
// 손실되고, 그 경로가 riskyFiles/secretFindings 매칭의 입력이므로 안전 게이트가
// 조용히 탐지를 놓칠 수 있다. (실제 e2e 실행에서 "README.md" -> "EADME.md" 발생)
// ---------------------------------------------------------------------------
const statusShortOutput = ' M README.md\n M src/app.js\n?? .env\nA  staged.txt\n';

const parsedStatus = parseStatusShort(statusShortOutput);
assert.deepEqual(
  parsedStatus.map((entry) => entry.path),
  ['README.md', 'src/app.js', '.env', 'staged.txt']
);
assert.deepEqual(
  parsedStatus.map((entry) => entry.status),
  ['M', 'M', '??', 'A']
);

// 회귀 방어: 선행 공백이 잘린 입력(과거 버그 재현)에서는 첫 줄이 손상된다.
// 이 단언은 "파서에 원문을 넘겨야 한다"는 계약을 문서화한다.
assert.equal(parseStatusShort(statusShortOutput.trim())[0].path, 'EADME.md');

// 위험 경로가 첫 줄일 때가 실질적인 위험 지점이다.
const envFirst = parseStatusShort(' M .env\n M README.md\n');
assert.equal(envFirst[0].path, '.env');
assert.equal(detectRiskyFiles(envFirst).length > 0, true);

// rename(R)은 화살표 뒤 최종 경로를 취한다.
assert.equal(parseStatusShort('R  old.js -> new.js\n')[0].path, 'new.js');

console.log('inspection status parser tests passed');
