# Hermes Autonomous Operations Roadmap

이 문서는 Multi Agent Harness를 “파이프라인 안에 Hermes가 있는 구조”에서 “Hermes가 하네스를 운영하는 구조”로 발전시키기 위한 개발 위키입니다.

Status: completed

현재 1차 로드맵은 완료되었습니다. Hermes는 더 이상 pipeline 내부 supervisor step만이 아니라, top-level 운영 명령으로 요청 접수, 실행 계획, task queue, memory, policy, feedback, promotion, report를 관리할 수 있습니다.

이 문서에 남아 있는 hardening 항목은 필수 미완료 작업이 아니라, 운영 품질을 더 높이기 위한 선택 확장 후보입니다.

## 완료된 목표 상태

1차 로드맵 완료 후 구조는 다음과 같습니다.

```text
user / event / schedule
  -> Hermes Operator
    -> task queue
    -> memory
    -> policy
    -> harness runtime
      -> planner / coder / qa / verifier / hermes supervisor / reporter
    -> report / notification
```

기존 구조는 다음과 같았습니다.

```text
user
  -> harness run
    -> pipeline
      -> worker steps
      -> hermes supervisor
      -> reporter
```

완료된 핵심 전환은 이것입니다.

```text
Before: harness owns hermes
After: hermes owns harness
```

## 설계 원칙

- Hermes는 자율 운영자이고, 하네스는 실행 런타임이다.
- 자율성은 항상 policy와 manifest로 추적 가능해야 한다.
- 사용자가 승인하지 않은 destructive 작업은 자동 실행하지 않는다.
- 반복 작업 성능 향상은 memory와 policy promotion을 통해 만든다.
- daemon은 필수 목표가 아니다. 우선은 명령형 `hermes tick`으로 시작한다.
- 모든 자동 판단은 JSON contract와 테스트 가능한 상태 전이로 남긴다.
- `runs/`는 원자료이고, memory는 그 원자료를 요약/색인한 파생 데이터다.

## 완료된 기반

구현된 것:

- `harness run`
- `harness doctor`
- `harness clean`
- `harness watch`
- 역할 기반 pipeline
- validation stage
- Hermes supervisor step
- Hermes decision actions
  - `continue`
  - `run_validation`
  - `escalate_to_safe_fix`
  - `rerun_step`
  - `stop_failed`
  - `request_human_review`
- `supervisorDecisions` manifest 기록
- `pipelineChanges` manifest 기록
- 실행 전후 git snapshot
- cleanup hook
- mock 기반 Hermes controller 테스트
- Hermes top-level command
- schedule/tick 기반 운영 루프
- file-based task queue
- memory index
- 과거 run 기반 pipeline 추천
- 사용자 피드백 저장
- terminal/markdown report
- env 기반 webhook/slack/discord notification adapter
- policy 기반 자율 실행 한계
- protected branch 자동 실행 차단
- 반복 패턴을 prompt/config/policy 후보로 승격하는 promotion workflow
- promotion record와 `.harness.json` 후보 diff 생성

## 전체 개발 단계

### Phase 1. Hermes Command Layer

Status: completed

목표: Hermes를 pipeline 내부 step이 아니라 top-level 운영 명령으로 노출한다.

추가 명령:

```sh
harness hermes status
harness hermes plan "<request>"
harness hermes tick
```

기능:

- `status`
  - 최근 runs 요약
  - 성공/실패/불완전 run 개수
  - 최근 Hermes decision 요약
  - 최근 validation 실패 요약
  - cleanup 상태 요약
- `plan`
  - 요청을 실행하지 않고 pipeline, agent, validation 전략을 제안
  - rule-based로 시작
  - 추후 memory 기반으로 확장
- `tick`
  - 현재 처리할 task queue가 있는지 확인
  - Phase 1에서는 queue가 없으면 명확히 “no tasks” 보고

완료 조건:

- Done: `harness hermes status`가 runs manifest를 읽어 요약한다.
- Done: `harness hermes plan "..."`이 실행 계획 JSON과 사람이 읽을 summary를 출력한다.
- Done: `harness hermes tick`이 현재 queue 없음 상태를 안정적으로 보고한다.
- Done: README와 이 문서가 갱신된다.
- Done: 테스트가 추가된다.

작업 단위:

1. Done: `src/hermes.js` 추가
2. Done: `src/cli.js`에 `hermes` subcommand parsing 추가
3. Done: 최근 manifest reader 구현
4. Done: status summarizer 구현
5. Done: rule-based planner 구현
6. Done: tick stub 구현
7. Done: 테스트 추가
8. Done: README 갱신

### Phase 2. Task Queue

Status: completed

목표: Hermes가 처리할 작업을 파일 기반 queue로 관리한다.

제안 저장소:

```text
.harness/
  queue/
    pending/
    running/
    done/
    failed/
```

명령:

```sh
harness hermes enqueue --repo <path> --pipeline <name> "<request>"
harness hermes queue
harness hermes tick
```

task schema 초안:

```json
{
  "schemaVersion": 1,
  "taskId": "2026-07-01_120000_000",
  "repo": "/path/to/repo",
  "request": "작업 요청",
  "pipeline": "code_fix",
  "agent": "codex",
  "status": "pending",
  "createdAt": "2026-07-01T03:00:00.000Z",
  "policy": {
    "allowEdits": true,
    "allowNetwork": false,
    "requireHumanApproval": false
  }
}
```

완료 조건:

- Done: enqueue가 pending task를 생성한다.
- Done: queue가 pending/running/done/failed task를 요약한다.
- Done: tick이 pending task 하나를 실행하고 상태를 이동한다.
- Done: 실행된 task는 runId를 기록한다.
- Done: 실패한 task는 error를 기록한다.

작업 단위:

1. Done: task schema 정의
2. Done: queue fs helper 추가
3. Done: `hermes enqueue` 구현
4. Done: `hermes queue` 구현
5. Done: `hermes tick`이 pending task 처리
6. Done: task에 runId 연결
7. Done: 테스트 추가

### Phase 3. Memory Index

Status: completed

목표: 과거 run을 검색 가능한 memory로 요약한다.

제안 저장소:

```text
.harness/
  memory/
    runs.jsonl
    repos.json
    patterns.json
```

memory record 초안:

```json
{
  "runId": "2026-07-01_120000_000",
  "repo": "/path/to/repo",
  "request": "작업 요청",
  "pipeline": "code_fix",
  "completedPipeline": "safe_fix",
  "status": "succeeded",
  "validationFailures": [],
  "supervisorActions": ["escalate_to_safe_fix", "continue"],
  "changedFiles": [],
  "createdAt": "2026-07-01T03:00:00.000Z"
}
```

명령:

```sh
harness hermes memory rebuild
harness hermes memory search "<query>"
```

완료 조건:

- Done: runs manifest를 읽어 `runs.jsonl`을 재생성한다.
- Done: repo별 성공률, 실패 validation, 자주 쓰는 pipeline을 요약한다.
- Done: status 단계가 memory freshness를 표시한다.
- Done: search 명령으로 memory index를 검색한다.

작업 단위:

1. Done: memory schema 정의
2. Done: manifest-to-memory mapper 구현
3. Done: rebuild 명령 구현
4. Done: search 명령 구현
5. Done: status에서 memory freshness 표시
6. Done: 테스트 추가

### Phase 4. Memory-backed Planning

Status: completed

목표: Hermes가 과거 run을 참고해서 pipeline과 검증 전략을 추천한다.

기능:

- 유사 요청의 과거 결과 확인
- repo별 실패 패턴 반영
- `safe_fix` 승격이 자주 필요한 repo는 처음부터 `safe_fix` 추천
- validation이 자주 누락되는 repo는 설정 보강 제안
- 반복 성공 패턴을 plan rationale에 표시

완료 조건:

- Done: `hermes plan`이 memory 근거를 함께 출력한다.
- Done: memory가 없으면 rule-based fallback을 사용한다.
- Done: plan 결과가 machine-readable JSON으로 출력된다.

작업 단위:

1. Done: query-to-memory matching 구현
2. Done: repo profile 요약 구현
3. Done: plan scoring 구현
4. Done: plan output schema 정의
5. Done: 테스트 추가

### Phase 5. Policy Engine

Status: completed

목표: Hermes가 자동 실행해도 되는 작업과 사람 승인이 필요한 작업을 구분한다.

policy 예시:

```json
{
  "policy": {
    "allowAutonomousRun": true,
    "allowEdits": true,
    "allowDestructiveCommands": false,
    "protectedBranches": ["main", "production"],
    "requireApprovalFor": [
      "database migration",
      "auth",
      "payment",
      "data deletion"
    ]
  }
}
```

완료 조건:

- Done: plan/tick이 policy를 확인한다.
- Done: 위험 작업은 tick에서 실행하지 않고 failed task로 이동한다.
- Done: policy decision이 task에 남는다.
- Done: protected branch에서는 tick 자동 실행을 막고 사람 검토로 전환한다.

작업 단위:

1. Done: policy schema 정의
2. Done: request classifier 구현
3. Done: repo branch/protected branch 확인 구현
4. Done: tick 실행 전 policy gate 추가
5. Done: 테스트 추가

### Phase 6. Feedback Loop

Status: completed

목표: 사용자 피드백을 memory에 반영한다.

명령:

```sh
harness hermes feedback --run <runId> --rating good "검증 요약이 좋았음"
harness hermes feedback --run <runId> --rating bad "불필요하게 safe_fix로 승격함"
```

완료 조건:

- Done: run별 feedback 저장
- Done: memory에 feedback 반영
- Done: plan이 나쁜 패턴을 caution evidence로 반영

작업 단위:

1. Done: feedback schema 정의
2. Done: feedback command 구현
3. Done: memory rebuild에 feedback join
4. Done: plan scoring에 feedback 반영
5. Done: 테스트 추가

### Phase 7. Pattern Promotion

Status: completed

목표: 반복되는 성공/실패 패턴을 설정, prompt, policy 후보로 승격한다.

예시:

- 특정 repo에서 `npm run lint`가 매번 필요하면 `.harness.json`에 validation 추가 제안
- 특정 유형 요청에서 `safe_fix`가 반복되면 routing policy 추가 제안
- Hermes가 자주 같은 reporter instruction을 내면 reporter prompt 개선 제안

명령:

```sh
harness hermes promote --dry-run
harness hermes promote --apply
```

완료 조건:

- Done: promotion 후보를 생성한다.
- Done: `--dry-run`은 제안과 JSON만 출력한다.
- Done: `--apply`는 `.harness/promotions/` 아래 안전한 promotion 기록, promotion marker diff, `.harness.json` 후보 diff를 생성한다.
- Done: promotion 결과가 로컬 운영 기록에 남는다.

작업 단위:

1. Done: pattern detector 구현
2. Done: promotion proposal schema 정의
3. Done: dry-run 출력 구현
4. Done: apply gate 구현
5. Done: 테스트 추가
6. Done: proposal별 patch artifact 생성
7. Done: `.harness.json` 후보 변경 diff 생성

### Phase 8. Reporting and Notification

Status: completed

목표: Hermes가 운영 결과를 사용자가 원하는 채널로 보고한다.

초기 채널:

- terminal
- markdown file

추후 채널:

- Slack
- Discord
- GitHub issue/comment
- email

완료 조건:

- Done: terminal과 markdown file 채널을 지원한다.
- Done: tick 결과를 report artifact로 남긴다.
- Done: 외부 채널은 adapter 구조로 분리했다.
- Done: `webhook`, `slack`, `discord` adapter type을 지원한다.
- Done: 실제 URL/token은 env key로 주입하고, 값이 없으면 skipped로 보고한다.

작업 단위:

1. Done: report schema 정의
2. Done: markdown report writer 구현
3. Done: notification adapter interface 정의
4. Done: terminal/markdown adapter 구현
5. Done: 테스트 추가
6. Done: webhook/slack/discord adapter scaffold 구현

## 완료된 구현 순서

1차 milestone:

```text
Milestone 1: Hermes Command Layer
```

이 순서로 진행한 이유:

- 현재 구조를 크게 흔들지 않는다.
- Hermes를 top-level 운영자로 승격하는 첫 단계다.
- 이후 queue, memory, policy가 붙을 자리를 만든다.
- 실패해도 기존 `harness run` 경로에 영향이 작다.

완료된 후속 milestone:

1. Done: Task Queue
2. Done: Memory Index
3. Done: Memory-backed Planning
4. Done: Policy Engine
5. Done: Feedback Loop
6. Done: Pattern Promotion
7. Done: Reporting and Notification

## Milestone 1 상세 설계

Status: completed

### 명령

```sh
harness hermes status
harness hermes plan "<request>"
harness hermes tick
```

### `status` 출력 초안

```text
Hermes status
Runs: 42 total, 31 succeeded, 7 failed, 4 incomplete
Recent failures:
- 2026-07-01_120000_000 validation:test failed
Recent Hermes actions:
- rerun_step: 4
- run_validation: 3
- escalate_to_safe_fix: 2
Cleanup: last run skipped because cleanup disabled
```

### `plan` 출력 초안

```text
Hermes plan
Recommended pipeline: safe_fix
Recommended agent: codex
Reason:
- Request mentions authentication and tests.
- Risk is high enough to include verifier.

Decision JSON:
{
  "pipeline": "safe_fix",
  "agent": "codex",
  "requiresApproval": false,
  "validation": "use project config",
  "reason": "High-risk code change should use verifier."
}
```

### `tick` 출력 초안

Phase 1에서는 queue가 없어 idle 상태만 보고했다. Phase 2 완료 후 `tick`은 pending task가 있으면 실제 `harness run`을 실행하고 task를 `done` 또는 `failed`로 이동한다.

```text
Hermes tick
Task: 2026-07-01_120000_000
Status: done
Pipeline: quick_fix
Run: 2026-07-01_120001_000
Exit code: 0
```

### 테스트 기준

- 빈/없는 runs에서도 status가 실패하지 않는다.
- 실제 runs가 있으면 성공/실패/decision count를 계산한다.
- plan은 요청 키워드에 따라 pipeline을 추천한다.
- tick은 pending task가 없으면 idle을 보고하고, pending task가 있으면 하나를 실행한다.
- 기존 `harness run` 테스트가 깨지지 않는다.

## 선택 확장 후보

아래 항목은 1차 로드맵의 완료 조건이 아닙니다. 운영 규모가 커지거나 외부 연동이 필요해질 때 선택적으로 확장할 수 있는 후보입니다.

- task queue를 repo별로 분리할지 여부
- Hermes를 여러 repo 운영자로 확장할지 여부
- 자동 수정 허용 범위 확대 여부
- schedule을 cron으로 맡길지 `hermes tick` 호출자로 유지할지 여부
- GitHub, email 같은 추가 외부 알림 채널 필요 여부
- memory를 JSONL에서 SQLite 같은 저장소로 옮길지 여부

현재 1차 완료 상태의 선택값:

- queue는 하네스 루트 `.harness/queue`에서 시작
- memory는 JSONL로 시작
- schedule은 데몬 없이 외부 cron 또는 수동 `hermes tick`
- notification은 terminal/markdown만 먼저 지원
- 자동 수정은 policy가 명시적으로 허용할 때만 수행
- `main`, `production`은 기본 보호 브랜치로 보고 Hermes `tick` 자동 실행을 막음

## 완료의 정의

자율 운영 Hermes가 “최소 완성”되었다고 볼 수 있는 조건:

- Hermes top-level command가 있다.
- task queue가 있다.
- tick이 pending task를 실행한다.
- memory index가 있다.
- plan이 memory와 policy를 참고한다.
- 위험 작업을 자동으로 멈추고 사람 검토를 요청한다.
- 반복 패턴을 promotion 후보로 만든다.
- 모든 판단과 실행 결과가 manifest 또는 memory에 남는다.
- watch로 운영 상태를 관찰할 수 있다.

Status: satisfied

이 조건을 모두 만족했으므로 Hermes는 더 이상 pipeline 내부 감독관만이 아니라, 하네스를 운영하는 자율 운영 에이전트로 볼 수 있다.
