import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { harnessRoot } from './fs-utils.js';

function parseRunTimestamp(name) {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})_(?<time>\d{6})(?:_(?<ms>\d{3}))?$/.exec(name);
  if (!match) {
    return null;
  }

  const time = match.groups.time;
  const ms = match.groups.ms || '000';
  return new Date(`${match.groups.date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${ms}`);
}

async function listRunIds(runsDir) {
  const entries = await readdir(runsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.trash' && parseRunTimestamp(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readManifest(runsDir, runId) {
  try {
    const text = await readFile(path.join(runsDir, runId, 'manifest.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeStep(step) {
  if (step.type === 'validation') {
    return `[validation] ${step.stepId} ${step.status}${step.exitCode === undefined ? '' : ` exit=${step.exitCode}`}`;
  }

  return `[step] ${step.stepId} ${step.status}${step.agent ? ` agent=${step.agent}` : ''}`;
}

function summarizeDecision(decision) {
  const target = decision.targetStep ? ` target=${decision.targetStep}` : '';
  const reason = decision.reason ? ` reason="${decision.reason}"` : '';
  return `[hermes] ${decision.nextAction} status=${decision.status}${target}${reason}`;
}

function summarizePipelineChange(change) {
  const reason = change.reason ? ` reason="${change.reason}"` : '';
  return `[pipeline] ${change.from} -> ${change.to}${reason}`;
}

function renderManifestEvents(manifest, state) {
  const events = [];
  const previous = state.get(manifest.runId) || {
    steps: 0,
    decisions: 0,
    pipelineChanges: 0,
    status: null,
    seen: false
  };

  if (!previous.seen) {
    events.push(`[run] ${manifest.runId} pipeline=${manifest.pipeline} repo=${manifest.repo}`);
  }

  const steps = manifest.steps || [];
  for (const step of steps.slice(previous.steps)) {
    events.push(summarizeStep(step));
  }

  const decisions = manifest.supervisorDecisions || [];
  for (const decision of decisions.slice(previous.decisions)) {
    events.push(summarizeDecision(decision));
  }

  const pipelineChanges = manifest.pipelineChanges || [];
  for (const change of pipelineChanges.slice(previous.pipelineChanges)) {
    events.push(summarizePipelineChange(change));
  }

  if (manifest.status && manifest.status !== previous.status) {
    events.push(`[done] ${manifest.runId} status=${manifest.status}`);
  }

  state.set(manifest.runId, {
    steps: steps.length,
    decisions: decisions.length,
    pipelineChanges: pipelineChanges.length,
    status: manifest.status || previous.status,
    seen: true
  });

  return events;
}

async function scanRuns({ runsDir, state, includeExisting = false }) {
  const events = [];
  const runIds = await listRunIds(runsDir);

  for (const runId of runIds) {
    const manifest = await readManifest(runsDir, runId);
    if (!manifest) {
      continue;
    }

    if (!includeExisting && !state.has(runId)) {
      state.set(runId, {
        steps: (manifest.steps || []).length,
        decisions: (manifest.supervisorDecisions || []).length,
        pipelineChanges: (manifest.pipelineChanges || []).length,
        status: manifest.status || null,
        seen: true
      });
      continue;
    }

    events.push(...renderManifestEvents(manifest, state));
  }

  return events;
}

export async function runWatch({ interval = 1000, once = false, includeExisting = false } = {}) {
  const runsDir = path.join(harnessRoot, 'runs');
  const state = new Map();
  const intervalMs = Math.max(250, Number(interval) || 1000);

  console.log(`Watching ${runsDir}`);
  console.log(`Polling every ${intervalMs}ms. Press Ctrl-C to stop.`);

  const printEvents = async (showExisting) => {
    const events = await scanRuns({ runsDir, state, includeExisting: showExisting });
    for (const event of events) {
      console.log(event);
    }
  };

  await printEvents(includeExisting);

  if (once) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      printEvents(true).catch((error) => {
        console.error(`[watch] ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);

    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log('\nStopped watching runs.');
      resolve();
    });
  });
}
