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
| B6 | **토큰 가시성**. claude adapter를 `--output-format json`으로 전환해 usage/total_cost_usd를 노출(text 모드에서는 아예 출력되지 않아 측정 불가였음). stdout이 JSON이 되므로 `extractFinalOutput`으로 `result`만 뽑아 다음 스텝 컨텍스트에 넣고, 파싱 실패 시 원문 폴백. 캐시 토큰을 포함한 `billedTokens`·`agentTurns` 집계를 `usage.js`/`show`에 추가. **실제 claude로 e2e 검증** | 직접 |

### ⏳ 남음 (후속)

| ID | 작업 | 우선순위 / 비고 |
|----|------|-----------------|
| C4b+ | docker 하드닝의 **실제 컨테이너 런타임** end-to-end 검증(로직·인자조립만 테스트됨) | 중간 |
| agent+ | agent spawn의 전이 오류(EAGAIN 등) 재시도. 실제 실행 e2e는 B6에서 claude 경로로 1회 확인됨(성공 경로만) | 중간 |

> 자율(hermes) 경로에서 하드 블록된 런은 현재 failed로 처리된다. 이를 `approval_pending` 큐로 라우팅하는 것은 선택적 개선(현재도 안전한 결과).

---

## 측정으로 드러난 것 (B6 이후)

B6로 토큰이 처음 측정 가능해지자 구조적 비용이 드러났다. `quick_fix`(provider 호출 3회)로 README 한 줄을 고치는 데 `billedTokens` 319,510 / $0.69가 들었고, 그중 **캐시 조회가 274,920 토큰(86%)** 이었다. `totalTokens`(input+output)는 7,370으로 실제의 2.3%만 보여준다.

원인은 낭비가 아니라 구조다. 스텝마다 새 CLI 프로세스가 뜨므로 (1) 스텝 간 프롬프트 캐시가 이어지지 않고, (2) 각 스텝이 repo 컨텍스트를 처음부터 다시 적재하며, (3) `previousOutputs` 누적으로 프롬프트가 스텝 수에 대해 O(N²)로 늘어난다. 실측한 safe_fix run에서 프롬프트 전송 총합 109KB 중 71%가 중복 재전송이었다.

후속 후보(우선순위 순):

| ID | 작업 | 비고 |
|----|------|------|
| B6+ | ✅ `harness metrics`에 토큰/비용 집계 추가(billed·캐시·turn·파이프라인별 비용). 측정 대상 판정은 파싱 상태가 아니라 실제 값 유무 기준 — status=parsed인데 값이 0인 구버전 run이 평균을 희석하던 문제를 피한다 | 완료 |
| B6a | ✅ `previousOutputs`를 역할별로 선별 주입. 누적 문자열을 `src/context-ledger.js`의 섹션 원장으로 바꾸고 역할별 정책 적용(옵트인 `context.selection.enabled`, 기본 off). 실측 절감: reporter 55.8%, 전체 18.0% | 완료 |
| B6b | ✅ `escalate_to_safe_fix`가 이미 끝낸 계획·구현을 건너뛰고 검증 보강만 이어간다(옵트인 `supervisor.escalation.skipCompletedSteps`). quick_fix→safe_fix 승격 실측 8스텝→6스텝(25% 감소), coder 재실행·planner 제거 | 완료 |
| B6c | `budget`에 token/cost 상한 추가(현재는 호출 횟수 상한만 존재) | B6로 측정이 가능해져 비로소 의미가 생김 |

### B6a 측정 결과와 한계

실제 claude safe_fix run 출력으로 시뮬레이션한 결과다.

| 스텝 | 선별 off | 선별 on | 절감 |
|------|--------:|-------:|-----:|
| coder | 7,325 | 7,325 | 0% |
| qa | 11,775 | 11,775 | 0% |
| verifier | 17,050 | 17,050 | 0% |
| hermes | 22,858 | 22,858 | 0% |
| reporter | 28,166 | 12,450 | **55.8%** |
| 합계 | 87,174 | 71,458 | **18.0%** |

절감이 reporter 한 곳에 몰린다. coder·qa는 그 시점에 존재하는 섹션이 이미 정책에 다 포함되어 있어 뺄 게 없고, verifier·hermes는 역할상 전체를 받아야 한다. **절감 상한이 구조적으로 정해져 있다.**

더 중요한 건 이게 전체 소비에서 차지하는 비중이다. 실측 run의 `billedTokens` 319,510 중 **86%가 캐시 조회**였다. 스텝마다 새 CLI 프로세스가 뜨므로 각 스텝이 repo 컨텍스트를 새로 적재하는 비용이 프롬프트 본문보다 크다. 즉 프롬프트를 줄이는 것만으로는 한계가 있고, 진짜 레버는 **스텝 간 세션/캐시 재사용**이다. 현재 provider CLI 계약으로는 세션을 이어붙일 수단이 없어 별도 아젠다로 남긴다.

### B6b 측정 결과

승격은 468 run 중 37건에서 발동했고, 기본 동작은 새 파이프라인을 처음부터 다시 도는 것이었다. mock e2e로 실측한 실행 스텝이다.

```text
기본:   coder → hermes → planner → coder-retry-1 → qa → verifier → hermes-retry-1 → reporter   (8)
옵트인: coder → hermes →                           qa → verifier → hermes-retry-1 → reporter   (6)
```

이미 끝난 `coder`의 재실행과 무의미한 `planner`가 사라져 provider 호출이 8회에서 6회로 줄었다(25%). `code_fix`에서 승격하면 실제로 추가되는 것은 `verifier` 하나뿐이다.

안전 케이스를 함께 고정했다. `review_only`에서 승격하면 아직 쓰기 스텝이 없으므로 옵트인이 켜져 있어도 처음부터 실행한다. 여기서 `coder`를 건너뛰면 승격이 아무 수정도 하지 않고 끝난다.

부수 관찰: `{{PROJECT_CONFIG}}`가 모든 스텝 프롬프트에 전문 주입된다. mock 데모에서 `.harness.json`에 필드 하나를 추가하자 6개 프롬프트가 각각 95바이트씩 늘었다. 설정이 커질수록 모든 스텝이 비싸진다.

## dogfooding 교훈 (이번 세션)

하네스로 하네스 자신을 고치며(B2·C3·C4 성공) 실제 약점 2개를 확증했다.

1. **pipeline-selection 오분류** — "테스트를 *작성*하라"가 `inspect`/`test` 키워드로 review_only(코드 미작성)로 분류됨. → **C2로 작성 의도 신호 추가해 수정 완료.**
2. **agent 실행 견고성** — coder 단계에서 `spawn claude ENOENT`로 실패(planner는 성공). agent 실행이 환경/PATH에 취약. → **위 "agent 실행 견고성" 항목으로 남김.**
3. **A2 정리 보장 확인(긍정)** — coder 실패 run에서 finally가 worktree를 실제로 정리하는 것을 확인.

교훈: 하네스는 **명확·안전·독립적인 작업(테스트·CI 추가)** 에 dogfooding이 잘 맞고, **민감(정책)·대규모 리팩터(C1)·실행 견고성 의존 작업**은 직접이 낫다.

### 추가 (B6 e2e 중)

4. **inspection 경로 파싱 결함을 supervisor가 발견** — B6 검증용으로 실제 claude를 태운 run에서 hermes가 `inspection-after-coder.json`의 `path: "EADME.md"`(정상값 `README.md`)를 스스로 짚어냈다. 원인은 `capture()`의 `stdout.trim()`이 `git status --short` 첫 줄의 선행 공백을 지운 것이었고, 그 경로가 riskyFiles/secretFindings 매칭의 입력이라 첫 변경 파일이 `.env`였다면 안전 게이트가 조용히 탐지를 놓칠 수 있었다. 별도 커밋으로 수정 + 회귀 테스트.

   주목할 점 두 가지. (1) supervisor가 "worker 주장을 증거로 대조하라"는 역할 지시대로 움직여 **작업 산출물이 아니라 도구 자체의 결함**을 찾아냈다 — 감독 계층이 실제로 값을 냈다. (2) 다만 supervisor가 제시한 원인(`slice(3)`을 `slice(2)`로) 은 **틀렸다**. 그대로 적용했다면 나머지 줄이 전부 깨졌다. 증상 보고는 신뢰하되 원인 진단은 직접 확인해야 한다는 사례.

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
