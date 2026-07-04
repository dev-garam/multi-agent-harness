import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harnessRoot = path.resolve(new URL('..', import.meta.url).pathname);
const harnessBin = path.join(harnessRoot, 'bin', 'harness');
const repo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-'));

writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build',
    test: 'vitest run',
    lint: 'eslint .',
    typecheck: 'tsc --noEmit',
    start: 'vite'
  }
}, null, 2));
writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '');

const gitInit = spawnSync('git', ['init', '-b', 'master'], {
  cwd: repo,
  encoding: 'utf8'
});
assert.equal(gitInit.status, 0, gitInit.stderr);

const init = spawnSync('node', [harnessBin, 'init-project', '--repo', repo], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(init.status, 0, init.stderr);
assert.match(init.stdout, /Detected package manager: pnpm/);
assert.match(init.stdout, /Build command: pnpm run build/);
assert.match(init.stdout, /Test command: pnpm run test/);

const config = JSON.parse(readFileSync(path.join(repo, '.harness.json'), 'utf8'));
assert.equal(config.buildCommand, 'pnpm run build');
assert.equal(config.testCommand, 'pnpm run test');
assert.deepEqual(config.validationCommands, [
  {
    id: 'lint',
    command: 'pnpm run lint'
  },
  {
    id: 'typecheck',
    command: 'pnpm run typecheck'
  }
]);
assert.deepEqual(config.protectedBranches, ['master', 'production']);
assert.equal(config.runner.mode, 'local');
assert.equal(config.pipeline, 'auto');
assert.deepEqual(config.pipelineSelection, {
  mode: 'deterministic',
  defaultPipeline: 'quick_fix'
});
assert.equal(config.budget.maxProviderCalls, 8);
assert.equal(config.context.maxPreviousOutputBytes, 65536);
assert.equal(config.retry.agentRetries, 0);
assert.equal(config.supervisor.maxSupervisorTurns, 2);
assert.equal(config.supervisor.maxStepRetries, 0);

const second = spawnSync('node', [harnessBin, 'init-project', '--repo', repo], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(second.status, 0, second.stderr);
assert.match(second.stdout, /Existing \.harness\.json kept unchanged/);

const devRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-dev-'));
writeFileSync(path.join(devRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'npm run compile',
    test: 'node --test',
    lint: 'eslint .'
  }
}, null, 2));

assert.equal(spawnSync('git', ['init', '-b', 'dev'], {
  cwd: devRepo,
  encoding: 'utf8'
}).status, 0);
spawnSync('git', ['config', 'user.email', 'harness@example.test'], { cwd: devRepo });
spawnSync('git', ['config', 'user.name', 'Harness Test'], { cwd: devRepo });
spawnSync('git', ['add', 'package.json'], { cwd: devRepo });
assert.equal(spawnSync('git', ['commit', '-m', 'init'], {
  cwd: devRepo,
  encoding: 'utf8'
}).status, 0);
assert.equal(spawnSync('git', ['branch', 'main'], {
  cwd: devRepo,
  encoding: 'utf8'
}).status, 0);

const devInit = spawnSync('node', [harnessBin, 'init-project', '--repo', devRepo], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(devInit.status, 0, devInit.stderr);
const devConfig = JSON.parse(readFileSync(path.join(devRepo, '.harness.json'), 'utf8'));
assert.deepEqual(devConfig.protectedBranches, ['main', 'production']);
assert.equal(devConfig.buildCommand, 'npm run build');
assert.equal(devConfig.testCommand, 'npm run test');
assert.deepEqual(devConfig.validationCommands, [
  {
    id: 'lint',
    command: 'npm run lint'
  }
]);

const refreshRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-refresh-'));
writeFileSync(path.join(refreshRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build',
    test: 'vitest run',
    lint: 'eslint .'
  }
}, null, 2));
writeFileSync(path.join(refreshRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  },
  protectedBranches: ['dev', 'production']
}, null, 2));
assert.equal(spawnSync('git', ['init', '-b', 'dev'], {
  cwd: refreshRepo,
  encoding: 'utf8'
}).status, 0);
spawnSync('git', ['config', 'user.email', 'harness@example.test'], { cwd: refreshRepo });
spawnSync('git', ['config', 'user.name', 'Harness Test'], { cwd: refreshRepo });
spawnSync('git', ['add', 'package.json', '.harness.json'], { cwd: refreshRepo });
assert.equal(spawnSync('git', ['commit', '-m', 'init'], {
  cwd: refreshRepo,
  encoding: 'utf8'
}).status, 0);
assert.equal(spawnSync('git', ['branch', 'main'], {
  cwd: refreshRepo,
  encoding: 'utf8'
}).status, 0);

const refresh = spawnSync('node', [harnessBin, 'init-project', '--repo', refreshRepo, '--refresh'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(refresh.status, 0, refresh.stderr);
assert.match(refresh.stdout, /Suggested \.harness\.json updates/);
assert.match(refresh.stdout, /\+ buildCommand: npm run build/);
assert.match(refresh.stdout, /~ protectedBranches: dev, production -> main, production/);
let refreshConfig = JSON.parse(readFileSync(path.join(refreshRepo, '.harness.json'), 'utf8'));
assert.equal(refreshConfig.buildCommand, undefined);
assert.deepEqual(refreshConfig.protectedBranches, ['dev', 'production']);

const apply = spawnSync('node', [harnessBin, 'init-project', '--repo', refreshRepo, '--refresh', '--apply'], {
  cwd: harnessRoot,
  encoding: 'utf8'
});
assert.equal(apply.status, 0, apply.stderr);
assert.match(apply.stdout, /Applied suggested \.harness\.json updates/);
refreshConfig = JSON.parse(readFileSync(path.join(refreshRepo, '.harness.json'), 'utf8'));
assert.equal(refreshConfig.buildCommand, 'npm run build');
assert.equal(refreshConfig.testCommand, 'npm run test');
assert.deepEqual(refreshConfig.validationCommands, [
  {
    id: 'lint',
    command: 'npm run lint'
  }
]);
assert.deepEqual(refreshConfig.protectedBranches, ['main', 'production']);

const interactiveNoRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-interactive-no-'));
writeFileSync(path.join(interactiveNoRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build'
  }
}, null, 2));
writeFileSync(path.join(interactiveNoRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  }
}, null, 2));
const interactiveNo = spawnSync('node', [harnessBin, 'init-project', '--repo', interactiveNoRepo, '--refresh', '--interactive'], {
  cwd: harnessRoot,
  input: 'n\n',
  encoding: 'utf8'
});
assert.equal(interactiveNo.status, 0, interactiveNo.stderr);
assert.match(interactiveNo.stdout, /Apply suggested \.harness\.json updates\? \[y\/N\]/);
let interactiveNoConfig = JSON.parse(readFileSync(path.join(interactiveNoRepo, '.harness.json'), 'utf8'));
assert.equal(interactiveNoConfig.buildCommand, undefined);

const interactiveYesRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-interactive-yes-'));
writeFileSync(path.join(interactiveYesRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build'
  }
}, null, 2));
writeFileSync(path.join(interactiveYesRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  }
}, null, 2));
const interactiveYes = spawnSync('node', [harnessBin, 'init-project', '--repo', interactiveYesRepo, '--refresh', '--interactive'], {
  cwd: harnessRoot,
  input: 'y\n',
  encoding: 'utf8'
});
assert.equal(interactiveYes.status, 0, interactiveYes.stderr);
assert.match(interactiveYes.stdout, /Apply suggested \.harness\.json updates\? \[y\/N\]/);
assert.match(interactiveYes.stdout, /Applied suggested \.harness\.json updates/);
const interactiveYesConfig = JSON.parse(readFileSync(path.join(interactiveYesRepo, '.harness.json'), 'utf8'));
assert.equal(interactiveYesConfig.buildCommand, 'npm run build');

const keepNoSuggestRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-keep-no-suggest-'));
writeFileSync(path.join(keepNoSuggestRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build'
  }
}, null, 2));
writeFileSync(path.join(keepNoSuggestRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  }
}, null, 2));
const keepNoSuggest = spawnSync('node', [harnessBin, 'init-project', '--repo', keepNoSuggestRepo, '--interactive'], {
  cwd: harnessRoot,
  input: 'n\nn\nn\n',
  encoding: 'utf8'
});
assert.equal(keepNoSuggest.status, 0, keepNoSuggest.stderr);
assert.match(keepNoSuggest.stdout, /Existing \.harness\.json found\. Reset it from scratch\? \[y\/N\]/);
assert.match(keepNoSuggest.stdout, /Add recommended default fields to \.harness\.json\? \[y\/N\]/);
assert.match(keepNoSuggest.stdout, /Allow the harness to ask before adding helpful config during future work\? \[y\/N\]/);
const keepNoSuggestConfig = JSON.parse(readFileSync(path.join(keepNoSuggestRepo, '.harness.json'), 'utf8'));
assert.equal(keepNoSuggestConfig.buildCommand, undefined);
assert.deepEqual(keepNoSuggestConfig.configSuggestions, {
  enabled: false
});

const keepAddSuggestRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-keep-add-suggest-'));
writeFileSync(path.join(keepAddSuggestRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build'
  }
}, null, 2));
writeFileSync(path.join(keepAddSuggestRepo, '.harness.json'), JSON.stringify({
  pipeline: 'code_fix',
  agent: {
    provider: 'codex'
  }
}, null, 2));
const keepAddSuggest = spawnSync('node', [harnessBin, 'init-project', '--repo', keepAddSuggestRepo, '--interactive'], {
  cwd: harnessRoot,
  input: 'n\ny\ny\n',
  encoding: 'utf8'
});
assert.equal(keepAddSuggest.status, 0, keepAddSuggest.stderr);
assert.match(keepAddSuggest.stdout, /Applied suggested \.harness\.json updates/);
assert.match(keepAddSuggest.stdout, /Future config suggestions: enabled \(mode: ask\)/);
const keepAddSuggestConfig = JSON.parse(readFileSync(path.join(keepAddSuggestRepo, '.harness.json'), 'utf8'));
assert.equal(keepAddSuggestConfig.buildCommand, 'npm run build');
assert.deepEqual(keepAddSuggestConfig.configSuggestions, {
  enabled: true,
  mode: 'ask'
});

const resetRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-reset-'));
writeFileSync(path.join(resetRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build',
    test: 'vitest run',
    lint: 'eslint .'
  }
}, null, 2));
writeFileSync(path.join(resetRepo, '.harness.json'), JSON.stringify({
  pipeline: 'review_only',
  agent: {
    provider: 'claude'
  },
  customField: true,
  protectedBranches: ['dev']
}, null, 2));
const reset = spawnSync('node', [harnessBin, 'init-project', '--repo', resetRepo, '--interactive'], {
  cwd: harnessRoot,
  input: 'y\ny\ny\n',
  encoding: 'utf8'
});
assert.equal(reset.status, 0, reset.stderr);
assert.match(reset.stdout, /Reset \.harness\.json with newly detected defaults/);
const resetConfig = JSON.parse(readFileSync(path.join(resetRepo, '.harness.json'), 'utf8'));
assert.equal(resetConfig.pipeline, 'auto');
assert.deepEqual(resetConfig.pipelineSelection, {
  mode: 'deterministic',
  defaultPipeline: 'quick_fix'
});
assert.equal(resetConfig.agent.provider, 'codex');
assert.equal(resetConfig.customField, undefined);
assert.equal(resetConfig.buildCommand, 'npm run build');
assert.equal(resetConfig.testCommand, 'npm run test');
assert.deepEqual(resetConfig.validationCommands, [
  {
    id: 'lint',
    command: 'npm run lint'
  }
]);
assert.deepEqual(resetConfig.configSuggestions, {
  enabled: true,
  mode: 'ask'
});

const resetCoreRepo = mkdtempSync(path.join(tmpdir(), 'harness-init-project-reset-core-'));
writeFileSync(path.join(resetCoreRepo, 'package.json'), JSON.stringify({
  scripts: {
    build: 'vite build',
    test: 'vitest run'
  }
}, null, 2));
writeFileSync(path.join(resetCoreRepo, '.harness.json'), JSON.stringify({
  pipeline: 'review_only',
  agent: {
    provider: 'claude'
  },
  customField: true
}, null, 2));
const resetCore = spawnSync('node', [harnessBin, 'init-project', '--repo', resetCoreRepo, '--interactive'], {
  cwd: harnessRoot,
  input: 'y\nn\nn\n',
  encoding: 'utf8'
});
assert.equal(resetCore.status, 0, resetCore.stderr);
assert.match(resetCore.stdout, /Reset \.harness\.json with core defaults/);
const resetCoreConfig = JSON.parse(readFileSync(path.join(resetCoreRepo, '.harness.json'), 'utf8'));
assert.equal(resetCoreConfig.pipeline, 'auto');
assert.deepEqual(resetCoreConfig.pipelineSelection, {
  mode: 'deterministic',
  defaultPipeline: 'quick_fix'
});
assert.equal(resetCoreConfig.budget.maxProviderCalls, 8);
assert.equal(resetCoreConfig.agent.provider, 'codex');
assert.equal(resetCoreConfig.customField, undefined);
assert.equal(resetCoreConfig.buildCommand, undefined);
assert.equal(resetCoreConfig.testCommand, undefined);
assert.equal(resetCoreConfig.validationCommands, undefined);
assert.deepEqual(resetCoreConfig.configSuggestions, {
  enabled: false
});

console.log('init project tests passed');
