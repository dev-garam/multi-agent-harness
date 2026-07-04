import assert from 'node:assert/strict';
import { selectPipeline } from '../src/pipeline-selection.js';

const harnessConfig = {
  defaultPipeline: 'code_fix',
  pipelines: {
    quick_fix: {},
    code_fix: {},
    safe_fix: {},
    review_only: {}
  }
};

const explicit = selectPipeline({
  request: 'README 수정',
  requestedPipeline: 'code_fix',
  harnessConfig
});
assert.equal(explicit.mode, 'explicit');
assert.equal(explicit.selected, 'code_fix');

const simple = selectPipeline({
  request: 'README 문구를 정리해줘',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.equal(simple.selected, 'quick_fix');

const complex = selectPipeline({
  request: 'pipeline runtime policy 구현',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.equal(complex.selected, 'code_fix');
assert.ok(complex.complexityScore >= 3);

const risky = selectPipeline({
  request: '인증 토큰 마이그레이션 수정',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.equal(risky.selected, 'safe_fix');
assert.ok(risky.riskScore >= 3);

const review = selectPipeline({
  request: '이번 변경을 리뷰만 해줘',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.equal(review.selected, 'review_only');

console.log('pipeline selection tests passed');
