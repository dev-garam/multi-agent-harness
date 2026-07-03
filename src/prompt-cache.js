import crypto from 'node:crypto';
import path from 'node:path';
import { harnessRoot, readText, writeText } from './fs-utils.js';

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  }
  return value;
}

async function templateEntry(step) {
  const templatePath = path.join(harnessRoot, step.prompt);
  const template = await readText(templatePath);
  return {
    stepId: step.id,
    prompt: step.prompt,
    templateHash: hash(template),
    templateBytes: Buffer.byteLength(template)
  };
}

export async function writePromptCacheArtifact({ runDir, pipeline, projectConfig, validationCommands }) {
  const templates = [];
  for (const step of pipeline.steps || []) {
    templates.push(await templateEntry(step));
  }

  const staticContext = {
    pipelineName: pipeline.pipelineName,
    validationCommands: validationCommands.map((entry) => ({
      id: entry.id,
      command: entry.command
    })),
    projectConfig
  };
  const artifact = {
    schemaVersion: 1,
    strategy: 'static-context-hash',
    reusable: true,
    cacheKey: hash([
      pipeline.pipelineName,
      stableJson(staticContext),
      templates.map((entry) => entry.templateHash).join('\n')
    ].join('\n')),
    staticContextHash: hash(stableJson(staticContext)),
    templates,
    createdAt: new Date().toISOString()
  };
  const artifactPath = path.join(runDir, 'prompt-cache.json');
  await writeText(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  return {
    ...artifact,
    path: artifactPath
  };
}
