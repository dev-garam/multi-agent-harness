#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'demos', 'showcase');
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-showcase-'));

fs.cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}.git${path.sep}`)
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: target,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
}

run('git', ['init', '-b', 'main']);
run('git', ['config', 'user.email', 'showcase@example.com']);
run('git', ['config', 'user.name', 'Harness Showcase']);
run('git', ['add', '.']);
run('git', ['commit', '-m', 'init showcase demo']);

console.log(target);
console.error('');
console.error('Showcase demo repo ready.');
console.error(`DEMO_REPO=${target}`);
console.error('');
console.error('Try:');
console.error(`node ./bin/harness run --repo "${target}" --pipeline quick_fix --agent mock --workspace-mode patch "데모 문구를 생성해줘"`);
