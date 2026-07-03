import path from 'node:path';
import { ensureDir, harnessRoot, timestampId, writeText } from './fs-utils.js';
import { readProjectHarnessConfig } from './hermes-config.js';
import { readHermesMemory, rebuildHermesMemory } from './hermes-memory.js';

function promotionRoot() {
  return path.join(harnessRoot, '.harness', 'promotions');
}

function validationFailureCounts(records) {
  const counts = {};
  for (const record of records) {
    for (const failure of record.validationFailures || []) {
      const command = failure.command || failure.id || failure.stepId || 'unknown';
      counts[command] ||= {
        command,
        count: 0,
        runIds: []
      };
      counts[command].count += 1;
      counts[command].runIds.push(record.runId);
    }
  }
  return Object.values(counts).sort((left, right) => right.count - left.count);
}

function repoPatternCounts(records) {
  const repos = {};
  for (const record of records) {
    const repo = record.repo || 'unknown';
    repos[repo] ||= {
      repo,
      totalRuns: 0,
      safeFixRuns: 0,
      escalations: 0,
      badFeedback: 0,
      runIds: []
    };
    const summary = repos[repo];
    summary.totalRuns += 1;
    summary.runIds.push(record.runId);
    if ((record.completedPipeline || record.pipeline) === 'safe_fix') {
      summary.safeFixRuns += 1;
    }
    if ((record.supervisorActions || []).includes('escalate_to_safe_fix')) {
      summary.escalations += 1;
    }
    if (record.feedback?.rating === 'bad') {
      summary.badFeedback += 1;
    }
  }
  return Object.values(repos).sort((left, right) => {
    return (right.escalations + right.safeFixRuns + right.badFeedback) - (left.escalations + left.safeFixRuns + left.badFeedback);
  });
}

function buildPromotionProposals(records) {
  const createdAt = new Date().toISOString();
  const proposals = [];

  for (const repo of repoPatternCounts(records)) {
    if (repo.escalations >= 2 || repo.safeFixRuns >= 2) {
      proposals.push({
        schemaVersion: 1,
        proposalId: `${timestampId()}-routing-${proposals.length + 1}`,
        type: 'routing_policy',
        title: 'Prefer safe_fix for a repo with repeated risk signals',
        reason: `Repo has ${repo.safeFixRuns} safe_fix run(s) and ${repo.escalations} safe_fix escalation(s).`,
        target: 'policy',
        action: 'review_route_to_safe_fix',
        status: 'proposed',
        createdAt,
        evidence: {
          repo: repo.repo,
          runIds: repo.runIds.slice(-5),
          safeFixRuns: repo.safeFixRuns,
          escalations: repo.escalations
        }
      });
    }

    if (repo.badFeedback > 0) {
      proposals.push({
        schemaVersion: 1,
        proposalId: `${timestampId()}-feedback-${proposals.length + 1}`,
        type: 'feedback_review',
        title: 'Review recurring bad feedback before autonomous execution',
        reason: `Repo has ${repo.badFeedback} run(s) with bad feedback.`,
        target: 'policy',
        action: 'require_review_for_similar_requests',
        status: 'proposed',
        createdAt,
        evidence: {
          repo: repo.repo,
          runIds: repo.runIds.slice(-5),
          badFeedback: repo.badFeedback
        }
      });
    }
  }

  for (const failure of validationFailureCounts(records).filter((entry) => entry.count >= 2).slice(0, 5)) {
    proposals.push({
      schemaVersion: 1,
      proposalId: `${timestampId()}-validation-${proposals.length + 1}`,
      type: 'validation_policy',
      title: 'Promote recurring validation failure into project validation review',
      reason: `Validation command failed ${failure.count} time(s): ${failure.command}`,
      target: '.harness.json',
      action: 'review_validation_command',
      status: 'proposed',
      createdAt,
      evidence: {
        command: failure.command,
        runIds: failure.runIds.slice(-5),
        failureCount: failure.count
      }
    });
  }

  return proposals;
}

function promotionPatchPayload(proposal) {
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    type: proposal.type,
    title: proposal.title,
    reason: proposal.reason,
    target: proposal.target,
    action: proposal.action,
    evidence: proposal.evidence,
    reviewStatus: 'pending',
    createdAt: proposal.createdAt
  };
}

function patchFileName(proposal) {
  return `.harness.promotions/${proposal.proposalId}.json`;
}

function jsonNewFilePatch(fileName, value) {
  const json = JSON.stringify(value, null, 2) + '\n';
  const lines = [
    `diff --git a/${fileName} b/${fileName}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${fileName}`,
    `@@ -0,0 +1,${json.split('\n').length - 1} @@`,
    ...json.split('\n').filter((line, index, array) => index < array.length - 1).map((line) => `+${line}`)
  ];
  return lines.join('\n') + '\n';
}

function patchLines(text) {
  const hasFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasFinalNewline) {
    lines.pop();
  }
  return {
    lines,
    hasFinalNewline
  };
}

function textReplaceFilePatch(fileName, beforeText, afterText) {
  const before = patchLines(beforeText);
  const after = patchLines(afterText);
  const body = [];
  for (const line of before.lines) {
    body.push(`-${line}`);
  }
  if (!before.hasFinalNewline) {
    body.push('\\ No newline at end of file');
  }
  for (const line of after.lines) {
    body.push(`+${line}`);
  }
  if (!after.hasFinalNewline) {
    body.push('\\ No newline at end of file');
  }
  return [
    `diff --git a/${fileName} b/${fileName}`,
    `--- a/${fileName}`,
    `+++ b/${fileName}`,
    `@@ -1,${before.lines.length} +1,${after.lines.length} @@`,
    ...body
  ].join('\n') + '\n';
}

function promotionConfigHint(proposal) {
  return {
    proposalId: proposal.proposalId,
    type: proposal.type,
    action: proposal.action,
    reason: proposal.reason,
    evidence: proposal.evidence,
    status: 'pending_review',
    createdAt: proposal.createdAt
  };
}

function configWithPromotionHint(config, proposal) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.hermes ||= {};
  next.hermes.promotions = Array.isArray(next.hermes.promotions) ? next.hermes.promotions : [];
  if (!next.hermes.promotions.some((entry) => entry.proposalId === proposal.proposalId)) {
    next.hermes.promotions.push(promotionConfigHint(proposal));
  }

  if (proposal.type === 'validation_policy' && proposal.evidence?.command) {
    next.hermes.suggestedValidationCommands = Array.isArray(next.hermes.suggestedValidationCommands)
      ? next.hermes.suggestedValidationCommands
      : [];
    if (!next.hermes.suggestedValidationCommands.some((entry) => entry.command === proposal.evidence.command)) {
      next.hermes.suggestedValidationCommands.push({
        command: proposal.evidence.command,
        reason: proposal.reason,
        proposalId: proposal.proposalId
      });
    }
  }

  if (proposal.type === 'routing_policy') {
    next.hermes.routingHints = Array.isArray(next.hermes.routingHints) ? next.hermes.routingHints : [];
    next.hermes.routingHints.push({
      pipeline: 'safe_fix',
      reason: proposal.reason,
      proposalId: proposal.proposalId
    });
  }

  if (proposal.type === 'feedback_review') {
    next.hermes.reviewHints = Array.isArray(next.hermes.reviewHints) ? next.hermes.reviewHints : [];
    next.hermes.reviewHints.push({
      reason: proposal.reason,
      proposalId: proposal.proposalId
    });
  }

  return next;
}

async function harnessConfigPatch(repo, proposal) {
  const current = await readProjectHarnessConfig(repo);
  const next = configWithPromotionHint(current.value, proposal);
  if (current.exists) {
    return textReplaceFilePatch('.harness.json', current.rawText, JSON.stringify(next, null, 2) + '\n');
  }
  return jsonNewFilePatch('.harness.json', next);
}

async function writePromotionPatchArtifacts(proposals) {
  await ensureDir(promotionRoot());
  const artifacts = [];
  for (const proposal of proposals) {
    const repo = proposal.evidence?.repo || harnessRoot;
    const fileName = patchFileName(proposal);
    const patchPath = path.join(promotionRoot(), `${proposal.proposalId}.patch`);
    const patch = [
      jsonNewFilePatch(fileName, promotionPatchPayload(proposal)),
      await harnessConfigPatch(repo, proposal)
    ].join('\n');
    await writeText(patchPath, patch);
    artifacts.push({
      proposalId: proposal.proposalId,
      repo,
      targetFiles: [fileName, '.harness.json'],
      patchPath
    });
  }
  return artifacts;
}

async function writeJson(filePath, value) {
  await writeText(filePath, JSON.stringify(value, null, 2) + '\n');
}

export async function promoteHermesPatterns({ apply = false } = {}) {
  let records = await readHermesMemory();
  let source = 'memory';
  if (records.length === 0) {
    const rebuilt = await rebuildHermesMemory();
    records = rebuilt.records;
    source = 'rebuilt-memory';
  }

  const proposals = buildPromotionProposals(records);
  const result = {
    schemaVersion: 1,
    mode: apply ? 'apply' : 'dry-run',
    source,
    createdAt: new Date().toISOString(),
    proposalCount: proposals.length,
    proposals: proposals.map((proposal) => ({
      ...proposal,
      status: apply ? 'recorded' : 'proposed'
    })),
    note: apply
      ? 'Safe apply records promotion proposals under .harness/promotions. Project config and prompts are not modified automatically.'
      : 'Dry-run only. Use --apply to record safe promotion proposals.'
  };

  if (apply) {
    await ensureDir(promotionRoot());
    result.patchArtifacts = await writePromotionPatchArtifacts(result.proposals);
    result.recordPath = path.join(promotionRoot(), `${timestampId()}.json`);
    await writeJson(result.recordPath, result);
  }

  return result;
}

export function formatPromotionResult(result) {
  const lines = [
    'Hermes promote',
    `Mode: ${result.mode}`,
    `Source: ${result.source}`,
    `Proposals: ${result.proposalCount}`,
    result.recordPath ? `Promotion record: ${result.recordPath}` : null,
    result.patchArtifacts?.length ? `Patch artifacts: ${result.patchArtifacts.length}` : null,
    `Note: ${result.note}`
  ].filter(Boolean);

  for (const proposal of result.proposals) {
    lines.push(`- [${proposal.type}] ${proposal.title}`);
    lines.push(`  action=${proposal.action} target=${proposal.target}`);
    lines.push(`  reason=${proposal.reason}`);
    const artifact = (result.patchArtifacts || []).find((candidate) => candidate.proposalId === proposal.proposalId);
    if (artifact) {
      lines.push(`  targets=${artifact.targetFiles.join(',')}`);
      lines.push(`  patch=${artifact.patchPath}`);
    }
  }

  if (result.proposals.length === 0) {
    lines.push('- no promotion candidates found');
  }

  lines.push('', 'Proposal JSON:', JSON.stringify(result, null, 2));
  return lines.join('\n');
}
