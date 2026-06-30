import path from 'node:path';
import { harnessRoot, readText } from './fs-utils.js';

export async function renderPrompt(step, context) {
  const templatePath = path.join(harnessRoot, step.prompt);
  const template = await readText(templatePath);
  const projectConfig = JSON.stringify(context.projectConfig || {}, null, 2);
  const validationCommands = (context.validationCommands || [])
    .map((entry) => `- ${entry.id}: ${entry.command}`)
    .join('\n') || '(none)';
  const supervisorInstructions = context.supervisorInstructions || '(none)';

  return template
    .replaceAll('{{REQUEST}}', context.request)
    .replaceAll('{{REPO}}', context.repo)
    .replaceAll('{{PROJECT_CONFIG}}', projectConfig)
    .replaceAll('{{VALIDATION_COMMANDS}}', validationCommands)
    .replaceAll('{{SUPERVISOR_INSTRUCTIONS}}', supervisorInstructions)
    .replaceAll('{{PREVIOUS_OUTPUTS}}', context.previousOutputs || '(none)');
}
