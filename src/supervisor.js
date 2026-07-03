const SUPERVISOR_ACTIONS = new Set([
  'continue',
  'run_validation',
  'escalate_to_safe_fix',
  'rerun_step',
  'stop_failed',
  'request_human_review'
]);

const SUPERVISOR_STATUSES = new Set([
  'success',
  'success_with_risks',
  'failed',
  'incomplete'
]);

function supervisorDecisionError(message, value = {}) {
  return {
    status: 'incomplete',
    nextAction: 'request_human_review',
    targetStep: null,
    reason: message,
    instructions: 'Tell the user that Hermes returned an invalid supervisor decision and human review is required.',
    valid: false,
    schemaErrors: [message],
    rawDecision: value
  };
}

export function normalizeSupervisorDecision(value) {
  if (!value || typeof value !== 'object') {
    return supervisorDecisionError('Supervisor decision must be a JSON object.', value);
  }

  const nextAction = String(value.nextAction || value.action || '').trim();
  if (!SUPERVISOR_ACTIONS.has(nextAction)) {
    return supervisorDecisionError(`Unsupported supervisor nextAction: ${nextAction || '(missing)'}.`, value);
  }

  const status = String(value.status || 'incomplete').trim();
  if (!SUPERVISOR_STATUSES.has(status)) {
    return supervisorDecisionError(`Unsupported supervisor status: ${status || '(missing)'}.`, value);
  }

  const targetStep = value.targetStep === null || value.targetStep === undefined
    ? null
    : String(value.targetStep).trim();

  if (nextAction === 'rerun_step' && !targetStep) {
    return supervisorDecisionError('rerun_step requires targetStep.', value);
  }

  return {
    status,
    nextAction,
    targetStep: targetStep || null,
    reason: String(value.reason || '').trim(),
    instructions: String(value.instructions || '').trim(),
    valid: true,
    schemaErrors: []
  };
}

export function parseSupervisorDecision(output) {
  const fencedBlocks = [...String(output).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let index = fencedBlocks.length - 1; index >= 0; index -= 1) {
    try {
      return normalizeSupervisorDecision(JSON.parse(fencedBlocks[index][1]));
    } catch {
      // Keep scanning earlier blocks. Hermes may include example JSON before the final decision.
    }
  }

  return {
    status: 'incomplete',
    nextAction: 'request_human_review',
    targetStep: null,
    reason: 'Hermes did not return a parseable supervisor decision JSON block.',
    instructions: 'Tell the user that the run needs human review because the supervisor decision could not be parsed.',
    valid: false,
    schemaErrors: ['No parseable supervisor decision JSON block found.']
  };
}

export function appendSupervisorInstructions(previousOutputs, decision) {
  return `${previousOutputs}\n\n## hermes decision for ${decision.targetStep || 'reporter'}\n` +
    `status: ${decision.status}\n` +
    `nextAction: ${decision.nextAction}\n` +
    `reason: ${decision.reason || '(none)'}\n` +
    `instructions: ${decision.instructions || '(none)'}`;
}
