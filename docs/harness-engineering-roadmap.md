# Harness Engineering Roadmap

이 문서는 Multi Agent Harness를 "여러 에이전트 CLI를 순서대로 실행하는 도구"에서 "불확실한 실행 주체를 관찰 가능하고 재현 가능하고 통제 가능한 작업 단위로 감싸는 하네스"로 발전시키기 위한 개발 계획입니다.

Status: phase-1-completed, phase-2-planned

## 정의

이 프로젝트에서 하네스 엔지니어링은 다음을 의미합니다.

```text
불확실한 실행 주체를
  -> 표준 실행 계약으로 감싸고
  -> 격리된 경계 안에서 실행하며
  -> 모든 입력/출력/판단을 기록하고
  -> 독립 검증과 정책으로 통제하고
  -> 실패 시 중단, 재시도, 복구, 사람 검토로 연결하는 엔지니어링
```

여기서 불확실한 실행 주체는 Codex, Claude Code, Antigravity, 커스텀 CLI, 또는 하네스가 직접 실행하는 validation command까지 포함합니다.

## 목표 상태

목표 구조는 다음과 같습니다.

```text
request / queue task / schedule
  -> policy preflight
  -> isolated run workspace
  -> pipeline runner
    -> agent adapter contract
    -> validation contract
    -> change inspection
    -> supervisor decision
  -> approval / recovery gate
  -> report / manifest / audit log
```

하네스가 보장해야 하는 것은 에이전트의 정답성이 아닙니다. 하네스가 보장해야 하는 것은 다음입니다.

- 같은 요청이 어떤 계약으로 실행되었는지 추적할 수 있다.
- 어떤 agent/provider가 실행되었는지 교체 가능하게 남긴다.
- 어떤 파일과 명령이 영향을 받았는지 독립적으로 검사한다.
- 위험 작업은 정책으로 중단하거나 승인 흐름으로 보낸다.
- 실패한 run을 재현하거나 복구할 근거를 남긴다.

## 1차 완료 상태

Phase 1-7은 하네스 엔지니어링의 기본 골격을 만들기 위한 1차 로드맵입니다.

Status: completed

완료된 핵심 구조:

- public safety warning과 security model
- trust boundary manifest 기록
- change inspection layer
- policy gate
- worktree/patch workspace mode
- resource timeout/log limit/cancellation
- approval pending/approve/reject/resume flow
- artifact schema와 reporter machine summary

## 현재 강점

이미 구현된 하네스 엔지니어링 요소:

- 역할 기반 pipeline
- provider adapter
- run directory
- prompt/stdout/stderr/final output 저장
- manifest 기록
- validation stage
- Hermes supervisor decision JSON
- pipeline escalation/retry/validation rerun
- top-level queue, memory, feedback, promotion, report
- protected branch policy
- notification adapter

## 부족한 구조

현재 구조에서 하네스 엔지니어링 관점으로 약한 부분은 다음입니다.

### 1. Runtime Boundary

현재 `sandbox`는 주로 agent CLI에 전달되는 옵션입니다. 하네스 자체가 파일 시스템, 네트워크, 환경 변수, 프로세스 실행 경계를 강하게 보장하지는 않습니다.

필요한 것:

- temp worktree 또는 patch-only workspace
- env allowlist
- network policy
- write boundary
- command allow/deny policy
- run 종료 후 workspace 정리

### 2. Policy Enforcement

Hermes policy와 protected branch 처리는 있으나, 전체 실행 흐름을 막는 hard gate로 충분히 정교하지 않습니다.

필요한 것:

- preflight policy gate
- step별 policy gate
- validation command policy
- destructive command detection
- branch/write sandbox policy
- high-risk request approval policy

### 3. Artifact Schema

manifest는 있지만 step output은 markdown 중심입니다. 사람에게는 읽기 좋지만, 후속 자동 판단에는 느슨합니다.

필요한 것:

- agent step result schema
- change summary schema
- validation result schema 정리
- supervisor decision schema 버전 관리
- reporter output과 machine-readable summary 분리

### 4. Change Inspection

agent가 바꾼 내용을 하네스가 독립적으로 검사하는 단계가 약합니다.

필요한 것:

- git diff summary
- changed files list
- file allow/deny rule
- secret scan
- dependency/lockfile change detection
- generated artifact detection
- risky file change detection

### 5. Recovery Model

실패 기록은 남지만, 실패 후 되돌리거나 이어서 승인하는 흐름은 약합니다.

필요한 것:

- temp branch/worktree execution
- patch artifact mode
- rollback metadata
- resume after approval
- failed run reproduction command

### 6. Resource Control

외부 CLI와 validation command가 오래 돌거나 로그를 과도하게 만들 수 있습니다.

필요한 것:

- step timeout
- validation timeout
- max log size
- process cancellation
- heartbeat
- stuck process cleanup

### 7. Human Approval

`request_human_review`는 있지만, 승인 후 계속 진행하는 명확한 UX가 없습니다.

필요한 것:

- approval pending task state
- approve/reject command
- approval reason 기록
- approval 후 resume
- denied task report

### 8. Trust Boundary Documentation

공개 저장소가 되려면 사용자가 어떤 입력을 신뢰해야 하는지 명확해야 합니다.

필요한 것:

- security model 문서
- `.harness.json` 임의 명령 실행 경고
- runs/logs secret leakage 경고
- untrusted repo 실행 금지
- public release checklist

## 1차 개발 단계

### Phase 1. Public Safety Baseline

목표: 공개 가능한 수준의 경고, 신뢰 경계, 실행 계약을 문서화하고 최소 보호 장치를 추가합니다.

작업:

1. Done: README에 `Experimental`, `Local-first`, `Runs arbitrary commands` 경고 추가
2. Done: `docs/security-model.md` 추가
3. Done: `.gitignore`에 `runs/`, `.harness/`, env 파일 제외 확인
4. Skipped: LICENSE 추가 여부 결정
5. Done: `harness doctor`에 주요 위험 설정 점검 추가
6. Done: manifest에 `trustBoundary` 또는 `warnings` 필드 추가

완료 조건:

- 사용자가 신뢰하지 않는 repo에서 실행하면 안 되는 이유를 README에서 바로 볼 수 있다.
- `.harness.json`과 validation command가 임의 명령 실행 표면이라는 점이 명시되어 있다.
- public release 전 체크리스트가 문서에 존재한다.

### Phase 2. Change Inspection Layer

목표: agent 실행 후 하네스가 독립적으로 변경 내용을 검사합니다.

작업:

1. Done: `src/inspection.js` 추가
2. Done: git status 기반 changed files 생성
3. Done: `git diff --stat`, `git diff --name-status` 저장
4. Done: lockfile/package/dependency 변경 감지
5. Done: secret 후보 문자열 scan
6. Done: inspection 결과를 manifest에 기록
7. Done: Hermes prompt에 inspection 결과 주입

완료 조건:

- coder step 이후 변경 파일과 diff stat이 manifest에 남는다.
- 위험 파일 변경이 supervisor 판단 근거로 들어간다.
- secret 후보가 있으면 기본적으로 human review로 보낸다.

### Phase 3. Policy Gate

목표: 정책을 "추천"이 아니라 실행 흐름을 막는 gate로 승격합니다.

작업:

1. Done: policy schema 정의
2. Done: run preflight에서 policy evaluate
3. Deferred: step 실행 전 policy evaluate
4. Deferred: validation command policy evaluate
5. Deferred: protected branch에서는 write sandbox 차단
6. Partial: destructive 작업은 direct run에서 차단, high-risk 작업은 설정으로 차단 가능
7. Done: policy decision을 manifest와 task에 기록

완료 조건:

- 정책 위반 작업은 agent 실행 전에 멈춘다.
- dry-run, read-only, approval-required 상태가 명확히 구분된다.
- Hermes top-level queue와 `harness run`의 정책 판단이 일관된다.

### Phase 4. Isolated Workspace

목표: 대상 repo를 직접 수정하지 않는 실행 모드를 제공합니다.

작업:

1. Done: `--workspace-mode direct|worktree|patch` 옵션 설계
2. Done: git worktree 기반 isolated run 구현
3. Done: patch artifact 생성
4. Done: direct mode와 worktree mode의 manifest 구분
5. Partial: patch mode는 worktree를 제거하고, worktree mode는 산출물 확인을 위해 남김
6. Done: README에 workspace mode별 위험도 문서화

완료 조건:

- 기본값을 direct로 유지하더라도 worktree/patch 모드가 선택 가능하다.
- worktree mode에서는 실패한 run이 대상 working tree를 오염시키지 않는다.
- patch mode에서는 agent 변경을 바로 적용하지 않고 artifact로 남길 수 있다.

### Phase 5. Resource Control

목표: 외부 process가 하네스를 멈추게 하지 않도록 제한합니다.

작업:

1. Done: agent step timeout
2. Done: validation timeout
3. Done: timeout 시 process kill
4. Done: stdout/stderr max size
5. Done: last output timestamp 기록
6. Done: cancellation signal 처리
7. Done: timeout 테스트 추가

완료 조건:

- 무한 실행되는 agent/validation이 run을 영구 점유하지 않는다.
- timeout 원인과 로그 위치가 manifest에 남는다.
- 강제 종료된 step은 reporter가 명확히 보고한다.

### Phase 6. Approval and Resume

목표: 사람 검토가 필요한 작업을 중단에서 끝내지 않고 승인/거절/재개할 수 있게 합니다.

작업:

1. Done: approval pending task 상태 추가
2. Done: `harness hermes approve --task <id>` 추가
3. Done: `harness hermes reject --task <id>` 추가
4. Done: approval reason 기록
5. Done: 승인 후 `tick`이 이어서 실행
6. Done: 거절된 작업을 rejected 상태로 기록

완료 조건:

- policy가 막은 작업을 사람이 승인하면 이어서 실행할 수 있다.
- 거절된 작업은 실패와 구분되어 기록된다.
- 승인 기록이 manifest/task/report에 남는다.

### Phase 7. Schema Hardening

목표: 사람이 읽는 산출물과 기계가 읽는 산출물을 분리합니다.

작업:

1. Done: manifest schema versioning 문서화
2. Done: step result schema 문서화
3. Done: supervisor decision schema 문서화
4. Done: reporter machine summary block 추가
5. Done: schema validation 테스트 추가
6. Done: invalid schema 처리 정책 정리

완료 조건:

- downstream 도구가 manifest와 step summary를 안정적으로 읽을 수 있다.
- schema 변경 시 migration 또는 compatibility 정책이 있다.
- public docs에서 artifact contract를 확인할 수 있다.

## 우선순위

공개 전 최소 우선순위:

1. Phase 1. Public Safety Baseline
2. Phase 2. Change Inspection Layer
3. Phase 3. Policy Gate

운영 품질 우선순위:

1. Phase 4. Isolated Workspace
2. Phase 5. Resource Control
3. Phase 6. Approval and Resume
4. Phase 7. Schema Hardening

## 공개 전 체크리스트

- [ ] README 상단에 실험적 로컬 하네스라는 설명이 있다.
- [ ] 신뢰하지 않는 repo/config에서 실행하지 말라는 경고가 있다.
- [ ] `.harness.json`과 validation command가 임의 명령 실행 표면임을 명시했다.
- [ ] `runs/`와 `.harness/`가 커밋되지 않는다.
- [ ] 실제 업무 로그, 절대경로, token, secret, private 요청이 repo에 남아 있지 않다.
- [ ] LICENSE가 있다.
- [ ] mock agent 기반 demo 또는 dry-run 예시가 있다.
- [ ] 실패와 한계가 README에 과장 없이 설명되어 있다.

## 비목표

현재 목표가 아닌 것:

- 자체 coding agent 구현
- correctness 보장
- 완전한 보안 sandbox 보장
- cloud service화
- 모든 provider별 고급 기능 통합

이 프로젝트의 우선 목표는 provider 자체를 대체하는 것이 아니라, provider가 한 작업을 더 안전하게 실행하고 더 잘 관찰할 수 있게 만드는 것입니다.

## 2차 개발 단계

Phase 8 이후는 기본 하네스 골격이 아니라 유지보수성, 시연성, 운영 편의성을 높이는 후속 로드맵입니다.

### Phase 8. Runner / Hermes Refactor

Status: completed

목표: `src/cli.js`와 `src/hermes.js`에 몰린 실행/운영 책임을 모듈 경계별로 분리합니다.

현재 문제:

- `src/cli.js`가 CLI 인자 처리, workspace, policy, manifest, pipeline loop, supervisor decision, reporter summary까지 함께 담당합니다.
- `src/hermes.js`가 queue, memory, promotion, report, planning, tick runner, feedback, command routing까지 함께 담당합니다.
- 기능은 동작하지만 다음 기능을 추가할수록 회귀 위험이 커집니다.

분리 후보:

1. `src/workspace.js`
   - `direct|worktree|patch` workspace 준비/마무리
   - patch artifact 생성
2. `src/supervisor.js`
   - Hermes decision normalize/parse
   - supervisor instruction rendering
3. `src/reporter-summary.js`
   - reporter summary normalize/parse
4. `src/resources.js`
   - resource config 기본값과 project config merge
5. `src/runner.js`
   - pipeline execution loop
   - step retry/escalation/validation/inspection coordination
6. `src/manifest.js`
   - manifest 생성/저장 helper
7. `src/hermes-*.js`
   - Hermes queue, memory, promotion, report, planner, feedback, tick, command 책임 분리

완료 조건:

- `src/cli.js`는 CLI 인자와 command routing 중심으로 줄어든다.
- `src/hermes.js`는 호환 export hub 수준으로 줄어든다.
- 기존 `npm run check`, `npm test`가 통과한다.
- manifest shape와 run behavior가 유지된다.

진행 상태:

- Done: `src/workspace.js` 분리
- Done: `src/reporter-summary.js` 분리
- Done: `runCapture` 공통 helper를 `src/fs-utils.js`로 이동
- Done: `src/supervisor.js` 분리
- Done: `src/resources.js` 분리
- Done: `src/git.js` 분리
- Done: `src/manifest.js` 기본 저장 helper 분리
- Done: `src/runner.js` 분리
- Done: `src/hermes-queue.js` 분리로 Hermes queue/approval 저장소 책임 이동
- Done: `src/hermes-memory.js` 분리로 Hermes memory rebuild/search/profile 책임 이동
- Done: `src/hermes-promotion.js` 분리로 Hermes promotion proposal/patch artifact 책임 이동
- Done: `src/hermes-config.js` 분리로 project `.harness.json` 읽기 책임 공유
- Done: `src/hermes-report.js` 분리로 Hermes status/report 생성과 포맷 책임 이동
- Done: `src/hermes-planner.js` 분리로 Hermes request planning/plan format 책임 이동
- Done: `src/hermes-feedback.js` 분리로 Hermes feedback 저장/포맷 책임 이동
- Done: `src/hermes-enqueue.js` 분리로 Hermes task enqueue 책임 이동
- Done: `src/hermes-tick.js` 분리로 Hermes tick runner/notification 책임 이동
- Done: `src/hermes-command.js` 분리로 Hermes subcommand routing 책임 이동

완료 상태:

- `src/cli.js`는 `run`/`hermes` command routing 중심으로 축소되었다.
- `src/hermes.js`는 기존 import 호환을 위한 export hub로 축소되었다.
- Hermes 운영 책임은 queue, memory, promotion, report, planner, feedback, enqueue, tick, command 모듈로 분리되었다.

### Phase 9. Demo / Showcase Mode

Status: completed

목표: 주변 사람에게 구조를 보여주기 쉬운 최소 demo flow를 제공합니다.

작업 후보:

1. Done: `demos/showcase` mock agent demo project 추가
2. Done: demo README 추가
3. Done: `--workspace-mode patch` demo command 정리
4. Done: approval flow demo command 정리
5. Done: sample manifest/report/patch 확인 포인트 설명
6. Done: `scripts/create-showcase-demo.cjs`로 임시 git demo repo 생성

완료 조건:

- Done: 5분 안에 하네스 구조를 보여줄 수 있는 demo path가 있다.
- Done: 실제 Codex/Claude CLI 없이도 mock agent로 흐름을 볼 수 있다.

### Phase 10. Manifest Viewer / Report UX

Status: completed

목표: 사용자가 manifest JSON을 직접 열지 않고 run 결과를 확인할 수 있게 합니다.

작업 후보:

1. Done: `harness show --latest`
2. Done: `harness show <runId>`
3. Done: `harness show --json <runId>`
4. Done: changed files, validation, Hermes decision, reporter summary 요약
5. Done: patch/worktree path 표시
6. Done: `test/show-command.test.js` 회귀 테스트 추가

완료 조건:

- Done: 최신 run 상태를 한 명령으로 사람이 읽기 좋게 볼 수 있다.
- Done: downstream 도구는 `--json`으로 안정적인 summary를 받을 수 있다.

### Phase 11. Config Validation

Status: completed

목표: `.harness.json` 설정 오류를 실행 전에 명확히 잡습니다.

작업 후보:

1. Done: config schema 문서화
2. Done: pipeline 이름 검증
3. Done: workspace mode 검증
4. Done: resources 숫자 검증
5. Done: validation command shape 검증
6. Done: custom agent command/args 검증
7. Done: `doctor`와 `run` preflight에 연결
8. Done: `test/config-validation.test.js` 회귀 테스트 추가

완료 조건:

- Done: 잘못된 설정은 agent 실행 전에 구체적인 오류로 중단된다.
- Done: `doctor`가 설정 경고를 한 번에 보여준다.

### Phase 12. Runtime Cleanup / Worktree Management

Status: completed

목표: isolated workspace와 runtime artifact를 관리하기 쉽게 합니다.

작업 후보:

1. Done: manifest에 기록된 active isolated worktree 탐지
2. Done: `harness clean --worktrees`
3. Done: run별 workspace cleanup 결과를 manifest에 반영
4. Done: patch/worktree 보존 정책 문서화
5. Done: `test/clean-worktrees.test.js` 회귀 테스트 추가

완료 조건:

- Done: 오래된 worktree 산출물을 안전하게 정리할 수 있다.
- Done: patch mode와 worktree mode의 보존 정책이 명확하다.

### Phase 13. Provider Adapter Hardening

Status: completed

목표: provider별 CLI adapter 계약을 더 명확히 합니다.

작업 후보:

1. Done: provider capability 표시
2. Done: provider별 default timeout
3. Done: output mode 검증
4. Done: version compatibility warning
5. Done: custom provider doctor
6. Done: env allowlist는 runtime runner 계약에서 검토

완료 조건:

- Done: provider 연결 실패가 더 빨리, 더 명확히 드러난다.
- Done: custom provider 설정의 오류를 실행 전에 잡는다.

### Phase 14. Container Runner

Status: completed

목표: 필요한 경우 Docker/container 기반 runner를 선택 확장으로 제공합니다.

작업 후보:

1. Done: `--runner local|docker` 설계
2. Done: repo/runDir bind mount 정책 결정
3. Done: env allowlist 설계
4. Done: agent CLI 인증 방식 문서화
5. Done: network policy 검토

완료 조건:

- Done: 기본 실행 모델은 local-first를 유지한다.
- Done: container runner는 강한 격리가 필요한 환경의 선택 옵션으로만 제공된다.
