import { spawn } from 'node:child_process';
import path from 'node:path';
import { writeText } from './fs-utils.js';

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'command';
}

export function validationCommandsFromProjectConfig(projectConfig = {}) {
  const commands = [];

  if (projectConfig.buildCommand) {
    commands.push({ id: 'build', command: projectConfig.buildCommand });
  }

  if (projectConfig.testCommand) {
    commands.push({ id: 'test', command: projectConfig.testCommand });
  }

  if (Array.isArray(projectConfig.validationCommands)) {
    projectConfig.validationCommands.forEach((entry, index) => {
      if (typeof entry === 'string') {
        commands.push({ id: `validation-${index + 1}`, command: entry });
        return;
      }

      if (entry && typeof entry === 'object' && entry.command) {
        commands.push({
          id: entry.id || slug(entry.name || entry.command),
          command: entry.command
        });
      }
    });
  }

  return commands;
}

export async function runValidationCommand({ repo, runDir, id, command }) {
  const startedAt = new Date();
  const safeId = slug(id);
  const stdoutPath = path.join(runDir, `validation-${safeId}.stdout.log`);
  const stderrPath = path.join(runDir, `validation-${safeId}.stderr.log`);

  const child = spawn(command, {
    cwd: repo,
    env: process.env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    const value = chunk.toString();
    stdout += value;
    process.stdout.write(value);
  });

  child.stderr.on('data', (chunk) => {
    const value = chunk.toString();
    stderr += value;
    process.stderr.write(value);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const finishedAt = new Date();
  await writeText(stdoutPath, stdout);
  await writeText(stderrPath, stderr);

  return {
    type: 'validation',
    stepId: `validation:${safeId}`,
    id: safeId,
    command,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stdoutPath,
    stderrPath
  };
}
