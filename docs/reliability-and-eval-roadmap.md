# 신뢰성·평가 체계 강화 로드맵

## 배경

4개 관점(실행 아키텍처 / Hermes / 보안·견고성·테스트 / 문서·DX)의 코드 기반 심층 평가와 추가 리뷰 판단을 종합한 결과, 이 하네스의 다음 단계는 **기능 추가가 아니라 "이미 표방한 것의 신뢰성 확보 + 품질을 측정하는 체계"** 다.

두 축: **새는 것(신뢰성 결함)** — redaction 누수, 비원자 쓰기, 리소스 정리 누수. **못 재는 것(평가 체계 부재)** — eval이 준비도 점검에 그치고 판단 품질을 측정 못 함.

## 핵심 원칙

> 무엇을 개선하든 측정 체계가 없으면 나아졌는지 알 수 없다. 평가 체계는 후속 개선의 전제 조건이다. 단, redaction 누수·상태 손상·리소스 누수처럼 측정 없이도 자명한 결함은 선제로 봉합한다.

실행은 3개 트랙: A(봉합) → B(평가 체계) → C(구조 강화).

---

## 진행 현황 (마지막 갱신: 2026-07-08)

### ✅ 완료 (전부 main에 머지됨)

| ID | 작업 | 방식 |
|----|------|------|
| A1 | redaction 신뢰화 (기본 ON, 패턴 8종, 줄경계 스트림 redactor, 산출물 redact, 무효패턴 경고) | 직접 |
| A2 | 원자적 writeText(tmp+fsync+rename) + 정리 보장(try/finally 멱등) | 직접 |
| B1 | supervisor decision fixture (무효 입력→human review 안전붕괴 고정) | 직접 |
| B2 | provider contract test (codex/claude/antigravity buildArgs·capabilities 스냅샷) | 하네스 dogfooding |
| B3 | 품질 지표 집계 (`harness metrics`: 복구율·재실행률·human-review율·provider별 성공률·평균시간) | 직접(하네스 실패 후) |
| C1 | runner God function(707줄) 분해 → `PipelineExecutor` 클래스(`src/pipeline-executor.js`). runner.js는 얇은 재노출 진입점. 단계 메서드로 분리(설정·워크스페이스·manifest·정책게이트·툴셋업·스텝루프·hermes결정·종료). dry-run manifest 동등성으로 동작 보존 검증 | 직접 |
| C2 | pipeline-selection 작성 의도 신호 (review_only 오분류 수정) | 직접 |
| C3 | CI (GitHub Actions, Node 20/24 매트릭스, check+test) | 하네스 dogfooding |
| C4 | 보안 모듈 테스트 (trust.js / inspection.js) | 하네스 dogfooding |
| B4 | eval을 준비도→품질 평가로 확장. `.harness-eval.json`에 `pipelineCases`(파이프라인 선택)·`supervisorCases`(supervisor 결정 파싱·안전 붕괴) 골든 시나리오 추가. 결정론적 오프라인 비교(LLM 미실행)로 CI-safe. 회귀 시 status=failed + recommendation 노출 | 직접 |
| B5 | 프롬프트/역할 품질 회귀. `src/prompt-registry.js`로 `prompts/*.md` 지문 스냅샷(버전) + 커밋된 `prompts/prompt-versions.json` 골든. eval의 `prompt-versions` check가 드리프트를 fail로 노출. renderPrompt 골든 스냅샷으로 렌더링 로직 회귀도 고정. 의도적 변경은 `scripts/update-prompt-versions.mjs`로 갱신 | 직접 |
| agent 견고성 | spawn 전 바이너리 해석(`resolveCommandPath`): PATH + 흔한 설치 위치 탐색, 실패 시 명확한 에러로 fail-fast. `spawn claude ENOENT` 대응 | 직접 |
| C2b | 정책을 diff·명령 allowlist에 근거화(`evaluateChangeRisk`, additive) + detached HEAD fail-safe. inspection 단계에 policyAssessment 연결. 텍스트 게이트는 회귀 없이 보존 | 직접 |
| C4b | docker 하드닝: `--user` 비루트 기본(host uid:gid), review_only에서 repo `:ro` + `--read-only`(+`/tmp` tmpfs). 모두 config로 재정의 가능 | 직접 |
| A2b | 큐 클레임 rename 원자적 선점(`claimPendingTask`). 동시 tick 이중 실행 방지 | 직접 |
| — | metrics를 `harness --help` usage에 노출(누락 보강) | 직접 |

| C2b+ | diff 위험 하드 블록: `policy.blockOnChangeRisk` 옵트인 시 inspection 후 런 차단(`#enforceChangeRiskGate`). `--policy-approved`로 우회, 기본 off로 하위 호환. e2e 테스트 | 직접 |

### ⏳ 남음 (후속)

| ID | 작업 | 우선순위 / 비고 |
|----|------|-----------------|
| C4b+ | docker 하드닝의 **실제 컨테이너 런타임** end-to-end 검증(로직·인자조립만 테스트됨) | 중간 |
| agent+ | agent spawn의 **실제 실행** end-to-end 검증 및 전이 오류(EAGAIN 등) 재시도 | 중간 |

> 자율(hermes) 경로에서 하드 블록된 런은 현재 failed로 처리된다. 이를 `approval_pending` 큐로 라우팅하는 것은 선택적 개선(현재도 안전한 결과).

---

## dogfooding 교훈 (이번 세션)

하네스로 하네스 자신을 고치며(B2·C3·C4 성공) 실제 약점 2개를 확증했다.

1. **pipeline-selection 오분류** — "테스트를 *작성*하라"가 `inspect`/`test` 키워드로 review_only(코드 미작성)로 분류됨. → **C2로 작성 의도 신호 추가해 수정 완료.**
2. **agent 실행 견고성** — coder 단계에서 `spawn claude ENOENT`로 실패(planner는 성공). agent 실행이 환경/PATH에 취약. → **위 "agent 실행 견고성" 항목으로 남김.**
3. **A2 정리 보장 확인(긍정)** — coder 실패 run에서 finally가 worktree를 실제로 정리하는 것을 확인.

교훈: 하네스는 **명확·안전·독립적인 작업(테스트·CI 추가)** 에 dogfooding이 잘 맞고, **민감(정책)·대규모 리팩터(C1)·실행 견고성 의존 작업**은 직접이 낫다.

---

## 다음 세션 착수 순서

1. **B4 → B5** — 평가체계 완성
2. **agent 실행 견고성** — spawn 견고화
3. 나머지(C2b·C4b·A2b) — 중간~낮은 우선순위

> C1(runner 분해) 완료: `runPipeline` God function을 `PipelineExecutor`로 분해. 동작 보존은 dry-run manifest 동등성 diff로 확인(브랜치명 유래 필드 외 완전 동일).

## 평가 근거 (영역별 점수, 세션 시작 시점)

| 영역 | 점수 | 핵심 |
|------|:---:|------|
| 실행 아키텍처 | 7.5 | provider 추상화·직교성·manifest 관측성 / God function(→C1✅)·정리 누수(→A2✅) |
| Hermes | 7.0 | 종료조건·이중 게이트 안전설계 / 비원자 쓰기(→A2✅)·키워드 정책(→C2b) |
| 보안·견고성·테스트 | 6.0 | config검증·trust 문서 / redaction 결함(→A1✅)·보안모듈 무테스트(→C4✅) |
| 문서·DX·성숙도 | 7.0 | 문서 정확성·자기 인식 / CI 부재(→C3✅) |
