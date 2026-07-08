import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderPrompt } from '../src/prompt.js';
import {
  computePromptRegistry,
  diffPromptRegistry,
  loadPromptVersionGolden
} from '../src/prompt-registry.js';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);

// B5: 프롬프트/역할 품질 회귀 (오프라인 스냅샷 골든).
// 목적 — 프롬프트/역할 텍스트나 렌더링 로직이 의도치 않게 바뀌면 회귀로 잡는다.

// --- 프롬프트 버전 지문이 커밋된 골든과 일치 ---
const golden = await loadPromptVersionGolden();
assert.ok(golden, 'prompts/prompt-versions.json golden must exist');
const current = await computePromptRegistry();
const drift = diffPromptRegistry(golden, current);
assert.equal(
  drift.drift,
  false,
  `prompt drift detected — changed=${drift.changed.join(',')} added=${drift.added.join(',')} removed=${drift.removed.join(',')}. `
    + 'If intentional, run: node scripts/update-prompt-versions.mjs'
);
// 알려진 역할 프롬프트가 레지스트리에 존재
const paths = current.prompts.map((entry) => entry.path);
for (const role of ['prompts/planner.md', 'prompts/coder.md', 'prompts/hermes.md', 'prompts/reporter.md']) {
  assert.ok(paths.includes(role), `${role} tracked in prompt registry`);
}

// diffPromptRegistry가 변경/추가/삭제를 정확히 감지
const mutated = {
  version: 1,
  prompts: [
    { ...current.prompts[0], sha256: 'deadbeef' },
    ...current.prompts.slice(1),
    { path: 'prompts/new-role.md', bytes: 1, sha256: 'abc' }
  ].filter((entry) => entry.path !== current.prompts[1].path)
};
const mutatedDiff = diffPromptRegistry(golden, mutated);
assert.ok(mutatedDiff.changed.includes(current.prompts[0].path), 'detects a changed prompt');
assert.ok(mutatedDiff.added.includes('prompts/new-role.md'), 'detects an added prompt');
assert.ok(mutatedDiff.removed.includes(current.prompts[1].path), 'detects a removed prompt');

// --- 렌더 골든 스냅샷: 렌더링 로직·플레이스홀더 치환 회귀 ---
const context = {
  request: 'README 문구를 정리해줘',
  repo: '/tmp/example-repo',
  projectConfig: { pipeline: 'code_fix', testCommand: 'npm test' },
  validationCommands: [{ id: 'lint', command: 'npm run check' }, { id: 'test', command: 'npm test' }],
  supervisorInstructions: '(none)',
  previousOutputs: '(none)'
};
const renderedPlanner = await renderPrompt({ prompt: 'prompts/planner.md' }, context);
const goldenPlanner = readFileSync(path.join(harnessRoot, 'test', 'fixtures', 'prompt-golden', 'planner.txt'), 'utf8');
assert.equal(renderedPlanner, goldenPlanner, 'rendered planner prompt matches golden snapshot');
// 미치환 플레이스홀더가 남지 않아야 함
assert.equal(/{{[A-Z_]+}}/.test(renderedPlanner), false, 'no unresolved placeholders remain');
assert.match(renderedPlanner, /README 문구를 정리해줘/, 'request substituted');
assert.match(renderedPlanner, /npm run check/, 'validation commands substituted');

console.log('prompt registry tests passed');
