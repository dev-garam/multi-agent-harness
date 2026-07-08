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

// 실제 명령에 대한 기본 파괴 패턴. 텍스트 키워드보다 정밀하게, 실행될 명령을
// 대상으로 판단한다. config의 policy.destructiveCommandPatterns(문자열/정규식)로 확장 가능.
const DEFAULT_DESTRUCTIVE_COMMANDS = [
  /\brm\s+-[a-z]*r[a-z]*\b/i,
  /\brm\s+-[a-z]*f[a-z]*\b/i,
  /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i
];

function matchCommandPattern(command, pattern) {
  if (pattern instanceof RegExp) {
    return pattern.test(command);
  }
  return String(command).toLowerCase().includes(String(pattern).toLowerCase());
}

// diff(inspection)와 명령 allowlist에 근거한 위험 판정. 요청 텍스트 키워드의
// 보완재로, approval 요구를 '추가'만 한다(기존 게이트를 완화하지 않는다).
export function evaluateChangeRisk({ inspection = null, commands = [], policy = defaultPolicy() } = {}) {
  const reasons = [];

  if (inspection && typeof inspection === 'object') {
    const riskyFiles = Array.isArray(inspection.riskyFiles) ? inspection.riskyFiles : [];
    const secretFindings = Array.isArray(inspection.secretFindings) ? inspection.secretFindings : [];
    const gatedRuleIds = new Set(policy.approvalRiskRuleIds
      || ['migration', 'security-sensitive-path', 'environment-file']);
    for (const entry of riskyFiles) {
      if (gatedRuleIds.has(entry.ruleId)) {
        reasons.push(`change touches ${entry.ruleId}: ${entry.path}`);
      }
    }
    if (secretFindings.length > 0) {
      reasons.push(`potential secret in diff: ${secretFindings.map((finding) => finding.path).join(', ')}`);
    }
  }

  const destructivePatterns = policy.destructiveCommandPatterns || DEFAULT_DESTRUCTIVE_COMMANDS;
  const allowedCommands = (policy.allowedCommands || []).map((entry) => String(entry));
  for (const raw of Array.isArray(commands) ? commands : [commands]) {
    const command = String(raw || '').trim();
    if (!command) {
      continue;
    }
    const isAllowed = allowedCommands.some((entry) => command === entry || command.startsWith(`${entry} `));
    if (isAllowed) {
      continue;
    }
    if (destructivePatterns.some((pattern) => matchCommandPattern(command, pattern))) {
      reasons.push(`destructive command not in allowlist: ${command}`);
    }
  }

  return {
    requiresApproval: reasons.length > 0,
    reasons
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
  if (result.exitCode === 0 && result.stdout) {
    return {
      available: true,
      branch: result.stdout,
      detached: false,
      reason: null
    };
  }

  // 브랜치명이 비었다: repo인데 detached HEAD인지, 아예 git work tree가 아닌지 구분.
  const inside = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode === 0 && inside.stdout === 'true') {
    return {
      available: true,
      branch: null,
      detached: true,
      reason: 'HEAD is detached'
    };
  }

  return {
    available: false,
    branch: null,
    detached: false,
    reason: result.stderr || 'current git branch unavailable'
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
  const onProtectedBranch = git.available && git.branch !== null && protectedBranches.includes(git.branch);
  // detached HEAD는 어떤 브랜치인지 확인할 수 없어 보호 브랜치 여부를 판단 못 한다.
  // 자율 실행을 허용하면 보호 브랜치 커밋 위에서 작업할 위험이 있으므로 fail-safe로 approval.
  const detachedBlocked = git.available && git.detached === true;
  const requiresApproval = onProtectedBranch || detachedBlocked;

  return {
    allowed: !requiresApproval,
    requiresApproval,
    reason: onProtectedBranch
      ? `Policy requires human approval on protected branch: ${git.branch}.`
      : detachedBlocked
        ? 'Policy requires human approval: HEAD is detached, cannot confirm the checkout is not a protected branch.'
        : 'Protected branch policy allows autonomous execution.',
    branch: git.branch,
    detached: git.detached === true,
    gitAvailable: git.available,
    gitReason: git.reason,
    protectedBranches
  };
}
