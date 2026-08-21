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

| cli-contract | provider CLI 인자 계약 검사: buildArgs가 실제로 쓰는 플래그를 provider에 선언하고 `doctor`가 `--help`로 존재 확인. 버전 숫자 핀보다 고장을 직접 잡는다. 선언↔buildArgs 교차 검증 테스트 포함. 외부 리뷰의 "버전 핀 없음" 지적 대응 | 직접 |
| no-change | 변경 0건 게이트: 쓰기 스텝이 돌았는데 `changedFiles: 0`이면 신호를 항상 기록(`noChangeAssessment`)하고 supervisor에 노출. 옵트인 `policy.blockOnNoChanges`면 supervisor 호출 **전에** 런을 차단해 provider 호출도 아낀다. validation이 통과해도 차단된다는 점이 핵심 | 직접 |
| C2b+ | diff 위험 하드 블록: `policy.blockOnChangeRisk` 옵트인 시 inspection 후 런 차단(`#enforceChangeRiskGate`). `--policy-approved`로 우회, 기본 off로 하위 호환. e2e 테스트 | 직접 |
| B6 | **토큰 가시성**. claude adapter를 `--output-format json`으로 전환해 usage/total_cost_usd를 노출(text 모드에서는 아예 출력되지 않아 측정 불가였음). stdout이 JSON이 되므로 `extractFinalOutput`으로 `result`만 뽑아 다음 스텝 컨텍스트에 넣고, 파싱 실패 시 원문 폴백. 캐시 토큰을 포함한 `billedTokens`·`agentTurns` 집계를 `usage.js`/`show`에 추가. **실제 claude로 e2e 검증** | 직접 |

### 외부 리뷰 대응 (2026-08-21)

다른 에이전트의 구조 지적을 항목별로 검증했다. 결과가 갈렸다.

**사실로 확인된 것** — 기본값이 안전 논지와 반대(`workspaceMode: direct`, `runner: local`), 상태가 프로젝트별이 아니라 하네스 루트에 쌓임(queue·memory·feedback·reports·promotions·eval 6종), provider CLI 인자 취약성과 버전 핀 부재, "multi-agent"라는 이름과 순차 실행(`Promise.all` 없음)의 불일치, 실제 버그 픽스처 기반 결과 지표 부재.

이 중 CLI 인자 취약성은 대응했다(위 `cli-contract`). 이 지적을 확인하다 **문서-코드 불일치**도 하나 발견했다: 엔지니어링 로드맵 Phase 13에 "version compatibility warning: Done"으로 적혀 있었으나 실제로는 버전 문자열을 읽어 표시만 했고 호환성 검사는 없었다. 해당 항목을 사실대로 정정하고 실제 구현 형태를 기록했다.

> 교훈: 완료 표시는 코드로 검증해야 한다. 이 로드맵의 다른 Done 항목도 같은 방식으로 재확인할 여지가 있다.

**부정확한 지적** — "qa/verifier가 coder 요약만 받아 검증한다". 두 프롬프트 모두 앞 출력을 *claim*으로 다루고 repo·git diff·명령 출력으로 대조하라고 명시한다. 게다가 하네스가 inspection 단계에서 결정론적으로 git diff를 떠서 `changedFiles`/`riskyFiles`/`secretFindings`를 컨텍스트에 넣는다. 실제 e2e에서 hermes가 git diff를 직접 실행해 coder 주장을 대조하고 하네스 자체 버그까지 찾아낸 사례가 있다.

**데이터로 답할 수 없던 것** — "hermes 결정 vs 룰 기반 일치율을 재보면 LLM 필요 여부가 나온다". 재봤다. 541개 결정 중 **98.7%가 mock**이고 mock 결정은 테스트 시나리오에 하드코딩돼 있어 판단 품질이 아니라 시나리오 분포를 반영한다(전체 63.6%, 실제 provider 7건 85.7%). 표본이 부족해 결론 불가 — 이는 기존에 인지한 "실증 부재"와 같은 문제다.

다만 룰과 갈린 실제 결정 2건이 시사적이었다.

| run | validation | hermes | 근거 |
|-----|-----------|--------|------|
| `..._141743` | build 통과(exit 0) | `stop_failed` | "변경 0건. build 통과는 기존 스캐폴드 확인일 뿐" |
| `..._162226` | 없음 | `request_human_review` | "설계 결정 미해결이라 자동화 단독 진행 부적절" |

둘 다 validation pass/fail만으로는 도달 불가능한 판단이다. **다만 1번은 절반이 지적대로다** — `changedFiles: 0`이 이미 manifest에 있었으므로 LLM 없이 잡을 수 있었다. 이를 값싼 룰 게이트로 구현했다(아래 no-change 게이트).

### 중단 복구 점검 (2026-08-21)

"어디선가 망가져 멈추면 찾거나 복구하는 로직이 없고 무한루프 위험이 있다"는 지적을 코드로 확인했다. 결과가 갈렸다.

**무한루프는 막혀 있다.** `assertBudget`이 agent/validation 호출마다 경과 시간(`maxRuntimeMs`)과 호출 수(`maxAgentSteps`/`maxProviderCalls`/`maxValidationCommands`)를 검사하고, supervisor 루프는 `maxSupervisorTurns`와 `maxStepRetries`로 닫혀 있으며, 승격은 `escalatedToSafeFix` 플래그로 run당 1회다. agent/validation은 각각 timeout 후 SIGTERM → SIGKILL로 끝난다.

한계: `maxRuntimeMs`는 다음 agent/validation 호출 시점에만 검사되므로 초과를 넘어선 뒤에 잡는다. 실시간 중단이 아니다(agent timeout이 실제 상한 역할을 한다).

**복구는 실제로 뚫려 있었다.** 두 군데다.

1. **큐에 갇힌 task.** `claimPendingTask`가 pending → running으로 rename해 선점한 뒤 프로세스가 죽으면 task가 running에 영구히 남는다. 다음 tick은 pending만 보므로 그 task는 처리되지 않는다. 오류가 나지 않고 tick이 계속 idle을 보고하는 **조용한 정지**다. 자율 운영(주기적 tick)에서 가장 위험한 형태다. → `reclaimStaleRunning`을 추가하고 tick 시작 시 호출한다. 회수는 failed로 보낸다(자동 재실행하면 죽은 run이 이미 바꾼 파일에 중복 적용될 수 있다).

2. **끝나지 않은 run.** 최종 status나 finishedAt이 없는 manifest가 실제로 2건 있었다(`2026-07-06_142509_962`, `2026-07-06_143844_338` — 둘 다 hermes까지 성공하고 reporter 전에 종료). 영구히 `unknown`으로 남아 지표를 오염시킨다. → metrics에 `interruptedRuns`로 따로 센다.

후속: `harness clean`이 중단된 run을 감지해 보고한다(아래 dogfooding 항목). 중단된 run의 워크스페이스 제거는 여전히 `harness clean --worktrees`로 처리한다 — run 단위 finally는 프로세스가 SIGKILL되면 실행되지 않는다.

### 소모량을 사용자에게 어떻게 보여줄 것인가 (2026-08-21)

문제: provider CLI가 주는 cost는 API 요금 환산값이다. 구독 인증(`authMethod: claude.ai`)으로 쓰면 실제 청구가 아니라 사용량 한도에서 차감된다. 사용자마다 요금제가 다르고 상품 구성도 바뀐다. `Cost USD: $0.69`를 그대로 보여주면 구독 사용자는 이를 청구로 오해한다.

원칙: **하네스가 모르는 것을 아는 척하지 않는다.** 요금제 프리셋(`plan: "max-5x"` 같은)은 두지 않는다. 상품이 바뀌면 하네스가 거짓말을 하게 된다.

세 층위로 해결했다.

1. **라벨링** — 기본(unknown)에서는 환산 추정치임을 표기에 드러낸다. `agent.billing`으로 `api`/`subscription`을 선언하면 그때만 단정한다. 프리셋이 아니라 과금 *모델*만 받으므로 상품 변화에 무관하다.
2. **자기 이력 기준선** — 절대 금액은 요금제마다 의미가 다르지만 "평소 run 대비"는 누구에게나 통한다. metrics가 사용자 자신의 `billedTokens` 분포(중앙값/p90/최대)를 준다. 외부 지식이 필요 없고 run이 쌓일수록 정확해진다.
3. **선언적 예산** — `budget.maxBilledTokens`(B6c)는 상품명이 아니라 숫자를 받는다. 사용자가 자기 기준으로 상한을 정한다.

`billedTokens`가 과금 모델 중립 지표라는 점을 문서에 명시했다. 구독이든 API든 실제 소모량이므로 요금제와 무관하게 비교할 수 있다.

### 벤치마크 1라운드 결과 (2026-08-21) — 하네스에 불리한 결과

"실제 버그 픽스처에서 단독 에이전트 대비 더 고치는가"를 처음으로 실측했다. `scripts/bench.mjs`, fixture 2개, 실제 claude.

판정은 fixture의 `npm test`가 한다. 모델의 자기 보고나 사람 판단이 개입하지 않는다.

| fixture | solo | harness | 배수 |
|---------|------|---------|-----:|
| 01-median-off-by-one | PASS $0.267 | PASS $0.785 | 2.9x |
| 02-leading-space-loss | PASS $0.265 | PASS $0.856 | 3.2x |
| **합계** | **2/2 $0.532** | **2/2 $1.642** | **3.1x** |
| 시간 | 71s | 264s | 3.7x |

**같은 결과에 3.1배 비용, 3.7배 시간.** 이 난이도에서 하네스는 순손실이다.

원인은 천장 효과다. Claude Opus가 두 fixture를 스캐폴딩 없이 이미 100% 푼다 — 어려운 쪽으로 설계한 02(증상과 원인의 위치가 다르고, 그럴듯한 오답이 테스트에 걸리는 함정까지 넣은 것)도 45초 만에 풀었다. **개선할 여지가 0인 문제에서는 검증·감독 계층이 오버헤드일 뿐이다.**

주의: 이 벤치마크는 하네스의 다른 가치(감사 추적, 정책 게이트, 격리 실행)를 재지 않는다. 재는 것은 "고쳤는가" 하나뿐이다.

### 2라운드: 약한 모델로 재측정 (Haiku)

증폭 가설 — "약한 모델을 하네스로 강한 모델 수준까지 끌어올린다" — 을 테스트하려 했다. `gemini` CLI는 인증이 안 돼 있어(사용자만 설정 가능) 대신 같은 질문에 답할 수 있는 Haiku로 쟀다. 이를 위해 `agent.model` 지정을 지원하도록 했다(기존 갭이었다).

| 조건 | 통과 | 비용 | billed | 최저 대비 |
|------|------|-----:|-------:|----------:|
| Opus solo | 2/2 | $0.532 | 390,168 | 4.5x |
| Opus harness | 2/2 | $1.642 | 895,106 | 13.9x |
| **Haiku solo** | **2/2** | **$0.118** | 384,661 | **1.0x** |
| Haiku harness | 2/2 | $0.239 | 607,677 | 2.0x |

**네 조건 모두 2/2다.** Haiku조차 두 fixture를 100% 푼다 — 함정을 넣어 어렵게 설계한 02에서도 Haiku가 `capture.js`(진짜 원인)를 고쳤고 `slice(2)` 함정에 빠지지 않았다.

그리고 **`solo Haiku`가 `harness Opus`보다 14배 싸다.** 결과는 같다.

### 결론: 증폭 방향 종료

증폭 가설은 **반증되지 않았지만 검증되지도 않았다.** 올릴 여지가 0인 문제에서는 잴 수 없기 때문이다. 검증하려면 "Haiku는 실패하고 Opus는 성공하는" 난이도 구간의 fixture가 필요한데, 그 구간을 안정적으로 만들고 유지하는 비용이 이 프로젝트에서 감당할 범위를 넘는다고 판단해 **이 방향을 접는다**(2026-08-21, 사용자 결정).

측정이 남긴 것은 분명하다.

> 하네스는 결과 품질을 올리지 않는다. 적어도 단일 파일 버그 수정 난이도에서는, 강한 모델에게도 약한 모델에게도 순수 오버헤드다(각각 3.1배, 2.0배).

따라서 이 프로젝트의 값어치는 "더 잘 고친다"가 아니라 다른 데 있다 — 감사 추적(manifest·prompt·로그), 정책 게이트(보호 브랜치·위험 변경·변경 0건), 격리 실행(worktree/patch/docker), 재현 가능성. 이 벤치마크는 그것들을 재지 않는다. **성능 도구가 아니라 통제 도구로 포지션을 잡는 것이 데이터에 부합한다.**

fixture와 러너는 자산으로 남긴다. 하네스 자체를 변경할 때 "여전히 고치는가 / 비용이 얼마나 늘었는가"를 재는 회귀 도구로 쓴다.

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
| B6d | ✅ metrics·show에 역할별/범주별 비용 분해 추가(`byRole`, `byCategory`, `avgCostPerStep`). 재시도 접미사는 base 역할로 정규화. **실측: write 25% vs meta(감독·보고) 75% — 오버헤드가 실제 작업의 3배** | 완료 |
| B6a | ✅ `previousOutputs`를 역할별로 선별 주입. 누적 문자열을 `src/context-ledger.js`의 섹션 원장으로 바꾸고 역할별 정책 적용(옵트인 `context.selection.enabled`, 기본 off). 실측 절감: reporter 55.8%, 전체 18.0% | 완료 |
| B6b | ✅ `escalate_to_safe_fix`가 이미 끝낸 계획·구현을 건너뛰고 검증 보강만 이어간다(옵트인 `supervisor.escalation.skipCompletedSteps`). quick_fix→safe_fix 승격 실측 8스텝→6스텝(25% 감소), coder 재실행·planner 제거 | 완료 |
| B6c | ✅ `budget.maxBilledTokens` / `maxCostUsd` 추가. 호출 횟수 상한은 소모량을 묶지 못한다(6번 호출로도 무한정 태울 수 있다). usage는 스텝 후에 알 수 있으므로 누적은 `recordUsage`, 검사는 다음 호출 시작 시점 — `maxRuntimeMs`와 같은 패턴 | 완료 |

### 어디에 돈이 가는가 (B6d)

README 한 줄 수정(`quick_fix`, provider 호출 3회) 실측을 역할별로 분해했다.

| 역할 | 비용 | 비중 | turns | billed |
|------|-----:|-----:|------:|-------:|
| hermes | $0.3054 | 44.0% | 4 | 119,269 |
| reporter | $0.2146 | 30.9% | 3 | 93,163 |
| coder | $0.1735 | 25.0% | 4 | 107,078 |
| **합계** | **$0.6935** | | 11 | 319,510 |

**실제 코드 변경 25%, 감독·보고 75%.** 오버헤드가 실제 작업의 3배이고, 단일 최대 항목이 감독(hermes)이다. 한 줄짜리 문서 수정에 $0.69는 작업 난이도가 아니라 구조가 정하는 비용이다.

스텝당 평균 $0.2312가 사실상 고정비다. 별도로 잰 최소 호출(`claude -p "Reply with exactly: ok"`)이 $0.104였다 — 아무 일도 하지 않는 세션 하나를 띄우는 값이다. 스텝을 하나 늘릴 때마다 이 고정비가 붙는다.

구조적 선택지(측정으로 근거가 생긴 것):

| 방향 | 근거 | 비고 |
|------|------|------|
| ✅ reporter 결정론화 + hermes 출력 축소 | meta 75% | **완료. $0.6935 -> $0.3665 (47.2%)** |
| 역할별 모델 차등 | meta 75% | **보류.** 아래 참조 |
| reporter를 결정론적 생성으로 | reporter 30.9% | 보고 재료(changedFiles·validation·hermes decision)가 이미 manifest에 있다 |
| 단순 요청에서 hermes 생략 | hermes 44% | 변경 0건 게이트처럼 값싼 룰로 대체 가능한 구간 |
| 스텝 수 축소 | 스텝당 $0.23 고정비 | quick_fix가 3스텝인데 단순 수정에 감독·보고가 필요한지 |

### 완료: reporter 결정론화 + hermes 출력 축소

원인은 고정비가 아니라 **출력 토큰**이었다. 캐시 조회는 세 역할이 78k~100k로 비슷했고 차이는 output이었다.

```
coder     output   645  ->   448B 산출물   $0.1735
hermes    output 4,495  -> 5,556B 보고서   $0.3054   (coder의 7배)
reporter  output 2,208  -> 3,409B 보고서   $0.2146
```

hermes가 산문 감독 보고서를 쓰는데 하네스가 파싱하는 건 JSON 블록뿐이고, 산문의 유일한 소비자는 reporter였다. 그리고 reporter는 그걸 읽고 또 보고서를 썼다 — **같은 내용을 두 번 쓰고 있었다.**

`reporter.mode: "deterministic"`(옵트인)이면 reporter가 manifest에서 보고서를 만들고 provider를 호출하지 않는다. 그러면 hermes 산문의 소비자가 없으므로 hermes도 압축 프롬프트를 쓴다. 평가 항목과 결정 규칙은 동일하게 두고 출력 형식만 압축했다.

| 역할 | 기본 | 적용 후 |
|------|-----:|-------:|
| coder | $0.1735 | $0.1739 |
| hermes | $0.3054 (out 4,495) | $0.1926 (out 1,245) |
| reporter | $0.2146 | $0.0000 |
| **합계** | **$0.6935** | **$0.3665 (-47.2%)** |

감독 품질은 유지됐다. 축소 프롬프트에서도 hermes는 `git diff`로 요청 일치를 확인하고, `grep`으로 잔여 원문이 없음을 검증하고, `git status --short`로 범위 이탈을 확인하고, validation이 `echo`라 코드 정합성을 입증하지 않는다는 판단까지 냈다. 산문만 사라지고 증거 기반 추론은 그대로다.

### 보류: 역할별 모델 차등

meta 75%를 줄이는 또 다른 수단이지만 **보류한다.**

reporter가 결정론이 되면 남는 LLM 스텝은 hermes뿐인데, hermes는 추론이 곧 역할이다. 증거 대조·주장 검증·위험 판단을 하고, 실제로 하네스 자체 버그(경로 파싱 off-by-one)를 찾아낸 것도 hermes였다. 게다가 위험한 실패 모드는 파싱 실패가 아니라 **그럴듯하지만 틀린 `continue`**이고, 하네스의 안전 붕괴(파싱 실패 -> human review)는 그걸 잡지 못한다.

결정적으로 **품질 저하를 잴 수단이 없다.** eval의 `supervisorCases`는 파싱 안전 붕괴만 검증하고 판단 품질은 보지 않으며, 실제 provider 결정 표본도 7건뿐이다. 비용은 metrics에 잡히지만 품질은 안 잡히므로 "낮춰보고 확인"이 성립하지 않는다.

재개 조건: supervisor 판단 품질 골든(같은 증거에서 같은 결정을 내는지)이 생기면 그때 다시 본다.

**선행 갭(그때 필요): 역할별 모델을 지정할 수단이 없다.** `--model`은 `step.model`에서만 오고, `step`은 `config/pipelines.json`의 파이프라인 정의에서 온다. 그런데 `config/pipelines.json`에는 `model` 필드가 없고, `.harness.json`의 `agents.<role>`은 provider만 바꿀 뿐 model을 step에 주입하지 않는다(`resolveStepAgent`가 전달하지 않음). 즉 "hermes만 더 싼 모델로" 같은 가장 직접적인 절감 수단이 막혀 있다. meta가 75%인 만큼 효과가 큰 항목이다.

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

## dogfooding: harness clean 중단 감지 (2026-08-21)

앞선 벤치마크가 "하네스는 결과 품질을 올리지 않는다"를 보여준 뒤, 그러면 실제로 쓸 때 어떤지 보기 위해 하네스에게 하네스를 고치게 했다. 과제는 이 문서가 "수동 처리해야 한다"고 남겨둔 갭이었다: `harness clean`이 중단된 run을 감지하지 못하는 것.

결과: **성공.** `quick_fix` / codex / worktree 모드, validation 3종(test·check·eval-ready) 통과, hermes `continue(success)`, 최종 status succeeded.

관찰된 것 네 가지.

1. **요구하지 않은 설계 개선을 했다.** `cleanRuns`에 `runsDir` 파라미터를 추가했다. 요구사항에 없었지만 임시 디렉터리로 테스트하려면 필요하다. 테스트를 쓰라는 요구가 설계 개선으로 이어진 셈이다.
2. **생성된 테스트가 요구 범위를 덮었다.** status 없음 / finishedAt 없음 / 정상 / manifest 없음 / manifest 파싱 실패, 그리고 console 출력까지 검증한다.
3. **worktree 모드의 마찰:** 결과가 `runs/<runId>/worktree`에 남고 원본 반영은 사람이 한다. 이번에는 파일 3개를 직접 복사했다. 안전한 기본값의 대가지만, 반복하면 부담이 된다. patch 모드도 마찬가지로 사람이 적용해야 한다.
4. **provider별 usage 노출 차이가 드러났다.** codex는 `billedTokens`만 채우고 `costUsd`·`turns`는 비운다(claude는 전부 채운다). 오늘 만든 비용 분해 지표가 provider에 따라 부분적으로만 작동한다는 뜻이다. `costUsd` 기반 비교는 provider를 섞으면 성립하지 않는다.

교훈은 기존 것과 일치한다 — **명확·안전·독립적인 작업에는 dogfooding이 잘 맞는다.** 이번 과제는 범위가 한 함수와 새 테스트 파일 하나로 닫혀 있었고, 판정 기준(validation 통과)이 결정론적이었다.

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
