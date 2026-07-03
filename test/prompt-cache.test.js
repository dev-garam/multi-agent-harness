import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePromptCacheArtifact } from '../src/prompt-cache.js';

const runDir = mkdtempSync(path.join(tmpdir(), 'harness-prompt-cache-'));
const artifact = await writePromptCacheArtifact({
  runDir,
  pipeline: {
    pipelineName: 'test',
    steps: [
      {
        id: 'planner',
        prompt: 'prompts/planner.md'
      },
      {
        id: 'coder',
        prompt: 'prompts/coder.md'
      }
    ]
  },
  projectConfig: {
    pipeline: 'test'
  },
  validationCommands: [
    {
      id: 'test',
      command: 'npm test'
    }
  ]
});

assert.equal(artifact.schemaVersion, 1);
assert.equal(artifact.strategy, 'static-context-hash');
assert.equal(artifact.templates.length, 2);
assert.ok(artifact.cacheKey);
assert.ok(existsSync(artifact.path));

const saved = JSON.parse(readFileSync(artifact.path, 'utf8'));
assert.equal(saved.cacheKey, artifact.cacheKey);
assert.equal(saved.templates[0].stepId, 'planner');

console.log('prompt cache tests passed');
