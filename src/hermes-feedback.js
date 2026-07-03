import path from 'node:path';
import { ensureDir, harnessRoot, writeText } from './fs-utils.js';

function feedbackRoot() {
  return path.join(harnessRoot, '.harness', 'feedback');
}

async function writeJson(filePath, value) {
  await writeText(filePath, JSON.stringify(value, null, 2) + '\n');
}

async function feedbackPath(runId) {
  await ensureDir(feedbackRoot());
  return path.join(feedbackRoot(), `${runId}.json`);
}

export async function writeFeedback({ runId, rating, note }) {
  if (!runId) {
    throw new Error('Missing --run for `harness hermes feedback`.');
  }
  if (!rating) {
    throw new Error('Missing --rating for `harness hermes feedback`.');
  }

  const feedback = {
    schemaVersion: 1,
    runId,
    rating,
    note: note || '',
    createdAt: new Date().toISOString()
  };
  await writeJson(await feedbackPath(runId), feedback);
  return feedback;
}

export function formatFeedback(feedback) {
  return [
    'Hermes feedback',
    `Run: ${feedback.runId}`,
    `Rating: ${feedback.rating}`,
    `Note: ${feedback.note || '(none)'}`
  ].join('\n');
}
