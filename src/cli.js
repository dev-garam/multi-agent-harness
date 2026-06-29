import path from 'node:path';
import { existsSync } from 'node:fs';
import { getAgentVersion, resolveAgentConfig, runAgentStep } from './agent.js';
import { loadConfig, getPipeline } from './config.js';
import { cleanRuns } from './clean.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { installIdeTask } from './ide.js';
import { renderPrompt } from './prompt.js';
import { runValidationCommand, validationCommandsFromProjectConfig } from './validation.js';

function usage() {
  return [
    'Usage:',
    '  harness run --repo <path> [--pipeline <name>] [--agent <provider>] "<request>"',
    '  harness install-ide-task --repo <path>',
    '  harness init-project --repo <path>',
    '  harness clean [--days <n>] [--keep <n>] [--dry-run]',
    '',
    'Examples:',
    '  harness run --repo "$PWD" --agent codex "Fix failing tests"',
    '  harness install-ide-task --repo "$PWD"'
  ].join('\n');
}

function parseArgs(args) {
  const command = args.shift();
  const options = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo') {
      options.repo = args[++index];
    } else if (arg === '--pipeline') {
      options.pipeline = args[++index];
    } else if (arg === '--agent') {
      options.agent = args[++index];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--days') {
      options.days = args[++index];
    } else if (arg === '--keep') {
      options.keep = args[++index];
    } else {
      positionals.push(arg);
    }
  }

  return { command, options, request: positionals.join(' ').trim() };
}

function requireRepo(repo) {
  if (!repo) {
    throw new Error(`Missing --repo.\n\n${usage()}`);
  }

  const resolved = path.resolve(repo);
  if (!existsSync(resolved)) {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }

  return resolved;
}

async function initProject(repo) {
  const configPath = path.join(repo, '.harness.json');
  if (!existsSync(configPath)) {
    await writeText(configPath, JSON.stringify({
      pipeline: 'code_fix',
      agent: {
        provider: 'codex'
      },
      testCommand: '',
      buildCommand: '',
      validationCommands: [],
      protectedBranches: ['main', 'production']
    }, null, 2) + '\n');
  }
  return configPath;
}

function validationSummary(result) {
  return [
    `command: ${result.command}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    `stdoutPath: ${result.stdoutPath}`,
    `stderrPath: ${result.stderrPath}`
  ].join('\n');
}

async function runValidationStage({ repo, runDir, stepId, validationCommands, manifest, previousOutputs }) {
  if (validationCommands.length === 0) {
    const skipped = {
      type: 'validation',
      stepId: `validation:after-${stepId}`,
      status: 'skipped',
      reason: 'no validation commands configured'
    };
    manifest.steps.push(skipped);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {
      failures: [],
      previousOutputs: `${previousOutputs}\n\n## validation after ${stepId}\nNo validation commands configured.`
    };
  }

  const failures = [];
  let nextPreviousOutputs = previousOutputs;

  for (const validation of validationCommands) {
    console.error(`\n== validation:${validation.id} ==`);
    const validationResult = await runValidationCommand({
      repo,
      runDir,
      id: validation.id,
      command: validation.command
    });
    manifest.steps.push(validationResult);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    nextPreviousOutputs += `\n\n## validation:${validationResult.id}\n${validationSummary(validationResult)}`;

    if (validationResult.exitCode !== 0) {
      failures.push(validationResult);
    }
  }

  return {
    failures,
    previousOutputs: nextPreviousOutputs
  };
}

async function run(options, request) {
  const repo = requireRepo(options.repo || process.cwd());
  if (!request) {
    throw new Error(`Missing request.\n\n${usage()}`);
  }

  const config = await loadConfig();
  const projectConfigPath = path.join(repo, '.harness.json');
  let projectConfig = {};
  if (existsSync(projectConfigPath)) {
    projectConfig = JSON.parse(await readText(projectConfigPath));
  }

  const pipelineName = options.pipeline || projectConfig.pipeline;
  const selected = getPipeline(config, pipelineName);
  const agent = resolveAgentConfig({ options, projectConfig });
  const validationCommands = validationCommandsFromProjectConfig(projectConfig);
  const runId = timestampId();
  const runDir = path.join(harnessRoot, 'runs', runId);
  await ensureDir(runDir);

  const manifest = {
    schemaVersion: 1,
    runId,
    repo,
    request,
    pipeline: selected.pipelineName,
    dryRun: Boolean(options.dryRun),
    agent: {
      provider: agent.name,
      command: agent.command,
      version: await getAgentVersion(agent, { skip: options.dryRun })
    },
    nodeVersion: process.version,
    projectConfig,
    validationCommands,
    startedAt: new Date().toISOString(),
    steps: []
  };
  await writeText(path.join(runDir, 'request.txt'), request + '\n');
  await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.error(`Harness run: ${runId}`);
  console.error(`Repo: ${repo}`);
  console.error(`Pipeline: ${selected.pipelineName}`);
  console.error(`Agent: ${agent.name} (${agent.command})`);
  console.error(`Run dir: ${runDir}`);

  let previousOutputs = '';
  const validationFailures = [];
  const validationAfter = new Set(selected.pipeline.validationAfter || []);
  for (const step of selected.pipeline.steps) {
    const prompt = await renderPrompt(step, {
      request,
      repo,
      previousOutputs,
      projectConfig,
      validationCommands
    });
    const promptPath = path.join(runDir, `${step.id}.prompt.md`);
    await writeText(promptPath, prompt);

    if (options.dryRun) {
      console.error(`[dry-run] ${step.id}`);
      manifest.steps.push({
        type: 'agent',
        stepId: step.id,
        status: 'skipped',
        reason: 'dry-run',
        agent: agent.name,
        command: agent.command,
        sandbox: step.sandbox || 'read-only',
        approval: step.approval || 'never',
        model: step.model || null
      });
      await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

      if (validationAfter.has(step.id)) {
        const skipped = {
          type: 'validation',
          stepId: `validation:after-${step.id}`,
          status: 'skipped',
          reason: 'dry-run'
        };
        manifest.steps.push(skipped);
        await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        previousOutputs += `\n\n## validation after ${step.id}\nSkipped because this was a dry run.`;
      }

      continue;
    }

    console.error(`\n== ${step.id} ==`);
    const result = await runAgentStep({ repo, runDir, step, prompt, promptPath, agent });
    manifest.steps.push(result);
    await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (existsSync(result.finalPath)) {
      const output = await readText(result.finalPath);
      previousOutputs += `\n\n## ${step.id}\n${output}`;
    }

    if (result.exitCode !== 0) {
      throw new Error(`Step failed: ${step.id} (exit ${result.exitCode}). See ${runDir}`);
    }

    if (validationAfter.has(step.id)) {
      const validationStage = await runValidationStage({
        repo,
        runDir,
        stepId: step.id,
        validationCommands,
        manifest,
        previousOutputs
      });
      previousOutputs = validationStage.previousOutputs;
      validationFailures.push(...validationStage.failures);
    }
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.status = validationFailures.length === 0 ? 'succeeded' : 'failed';
  await writeText(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.error(`\nDone. Final report: ${path.join(runDir, `${selected.pipeline.steps.at(-1).id}.md`)}`);

  if (validationFailures.length > 0) {
    throw new Error(`Validation failed (${validationFailures.length} command(s)). See ${runDir}`);
  }
}

export async function main(args) {
  const parsed = parseArgs([...args]);

  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    console.log(usage());
    return;
  }

  if (parsed.command === 'run') {
    await run(parsed.options, parsed.request);
    return;
  }

  if (parsed.command === 'install-ide-task') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const tasksPath = await installIdeTask(repo);
    console.log(`Installed IDE task: ${tasksPath}`);
    return;
  }

  if (parsed.command === 'init-project') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const configPath = await initProject(repo);
    console.log(`Project harness config: ${configPath}`);
    return;
  }

  if (parsed.command === 'clean') {
    await cleanRuns({
      days: parsed.options.days ?? 7,
      keep: parsed.options.keep ?? 5,
      dryRun: parsed.options.dryRun
    });
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
}
