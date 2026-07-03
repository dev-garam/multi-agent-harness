# Agent Harness Gap Review

Source: [LangChain - How to Build a Custom Agent Harness](https://www.langchain.com/blog/how-to-build-a-custom-agent-harness), published 2026-06-03.

이 문서는 LangChain의 custom agent harness 관점으로 Multi Agent Harness의 현재 상태를 점검하고, 앞으로 개발이 필요한 항목을 정리한다.

## LangChain 글의 핵심 기준

LangChain 글에서 하네스는 모델을 실제 환경과 연결하는 scaffolding이다. 핵심은 모델이 매 단계 필요한 context를 받도록 만들고, agent loop 주변에 middleware를 붙여 정책, 도구, 상태, 스트림, 비용, 재시도, memory를 통제하는 것이다.

글에서 강조하는 주요 축은 다음과 같다.

- Base harness: model, tools, system prompt, agent loop
- Middleware hooks: agent 시작/종료, model 호출 전후, tool 호출 전후
- Deterministic logic: prompt에만 맡기면 안 되는 정책, business rule, runtime control
- Tool lifecycle: tool setup, teardown, registration을 한곳에서 관리
- Custom state: run 동안 유지되는 counter, flag, shared state
- Stream handlers: token/event stream 필터링, metadata 주입, audit/monitoring routing
- Context management: summarization, context editing, overflow 방지
- Memory: 필요한 지식을 불러오고 실행 후 다시 쓰는 구조
- Environment action: filesystem, shell, code execution, sandbox
- Delegation: subagent, async subagent, todo list
- Retry/fallback: model/tool retry, backoff, fallback model
- Policy/HITL: PII, compliance, approval gate, interrupt
- Cost control: model/tool call limit, prompt caching

## 현재 이미 강한 부분

현재 Multi Agent Harness는 일반적인 "model + tool loop"보다는 coding CLI agent를 파이프라인 계약으로 감싸는 하네스에 가깝다. LangChain 기준으로 보면 다음은 이미 강하다.

- Agent adapter: Codex, Claude, Antigravity, custom CLI를 같은 계약으로 실행한다.
- Pipeline orchestration: planner, coder, qa, verifier, hermes, reporter 역할 분리가 있다.
- Runtime environment: local runner와 optional Docker runner가 있다.
- Workspace isolation: direct, worktree, patch mode가 있다.
- Validation: build/test/validation command를 하네스가 직접 실행한다.
- Policy/HITL: protected branch, destructive request, approval pending, approve/reject 흐름이 있다.
- Memory: runs 기반 Hermes memory rebuild/search가 있다.
- Feedback loop: feedback, promotion, report가 있다.
- Observability: manifest, prompt/stdout/stderr, show/watch/report가 있다.
- Resource control: timeout, max log size, cancellation 기록이 있다.
- Recovery: Hermes가 validation rerun, step rerun, safe_fix escalation, human review를 결정할 수 있다.

## 부족하거나 약한 부분

### 1. Middleware Hook System

현재 파이프라인 단계는 고정된 runner 흐름 안에 있고, LangChain식 middleware처럼 "before_agent", "before_model", "wrap_model_call", "wrap_tool_call", "after_agent" 같은 확장 지점이 없다.

개발 필요:

- `src/middleware.js` 같은 hook registry 추가
- run 시작 전/후 hook
- step 실행 전/후 hook
- validation 실행 전/후 hook
- Hermes decision 전/후 hook
- hook 결과를 manifest에 기록

우선순위: 높음

### 2. Tool Lifecycle

현재 provider CLI와 validation command는 실행할 수 있지만, tool을 등록하고 setup/teardown하는 계층은 약하다. MCP server, shell session, browser, external API 같은 도구를 하네스가 life cycle 단위로 관리하지 않는다.

개발 필요:

- tool registry schema
- tool setup/teardown contract
- tool별 env allowlist
- tool별 timeout/log policy
- tool 실행 기록 artifact
- 실패한 tool cleanup 보장

우선순위: 높음

### 3. Context Management

현재 prompt template과 이전 step output 주입은 있지만, 긴 실행에서 context overflow를 관리하는 summarization/compaction 계층은 없다. memory도 run 이후 검색 중심이지, 현재 run의 context window를 동적으로 관리하지는 않는다.

개발 필요:

- step output summarizer
- verbose log/context offloading
- context budget 설정
- 중요 artifact만 다음 step에 주입
- Hermes memory와 현재 run context의 분리

우선순위: 높음

### 4. Custom State

manifest는 최종 기록으로는 좋지만, 실행 중 middleware와 step들이 공유하는 mutable state store는 명확하지 않다.

개발 필요:

- run state object
- step-local state와 run-global state 구분
- state schema validation
- state snapshot artifact
- middleware가 state를 읽고 쓰는 규칙

우선순위: 중간

### 5. Stream Handling

현재 stdout/stderr 로그와 watch polling은 있지만, agent event stream을 실시간으로 필터링하거나 routing하는 구조는 제한적이다.

개발 필요:

- event bus
- model/tool/validation/Hermes event type 표준화
- stream consumer adapter
- audit log consumer
- UI/terminal consumer 분리
- secret redaction stream filter

우선순위: 중간

### 6. Retry, Backoff, Fallback

Hermes의 step rerun은 있지만, LangChain 글에서 말하는 model/tool retry middleware처럼 transient failure에 대한 backoff, provider fallback, tool retry 정책은 아직 약하다.

개발 필요:

- provider fallback list
- retryable error classifier
- exponential backoff
- validation retry와 agent retry 분리
- fallback 발생 기록
- `.harness.json` retry schema

우선순위: 높음

### 7. Cost Control

현재 timeout/log limit은 있지만 model call count, tool call count, token/cost budget, prompt caching은 없다. CLI provider를 감싸는 구조라 정확한 token 측정은 어렵지만, 하네스 차원의 budget gate는 가능하다.

개발 필요:

- max step count
- max provider calls
- max validation runs
- run budget config
- prompt cache artifact 또는 static context reuse
- provider별 usage parser가 가능한 경우 usage 기록

우선순위: 중간

### 8. PII/Secret Policy

현재 secret 후보 scan은 change inspection 중심이다. LangChain 글의 PII middleware 관점처럼 model input/output/tool output 전 구간에서 deterministic redaction을 수행하는 계층은 약하다.

개발 필요:

- prompt 생성 전 secret/PII scan
- stdout/stderr 저장 전 redaction option
- reporter output redaction
- policy violation severity
- block/mask/hash modes

우선순위: 높음

### 9. Delegation And Todo State

현재 multi-step pipeline은 있지만, agent가 동적으로 subagent에게 하위 작업을 위임하거나 todo list를 유지하는 구조는 없다. 하네스가 미리 정의한 단계는 실행하지만, 작업 중 새 하위 작업을 생성/추적하는 방식은 약하다.

개발 필요:

- subtask schema
- todo artifact
- dynamic child task enqueue
- subagent role config
- parent/child run linkage

우선순위: 중간

### 10. Evaluation Layer

현재 validation은 프로젝트 명령 중심이고, reporter/verifier/Hermes 판단은 있지만, 하네스 자체의 품질을 eval set으로 반복 측정하는 계층은 없다.

개발 필요:

- fixture repo 기반 eval cases
- expected manifest assertions
- expected policy decisions
- regression score
- before/after harness change comparison

우선순위: 중간

## 추천 개발 순서

### Phase A. Middleware Foundation

목표: 하네스 내부 주요 지점에 hook을 만들고, hook 결과를 manifest에 남긴다.

작업:

1. middleware hook interface 정의
2. runner에 run/step/validation/Hermes hook 삽입
3. built-in no-op middleware 추가
4. middleware 결과 manifest 기록
5. middleware unit test 추가

### Phase B. Context And Redaction

목표: 모델과 CLI agent에 들어가고 나오는 context를 하네스가 통제한다.

작업:

1. prompt/input redaction middleware
2. output redaction middleware
3. step output summarizer
4. context budget config
5. verbose output artifact offloading

### Phase C. Retry And Fallback

목표: 일시적 실패를 deterministic policy로 복구한다.

작업:

1. retry config schema
2. retryable error classifier
3. provider fallback list
4. backoff 실행
5. retry/fallback manifest 기록

### Phase D. Tool Lifecycle

목표: provider CLI 외부의 도구를 setup/teardown 가능한 실행 단위로 관리한다.

작업:

1. tool registry schema
2. setup/teardown lifecycle
3. tool env allowlist
4. tool event logging
5. cleanup failure handling

### Phase E. Budget And Eval

목표: 하네스 비용과 품질을 지속적으로 관리한다.

작업:

1. run budget schema
2. model/tool/validation call limits
3. provider usage parser
4. eval fixture repo
5. regression score report

## 결론

현재 하네스는 "coding CLI agent를 관찰 가능하고 검증 가능한 파이프라인으로 감싸는 구조"는 꽤 잘 갖췄다. LangChain 글 기준으로 다음 단계의 핵심은 pipeline을 더 늘리는 것이 아니라, pipeline 주변에 조합 가능한 middleware layer를 만드는 것이다.

가장 먼저 해야 할 일은 middleware foundation, context/redaction, retry/fallback이다. 이 셋이 들어오면 지금의 Hermes memory, policy, validation, manifest 구조가 더 자연스럽게 연결된다.
