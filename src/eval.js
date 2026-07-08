import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { ensureDir, harnessRoot, readText, timestampId, writeText } from './fs-utils.js';
import { validateProjectConfig } from './config-validation.js';
import { validationCommandsFromProjectConfig } from './validation.js';
import { evaluatePolicy, policyFromProjectConfig } from './policy.js';
import { selectPipeline } from './pipeline-selection.js';
import { parseSupervisorDecision } from './supervisor.js';
import { computePromptRegistry, diffPromptRegistry, loadPromptVersionGolden } from './prompt-registry.js';

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

function recommendationsForChecks(checks) {
  const recommendations = [];
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  if (byId.get('project-config-exists')?.status === 'fail') {
    recommendations.push('Run `harness init-project --repo <path>` to create .harness.json.');
  }
  if (byId.get('project-config-schema')?.status === 'fail') {
    recommendations.push('Fix .harness.json schema errors, then rerun `harness doctor --repo <path>`.');
  }
  if (byId.get('validation-coverage')?.status === 'warn') {
    recommendations.push('Add testCommand, buildCommand, or validationCommands so the harness can verify changes.');
  }
  if (byId.get('protected-branches')?.status === 'warn') {
    recommendations.push('Add protectedBranches to prevent accidental autonomous work on main/production.');
  }
  if (byId.get('redaction-policy')?.status === 'warn') {
    recommendations.push('Enable redaction to reduce secret exposure in prompts, logs, and manifests.');
  }
  if (byId.get('budget-policy')?.status === 'warn') {
    recommendations.push('Add budget limits for agent steps, provider calls, validation commands, and runtime.');
  }
  if (byId.get('prompt-versions')?.status === 'fail') {
    recommendations.push('Prompt drift detected. If intentional, run `node scripts/update-prompt-versions.mjs` and commit; otherwise revert the prompt change.');
  }
  for (const entry of checks) {
    if (entry.id.startsWith('expected-') && entry.status === 'fail') {
      recommendations.push(`Review fixture expectation: ${entry.id}.`);
    }
    if (entry.id.startsWith('policy-case:') && entry.status === 'fail') {
      recommendations.push(`Review policy case expectation: ${entry.id}.`);
    }
    if (entry.id.startsWith('pipeline-case:') && entry.status === 'fail') {
      recommendations.push(`Pipeline selection regressed: ${entry.id}. Check pipeline-selection signals.`);
    }
    if (entry.id.startsWith('supervisor-case:') && entry.status === 'fail') {
      recommendations.push(`Supervisor decision regressed: ${entry.id}. Check supervisor parse/normalize.`);
    }
  }
  return [...new Set(recommendations)];
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

function addPipelineCaseChecks({ checks, spec, projectConfig, harnessConfig }) {
  if (!Array.isArray(spec?.pipelineCases)) {
    return;
  }

  spec.pipelineCases.forEach((pipelineCase, index) => {
    const id = pipelineCase.id || `pipeline-${index + 1}`;
    const selection = selectPipeline({
      request: pipelineCase.request || '',
      requestedPipeline: pipelineCase.requestedPipeline || null,
      projectConfig,
      harnessConfig
    });
    const expected = pipelineCase.expected || {};
    const mismatches = [];

    for (const key of ['selected', 'mode']) {
      if (expected[key] !== undefined && selection[key] !== expected[key]) {
        mismatches.push(`${key}: expected ${expected[key]}, got ${selection[key]}`);
      }
    }
    if (expected.minComplexity !== undefined && !(selection.complexityScore >= expected.minComplexity)) {
      mismatches.push(`complexityScore: expected >= ${expected.minComplexity}, got ${selection.complexityScore}`);
    }
    if (expected.minRisk !== undefined && !(selection.riskScore >= expected.minRisk)) {
      mismatches.push(`riskScore: expected >= ${expected.minRisk}, got ${selection.riskScore}`);
    }

    checks.push(check(
      `pipeline-case:${id}`,
      mismatches.length === 0 ? 'pass' : 'fail',
      mismatches.length === 0 ? 'pipeline selection matched expected result' : mismatches.join('; '),
      {
        request: pipelineCase.request || '',
        requestedPipeline: pipelineCase.requestedPipeline || null,
        expected,
        selection
      }
    ));
  });
}

function addSupervisorCaseChecks({ checks, spec }) {
  if (!Array.isArray(spec?.supervisorCases)) {
    return;
  }

  spec.supervisorCases.forEach((supervisorCase, index) => {
    const id = supervisorCase.id || `supervisor-${index + 1}`;
    const decision = parseSupervisorDecision(supervisorCase.output || '');
    const expected = supervisorCase.expected || {};
    const mismatches = [];

    for (const key of ['valid', 'nextAction', 'status', 'targetStep']) {
      if (expected[key] !== undefined && decision[key] !== expected[key]) {
        mismatches.push(`${key}: expected ${expected[key]}, got ${decision[key]}`);
      }
    }

    checks.push(check(
      `supervisor-case:${id}`,
      mismatches.length === 0 ? 'pass' : 'fail',
      mismatches.length === 0 ? 'supervisor decision matched expected result' : mismatches.join('; '),
      {
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

  // B5: 프롬프트/역할 품질 회귀. 하네스 프롬프트 지문을 커밋된 골든과 비교해
  // 의도치 않은 프롬프트 드리프트를 품질 리포트에 노출한다.
  const promptGolden = await loadPromptVersionGolden();
  if (!promptGolden) {
    checks.push(check('prompt-versions', 'warn', 'prompt version golden not found (run scripts/update-prompt-versions.mjs)'));
  } else {
    const promptDrift = diffPromptRegistry(promptGolden, await computePromptRegistry());
    checks.push(check(
      'prompt-versions',
      promptDrift.drift ? 'fail' : 'pass',
      promptDrift.drift
        ? `prompt drift: changed=[${promptDrift.changed.join(', ')}] added=[${promptDrift.added.join(', ')}] removed=[${promptDrift.removed.join(', ')}]`
        : 'prompts match committed version golden',
      promptDrift
    ));
  }

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
    addPipelineCaseChecks({ checks, spec: evalSpec.spec, projectConfig, harnessConfig });
    addSupervisorCaseChecks({ checks, spec: evalSpec.spec });
  }

  const result = {
    evalId,
    repo: resolvedRepo,
    configPath,
    reportPath,
    status: checks.some((entry) => entry.status === 'fail') ? 'failed' : 'passed',
    score: scoreChecks(checks),
    checks,
    recommendations: recommendationsForChecks(checks)
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
    ...checks.map((entry) => `- ${entry.status}: ${entry.id}: ${entry.message}`),
    '',
    'Recommendations',
    ...(result.recommendations.length > 0
      ? result.recommendations.map((entry) => `- ${entry}`)
      : ['- none'])
  ].join('\n');
}
