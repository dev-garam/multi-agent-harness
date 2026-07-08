import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { harnessRoot, readText } from './fs-utils.js';

const PROMPTS_DIR = 'prompts';
export const PROMPT_VERSIONS_PATH = path.join(harnessRoot, PROMPTS_DIR, 'prompt-versions.json');

// prompts/*.md 를 정렬해 열거한다(새 역할 프롬프트도 자동 포함).
export function listPromptFiles() {
  const dir = path.join(harnessRoot, PROMPTS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${PROMPTS_DIR}/${name}`);
}

export async function promptFingerprint(relPath) {
  const text = await readText(path.join(harnessRoot, relPath));
  // 줄바꿈 정규화로 플랫폼 차이(CRLF/LF)를 제거해 지문을 안정화.
  const normalized = text.replace(/\r\n/g, '\n');
  return {
    path: relPath,
    bytes: Buffer.byteLength(normalized, 'utf8'),
    sha256: createHash('sha256').update(normalized, 'utf8').digest('hex')
  };
}

// 현재 프롬프트 전체의 지문 레지스트리(= 프롬프트 버전 스냅샷).
export async function computePromptRegistry() {
  const files = listPromptFiles();
  const prompts = [];
  for (const rel of files) {
    prompts.push(await promptFingerprint(rel));
  }
  return { version: 1, prompts };
}

export async function loadPromptVersionGolden() {
  if (!existsSync(PROMPT_VERSIONS_PATH)) {
    return null;
  }
  try {
    return JSON.parse(await readText(PROMPT_VERSIONS_PATH));
  } catch {
    return null;
  }
}

// 커밋된 골든과 현재 레지스트리를 비교해 드리프트를 반환한다.
export function diffPromptRegistry(golden, current) {
  const goldenMap = new Map((golden?.prompts || []).map((entry) => [entry.path, entry]));
  const currentMap = new Map((current?.prompts || []).map((entry) => [entry.path, entry]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, cur] of currentMap) {
    const known = goldenMap.get(rel);
    if (!known) {
      added.push(rel);
    } else if (known.sha256 !== cur.sha256) {
      changed.push(rel);
    }
  }
  for (const rel of goldenMap.keys()) {
    if (!currentMap.has(rel)) {
      removed.push(rel);
    }
  }
  return {
    changed,
    added,
    removed,
    drift: changed.length + added.length + removed.length > 0
  };
}
