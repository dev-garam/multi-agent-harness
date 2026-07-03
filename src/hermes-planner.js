import {
  repoProfileFromMemory,
  similarMemoryRecords
} from './hermes-memory.js';
import {
  classifyRequestRisk,
  defaultPolicy,
  evaluatePolicy
} from './policy.js';

const REVIEW_KEYWORDS = [
  'review',
  '리뷰',
  '검토',
  '읽기 전용',
  'read-only'
];

const SMALL_FIX_KEYWORDS = [
  'typo',
  '오타',
  '문구',
  'readme',
  '작게',
  '간단',
  'small'
];

export function planHermesRequest(request, { agent = 'codex', repo = null, memoryRecords = [], policy = defaultPolicy() } = {}) {
  const normalized = String(request || '').toLowerCase();
  const hasRisk = classifyRequestRisk(request).highRisk;
  const isReview = REVIEW_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const isSmall = SMALL_FIX_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const similarRuns = similarMemoryRecords(memoryRecords, request, repo);
  const repoProfile = repoProfileFromMemory(memoryRecords, repo);
  const policyDecision = evaluatePolicy({ request, policy });

  let pipeline = 'code_fix';
  const reasons = [];
  const memoryEvidence = [];

  if (isReview) {
    pipeline = 'review_only';
    reasons.push('Request looks like a read-only review.');
  } else if (hasRisk) {
    pipeline = 'safe_fix';
    reasons.push('Request contains high-risk keywords and should include verifier coverage.');
  } else if (isSmall) {
    pipeline = 'quick_fix';
    reasons.push('Request looks small and focused.');
  } else {
    reasons.push('Default code change path is appropriate.');
  }

  if (!isReview && repoProfile) {
    if ((repoProfile.actionCounts.escalate_to_safe_fix || 0) > 0) {
      pipeline = 'safe_fix';
      reasons.push('Memory shows prior safe_fix escalation for this repo.');
      memoryEvidence.push({
        type: 'repo_profile',
        signal: 'escalate_to_safe_fix',
        count: repoProfile.actionCounts.escalate_to_safe_fix
      });
    }

    if (repoProfile.validationFailureCount > 0 && pipeline !== 'safe_fix') {
      pipeline = 'safe_fix';
      reasons.push('Memory shows validation failures for this repo; verifier coverage is recommended.');
      memoryEvidence.push({
        type: 'repo_profile',
        signal: 'validation_failures',
        count: repoProfile.validationFailureCount
      });
    }
  }

  for (const record of similarRuns.slice(0, 3)) {
    memoryEvidence.push({
      type: 'similar_run',
      runId: record.runId,
      pipeline: record.pipeline,
      completedPipeline: record.completedPipeline,
      status: record.status,
      supervisorActions: record.supervisorActions,
      feedback: record.feedback ? {
        rating: record.feedback.rating,
        note: record.feedback.note
      } : null
    });
  }

  if (!isReview && similarRuns.some((record) => record.completedPipeline === 'safe_fix' || (record.supervisorActions || []).includes('escalate_to_safe_fix'))) {
    pipeline = 'safe_fix';
    reasons.push('Similar memory records used safe_fix or escalated to safe_fix.');
  }

  const badFeedback = similarRuns.filter((record) => record.feedback?.rating === 'bad');
  if (badFeedback.length > 0) {
    reasons.push('Memory contains negative feedback for similar runs; use extra caution.');
    memoryEvidence.push({
      type: 'feedback',
      signal: 'bad_feedback',
      count: badFeedback.length
    });
  }

  return {
    pipeline,
    agent,
    requiresApproval: policyDecision.requiresApproval,
    validation: 'use project config',
    reason: reasons.join(' '),
    source: memoryEvidence.length > 0 ? 'memory-backed' : 'rule-based',
    memoryEvidence,
    policyDecision
  };
}

export function formatHermesPlan(plan) {
  const lines = [
    'Hermes plan',
    `Recommended pipeline: ${plan.pipeline}`,
    `Recommended agent: ${plan.agent}`,
    `Requires approval: ${plan.requiresApproval}`,
    `Validation: ${plan.validation}`,
    `Reason: ${plan.reason}`,
    `Source: ${plan.source}`
  ];

  if (plan.policyDecision) {
    lines.push(`Policy: ${plan.policyDecision.allowed ? 'allowed' : 'requires_approval'} (${plan.policyDecision.reason})`);
  }

  if ((plan.memoryEvidence || []).length > 0) {
    lines.push('Memory evidence:');
    for (const evidence of plan.memoryEvidence) {
      if (evidence.type === 'similar_run') {
        const feedback = evidence.feedback ? ` feedback=${evidence.feedback.rating}` : '';
        lines.push(`- similar run ${evidence.runId}: ${evidence.pipeline}->${evidence.completedPipeline} ${evidence.status}${feedback}`);
      } else {
        lines.push(`- ${evidence.signal}: ${evidence.count}`);
      }
    }
  }

  lines.push('', 'Decision JSON:', JSON.stringify(plan, null, 2));
  return lines.join('\n');
}
