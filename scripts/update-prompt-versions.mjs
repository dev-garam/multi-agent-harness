// 프롬프트를 의도적으로 수정한 뒤 골든 버전 스냅샷을 갱신한다.
//   node scripts/update-prompt-versions.mjs
// 갱신 후 diff를 검토해 프롬프트 변경이 의도된 것인지 확인하고 커밋한다.
import { writeText } from '../src/fs-utils.js';
import { computePromptRegistry, PROMPT_VERSIONS_PATH } from '../src/prompt-registry.js';

const registry = await computePromptRegistry();
await writeText(PROMPT_VERSIONS_PATH, JSON.stringify(registry, null, 2) + '\n');
console.log(`Wrote ${registry.prompts.length} prompt fingerprints to ${PROMPT_VERSIONS_PATH}`);
