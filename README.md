# Multi Agent Harness

여러 CLI 에이전트를 같은 파이프라인 계약으로 실행하기 위한 오케스트레이션 하네스입니다.

이 프로젝트는 Codex 전용 wrapper가 아닙니다. 하네스가 요청, 역할별 프롬프트, 에이전트 실행, 검증, Hermes 감독, 최종 보고, 로그/manifest 기록을 관리하고, 실제 추론과 수정 작업은 선택한 CLI 에이전트가 수행합니다.

## 핵심 개념

- **Agent adapter**: `codex`, `claude`, `antigravity`, 커스텀 CLI를 같은 실행 인터페이스로 감쌉니다.
- **Pipeline**: 요청 성격에 따라 planner, coder, qa, verifier, hermes, reporter 같은 역할을 순서대로 실행합니다.
- **Validation**: 대상 프로젝트의 `.harness.json`에 정의한 build/test/validation 명령을 하네스가 직접 실행합니다.
- **Hermes supervisor**: 작업자 결과와 검증 결과를 읽고 다음 행동을 결정하는 감독관 에이전트입니다.
- **Hermes operator**: task queue, memory, policy, feedback, promotion, report를 관리하는 top-level 운영 명령입니다.
- **Manifest**: run마다 요청, 설정, git 상태, 단계 결과, Hermes 결정, cleanup 결과를 `runs/<runId>/manifest.json`에 남깁니다.
- **Runs archive**: prompt, stdout/stderr 로그, 최종 markdown 산출물을 `runs/` 아래에 보관합니다.

## 빠른 시작

대상 프로젝트에 기본 설정 파일을 만듭니다.

```sh
node ./bin/harness init-project --repo /path/to/project
```

하네스를 실행합니다.

```sh
node ./bin/harness run --repo /path/to/project --pipeline code_fix --agent codex "작업 요청"
```

전역 CLI로 연결했다면 `harness` 명령을 바로 사용할 수 있습니다.

```sh
npm link
harness doctor --repo /path/to/project --agent codex
harness run --repo /path/to/project --pipeline safe_fix --agent codex "검증까지 안전하게 처리해줘"
```

실제 에이전트를 실행하지 않고 prompt와 manifest 생성만 확인하려면 `--dry-run`을 붙입니다.

```sh
node ./bin/harness run --repo . --pipeline safe_fix --dry-run "Hermes 동작 확인"
```

Hermes를 top-level 운영자로 사용할 수도 있습니다.

```sh
harness hermes enqueue --repo . --pipeline quick_fix "작업 요청"
harness hermes tick
harness hermes report
```

설계와 진행 이력은 [docs/Hermes Autonomous Operations Roadmap](docs/hermes-autonomy-roadmap.md)에 정리되어 있습니다.

## 명령어

```sh
harness run --repo <path> [--pipeline <name>] [--agent <provider>] "<request>"
harness doctor [--repo <path>] [--agent <provider>]
harness hermes <status|plan|enqueue|queue|tick|memory|feedback|promote|report> [request]
harness init-project --repo <path>
harness install-ide-task --repo <path>
harness watch [--interval <ms>] [--once] [--include-existing]
harness clean [--days <n>] [--keep <n>] [--dry-run]
```

- `run`: 파이프라인을 실행합니다.
- `doctor`: 에이전트 CLI 연결 상태를 확인합니다.
- `hermes`: Hermes top-level 운영 명령을 실행합니다.
- `init-project`: 대상 프로젝트에 `.harness.json` 기본 파일을 만듭니다.
- `install-ide-task`: 대상 프로젝트의 `.vscode/tasks.json`에 `Harness: Run` 작업을 추가합니다.
- `watch`: `runs/`의 manifest 변화를 관찰하며 run, step, validation, Hermes decision, 완료 상태를 터미널에 표시합니다.
- `clean`: 오래된 `runs/` 디렉터리를 `runs/.trash/`로 이동합니다.

## 파이프라인

파이프라인은 [config/pipelines.json](config/pipelines.json)에 정의되어 있습니다.

| Pipeline | 흐름 | 용도 |
| --- | --- | --- |
| `quick_fix` | coder -> validation -> hermes -> reporter | 작고 명확한 수정 |
| `code_fix` | planner -> coder -> validation -> qa -> hermes -> reporter | 일반적인 코드 변경 |
| `safe_fix` | planner -> coder -> validation -> qa -> verifier -> hermes -> reporter | 위험하거나 중요한 변경 |
| `review_only` | reviewer -> verifier -> hermes -> reporter | 파일 수정 없는 리뷰 |

기본 파이프라인은 `code_fix`입니다. 변경 영향이 작으면 `quick_fix`, 검증과 주장 확인이 중요하면 `safe_fix`, 읽기 전용 검토는 `review_only`를 사용합니다.

## Hermes Supervisor

`hermes`는 작업자 에이전트를 감시하고 다음 흐름을 결정하는 감독관입니다. 단순 요약자가 아니라 하네스가 읽을 수 있는 decision JSON을 출력하고, 하네스는 그 결정을 실제 실행 흐름에 반영합니다.

Hermes가 사용할 수 있는 액션은 다음과 같습니다.

- `continue`: 최종 보고 단계로 진행합니다.
- `run_validation`: 설정된 validation 명령만 다시 실행한 뒤 Hermes 판단으로 돌아갑니다.
- `escalate_to_safe_fix`: 현재 파이프라인을 `safe_fix`로 승격하고 더 강한 흐름을 다시 실행합니다.
- `rerun_step`: 이전 worker 하나를 제한된 횟수 안에서 다시 실행합니다.
- `stop_failed`: reporter가 실패 상태를 보고하게 한 뒤 하네스 실행을 실패로 종료합니다.
- `request_human_review`: reporter가 사람 검토 필요 상태를 보고하게 한 뒤 하네스 실행을 실패로 종료합니다.

Hermes 결정은 `manifest.json`의 `supervisorDecisions`에 기록됩니다. 파이프라인 승격은 `pipelineChanges`에 기록됩니다.

Hermes 출력의 마지막에는 아래 형식의 fenced JSON block이 있어야 합니다.

```json
{
  "status": "success",
  "nextAction": "continue",
  "targetStep": null,
  "reason": "Validation passed and no blocking risks remain.",
  "instructions": "Report the changed files and validation result."
}
```

하네스는 decision schema를 검증합니다. 파싱할 수 없거나 지원하지 않는 액션이면 `request_human_review`로 처리하고 manifest에 schema 오류를 남깁니다.

## Hermes Command Layer

Hermes를 pipeline 내부 supervisor step이 아니라 top-level 운영 명령으로도 사용할 수 있습니다.

```sh
harness hermes status
harness hermes plan "인증 로직을 안전하게 수정해줘"
harness hermes enqueue --repo . --pipeline quick_fix "작업 요청"
harness hermes queue
harness hermes tick
harness hermes memory rebuild
harness hermes memory search "인증"
harness hermes feedback --run <runId> --rating good "요약과 검증이 좋았음"
harness hermes promote --dry-run
harness hermes promote --apply
harness hermes report
```

- `status`: 최근 `runs/` manifest를 읽어 성공/실패 상태, Hermes decision, validation 실패, cleanup 상태를 요약합니다.
- `plan`: 요청을 실행하지 않고 rule-based preflight로 pipeline과 agent 전략을 추천합니다.
- `enqueue`: 파일 기반 task queue에 작업을 추가합니다.
- `queue`: pending/running/done/failed task 상태를 요약합니다.
- `tick`: pending task 하나를 꺼내 `harness run`으로 실행하고 done/failed로 이동합니다. 대상 repo가 보호 브랜치면 실행하지 않고 사람 검토가 필요한 failed task로 이동합니다.
- `memory rebuild`: `runs/` manifest를 `.harness/memory/runs.jsonl`과 repo 요약으로 재생성합니다.
- `memory search`: memory index에서 요청, repo, pipeline, status, Hermes action 기준으로 검색합니다.
- `feedback`: 특정 run에 대한 사용자 평가를 저장하고 memory rebuild 시 plan 근거에 반영합니다.
- `promote`: 반복되는 safe_fix 승격, validation 실패, bad feedback을 설정/policy/prompt 개선 후보로 승격합니다. `--dry-run`은 제안만 출력하고, `--apply`는 promotion 기록과 `.harness.json` 후보 변경을 담은 patch artifact를 `.harness/promotions/`에 남깁니다.
- `report`: 현재 Hermes 운영 상태를 terminal에 요약하고 markdown 리포트를 `.harness/reports/`에 남깁니다.

`plan`은 사람이 읽을 수 있는 요약과 함께 machine-readable JSON을 출력합니다. memory index가 있고 `--repo`를 함께 넘기면 과거 run과 repo profile을 근거로 추천을 보강합니다.

```sh
harness hermes memory rebuild
harness hermes plan --repo /path/to/project "인증 로직을 안전하게 수정해줘"
```

task queue는 하네스 루트의 `.harness/queue/` 아래에 저장됩니다. 이 디렉터리는 로컬 운영 상태이므로 커밋 대상이 아닙니다.
memory index는 하네스 루트의 `.harness/memory/` 아래에 저장됩니다. `runs/`를 원자료로 다시 만들 수 있는 파생 데이터입니다.
feedback은 하네스 루트의 `.harness/feedback/` 아래에 저장됩니다. `bad` feedback이 있는 유사 run은 이후 plan에서 caution evidence로 표시됩니다.
promotion 기록은 하네스 루트의 `.harness/promotions/` 아래에 저장됩니다. `--apply`도 프로젝트 설정과 prompt를 직접 수정하지 않고, 대상 repo에서 검토 후 적용할 수 있는 `.harness.json` 후보 diff와 promotion marker 파일 diff를 `.patch`로 함께 남깁니다.
report artifact는 하네스 루트의 `.harness/reports/` 아래에 저장됩니다. `hermes tick`은 idle, done, failed 결과마다 tick report를 자동으로 남깁니다.
외부 알림은 `hermes.notifications.channels`에 adapter를 설정하면 `tick` 결과와 report path를 전송합니다. env key가 없으면 실패하지 않고 skipped로 기록됩니다.

## 프로젝트 설정

대상 프로젝트 루트에 `.harness.json`을 둘 수 있습니다.

```json
{
  "pipeline": "code_fix",
  "agent": {
    "provider": "codex"
  },
  "buildCommand": "npm run build",
  "testCommand": "npm test",
  "validationCommands": [],
  "supervisor": {
    "enabled": true,
    "maxSupervisorTurns": 3,
    "maxStepRetries": 1,
    "agent": {
      "provider": "codex"
    }
  },
  "cleanup": {
    "enabled": false,
    "days": 7,
    "keep": 20
  },
  "protectedBranches": ["main", "production"]
}
```

CLI 옵션이 `.harness.json`보다 우선합니다.

```sh
node ./bin/harness run --repo /path/to/project --agent claude "작업 요청"
```

### Validation 설정

`buildCommand`, `testCommand`, `validationCommands`는 validation 단계에서 사용됩니다. 실행 순서는 다음과 같습니다.

1. `buildCommand`
2. `testCommand`
3. `validationCommands`

예시:

```json
{
  "buildCommand": "npm run build",
  "testCommand": "npm test",
  "validationCommands": [
    "npm run lint",
    {
      "id": "typecheck",
      "command": "npm run typecheck"
    }
  ]
}
```

validation 명령이 하나도 없으면 manifest에 `skipped`로 기록됩니다.

### Protected Branch 설정

Hermes `tick`은 task를 실행하기 직전에 대상 repo의 현재 git branch를 확인합니다. 현재 branch가 `protectedBranches`에 포함되면 자동 실행하지 않고 failed task로 이동하며 사람 검토가 필요하다고 보고합니다.

```json
{
  "protectedBranches": ["main", "production"]
}
```

설정이 없으면 기본값으로 `main`, `production`을 보호 브랜치로 봅니다. git branch를 확인할 수 없는 repo에서는 이 정책만으로 실행을 막지 않습니다.

### Notification 설정

Hermes는 기본적으로 terminal과 markdown report를 사용합니다. 외부 alert 채널은 `.harness.json`에 adapter 구조만 설정해두고, 실제 URL이나 토큰은 환경변수로 주입합니다.

```json
{
  "hermes": {
    "notifications": {
      "channels": [
        {
          "name": "harness-alerts",
          "type": "webhook",
          "urlEnv": "HERMES_ALERT_WEBHOOK_URL",
          "events": ["tick.failed"]
        },
        {
          "name": "team-slack",
          "type": "slack",
          "urlEnv": "HERMES_SLACK_WEBHOOK_URL",
          "events": ["tick.failed", "tick.done"]
        }
      ]
    }
  }
}
```

지원되는 초기 adapter type은 `webhook`, `slack`, `discord`입니다.

- `webhook`: Hermes event payload를 JSON으로 POST합니다.
- `slack`: Slack incoming webhook 형식으로 text를 보냅니다.
- `discord`: Discord webhook 형식으로 content를 보냅니다.

채널 env가 없거나 event가 구독 대상이 아니면 Hermes는 알림을 보내지 않고 `Notifications: skipped ...`로 보고합니다.

### Supervisor 설정

```json
{
  "supervisor": {
    "enabled": true,
    "maxSupervisorTurns": 3,
    "maxStepRetries": 1,
    "agent": {
      "provider": "codex"
    }
  }
}
```

- `enabled`: `false`면 `hermes` 단계를 건너뜁니다.
- `maxSupervisorTurns`: Hermes가 판단할 수 있는 최대 턴 수입니다.
- `maxStepRetries`: 같은 worker를 다시 실행할 수 있는 최대 횟수입니다.
- `agent`: Hermes 단계만 별도 provider/CLI로 실행합니다. 생략하면 기본 `agent`를 사용합니다.

역할별 agent가 더 필요하면 `agents.<stepId>`에 같은 형식의 설정을 둘 수 있습니다.

```json
{
  "agents": {
    "qa": {
      "provider": "claude"
    }
  }
}
```

### Cleanup 설정

자동 청소를 켜려면 `cleanup.enabled`를 `true`로 설정합니다.

```json
{
  "cleanup": {
    "enabled": true,
    "days": 7,
    "keep": 20
  }
}
```

자동 청소 훅은 하네스 run이 끝난 뒤 실행됩니다.

- 현재 run은 항상 제외합니다.
- `--dry-run`으로 실행한 경우 cleanup도 dry-run으로 수행합니다.
- cleanup 결과는 `manifest.json`의 `cleanup` 필드에 기록됩니다.
- cleanup 실패는 manifest에 남지만 이미 끝난 작업 결과를 덮어쓰지는 않습니다.

## 커스텀 에이전트

기본 provider 외의 CLI도 붙일 수 있습니다.

```json
{
  "agent": {
    "provider": "my-agent",
    "command": "my-agent",
    "versionArgs": ["--version"],
    "outputMode": "stdout",
    "args": ["run", "--repo", "{{repo}}", "--prompt-file", "{{promptPath}}"]
  }
}
```

`args`에서 사용할 수 있는 placeholder:

- `{{repo}}`
- `{{prompt}}`
- `{{promptPath}}`
- `{{finalPath}}`
- `{{stepId}}`

`outputMode`는 두 가지입니다.

- `stdout`: 에이전트 stdout을 단계 결과 markdown으로 저장합니다.
- `file`: 에이전트가 `{{finalPath}}` 또는 자체 옵션으로 결과 파일을 직접 쓰는 방식입니다.

현재 내장 provider의 기본 실행 형태:

- `codex`: `codex exec --cd <repo> --sandbox <mode> --json --output-last-message <file>`
- `claude`: `claude -p <prompt> --output-format text`
- `antigravity`: `antigravity run --prompt <prompt>`

CLI 버전이나 조직 정책에 따라 지원 옵션이 다를 수 있습니다. 실패하면 먼저 `harness doctor`와 해당 CLI의 `--help`를 확인합니다.

## Runs와 Manifest

각 실행은 `runs/<runId>/` 아래에 산출물을 남깁니다.

대표 파일:

- `request.txt`: 사용자 요청 원문
- `manifest.json`: 실행 설정, 단계 결과, git snapshot, Hermes 결정, cleanup 결과
- `<step>.prompt.md`: 각 step에 전달한 prompt
- `<step>.<agent>.stdout.log`: step stdout 로그
- `<step>.<agent>.stderr.log`: step stderr 로그
- `<step>.md`: step 최종 markdown 산출물

`manifest.json`에는 다음 정보가 포함됩니다.

- `runId`, `repo`, `request`, `pipeline`, `completedPipeline`
- agent provider, command, version
- `projectConfig`, `validationCommands`, `supervisor`
- 실행 전후 `git`, `gitAfter` snapshot
- `steps`
- `supervisorDecisions`
- `pipelineChanges`
- `cleanup`
- 최종 `status`

## Watch 모드

하네스 전용 터미널을 열어두고 다른 터미널이나 IDE에서 실행되는 하네스 run을 관찰하려면 `watch`를 사용합니다.

```sh
harness watch
```

로컬 개발 중에는 다음처럼 실행할 수 있습니다.

```sh
node ./bin/harness watch --interval 1000
```

표시되는 이벤트 예시:

```text
[run] 2026-06-30_215720_830 pipeline=safe_fix repo=/path/to/project
[step] planner succeeded agent=codex
[step] coder succeeded agent=codex
[validation] validation:test failed exit=1
[hermes] rerun_step status=incomplete target=coder reason="Validation failed."
[pipeline] code_fix -> safe_fix reason="Verifier coverage is needed."
[done] 2026-06-30_215720_830 status=succeeded
```

기본적으로 이미 끝난 과거 run은 처음에 쏟아내지 않고, 새 run과 진행 중인 run 변화를 보여줍니다. 과거 run까지 한 번에 확인하려면 `--include-existing`을 사용합니다.

```sh
node ./bin/harness watch --once --include-existing
```

- `--interval <ms>`: polling 주기를 지정합니다. 기본값은 `1000`입니다.
- `--once`: 한 번만 스캔하고 종료합니다. 테스트나 상태 확인에 유용합니다.
- `--include-existing`: 이미 끝난 run도 출력합니다.

## Runs 청소

`runs/`는 기본적으로 `.gitignore`에 포함되어 있습니다. 요청 원문, 로컬 절대경로, 에이전트 로그가 들어가므로 커밋하지 않는 편이 안전합니다.

오래된 실행 로그는 아래 명령으로 정리합니다.

```sh
harness clean --days 7 --keep 5
harness clean --days 7 --keep 5 --dry-run
```

조건은 두 가지를 모두 만족해야 합니다.

- 최신 run `keep`개에 포함되지 않아야 합니다.
- run timestamp가 `days`일보다 오래되어야 합니다.

대상 run은 삭제하지 않고 `runs/.trash/`로 이동합니다.

## IDE 대화에서 하네스 사용하기

`.harness.json`은 하네스 실행 설정입니다. 이것만으로 Codex IDE 대화가 자동으로 하네스를 호출하지는 않습니다.

IDE에서 사용자가 "하네스를 활용해서 작업을 수행해"라고 말했을 때 하네스를 태우려면 대상 프로젝트의 `AGENTS.md`에 라우팅 규칙이 있어야 합니다.

권장 섹션:

````md
## Harness Routing

사용자가 "하네스로", "하네스를 활용해서", "하네스 태워서", "quick_fix로", "code_fix로", "safe_fix로", "review_only로", "검증까지"라고 명시하면 직접 파일을 수정하지 말고 먼저 하네스를 실행한다.

실행 전 연결 상태를 확인한다.

```sh
harness doctor --repo . --agent codex
```

그 다음 요청 성격에 맞는 파이프라인으로 실행한다.

```sh
harness run --repo . --pipeline code_fix --agent codex "<사용자 요청>"
```

파이프라인 기준:

- `quick_fix`: 작고 명확한 수정
- `code_fix`: 일반적인 코드 변경
- `safe_fix`: 위험하거나 큰 변경
- `review_only`: 파일 수정 없는 리뷰

하네스 실행 후에는 `runs/<runId>/manifest.json`과 reporter 산출물을 확인해 사용자에게 요약한다.
````

하네스 내부 step prompt에는 nested harness 실행 방지 문구가 들어 있습니다. 이미 하네스 안에서 실행 중인 step은 다시 `harness doctor`나 `harness run`을 호출하지 않아야 합니다.

## 언제 하네스를 사용할까

하네스는 모든 대화를 자동으로 처리하는 장치가 아닙니다. 코드 변경과 검증을 재현 가능하게 만들기 위한 실행 장치입니다.

바로 하네스를 쓰기 좋은 경우:

- 사용자가 "하네스로", "하네스 태워서", "`safe_fix`로"처럼 명시한 경우
- 여러 파일을 수정해야 하는 작업
- 테스트, 빌드, lint 등 검증이 중요한 작업
- 보안, 인증, 결제, 데이터 삭제, 마이그레이션 등 위험도가 높은 작업
- 큰 리팩토링이나 구조 변경
- 커밋, 배포 전 최종 점검
- 에이전트 출력의 환각 여부를 별도 검증해야 하는 작업

직접 대화로 처리하는 편이 좋은 경우:

- 개념 설명, 사용법 안내, 에러 메시지 해석
- 레포명 추천, 설계 토론, 의사결정 대화
- 단일 파일의 아주 작은 문구 수정
- 하네스 자체의 라우팅 규칙을 논의하거나 수정하는 메타 작업
- 사용자가 "하네스 없이", "직접 해줘", "답변만 해줘"라고 말한 경우

## 개발과 테스트

문법과 기본 로딩 검증:

```sh
npm run check
```

Hermes controller 회귀 테스트:

```sh
npm test
```

`npm test`는 mock agent를 사용해 다음 경로를 검증합니다.

- Hermes가 `rerun_step`으로 worker를 재실행
- Hermes가 `run_validation`으로 validation만 재실행
- Hermes가 `escalate_to_safe_fix`로 파이프라인 승격
- Hermes 전용 supervisor agent 사용
- cleanup hook 결과가 manifest에 기록

dry-run smoke test:

```sh
node ./bin/harness run --repo . --pipeline safe_fix --dry-run "Hermes controller smoke test"
```

## Git 관리

레포로 올릴 기본 대상은 다음입니다.

- `bin/`
- `config/`
- `prompts/`
- `src/`
- `test/`
- `package.json`
- `README.md`
- `.gitignore`
- `AGENTS.md`

`runs/`는 실행 산출물이므로 커밋하지 않습니다.

## 현재 한계

- 내장 provider의 CLI 인자는 각 도구의 일반적인 headless 실행 형태에 맞춘 초기값입니다.
- IDE 대화에서 항상 자동으로 하네스를 타게 만드는 것은 이 레포만으로 강제할 수 없습니다.
- Hermes는 decision schema와 제한된 액션 집합 안에서 제어합니다. 임의의 새 액션을 쓰려면 `src/cli.js`의 controller 로직과 테스트를 함께 확장해야 합니다.
