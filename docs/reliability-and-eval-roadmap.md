# 신뢰성·평가 체계 강화 로드맵

## 배경

4개 관점(실행 아키텍처 / Hermes / 보안·견고성·테스트 / 문서·DX)의 코드 기반 심층 평가와 추가 리뷰 판단을 종합한 결과, 이 하네스의 다음 단계는 **기능 추가가 아니라 "이미 표방한 것의 신뢰성 확보 + 품질을 측정하는 체계"** 다.

두 개의 축으로 정리된다.

- **새는 것(신뢰성 결함)** — redaction 누수, 비원자적 상태 쓰기, 리소스 정리 누수. 측정 없이도 틀렸음이 자명하다.
- **못 재는 것(평가 체계 부재)** — `harness eval`이 준비도 점검에 그치고, Hermes 판단 품질·프롬프트 회귀·품질 지표를 측정하지 못한다. 개선해도 나아졌는지 알 수 없다.

## 핵심 원칙

> 무엇을 개선하든 측정 체계가 없으면 나아졌는지 알 수 없다. **평가 체계는 후속 개선의 전제 조건**이다. 단, redaction 누수·상태 손상·리소스 누수처럼 측정 없이도 자명한 결함은 선제로 봉합한다.

실행은 3개 트랙으로 나눈다. A(봉합)는 즉시·병행, B(평가 체계)가 이번 단계의 중심, C(구조 강화)는 B가 안전망을 깐 뒤.

```
A (봉합)  ──병행──┐
                  ├─→ B (평가 체계) ──→ C (구조 강화)
   측정 불필요한        모든 후속 개선을      B가 회귀를 잡아주므로
   자명한 버그          측정 가능하게 만듦    리팩터·정책변경을 안전하게
```

## 트랙 A — 자명한 신뢰성 결함 봉합

| ID | 항목 | 산출물 | 상태 |
|----|------|--------|:---:|
| A1 | **redaction 신뢰화** | 기본 ON + 청크 tail 이월 버퍼(스트림 경계 누수 제거) + `request.txt`/`manifest.json`/`changes.patch`/worktree 산출물에도 적용 + 패턴 확장(AWS/GCP/JWT/일반 `key=` 대입) + 무효 custom regex는 조용히 버리지 말고 config 경고 | ✅ Done |
| A2 | **원자적 영속성 + 정리 보장** | `write→fsync→rename` 패턴(`fs-utils.js writeText`), 큐 클레임은 rename 선점, 실행 전체를 `try/finally`로 감싸 `finalizeWorkspace`·`teardownTools`가 어떤 에러(budget 포함)에도 항상 실행 | Planned |

근거: redaction은 `middleware.js:57-64,229-264`(기본 OFF), `validation.js:118-131`(청크별 redact), `manifest.js:9`·`runner.js:473`(산출물 미적용). 정리 누수는 `runner.js` budget 경로가 teardown을 건너뜀. 비원자 쓰기는 `fs-utils.js writeText`, `hermes-memory.js:45`(jsonl 전체 재작성).

## 트랙 B — 평가 체계 (이번 단계의 핵심)

| ID | 항목 | 목적 / 산출물 | 상태 |
|----|------|--------------|:---:|
| B1 | **Hermes decision fixture 회귀** | `(validation 결과 + config) → 기대 decision` 골든 케이스. "실패→safe_fix 승격 / 불필요 재실행 안 함 / 잘못된 decision JSON→human review 붕괴"를 고정. `supervisor.js`가 파싱·정규화 분리라 테스트 용이 | ✅ Done |
| B2 | **provider contract test** | codex/claude/antigravity adapter의 `buildArgs·capabilities·outputMode·sandbox 매핑`을 스냅샷 고정. adapter 변경 시 계약 누수 감지 | Planned |
| B3 | **품질 지표 집계** | manifest에 이미 있는 데이터 집계 — 복구 성공률·불필요 재실행률·human review 전환률·validation 실패 후 최종 성공률·provider별 성공률·평균 비용/시간·decision accuracy(B1 fixture 대비 일치율). `harness metrics` 또는 eval 통합 | Planned |
| B4 | **eval을 준비도→품질로 확장** | 현재 eval(config 유무 점검)에 골든 시나리오(알려진 입력→기대 pipeline 선택·decision·최종 상태)를 추가해 판단 품질 회귀를 감지 | Planned |
| B5 | **프롬프트/역할 회귀 관리** | 프롬프트 버전 + 골든 출력 비교. 프롬프트 변경 시 B1·B4 fixture로 before/after 품질을 수치로 확인 | Planned |

## 트랙 C — 구조·운영 강화 (B의 안전망 위에서)

| ID | 항목 | 상태 |
|----|------|:---:|
| C1 | `runPipeline`(약 680줄 God function) 분해 — 스텝 루프/supervisor 상태머신을 `PipelineExecutor`로 추출. B1·B2 테스트가 리팩터 안전망 | Planned |
| C2 | 정책 판정을 키워드 substring → inspection diff·명령 allowlist 기반으로. detached HEAD(빈 브랜치) 보호 우회 처리 | Planned |
| C3 | CI(GitHub Actions `check && test` 게이트) + LICENSE + eslint 최소 룰셋 | Planned |
| C4 | docker 하드닝(non-root `--user`, review_only에서 repo `:ro`, `--read-only`) + 보안 모듈(trust/inspection) 테스트 | Planned |

## 착수 순서

1. **A1(redaction) + B1(Hermes fixture) 병행** — A1은 신뢰도를 가장 크게 올리는 봉합(말과 코드 일치), B1은 평가 체계의 첫 벽돌이자 ROI가 가장 높은 fixture(Hermes가 이 프로젝트의 정체성인데 회귀 안전망이 없음).
2. B3(지표) → B2·B4·B5 — 측정 인프라를 넓힌다.
3. C1~C4 — 회귀 안전망 위에서 구조·운영을 강화한다.

## 평가 근거 요약 (영역별 점수)

| 영역 | 점수 | 핵심 |
|------|:---:|------|
| 실행 아키텍처 | 7.5 | provider 추상화·workspace×runner 직교성·manifest 관측성 강함 / God function·정리 누수 |
| Hermes | 7.0 | 종료조건·이중 게이트·비자동 promotion 안전설계 우수 / 비원자 쓰기·락 없는 큐·키워드 정책 |
| 보안·견고성·테스트 | 6.0 | config검증·trust 문서·branch 게이트 견고 / redaction 결함·보안모듈 무테스트 |
| 문서·DX·성숙도 | 7.0 | 문서 정확성·정직한 자기 갭 인식 / CI·LICENSE·lint 부재 |

종합 약 7.0/10. 설계·문서 성숙도는 상급, 프로덕션 안전·평가 성숙도는 초기.
