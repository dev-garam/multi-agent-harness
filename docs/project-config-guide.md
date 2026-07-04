# Project Config Guide

이 문서는 대상 프로젝트의 `.harness.json`을 사람이 어떻게 채우고 고치는지 설명합니다.

`harness init-project --repo <path>`는 가능한 기본값을 자동으로 채우지만, 프로젝트의 배포 정책, 테스트 전략, 브랜치 운영 방식까지 완전히 알 수는 없습니다. 생성 후에는 이 문서를 기준으로 한 번 검토합니다.

필드의 형식만 확인하려면 [Project Config Schema](./config-schema.md)를 봅니다.

## 먼저 볼 것

대상 repo에서 아래 명령을 먼저 확인합니다.

```sh
cat package.json
git branch --all
git remote show origin
```

Node 프로젝트가 아니면 해당 생태계의 검증 명령을 확인합니다.

```sh
make help
cargo test --help
go test ./...
./gradlew tasks
```

이미 `.harness.json`이 있다면 하네스가 다시 스캔한 추천값을 볼 수 있습니다.

```sh
harness init-project --repo . --refresh
```

이 명령은 파일을 바꾸지 않고 제안만 출력합니다. 적용하려면 명시적으로 `--apply`를 붙입니다.

```sh
harness init-project --repo . --refresh --apply
```

예시:

```text
Suggested .harness.json updates:
+ buildCommand: npm run build
+ validationCommands.typecheck: npm run typecheck
~ protectedBranches: dev, production -> main, production
Run with --refresh --apply to update .harness.json.
```

이 방식은 하네스가 설정을 몰래 바꾸지 않게 하기 위한 안전장치입니다.

터미널에서 직접 질문을 받고 싶으면 `--interactive`를 사용합니다. 기존 `.harness.json`이 있을 때 `--interactive`만 붙이면 세 가지를 순서대로 묻습니다.

```sh
harness init-project --repo . --interactive
```

첫 번째 질문은 기존 설정을 전체 리셋할지 묻습니다.

```text
Existing .harness.json found. Reset it from scratch? [y/N]
```

`y`를 입력하면 기존 설정을 코어 기본값으로 전체 재설정합니다. 기존 커스텀 필드는 사라질 수 있습니다. `n` 또는 Enter를 입력하면 기존 설정을 유지합니다.

두 번째 질문은 기본 추천 필드를 추가할지 묻습니다.

```text
Add recommended default fields to .harness.json? [y/N]
```

첫 번째 질문에서 리셋을 선택했다면 새로 재설정되는 파일에 적용되고, 리셋하지 않았다면 기존 파일에 병합됩니다. `y`를 입력하면 누락된 `buildCommand`, `testCommand`, `validationCommands`, `supervisor`, `cleanup`, `runner`, `protectedBranches` 추천값을 병합합니다. `n` 또는 Enter를 입력하면 리셋한 경우 코어 기본값만 남기고, 리셋하지 않은 경우 기존 필드를 그대로 둡니다.

세 번째 질문은 앞으로 작업 중 하네스가 설정 제안을 해도 되는지 저장합니다.

```text
Allow the harness to ask before adding helpful config during future work? [y/N]
```

`y`를 입력하면 `configSuggestions.enabled: true`, `mode: "ask"`를 저장합니다. `n` 또는 Enter를 입력하면 `configSuggestions.enabled: false`를 저장합니다.

이 흐름은 테스트 코드에서도 확인할 수 있습니다. CLI 프로세스에 stdin으로 답을 넣으면 됩니다.

```js
const run = spawnSync('node', [
  harnessBin,
  'init-project',
  '--repo',
  repo,
  '--refresh',
  '--interactive'
], {
  input: 'y\n',
  encoding: 'utf8'
});
```

## 최소 설정

가장 작은 설정은 아래 정도입니다.

```json
{
  "pipeline": "auto",
  "pipelineSelection": {
    "mode": "deterministic",
    "defaultPipeline": "quick_fix"
  },
  "agent": {
    "provider": "codex"
  },
  "buildCommand": "npm run build",
  "testCommand": "npm run test",
  "validationCommands": [
    {
      "id": "lint",
      "command": "npm run lint"
    }
  ],
  "runner": {
    "mode": "local"
  },
  "protectedBranches": ["main", "production"]
}
```

처음에는 `runner.mode`를 `local`로 두는 것을 권장합니다. Docker runner는 이미지 안에 필요한 CLI와 인증 환경이 준비되어 있을 때만 사용합니다.

## Pipeline

`pipeline`은 하네스가 어떤 역할 순서로 실행될지 정합니다.

| 값 | 언제 쓰나 |
| --- | --- |
| `auto` | deterministic classifier로 요청 성격에 맞는 pipeline을 고르게 할 때 |
| `quick_fix` | 작은 수정, 단일 버그 수정, 문서/설정 변경 |
| `code_fix` | 일반적인 기능 수정, 리팩터링, 검증이 필요한 변경 |
| `safe_fix` | 인증, 결제, 마이그레이션, 대규모 변경처럼 더 조심해야 하는 작업 |
| `review_only` | 파일을 고치지 않고 코드 리뷰만 받고 싶을 때 |

잘 모르겠으면 `auto`로 시작합니다. `auto`는 LLM 호출 없이 keyword/risk/complexity score로 선택하므로 selector 토큰 비용이 들지 않습니다. 복잡한 작업임을 이미 알고 있다면 `--pipeline code_fix`처럼 명시하는 편이 가장 확실합니다.

## Agent

기본 provider는 `codex`, `claude`, `antigravity`입니다.

```json
{
  "agent": {
    "provider": "codex"
  }
}
```

역할별로 provider를 바꾸고 싶으면 `agents.<stepId>`를 씁니다.

```json
{
  "agent": {
    "provider": "codex"
  },
  "agents": {
    "qa": {
      "provider": "claude"
    }
  }
}
```

커스텀 CLI를 붙일 때는 `command`, `args`, `outputMode`가 필요합니다.

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

`outputMode` 기준:

- `stdout`: CLI stdout이 step 결과가 됩니다.
- `file`: CLI가 `{{finalPath}}`에 결과 파일을 직접 씁니다.

## Validation

Validation은 “에이전트가 고친 결과를 하네스가 어떻게 확인할지”입니다.

실행 순서:

1. `buildCommand`
2. `testCommand`
3. `validationCommands`

Node 예시:

```json
{
  "buildCommand": "npm run build",
  "testCommand": "npm run test",
  "validationCommands": [
    {
      "id": "lint",
      "command": "npm run lint"
    },
    {
      "id": "typecheck",
      "command": "npm run typecheck"
    }
  ]
}
```

명령 선택 기준:

- `buildCommand`: 실제 빌드가 깨지는지 확인하는 명령
- `testCommand`: 자동 테스트 전체 또는 기본 테스트 명령
- `validationCommands`: lint, typecheck, format check, migration dry-run처럼 추가 확인 명령

프로젝트별 예시:

```json
{
  "buildCommand": "go build ./...",
  "testCommand": "go test ./...",
  "validationCommands": [
    {
      "id": "vet",
      "command": "go vet ./..."
    }
  ]
}
```

```json
{
  "buildCommand": "cargo build",
  "testCommand": "cargo test",
  "validationCommands": [
    {
      "id": "fmt",
      "command": "cargo fmt --check"
    },
    {
      "id": "clippy",
      "command": "cargo clippy -- -D warnings"
    }
  ]
}
```

```json
{
  "buildCommand": "./gradlew build -x test",
  "testCommand": "./gradlew test",
  "validationCommands": [
    {
      "id": "check",
      "command": "./gradlew check"
    }
  ]
}
```

명령이 오래 걸리면 command별 timeout을 둡니다.

```json
{
  "validationCommands": [
    {
      "id": "integration",
      "command": "npm run test:integration",
      "timeoutMs": 900000,
      "maxLogBytes": 2097152
    }
  ]
}
```

## Protected Branches

`protectedBranches`는 Hermes queue 기반 자율 실행에서 자동 실행을 막고 사람 승인을 요구할 브랜치입니다.

```json
{
  "protectedBranches": ["main", "production"]
}
```

선택 기준:

- `main`, `master`: 보통 보호합니다.
- `production`, `release`: 거의 항상 보호합니다.
- `dev`, `develop`: 팀 공유 브랜치면 보호하고, 개인 작업 브랜치처럼 쓰면 빼도 됩니다.

현재 브랜치가 `dev`라도 repo에 `main`이 있으면 보통 `main`, `production`을 권장합니다.

## Workspace Mode

`workspaceMode`는 에이전트가 어디에 변경을 만들지 정합니다.

```json
{
  "workspaceMode": "patch"
}
```

| 값 | 의미 | 추천 상황 |
| --- | --- | --- |
| `direct` | 대상 repo를 직접 수정 | 혼자 쓰는 repo, 빠른 실험 |
| `worktree` | `runs/<runId>/worktree`에서 수정 | 원본 working tree를 보존하고 결과를 직접 확인 |
| `patch` | 임시 worktree에서 수정 후 patch만 남김 | 주변 사람에게 보여주거나 안전하게 시연 |

잘 모르겠으면 `patch`가 가장 안전합니다.

## Runner

기본은 local runner입니다.

```json
{
  "runner": {
    "mode": "local"
  }
}
```

Docker runner는 격리가 필요할 때만 사용합니다.

```json
{
  "runner": {
    "mode": "docker",
    "image": "node:22",
    "network": "none",
    "envAllowlist": ["OPENAI_API_KEY"]
  }
}
```

주의할 점:

- Docker 이미지 안에 agent CLI와 validation 실행 도구가 있어야 합니다.
- env는 자동 전달되지 않습니다. 필요한 값만 `envAllowlist`에 넣습니다.
- Docker daemon이 실행 중이어야 합니다.

## Supervisor

Hermes supervisor는 validation 결과를 보고 다음 행동을 결정합니다.

```json
{
  "supervisor": {
    "enabled": true,
    "maxSupervisorTurns": 3,
    "maxStepRetries": 1
  }
}
```

대부분 기본값으로 충분합니다.

- `enabled: false`: Hermes 판단 단계를 끕니다.
- `maxSupervisorTurns`: Hermes가 판단할 수 있는 최대 횟수입니다.
- `maxStepRetries`: worker step을 다시 시도할 수 있는 횟수입니다.

## Resources

느린 프로젝트는 timeout을 늘립니다.

```json
{
  "resources": {
    "agentTimeoutMs": 900000,
    "validationTimeoutMs": 600000,
    "maxLogBytes": 2097152
  }
}
```

기본값이 부족할 때만 추가합니다.

## Cleanup

오래된 run 산출물을 자동 정리하려면 켭니다.

```json
{
  "cleanup": {
    "enabled": true,
    "days": 14,
    "keep": 30
  }
}
```

처음에는 `enabled: false`를 권장합니다. run 결과를 충분히 확인한 뒤 켭니다.

## Policy

위험 작업을 직접 실행 전에 막고 싶으면 policy를 추가합니다.

```json
{
  "policy": {
    "enforceApprovalForDirectRun": true,
    "allowDestructiveCommands": false,
    "requireApprovalFor": ["auth", "payment", "database migration"]
  }
}
```

팀에 보여주는 용도라면 기본값으로 시작하고, 위험한 repo에 붙일 때만 강화합니다.

## 설정 후 확인

설정 파일을 고친 뒤에는 항상 doctor를 먼저 실행합니다.

```sh
harness doctor --repo . --agent codex
```

그 다음 dry-run으로 prompt와 manifest 생성만 확인합니다.

```sh
harness run --repo . --pipeline code_fix --dry-run "설정 확인"
```

실제 변경을 원본 repo에 바로 만들기 부담스럽다면 patch mode를 씁니다.

```sh
harness run --repo . --workspace-mode patch "작업 요청"
```

## 판단 순서

처음 설정할 때는 아래 순서로만 결정해도 충분합니다.

1. `pipeline`: 잘 모르겠으면 `code_fix`
2. `agent`: 지금 쓰는 CLI, 보통 `codex`
3. `validation`: build, test, lint, typecheck 명령
4. `protectedBranches`: `main`, `production`, 필요하면 `develop`
5. `workspaceMode`: 안전하게 보려면 `patch`
6. `runner`: 잘 모르겠으면 `local`
7. `supervisor`, `cleanup`, `resources`: 기본값으로 시작
