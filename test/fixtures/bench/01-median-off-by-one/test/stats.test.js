import assert from 'node:assert/strict';
import { median, percentile } from '../src/stats.js';

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(median([10, 20]), 15);
assert.equal(median([]), null);
assert.equal(median([5]), 5);

assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
assert.equal(percentile([], 0.5), null);

console.log('stats tests passed');
