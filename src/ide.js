import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { harnessRoot } from './fs-utils.js';

const taskLabel = 'Harness: Run';
const inputId = 'harnessRequest';

export async function installIdeTask(repo) {
  const vscodeDir = path.join(repo, '.vscode');
  const tasksPath = path.join(vscodeDir, 'tasks.json');
  await mkdir(vscodeDir, { recursive: true });

  let tasks = { version: '2.0.0', tasks: [] };
  try {
    tasks = JSON.parse(await readFile(tasksPath, 'utf8'));
    if (!Array.isArray(tasks.tasks)) {
      tasks.tasks = [];
    }
    if (!Array.isArray(tasks.inputs)) {
      tasks.inputs = [];
    }
  } catch {
  }

  const harnessBin = path.join(harnessRoot, 'bin', 'harness');
  const command = `"${harnessBin}" run --repo "\${workspaceFolder}" "\${input:${inputId}}"`;
  const nextTask = {
    label: taskLabel,
    type: 'shell',
    command,
    problemMatcher: []
  };

  const existingIndex = tasks.tasks.findIndex((task) => task.label === taskLabel);
  if (existingIndex >= 0) {
    tasks.tasks[existingIndex] = nextTask;
  } else {
    tasks.tasks.push(nextTask);
  }

  const nextInput = {
    id: inputId,
    type: 'promptString',
    description: 'Harness request'
  };
  const existingInputIndex = tasks.inputs.findIndex((input) => input.id === inputId);
  if (existingInputIndex >= 0) {
    tasks.inputs[existingInputIndex] = nextInput;
  } else {
    tasks.inputs.push(nextInput);
  }

  await writeFile(tasksPath, JSON.stringify(tasks, null, 2) + '\n');
  return tasksPath;
}
