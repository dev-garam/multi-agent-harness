import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { validateProjectConfig } from './config-validation.js';
import { validationCommandsFromProjectConfig } from './validation.js';
import { evaluatePolicy, policyFromProjectConfig } from './policy.js';

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

async function loadEvalSpec(repo) {
  const specPath = path.join(repo, '.harness-eval.json');
  if (!existsSync(specPath)) {
    return {
      specPath,
      spec: null,
      error: null
    };
  }

  try {
    return {
      specPath,
      spec: JSON.parse(await readText(specPath)),
      error: null
    };
  } catch (error) {
    return {
      specPath,
      spec: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function addExpectedChecks({ checks, spec, baseScore, baseStatus }) {
  if (!spec?.expected || typeof spec.expected !== 'object') {
    return;
  }

  if (spec.expected.status !== undefined) {
    checks.push(check(
      'expected-status',
      spec.expected.status === baseStatus ? 'pass' : 'fail',
      spec.expected.status === baseStatus
        ? `status matched expected ${spec.expected.status}`
        : `expected status ${spec.expected.status}, got ${baseStatus}`,
      { expected: spec.expected.status, actual: baseStatus }
    ));
  }

  if (spec.expected.minScore !== undefined) {
    const minScore = Number(spec.expected.minScore);
    checks.push(check(
      'expected-min-score',
      Number.isFinite(minScore) && baseScore.score >= minScore ? 'pass' : 'fail',
      Number.isFinite(minScore) && baseScore.score >= minScore
        ? `score ${baseScore.score} >= ${minScore}`
        : `score ${baseScore.score} < ${minScore}`,
      { expected: minScore, actual: baseScore.score }
    ));
  }

  if (spec.expected.checks && typeof spec.expected.checks === 'object') {
    for (const [checkId, expectedStatus] of Object.entries(spec.expected.checks)) {
      const actual = checks.find((entry) => entry.id === checkId);
      checks.push(check(
        `expected-check:${checkId}`,
        actual?.status === expectedStatus ? 'pass' : 'fail',
        actual?.status === expectedStatus
          ? `${checkId} matched expected ${expectedStatus}`
          : `${checkId} expected ${expectedStatus}, got ${actual?.status || 'missing'}`,
        { expected: expectedStatus, actual: actual?.status || null }
      ));
    }
  }
}

function addPolicyCaseChecks({ checks, spec, projectConfig }) {
  if (!Array.isArray(spec?.policyCases)) {
    return;
  }

  const policy = policyFromProjectConfig(projectConfig);
  spec.policyCases.forEach((policyCase, index) => {
    const id = policyCase.id || `policy-${index + 1}`;
    const decision = evaluatePolicy({
      request: policyCase.request || '',
      policy,
      mode: policyCase.mode || 'autonomous'
    });
    const expected = policyCase.expected || {};
    const mismatches = [];
    for (const key of ['allowed', 'requiresApproval']) {
      if (expected[key] !== undefined && decision[key] !== expected[key]) {
        mismatches.push(`${key}: expected ${expected[key]}, got ${decision[key]}`);
      }
    }

    checks.push(check(
      `policy-case:${id}`,
      mismatches.length === 0 ? 'pass' : 'fail',
      mismatches.length === 0 ? 'policy decision matched expected result' : mismatches.join('; '),
      {
        request: policyCase.request || '',
        mode: policyCase.mode || 'autonomous',
        expected,
        decision
      }
    ));
  });
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
  const evalSpec = await loadEvalSpec(resolvedRepo);

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

  if (evalSpec.error) {
    checks.push(check('eval-spec-parse', 'fail', 'failed to parse .harness-eval.json', {
      specPath: evalSpec.specPath,
      error: evalSpec.error
    }));
  } else if (evalSpec.spec) {
    checks.push(check('eval-spec-exists', 'pass', '.harness-eval.json found', {
      specPath: evalSpec.specPath
    }));
    const baseScore = scoreChecks(checks);
    const baseStatus = checks.some((entry) => entry.status === 'fail') ? 'failed' : 'passed';
    addExpectedChecks({ checks, spec: evalSpec.spec, baseScore, baseStatus });
    addPolicyCaseChecks({ checks, spec: evalSpec.spec, projectConfig });
  }

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
