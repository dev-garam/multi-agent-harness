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

// 작성 의도가 있으면 리뷰 키워드('inspect')가 섞여도 review_only 로 가지 않는다.
// (dogfooding에서 "inspection 테스트 작성"이 review_only 로 오분류되던 문제)
const writeWithReviewWord = selectPipeline({
  request: 'inspection 보안 모듈 테스트를 작성한다',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.notEqual(writeWithReviewWord.selected, 'review_only', 'write intent overrides review keyword');

// 순수 리뷰 요청은 여전히 review_only 로 남는다.
const pureReview = selectPipeline({
  request: '코드를 검토만 해줘',
  requestedPipeline: 'auto',
  harnessConfig
});
assert.equal(pureReview.selected, 'review_only');

console.log('pipeline selection tests passed');
