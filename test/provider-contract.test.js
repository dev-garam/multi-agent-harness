import assert from 'node:assert/strict';
import {
  resolveAgentConfig,
  providerCapabilities,
  listProviderCapabilities,
  knownProviderNames
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
// claude — outputMode: stdout, sandbox는 capabilities상 미지원이지만
// workspace-write 의도는 --permission-mode/--allowedTools 플래그로 매핑된다.
// ---------------------------------------------------------------------------
const CLAUDE_ALLOWED_TOOLS = 'Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(mkdir:*),Bash(touch:*),Bash(cp:*),Bash(mv:*)';

// read-only(또는 sandbox 미지정): permission 플래그를 추가하지 않는다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'read-only' }),
  ['-p', PROMPT, '--output-format', 'text']
);
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder' }),
  ['-p', PROMPT, '--output-format', 'text']
);

// workspace-write: acceptEdits permission-mode와 allowedTools를 추가한다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'workspace-write' }),
  ['-p', PROMPT, '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_ALLOWED_TOOLS]
);

// model은 permission 플래그 이후에 추가된다.
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'workspace-write', model: 'claude-x' }),
  ['-p', PROMPT, '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_ALLOWED_TOOLS, '--model', 'claude-x']
);
assert.deepEqual(
  buildArgsFor('claude', { id: 'coder', sandbox: 'read-only', model: 'claude-x' }),
  ['-p', PROMPT, '--output-format', 'text', '--model', 'claude-x']
);

const claudeCaps = providerCapabilities('claude');
assert.deepEqual(claudeCaps, {
  outputMode: 'stdout',
  supportsModel: true,
  supportsSandbox: false,
  requiresOutputFile: false
});

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
