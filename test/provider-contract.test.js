import assert from 'node:assert/strict';
import {
  resolveAgentConfig,
  providerCapabilities,
  listProviderCapabilities,
  knownProviderNames,
  providerContract,
  missingContractFlags
} from '../src/agent.js';

// built-in provider adapter의 buildArgs 계약이 바뀌면 이 스냅샷 테스트가 깨진다.
// 실제 자식 프로세스는 실행하지 않고 순수 함수(buildArgs)/설정 조회만 검증한다.
const REPO = '/repo';
const PROMPT = 'PROMPT';
const PROMPT_PATH = '/run/coder.prompt.md';
const FINAL_PATH = '/run/coder.md';

function contextFor(step) {
  return { repo: REPO, step, prompt: PROMPT, promptPath: PROMPT_PATH, finalPath: FINAL_PATH };
}

function buildArgsFor(providerName, step) {
  const agent = resolveAgentConfig({ options: { agent: providerName } });
  // built-in adapter는 항상 base로 노출된다. 사라지면 계약 위반이므로 여기서 감지한다.
  assert.ok(agent.base, `provider "${providerName}" must expose a built-in base adapter`);
  assert.equal(typeof agent.base.buildArgs, 'function', `provider "${providerName}" must expose buildArgs`);
  return agent.base.buildArgs(contextFor(step));
}

// 알려진 built-in provider 집합 (계약: 이 3개가 제공되어야 함)
const names = knownProviderNames();
assert.deepEqual(names, ['codex', 'claude', 'antigravity']);

// ---------------------------------------------------------------------------
// codex — outputMode: file, sandbox는 --sandbox <값>으로 매핑, model은 prompt 앞.
// ---------------------------------------------------------------------------
assert.deepEqual(
  buildArgsFor('codex', { id: 'coder', sandbox: 'read-only' }),
  ['exec', '--cd', REPO, '--sandbox', 'read-only', '--json', '--output-last-message', FINAL_PATH, PROMPT]
);

assert.deepEqual(
  buildArgsFor('codex', { id: 'coder', sandbox: 'workspace-write' }),
  ['exec', '--cd', REPO, '--sandbox', 'workspace-write', '--json', '--output-last-message', FINAL_PATH, PROMPT]
);

// sandbox 미지정 시 read-only가 기본값으로 매핑된다.
assert.deepEqual(
  buildArgsFor('codex', { id: 'coder' }),
  ['exec', '--cd', REPO, '--sandbox', 'read-only', '--json', '--output-last-message', FINAL_PATH, PROMPT]
);

// model은 finalPath 뒤, prompt 앞에 삽입된다.
assert.deepEqual(
  buildArgsFor('codex', { id: 'coder', sandbox: 'workspace-write', model: 'gpt-x' }),
  ['exec', '--cd', REPO, '--sandbox', 'workspace-write', '--json', '--output-last-message', FINAL_PATH, '--model', 'gpt-x', PROMPT]
);

const codexCaps = providerCapabilities('codex');
assert.deepEqual(codexCaps, {
  outputMode: 'file',
  supportsModel: true,
  supportsSandbox: true,
  requiresOutputFile: true
});

// ---------------------------------------------------------------------------
// claude — outputMode: stdout(JSON), sandbox는 capabilities상 미지원이지만
// workspace-write 의도는 --permission-mode/--allowedTools 플래그로 매핑된다.
// --output-format json은 usage/total_cost_usd를 노출시키기 위한 계약이다.
// ---------------------------------------------------------------------------
const CLAUDE_ALLOWED_TOOLS = 'Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(mkdir:*),Bash(touch:*),Bash(cp:*),Bash(mv:*)';

// read-only(또는 sandbox 미지정): permission 플래그를 추가하지 않는다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'read-only' }),
  ['-p', PROMPT, '--output-format', 'json']
);
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder' }),
  ['-p', PROMPT, '--output-format', 'json']
);

// workspace-write: acceptEdits permission-mode와 allowedTools를 추가한다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'workspace-write' }),
  ['-p', PROMPT, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_ALLOWED_TOOLS]
);

// model은 permission 플래그 이후에 추가된다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'workspace-write', model: 'claude-x' }),
  ['-p', PROMPT, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_ALLOWED_TOOLS, '--model', 'claude-x']
);
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'read-only', model: 'claude-x' }),
  ['-p', PROMPT, '--output-format', 'json', '--model', 'claude-x']
);

const claudeCaps = providerCapabilities('claude');
assert.deepEqual(claudeCaps, {
  outputMode: 'stdout',
  stdoutFormat: 'json',
  supportsModel: true,
  supportsSandbox: false,
  requiresOutputFile: false
});

// claude는 stdout JSON에서 최종 텍스트(result)를 뽑아내는 계약을 제공한다.
// 이게 없으면 JSON 래퍼가 통째로 다음 스텝 프롬프트에 실린다.
const claudeAgent = resolveAgentConfig({ options: { agent: 'claude' } });
assert.equal(typeof claudeAgent.base.extractFinalOutput, 'function');
assert.equal(claudeAgent.stdoutFormat, 'json');
assert.equal(
  claudeAgent.base.extractFinalOutput('{"type":"result","result":"final text","usage":{"input_tokens":2}}'),
  'final text'
);
// 파싱 불가/구조 불일치는 null을 반환해 호출부가 원문으로 폴백하게 한다.
assert.equal(claudeAgent.base.extractFinalOutput('plain text output'), null);
assert.equal(claudeAgent.base.extractFinalOutput('{"broken json'), null);
assert.equal(claudeAgent.base.extractFinalOutput('{"type":"result"}'), null);
assert.equal(claudeAgent.base.extractFinalOutput(''), null);

// ---------------------------------------------------------------------------
// antigravity — outputMode: stdout, sandbox/model 무시하고 고정 인자만 생성.
// ---------------------------------------------------------------------------
assert.deepEqual(
  buildArgsFor('antigravity', { id: 'coder', sandbox: 'workspace-write', model: 'ignored' }),
  ['run', '--prompt', PROMPT]
);

const antigravityCaps = providerCapabilities('antigravity');
assert.deepEqual(antigravityCaps, {
  outputMode: 'stdout',
  supportsModel: false,
  supportsSandbox: false,
  requiresOutputFile: false
});

// ---------------------------------------------------------------------------
// outputMode 계약: codex는 file, claude/antigravity는 stdout.
// ---------------------------------------------------------------------------
const listed = listProviderCapabilities();
assert.equal(listed.codex.outputMode, 'file');
assert.equal(listed.claude.outputMode, 'stdout');
assert.equal(listed.antigravity.outputMode, 'stdout');

assert.equal(listed.codex.command, 'codex');
assert.equal(listed.claude.command, 'claude');
assert.equal(listed.antigravity.command, 'antigravity');

// capabilities 안의 outputMode는 provider outputMode와 일치해야 한다.
assert.equal(listed.codex.capabilities.outputMode, 'file');
assert.equal(listed.claude.capabilities.outputMode, 'stdout');
assert.equal(listed.antigravity.capabilities.outputMode, 'stdout');

console.log('provider contract tests passed');

// ---------------------------------------------------------------------------
// CLI 인자 계약: provider CLI는 버전에 따라 플래그가 바뀐다. 버전 숫자를 핀으로
// 박는 대신 buildArgs가 실제로 쓰는 플래그를 선언해두고 doctor가 --help로 존재를
// 확인한다. 이 스냅샷이 깨지면 계약 선언과 buildArgs가 어긋난 것이다.
// ---------------------------------------------------------------------------
assert.deepEqual(providerContract('codex'), {
  helpArgs: ['exec', '--help'],
  requiredFlags: ['--cd', '--sandbox', '--json', '--output-last-message']
});
assert.deepEqual(providerContract('claude'), {
  helpArgs: ['--help'],
  requiredFlags: ['-p', '--output-format', '--permission-mode', '--allowedTools']
});
assert.deepEqual(providerContract('antigravity'), {
  helpArgs: ['--help'],
  requiredFlags: ['--prompt']
});
assert.equal(providerContract('my-cli'), null);

// 선언한 필수 플래그는 실제 buildArgs 출력에 모두 나타나야 한다. 선언만 하고
// 쓰지 않거나, 쓰는데 선언하지 않으면 검사가 무의미해진다.
for (const [name, step] of [
  ['codex', { id: 'coder', sandbox: 'workspace-write' }],
  ['claude', { id: 'coder', sandbox: 'workspace-write' }],
  ['antigravity', { id: 'coder' }]
]) {
  const args = buildArgsFor(name, step).join(' ');
  for (const flag of providerContract(name).requiredFlags) {
    assert.ok(args.includes(flag), `${name} buildArgs must actually use declared flag ${flag}`);
  }
}

// missingContractFlags: 순수 함수라 실제 CLI 없이 검증한다.
assert.deepEqual(
  missingContractFlags('claude', '-p --output-format --permission-mode --allowedTools --model'),
  []
);
// 플래그가 사라지거나 이름이 바뀐 상황(실제 고장 1순위).
assert.deepEqual(
  missingContractFlags('claude', 'usage: claude -p --print-format text'),
  ['--output-format', '--permission-mode', '--allowedTools']
);
// 도움말을 읽지 못했으면 null(= 판단 불가). 빈 배열(= 전부 존재)과 구분한다.
assert.equal(missingContractFlags('claude', ''), null);
assert.equal(missingContractFlags('claude', null), null);
// 커스텀 provider는 내장 buildArgs를 타지 않으므로 검사 대상이 아니다.
assert.equal(missingContractFlags('my-cli', 'anything'), null);

// listProviderCapabilities도 계약을 노출한다.
const listedContracts = listProviderCapabilities();
assert.deepEqual(listedContracts.codex.contract, providerContract('codex'));
assert.equal(listedContracts.claude.contract.requiredFlags.includes('--output-format'), true);

console.log('provider CLI contract tests passed');
