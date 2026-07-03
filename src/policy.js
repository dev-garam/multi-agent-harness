import { spawn } from 'node:child_process';
import path from 'node:path';

const RISK_KEYWORDS = [
  'auth',
  'authentication',
  'authorization',
  'payment',
  'billing',
  'security',
  'migration',
  'delete',
  'destructive',
  'database',
  'credential',
  'token',
  '인증',
  '인가',
  '결제',
  '보안',
  '마이그레이션',
  '삭제',
  '데이터베이스'
];

const DESTRUCTIVE_KEYWORDS = [
  'delete',
  'drop',
  'remove all',
  'truncate',
  'destroy',
  'wipe',
  '삭제',
  '드롭',
  '전체 삭제',
  '파기'
];

export function defaultPolicy() {
  return {
    allowAutonomousRun: true,
    allowEdits: true,
    allowDestructiveCommands: false,
    protectedBranches: ['main', 'production'],
    requireApprovalFor: ['auth', 'payment', 'data deletion', 'database migration'],
    enforceApprovalForDirectRun: false
  };
}

export function policyFromProjectConfig(projectConfig = {}) {
  return {
    ...defaultPolicy(),
    ...(projectConfig.policy || {}),
    ...(projectConfig.hermes?.policy || {})
  };
}

export function classifyRequestRisk(request) {
  const normalized = String(request || '').toLowerCase();
  const riskKeywords = RISK_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  const destructiveKeywords = DESTRUCTIVE_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  return {
    riskKeywords,
    destructiveKeywords,
    highRisk: riskKeywords.length > 0 || destructiveKeywords.length > 0,
    destructive: destructiveKeywords.length > 0
  };
}

export function evaluatePolicy({ request, policy = defaultPolicy(), mode = 'autonomous' }) {
  const risk = classifyRequestRisk(request);
  const approvalKeywords = policy.requireApprovalFor || [];
  const keywordRequiresApproval = risk.riskKeywords.some((keyword) => {
    return approvalKeywords.some((entry) => {
      return keyword.toLowerCase().includes(String(entry).toLowerCase()) ||
        String(entry).toLowerCase().includes(keyword.toLowerCase());
    });
  });
  const destructiveBlocked = risk.destructive && !policy.allowDestructiveCommands;
  const autonomousBlocked = mode === 'autonomous' && !policy.allowAutonomousRun;
  const approvalBlocked = mode === 'autonomous' || policy.enforceApprovalForDirectRun
    ? keywordRequiresApproval
    : false;
  const requiresApproval = autonomousBlocked || destructiveBlocked || approvalBlocked;

  return {
    allowed: !requiresApproval,
    requiresApproval,
    mode,
    risk,
    reason: requiresApproval
      ? 'Policy requires human approval for this request.'
      : 'Policy allows execution.'
  };
}

async function runCapture(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', resolve);
  });

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

async function currentGitBranch(repo) {
  const result = await runCapture('git', ['branch', '--show-current'], { cwd: repo });
  if (result.exitCode !== 0 || !result.stdout) {
    return {
      available: false,
      branch: null,
      reason: result.stderr || 'current git branch unavailable'
    };
  }

  return {
    available: true,
    branch: result.stdout,
    reason: null
  };
}

export function protectedBranchesFromConfig(config = {}, policy = defaultPolicy()) {
  const candidates = [
    config.protectedBranches,
    config.policy?.protectedBranches,
    config.hermes?.policy?.protectedBranches,
    policy.protectedBranches
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length > 0) {
      return value.map((branch) => String(branch));
    }
  }
  return [];
}

export async function evaluateProtectedBranchPolicy({ repo, projectConfig = {}, policy = policyFromProjectConfig(projectConfig) }) {
  const protectedBranches = protectedBranchesFromConfig(projectConfig, policy);
  const git = await currentGitBranch(path.resolve(repo));
  const protectedBranch = git.available && protectedBranches.includes(git.branch);

  return {
    allowed: !protectedBranch,
    requiresApproval: protectedBranch,
    reason: protectedBranch
      ? `Policy requires human approval on protected branch: ${git.branch}.`
      : 'Protected branch policy allows autonomous execution.',
    branch: git.branch,
    gitAvailable: git.available,
    gitReason: git.reason,
    protectedBranches
  };
}
