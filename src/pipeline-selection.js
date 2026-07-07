const REVIEW_KEYWORDS = [
  'review',
  'audit',
  'inspect',
  '검토',
  '리뷰',
  '확인만'
];

// 작성/변경 의도 신호. 이 신호가 있으면 리뷰 키워드가 섞여 있어도
// review_only(코드 미작성)로 분류하지 않는다. (예: "inspection 테스트를 작성"에서
// 'inspect'가 매칭되어 작성 요청이 리뷰로 오분류되던 문제를 방지)
const WRITE_KEYWORDS = [
  'write',
  'create',
  'add',
  'implement',
  'generate',
  'scaffold',
  '작성',
  '생성',
  '추가',
  '구현',
  '만들'
];

const RISK_SIGNALS = [
  ['auth', 3],
  ['authentication', 3],
  ['authorization', 3],
  ['login', 3],
  ['token', 3],
  ['session', 3],
  ['jwt', 3],
  ['oauth', 3],
  ['payment', 3],
  ['billing', 3],
  ['subscription', 3],
  ['invoice', 3],
  ['security', 3],
  ['secret', 3],
  ['credential', 3],
  ['api key', 3],
  ['delete', 3],
  ['drop', 3],
  ['truncate', 3],
  ['migration', 3],
  ['schema migration', 3],
  ['production', 2],
  ['deploy', 2],
  ['docker', 2],
  ['terraform', 2],
  ['kubernetes', 2],
  ['postgres', 2],
  ['redis', 2],
  ['인증', 3],
  ['인가', 3],
  ['결제', 3],
  ['보안', 3],
  ['삭제', 3],
  ['마이그레이션', 3],
  ['운영', 2],
  ['배포', 2]
];

const COMPLEXITY_SIGNALS = [
  ['architecture', 2],
  ['refactor', 2],
  ['runtime', 2],
  ['pipeline', 2],
  ['middleware', 2],
  ['policy', 2],
  ['runner', 2],
  ['workspace', 2],
  ['manifest', 1],
  ['schema', 1],
  ['config', 1],
  ['implement', 1],
  ['support', 1],
  ['integrate', 1],
  ['test fail', 1],
  ['validation', 1],
  ['구조', 2],
  ['아키텍처', 2],
  ['리팩토링', 2],
  ['런타임', 2],
  ['파이프라인', 2],
  ['정책', 2],
  ['구현', 1],
  ['추가', 1],
  ['연동', 1],
  ['테스트', 1],
  ['검증', 1],
  ['전체', 1],
  ['일괄', 1],
  ['순차', 1]
];

const SIMPLE_SIGNALS = [
  'readme',
  'docs',
  'document',
  'typo',
  'copy',
  'comment',
  'help text',
  '문서',
  '오타',
  '문구',
  '설명',
  '주석',
  '도움말'
];

function includesSignal(normalized, signal) {
  return normalized.includes(signal.toLowerCase());
}

function scoreSignals(normalized, entries) {
  const signals = [];
  let score = 0;
  for (const [signal, weight] of entries) {
    if (includesSignal(normalized, signal)) {
      signals.push(signal);
      score += weight;
    }
  }
  return { score, signals };
}

function simpleSignals(normalized) {
  return SIMPLE_SIGNALS.filter((signal) => includesSignal(normalized, signal));
}

function pipelineSelectionConfig(projectConfig = {}) {
  const config = projectConfig.pipelineSelection || {};
  return {
    mode: config.mode || 'deterministic',
    defaultPipeline: config.defaultPipeline || 'quick_fix',
    riskThreshold: Number.isFinite(Number(config.riskThreshold)) ? Number(config.riskThreshold) : 3,
    complexityThreshold: Number.isFinite(Number(config.complexityThreshold)) ? Number(config.complexityThreshold) : 3
  };
}

export function selectPipeline({ request = '', requestedPipeline = null, projectConfig = {}, harnessConfig = {} } = {}) {
  const configured = pipelineSelectionConfig(projectConfig);
  const available = harnessConfig.pipelines || {};

  if (requestedPipeline && requestedPipeline !== 'auto') {
    return {
      mode: 'explicit',
      selected: requestedPipeline,
      requested: requestedPipeline,
      defaultPipeline: configured.defaultPipeline,
      riskScore: 0,
      complexityScore: 0,
      signals: [],
      reason: 'Pipeline was explicitly selected.'
    };
  }

  const normalized = String(request || '').toLowerCase();
  const reviewSignals = REVIEW_KEYWORDS.filter((signal) => includesSignal(normalized, signal));
  const writeSignals = WRITE_KEYWORDS.filter((signal) => includesSignal(normalized, signal));
  const risk = scoreSignals(normalized, RISK_SIGNALS);
  const complexity = scoreSignals(normalized, COMPLEXITY_SIGNALS);
  const simple = simpleSignals(normalized);

  let selected = configured.defaultPipeline;
  let reason = 'Selected default pipeline.';

  if (reviewSignals.length > 0 && writeSignals.length === 0 && available.review_only) {
    selected = 'review_only';
    reason = 'Request looks like review-only work.';
  } else if (risk.score >= configured.riskThreshold && available.safe_fix) {
    selected = 'safe_fix';
    reason = 'Risk score exceeded threshold.';
  } else if (complexity.score >= configured.complexityThreshold && available.code_fix) {
    selected = 'code_fix';
    reason = 'Complexity score exceeded threshold.';
  } else if (simple.length > 0 && available.quick_fix) {
    selected = 'quick_fix';
    reason = 'Request looks like a small scoped change.';
  }

  if (!available[selected]) {
    selected = harnessConfig.defaultPipeline || configured.defaultPipeline;
    reason = 'Selected pipeline was unavailable; fell back to configured default.';
  }

  return {
    mode: configured.mode,
    selected,
    requested: requestedPipeline || null,
    defaultPipeline: configured.defaultPipeline,
    riskScore: risk.score,
    complexityScore: complexity.score,
    signals: [...reviewSignals, ...risk.signals, ...complexity.signals, ...simple],
    thresholds: {
      risk: configured.riskThreshold,
      complexity: configured.complexityThreshold
    },
    reason
  };
}
