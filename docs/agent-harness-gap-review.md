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

Status: baseline implemented

목표: 하네스 내부 주요 지점에 hook을 만들고, hook 결과를 manifest에 남긴다.

작업:

1. Done: `src/middleware.js` hook/state/event runtime 추가
2. Done: runner에 run/step/validation/Hermes hook 삽입
3. Done: built-in runtime summary를 `manifest.middleware`에 기록
4. Done: middleware state counter와 event stream 기록
5. Done: `test/middleware.test.js` 추가

### Phase B. Context And Redaction

Status: implemented

목표: 모델과 CLI agent에 들어가고 나오는 context를 하네스가 통제한다.

작업:

1. Done: prompt/input redaction runtime 추가
2. Done: agent/validation/tool stdout/stderr redaction 연결
3. Done: step output context trimming 추가
4. Done: `context.maxPreviousOutputBytes`, `context.maxStepOutputBytes` schema 추가
5. Done: `context.summarizer` 기반 deterministic head/tail compaction 추가

메모: 실제 model summarizer 호출은 비용과 provider 부작용이 있으므로 기본 실행 경로에는 넣지 않았다. `mode: "model"`은 설정 의도를 manifest에 남길 수 있게 열어두되, 현재 구현은 deterministic compaction을 안전 기본값으로 사용한다.

### Phase C. Retry And Fallback

Status: implemented

목표: 일시적 실패를 deterministic policy로 복구한다.

작업:

1. Done: `retry` config schema 추가
2. Done: agent/validation retry count와 backoff 실행
3. Done: provider fallback list 지원
4. Done: retry/fallback event를 `manifest.middleware.events`에 기록
5. Done: `retryOnExitCodes`, `retryOnStderrPatterns` 기반 retryable classifier 추가

### Phase D. Tool Lifecycle

Status: implemented

목표: provider CLI 외부의 도구를 setup/teardown 가능한 실행 단위로 관리한다.

작업:

1. Done: `tools` config schema 추가
2. Done: `src/tools.js` setup/teardown lifecycle 추가
3. Done: selected runtime runner를 통한 tool command 실행
4. Done: `manifest.tools.lifecycle`에 tool 결과 기록
5. Done: tool별 `envAllowlist` 추가. Docker runner에서는 runner-level allowlist와 교집합으로 제한

### Phase E. Budget And Eval

Status: implemented

목표: 하네스 비용과 품질을 지속적으로 관리한다.

작업:

1. Done: `budget` config schema 추가
2. Done: agent/provider/validation call limit 적용
3. Done: `harness eval [--json]` 명령 추가
4. Done: eval report를 `.harness/eval/`에 기록
5. Done: provider token/cost usage parser 추가. 파싱 불가 시 `unknown`으로 기록
6. Done: fixture repo 기반 eval score test 추가

### Phase F. Regression Eval And Policy Gates

Status: implemented

목표: 하네스 자체 변경을 fixture와 deterministic policy 기대값으로 회귀 검증한다.

작업:

1. Done: fixture repo의 `.harness-eval.json` spec 지원
2. Done: expected status, min score, check status assertion 추가
3. Done: policy case assertion 추가
4. Done: protected branch + `workspaceMode: "direct"` 쓰기 실행 차단
5. Done: policy gate command test 추가

### Phase G. Provider And Runtime Refinement

Status: implemented

목표: provider별 capability/usage/runtime 차이를 더 정확히 모델링한다.

작업:

1. Done: Codex/Claude/custom CLI별 usage adapter metadata 분리
2. Done: manifest `runtime.contract`에 local/Docker runner 계약 기록
3. Done: `prompt-cache.json` static context/template hash artifact 추가
4. Done: Docker/local runner 차이 테스트 확장

### Phase H. Operator UX And Reporting

Status: implemented

목표: 실행 결과를 더 쉽게 판단하고, 설정 제안 UX를 정리한다.

작업:

1. Done: `harness show`에 retry/usage/redaction/policy/runtime/prompt cache 요약 추가
2. Done: `doctor`에 eval/config readiness 요약 추가
3. Done: `harness eval` recommendations 추가
4. Done: 공개 repo용 README/docs 최종 정리

## 이번 구현으로 생긴 주요 산출물

- `src/middleware.js`: hook event, shared state, redaction, context trimming, retry/budget config를 담당한다.
- `src/tools.js`: setup/teardown tool lifecycle을 담당한다.
- `src/eval.js`: 하네스 자체 regression gate를 실행하고 eval report를 남긴다.
- `src/usage.js`: provider stdout/stderr에서 token/cost usage를 best-effort로 파싱한다.
- `src/prompt-cache.js`: prompt template과 static context hash artifact를 생성한다.
- `.harness-eval.json`: fixture별 eval 기대값과 policy case를 선언한다.
- `manifest.runtime.contract`: runner별 isolation, env, mount/network 계약을 저장한다.
- `manifest.promptCache`: run의 prompt/static context cache metadata를 저장한다.
- `manifest.middleware`: hook event stream, counters, runtime config summary를 저장한다.
- `manifest.tools.lifecycle`: tool setup/teardown 결과를 저장한다.
- `.harness.json` 신규 필드: `redaction`, `context`, `context.summarizer`, `retry`, `budget`, `tools`, `tools[].envAllowlist`.
- 테스트: `test/middleware.test.js`, `test/config-validation.test.js`, `test/runtime-runner.test.js`, `test/eval-command.test.js`, `test/usage.test.js`, `test/policy-gate.test.js`, `test/prompt-cache.test.js`, `test/show-command.test.js` 확장.

## 결론

현재 하네스는 "coding CLI agent를 관찰 가능하고 검증 가능한 파이프라인으로 감싸는 구조"에서 한 단계 더 나아가, pipeline 주변에 조합 가능한 middleware runtime을 갖는다.

Phase A부터 H까지 완료되었고, 공개 repo에서 구조를 보여주는 목적에는 충분한 상태다. 이후 확장은 제품화 범위로 분리하는 편이 맞다. 실제 provider를 호출하는 model summarizer, 원격 runner, 웹 대시보드, 팀 단위 queue는 현재 기본 실행 계약 위에 별도 로드맵으로 다룬다.
