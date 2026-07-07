import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeText } from './fs-utils.js';

export const SECRET_PATTERNS = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  },
  {
    id: 'generic-secret-assignment',
    pattern: /\b(secret|token|api[_-]?key|password)\b\s*[:=]\s*['"][^'"]{12,}['"]/i
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/
  }
];

export const RISKY_FILE_PATTERNS = [
  {
    id: 'environment-file',
    pattern: /(^|\/)\.env(\.|$)/
  },
  {
    id: 'dependency-manifest',
    pattern: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/
  },
  {
    id: 'migration',
    pattern: /(^|\/)(migrations?|schema|db)(\/|$)/i
  },
  {
    id: 'security-sensitive-path',
    pattern: /(^|\/)(auth|security|permissions?|billing|payments?)(\/|$)/i
  }
];

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'inspection';
}

async function capture(command, args, { cwd }) {
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

function parseStatusShort(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || 'modified';
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(' -> ');
      return {
        status,
        path: renameParts.at(-1) || rawPath,
        raw: line
      };
    });
}

function uniqueByPath(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry.path || seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    result.push(entry);
  }
  return result;
}

export function detectRiskyFiles(files) {
  const findings = [];
  for (const file of files) {
    for (const rule of RISKY_FILE_PATTERNS) {
      if (rule.pattern.test(file.path)) {
        findings.push({
          ruleId: rule.id,
          path: file.path,
          status: file.status
        });
      }
    }
  }
  return findings;
}

async function scanSecrets(repo, files) {
  const findings = [];
  for (const file of files) {
    const absolutePath = path.join(repo, file.path);
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile() || stats.size > 1024 * 1024) {
        continue;
      }
      const text = await readFile(absolutePath, 'utf8');
      for (const rule of SECRET_PATTERNS) {
        if (rule.pattern.test(text)) {
          findings.push({
            ruleId: rule.id,
            path: file.path
          });
        }
      }
    } catch {
      // Deleted, binary, unreadable, or outside normal text handling. Ignore it for the lightweight scan.
    }
  }
  return findings;
}

export function inspectionSummary(result) {
  if (result.status === 'skipped') {
    return `status: skipped\nreason: ${result.reason}`;
  }

  return [
    `status: ${result.status}`,
    `changedFiles: ${result.changedFiles.length}`,
    `riskyFiles: ${result.riskyFiles.length}`,
    `secretFindings: ${result.secretFindings.length}`,
    `diffStatPath: ${result.diffStatPath || '(none)'}`,
    `detailsPath: ${result.detailsPath || '(none)'}`
  ].join('\n');
}

export async function inspectChanges({ repo, runDir, id, baselineStatusShort = '' }) {
  const startedAt = new Date();
  const safeId = slug(id);

  const inside = await capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (inside.exitCode !== 0 || inside.stdout !== 'true') {
    return {
      type: 'inspection',
      stepId: `inspection:${safeId}`,
      id: safeId,
      status: 'skipped',
      reason: inside.stderr || 'not a git work tree',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString()
    };
  }

  const [statusShort, diffStat, nameStatus] = await Promise.all([
    capture('git', ['status', '--short'], { cwd: repo }),
    capture('git', ['diff', '--stat'], { cwd: repo }),
    capture('git', ['diff', '--name-status'], { cwd: repo })
  ]);

  const statusFiles = parseStatusShort(statusShort.exitCode === 0 ? statusShort.stdout : '');
  const changedFiles = uniqueByPath(statusFiles);
  const riskyFiles = detectRiskyFiles(changedFiles);
  const secretFindings = await scanSecrets(repo, changedFiles);
  const diffStatPath = path.join(runDir, `inspection-${safeId}.diffstat.log`);
  const nameStatusPath = path.join(runDir, `inspection-${safeId}.name-status.log`);
  const detailsPath = path.join(runDir, `inspection-${safeId}.json`);
  const finishedAt = new Date();

  const result = {
    type: 'inspection',
    stepId: `inspection:${safeId}`,
    id: safeId,
    status: secretFindings.length > 0 ? 'warning' : 'succeeded',
    baselineDirty: String(baselineStatusShort || '').trim().length > 0,
    changedFiles,
    riskyFiles,
    secretFindings,
    diffStatPath,
    nameStatusPath,
    detailsPath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime()
  };

  await writeText(diffStatPath, diffStat.exitCode === 0 ? diffStat.stdout + '\n' : diffStat.stderr + '\n');
  await writeText(nameStatusPath, nameStatus.exitCode === 0 ? nameStatus.stdout + '\n' : nameStatus.stderr + '\n');
  await writeText(detailsPath, JSON.stringify(result, null, 2) + '\n');

  return result;
}
