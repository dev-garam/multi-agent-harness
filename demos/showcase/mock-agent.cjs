const fs = require('fs');

const stepId = process.argv[2];
const finalPath = process.argv[3];
const fence = String.fromCharCode(96, 96, 96);
const logPath = '.mock-steps.log';
const statePath = '.mock-state.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

state[stepId] = (state[stepId] || 0) + 1;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
fs.appendFileSync(logPath, `${stepId}\n`);

function markdownJson(title, value) {
  return `# ${title}\n\n${fence}json\n${JSON.stringify(value, null, 2)}\n${fence}\n`;
}

let body = `# ${stepId}\n\nMock agent completed ${stepId}.\n`;

if (stepId === 'coder') {
  fs.writeFileSync('demo-output.txt', [
    'created by the harness showcase mock agent',
    `step=${stepId}`,
    `time=${new Date().toISOString()}`,
    ''
  ].join('\n'));
  body = `# ${stepId}\n\nCreated demo-output.txt.\n`;
}

if (stepId.startsWith('hermes')) {
  body = markdownJson(stepId, {
    status: 'success',
    nextAction: 'continue',
    targetStep: null,
    reason: 'mock supervisor accepted the demo run',
    instructions: 'continue to reporter'
  });
}

if (stepId.startsWith('reporter')) {
  body = markdownJson(stepId, {
    status: 'success',
    summary: 'showcase demo completed with mock agent',
    changedFiles: ['demo-output.txt'],
    validation: ['demo-output-exists'],
    risks: []
  });
}

fs.writeFileSync(finalPath, body);
