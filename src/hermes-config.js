import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readProjectHarnessConfig(repo) {
  const configPath = path.join(repo, '.harness.json');
  try {
    const rawText = await readFile(configPath, 'utf8');
    return {
      exists: true,
      rawText,
      value: JSON.parse(rawText)
    };
  } catch {
    return {
      exists: false,
      rawText: '',
      value: {}
    };
  }
}
