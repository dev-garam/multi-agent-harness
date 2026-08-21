import assert from 'node:assert/strict';
import { captureOutput } from '../src/capture.js';
import { parseStatusLines } from '../src/parse.js';

// Real output of a status command. A leading space is significant: it means the
// change is in the working tree rather than staged.
const RAW = ' M README.md\n M src/app.js\n?? .env\nA  staged.txt\n';

const parsed = parseStatusLines(captureOutput(RAW));

assert.deepEqual(
  parsed.map((entry) => entry.path),
  ['README.md', 'src/app.js', '.env', 'staged.txt']
);
assert.deepEqual(
  parsed.map((entry) => entry.status),
  ['M', 'M', '??', 'A']
);

// A single working-tree change must survive too.
const single = parseStatusLines(captureOutput(' M only.js\n'));
assert.deepEqual(single, [{ status: 'M', path: 'only.js' }]);

console.log('parse tests passed');
