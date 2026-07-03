import path from 'node:path';
import { writeText } from './fs-utils.js';

export function manifestPath(runDir) {
  return path.join(runDir, 'manifest.json');
}

export async function saveManifest(runDir, manifest) {
  await writeText(manifestPath(runDir), JSON.stringify(manifest, null, 2) + '\n');
}

export async function appendManifestStep(runDir, manifest, step) {
  manifest.steps.push(step);
  await saveManifest(runDir, manifest);
}
