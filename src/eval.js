import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { validateProjectConfig } from './config-validation.js';
import { validationCommandsFromProjectConfig } from './validation.js';

function check(id, status, message, detail = null) {
  return {
    id,
    status,
    message,
    detail
  };
}

function scoreChecks(checks) {
  const total = checks.length;
  const passed = checks.filter((entry) => entry.status === 'pass').length;
  const failed = checks.filter((entry) => entry.status === 'fail').length;
  const warned = checks.filter((entry) => entry.status === 'warn').length;
  return {
    total,
    passed,
    warned,
    failed,
    score: total === 0 ? 1 : passed / total
  };
}

export async function runHarnessEval({ repo = process.cwd(), json = false } = {}) {
  const resolvedRepo = path.resolve(repo);
  const configPath = path.join(resolvedRepo, '.harness.json');
  const evalDir = path.join(harnessRoot, '.harness', 'eval');
  const evalId = timestampId();
  const reportPath = path.join(evalDir, `${evalId}.json`);
  const harnessConfig = await loadConfig();
  let projectConfig = {};
  const checks = [];

  if (!existsSync(configPath)) {
    checks.push(check('project-config-exists', 'fail', '.harness.json not found', { configPath }));
  } else {
    checks.push(check('project-config-exists', 'pass', '.harness.json found', { configPath }));
    try {
      projectConfig = JSON.parse(await readText(configPath));
    } catch (error) {
      checks.push(check('project-config-parse', 'fail', 'failed to parse .harness.json', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  const validation = validateProjectConfig(projectConfig, { harnessConfig });
  checks.push(check(
    'project-config-schema',
    validation.valid ? 'pass' : 'fail',
    validation.valid ? 'project config schema is valid' : 'project config schema has errors',
    validation
  ));

  const validationCommands = validationCommandsFromProjectConfig(projectConfig);
  checks.push(check(
    'validation-coverage',
    validationCommands.length > 0 ? 'pass' : 'warn',
    validationCommands.length > 0 ? `${validationCommands.length} validation command(s) configured` : 'no validation commands configured',
    validationCommands.map((entry) => ({ id: entry.id, command: entry.command }))
  ));

  const protectedBranches = projectConfig.protectedBranches || projectConfig.policy?.protectedBranches || [];
  checks.push(check(
    'protected-branches',
    protectedBranches.length > 0 ? 'pass' : 'warn',
    protectedBranches.length > 0 ? 'protected branches configured' : 'no protected branches configured',
    protectedBranches
  ));

  checks.push(check(
    'redaction-policy',
    projectConfig.redaction?.enabled === true ? 'pass' : 'warn',
    projectConfig.redaction?.enabled === true ? 'redaction enabled' : 'redaction is not enabled'
  ));

  checks.push(check(
    'budget-policy',
    projectConfig.budget ? 'pass' : 'warn',
    projectConfig.budget ? 'budget policy configured' : 'no budget policy configured'
  ));

  const result = {
    evalId,
    repo: resolvedRepo,
    configPath,
    reportPath,
    status: checks.some((entry) => entry.status === 'fail') ? 'failed' : 'passed',
    score: scoreChecks(checks),
    checks
  };

  await ensureDir(evalDir);
  await writeText(reportPath, JSON.stringify(result, null, 2) + '\n');

  if (json) {
    return JSON.stringify(result, null, 2);
  }

  return [
    'Harness eval',
    `Repo: ${result.repo}`,
    `Status: ${result.status}`,
    `Score: ${result.score.passed}/${result.score.total}`,
    `Report: ${result.reportPath}`,
    '',
    ...checks.map((entry) => `- ${entry.status}: ${entry.id}: ${entry.message}`)
  ].join('\n');
}
