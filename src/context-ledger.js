/**
 * ContextLedger는 파이프라인이 다음 스텝에 넘기는 컨텍스트를 하나의 누적 문자열이
 * 아니라 섹션 목록으로 관리한다.
 *
 * 기존 구조는 `previousOutputs`에 모든 스텝 출력을 무조건 이어붙여 매 스텝마다
 * 전부 다시 전송했다. 스텝 수에 대해 O(N^2)이고, 실측한 safe_fix run에서는
 * 프롬프트 전송 총합 109KB 중 71%가 중복 재전송이었다.
 *
 * 섹션 단위로 들고 있으면 역할별로 필요한 것만 골라 렌더링할 수 있다. 다만
 * 무엇을 빼도 되는지는 역할마다 다르고 잘못 빼면 판단 품질이 떨어지므로,
 * 선별은 옵트인(`context.selection.enabled`)이고 기본값은 기존 동작이다.
 */

/** 렌더링 대상 섹션 종류. */
export const CONTEXT_KINDS = [
  'agent',
  'validation',
  'inspection',
  'usage',
  'supervisor',
  'note'
];

/**
 * 역할별 컨텍스트 정책. 값이 없는 역할은 전체를 받는다(선별하지 않는다).
 *
 * 근거는 각 역할의 프롬프트(`prompts/*.md`)에 적힌 요구사항이다.
 * - verifier: "planner, coder, QA, reviewer 출력에서 주장을 추출하라"고 명시하므로
 *   앞 단계 원문이 전부 필요하다. 선별 대상이 아니다.
 * - hermes: 감독이 역할이라 모든 증거가 필요하다. 선별 대상이 아니다.
 * - planner / reviewer: 파이프라인 첫 스텝이라 앞 출력이 없다.
 */
export const DEFAULT_ROLE_POLICY = {
  // "Use the planner output as guidance" — 계획과 검증 결과면 충분하다.
  // 재실행 시 뒤 단계(qa/verifier/hermes) 원문은 필요 없고, hermes 지시는
  // supervisor 섹션과 {{SUPERVISOR_INSTRUCTIONS}}로 따로 전달된다.
  coder: {
    agentSteps: ['planner'],
    kinds: ['validation', 'inspection', 'supervisor', 'note']
  },
  // "Review the current diff and relevant test results" — 계획·구현·검증 근거.
  qa: {
    agentSteps: ['planner', 'coder'],
    kinds: ['validation', 'inspection', 'supervisor', 'note']
  },
  // "If Hermes output exists, use it as the final supervision gate" — hermes가
  // 이미 앞 단계를 종합했으므로 planner/coder/qa 원문을 다시 넣지 않는다.
  // usage 섹션은 "Harness usage" 절을 쓰기 위해 반드시 유지한다.
  reporter: {
    agentSteps: ['hermes', 'verifier'],
    kinds: ['validation', 'inspection', 'usage', 'supervisor', 'note']
  }
};

export function contextSelectionFromProjectConfig(projectConfig = {}) {
  const selection = projectConfig.context?.selection || {};
  return {
    // 안전 기본값: 명시적으로 true를 준 경우에만 선별한다(기본은 기존 동작).
    enabled: selection.enabled === true,
    mode: selection.mode || 'role-aware'
  };
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return null;
  }
  return {
    agentSteps: Array.isArray(policy.agentSteps) ? policy.agentSteps.map(String) : [],
    kinds: Array.isArray(policy.kinds) ? policy.kinds.map(String) : []
  };
}

export class ContextLedger {
  constructor({ selection = { enabled: false }, rolePolicy = DEFAULT_ROLE_POLICY } = {}) {
    this.selection = selection;
    this.rolePolicy = rolePolicy || {};
    this.sections = [];
  }

  /**
   * 섹션 하나를 추가한다.
   * text는 렌더링될 본문 전체(제목 줄 포함)이며, 기존 누적 포맷을 그대로 담는다.
   */
  push({ kind, text, baseStepId = null, stepId = null }) {
    if (!CONTEXT_KINDS.includes(kind)) {
      throw new Error(`Unknown context section kind: ${kind}`);
    }
    if (text === null || text === undefined) {
      return this;
    }
    this.sections.push({ kind, text: String(text), baseStepId, stepId });
    return this;
  }

  /** 역할 정책상 이 섹션이 대상 스텝에 필요한지 판단한다. */
  #isRelevant(section, policy) {
    if (section.kind === 'agent') {
      return policy.agentSteps.includes(String(section.baseStepId));
    }
    return policy.kinds.includes(section.kind);
  }

  /**
   * 대상 스텝에 넣을 컨텍스트를 문자열로 만든다.
   *
   * 선별이 꺼져 있거나 해당 역할 정책이 없으면 전체를 그대로 렌더링한다.
   * 이때 결과는 기존 누적 문자열과 바이트 단위로 동일하다(선행 "\n\n" 포함).
   */
  render(baseStepId = null) {
    return this.#renderSections(this.#selectSections(baseStepId));
  }

  #renderSections(sections) {
    return sections.map((section) => `\n\n${section.text}`).join('');
  }

  #selectSections(baseStepId) {
    if (!this.selection.enabled || !baseStepId) {
      return this.sections;
    }
    const policy = normalizePolicy(this.rolePolicy[baseStepId]);
    if (!policy) {
      return this.sections;
    }
    return this.sections.filter((section) => this.#isRelevant(section, policy));
  }

  /** 선별로 얼마나 줄었는지. manifest/이벤트 기록용. */
  stats(baseStepId = null) {
    const all = this.sections;
    const selected = this.#selectSections(baseStepId);
    const fullBytes = Buffer.byteLength(this.#renderSections(all));
    const selectedBytes = Buffer.byteLength(this.#renderSections(selected));
    return {
      stepId: baseStepId,
      applied: selected.length !== all.length,
      totalSections: all.length,
      selectedSections: selected.length,
      fullBytes,
      selectedBytes,
      savedBytes: fullBytes - selectedBytes
    };
  }
}
