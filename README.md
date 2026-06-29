# Multi Agent Harness

여러 CLI 에이전트를 같은 방식으로 실행하기 위한 작은 오케스트레이션 하네스입니다.

Codex 전용 도구가 아니라, 하네스가 워크플로우를 관리하고 실제 추론/수정 작업은 선택한 에이전트 CLI에 맡기는 구조입니다.

## 하는 일

- 역할별 프롬프트를 렌더링합니다.
- 선택한 파이프라인에 따라 코드 수정, 검증, 리뷰, 최종 보고 단계를 실행합니다.
- 실행 manifest, 프롬프트, stdout/stderr 로그를 `runs/` 아래에 남깁니다.
- 프로젝트별 `.harness.json`에 정의한 build/test/validation 명령을 하네스가 직접 실행합니다.
- `codex`, `claude`, `antigravity`, 커스텀 CLI 실행기를 선택할 수 있습니다.

## 빠른 사용

대상 프로젝트에 기본 설정 파일을 먼저 만들 수 있습니다.

```sh
harness init-project --repo /path/to/project
```

바로 실행할 수도 있습니다.

```sh
node ./bin/harness run --repo /path/to/project --pipeline quick_fix --agent codex "테스트 실패를 고쳐줘"
node ./bin/harness run --repo /path/to/project --pipeline code_fix --agent claude "기능을 수정해줘"
node ./bin/harness run --repo /path/to/project --pipeline safe_fix --agent antigravity "위험한 변경을 안전하게 처리해줘"
node ./bin/harness run --repo /path/to/project --pipeline review_only --agent codex "이번 변경을 리뷰해줘"
```

`--dry-run`은 실제 에이전트를 실행하지 않고 프롬프트와 manifest 생성만 확인합니다.

## Codex CLI 연결

하네스를 전역 CLI로 연결하면 Codex 세션이나 일반 터미널에서 같은 명령을 사용할 수 있습니다.

```sh
npm link
harness doctor --repo /path/to/project --agent codex
harness run --repo /path/to/project --pipeline code_fix --agent codex "작업 요청"
```

Codex에게는 다음처럼 요청하면 됩니다.

```text
harness run --repo . --pipeline safe_fix --agent codex "이 변경을 안전하게 처리해줘"
```

연결 상태는 언제든 `harness doctor`로 확인합니다.

현재 Codex 내장 adapter는 `codex exec --cd <repo> --sandbox <mode> --json --output-last-message <file>` 형태로 실행합니다. Codex CLI 버전에 따라 지원 옵션이 달라질 수 있으므로, 실행이 실패하면 먼저 `codex exec --help`와 `harness doctor`를 확인합니다.

## IDE 대화에서 자동으로 태우기

`.harness.json`은 하네스가 실행될 때 사용하는 프로젝트 설정입니다. 이것만으로 Codex IDE 대화가 자동으로 하네스를 호출하지는 않습니다.

IDE에서 사용자가 "하네스를 활용해서 작업을 수행해"라고 말했을 때 자동으로 하네스를 태우려면, 대상 프로젝트의 `AGENTS.md`에 하네스 라우팅 규칙이 있어야 합니다.

역할을 분리해서 보면 다음과 같습니다.

- `.harness.json`: 어떤 pipeline, agent, validation command를 쓸지 정하는 실행 설정
- `AGENTS.md`: IDE/Codex 에이전트가 언제 `harness doctor`와 `harness run`을 호출해야 하는지 알려주는 작업 규칙

대상 프로젝트의 `AGENTS.md`에는 아래와 같은 섹션을 추가하는 것을 권장합니다.

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

하네스 실행 후에는 `runs/<runId>/manifest.json`과 최종 reporter 산출물을 확인해 사용자에게 요약한다.
````

이 규칙은 강제 훅이 아니라 에이전트 지침입니다. 따라서 대상 프로젝트의 `AGENTS.md`가 Codex IDE 컨텍스트에 로드되어야 안정적으로 동작합니다.

하네스 내부에서 실행되는 역할별 프롬프트에는 nested harness 실행 방지 문구가 들어 있습니다. 대상 프로젝트의 `AGENTS.md`에 하네스 라우팅 규칙이 있더라도, 이미 하네스 안에서 실행 중인 step은 다시 `harness doctor`나 `harness run`을 호출하지 않아야 합니다.

VS Code 작업으로 등록하고 싶다면 아래 명령을 사용할 수 있습니다.

```sh
harness install-ide-task --repo /path/to/project
```

이 명령은 대상 프로젝트의 `.vscode/tasks.json`에 `Harness: Run` 작업을 추가합니다. 작업 실행 시 요청 문구를 입력하면 현재 workspace를 `--repo`로 넘겨 하네스를 실행합니다.

## 언제 하네스를 사용할까

하네스는 모든 대화를 자동으로 처리하는 장치가 아닙니다. 코드 변경과 검증을 재현 가능하게 만들기 위한 실행 장치입니다. 단순 질의나 설계 대화에는 하네스를 쓰지 않는 편이 낫습니다.

### 바로 하네스를 쓰는 경우

사용자가 아래처럼 명시하면 하네스를 실행합니다.

- "하네스로 돌려줘"
- "하네스 태워서 해줘"
- "`quick_fix`로 해줘"
- "`code_fix`로 해줘"
- "`safe_fix`로 해줘"
- "`review_only`로 리뷰해줘"
- "검증까지 하네스로 해줘"

파이프라인이 명시되지 않았고 코드 변경 요청이면 기본적으로 `code_fix`를 사용합니다.

### 먼저 제안하는 경우

아래 상황에서는 하네스 사용을 먼저 제안하는 것이 좋습니다.

- 여러 파일을 수정해야 하는 작업
- 테스트, 빌드, lint 등 검증이 중요한 작업
- 보안, 인증, 결제, 데이터 삭제, 마이그레이션 등 위험도가 높은 작업
- 큰 리팩토링이나 구조 변경
- 커밋, 배포 전 최종 점검
- 에이전트 출력의 환각 여부를 별도 검증해야 하는 작업

예:

```text
이 작업은 영향 범위가 넓어서 safe_fix로 하네스를 태우는 것이 좋습니다.
```

### 하네스를 쓰지 않는 경우

아래 상황은 직접 대화로 처리하는 편이 낫습니다.

- 개념 설명, 사용법 안내, 에러 메시지 해석
- 레포명 추천, 설계 토론, 의사결정 대화
- 단일 파일의 아주 작은 문구 수정
- 하네스 자체의 라우팅 규칙을 논의하거나 수정하는 메타 작업
- 사용자가 "하네스 없이", "직접 해줘", "답변만 해줘"라고 말한 경우

하네스 실행 전에는 필요에 따라 연결 상태를 확인합니다.

```sh
harness doctor --repo <repo> --agent codex
harness run --repo <repo> --pipeline <pipeline> --agent codex "<요청>"
```

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
  "validationCommands": []
}
```

CLI 옵션이 설정 파일보다 우선합니다.

```sh
node ./bin/harness run --repo /path/to/project --agent claude "작업 요청"
```

`buildCommand`, `testCommand`, `validationCommands`는 validation 단계에서 사용됩니다. 실행 순서는 `buildCommand`, `testCommand`, `validationCommands` 순서입니다. validation 명령이 하나도 없으면 manifest에 skipped로 기록됩니다.

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

## 파이프라인

파이프라인은 [config/pipelines.json](config/pipelines.json)에 정의합니다.

- `quick_fix`: 코드 작업, validation, 최종 보고. 작고 명확한 수정에 적합합니다.
- `code_fix`: 계획, 코드 작업, validation, QA, 최종 보고. 기본값이며 일반적인 코드 변경에 적합합니다.
- `safe_fix`: 계획, 코드 작업, validation, QA, 주장 검증, 최종 보고. 위험하거나 중요한 변경에 적합합니다.
- `review_only`: 읽기 전용 리뷰, 주장 검증, 최종 보고. 파일을 수정하지 않는 검토에 적합합니다.

`validationAfter`에 지정된 단계가 끝나면 `.harness.json`의 validation 명령을 실행합니다.

기본 파이프라인은 `code_fix`입니다. 간단한 작업은 `quick_fix`, 중요한 작업은 `safe_fix`를 명시해서 실행하는 것을 권장합니다.

## Git 관리

`runs/`는 기본적으로 `.gitignore`에 포함되어 있습니다. 이 디렉터리에는 사용자 요청, 생성 프롬프트, 로컬 절대경로, 에이전트 로그가 들어가므로 프라이빗 레포라도 커밋하지 않는 편이 안전합니다.

레포로 올릴 기본 대상은 `bin/`, `config/`, `prompts/`, `src/`, `package.json`, `README.md`, `.gitignore`, `AGENTS.md`입니다.

오래된 실행 로그는 아래 명령으로 정리할 수 있습니다.

```sh
harness clean --days 7 --keep 5
harness clean --days 7 --keep 5 --dry-run
```

`clean`은 조건에 맞는 run 디렉터리를 바로 삭제하지 않고 `runs/.trash/`로 이동합니다.

## 현재 한계

내장 provider의 CLI 인자는 각 도구의 일반적인 headless 실행 형태에 맞춘 초기값입니다. 실제 설치 버전이나 조직 정책에 따라 `agent.args`로 조정하는 것을 권장합니다.

IDE 대화에서 항상 자동으로 하네스를 타게 만드는 것은 이 레포만으로 강제할 수 없습니다. 대상 프로젝트의 `AGENTS.md` 라우팅 규칙, 전역 `harness` 명령 연결, 그리고 현재 IDE/Codex 세션이 그 규칙을 읽는지가 함께 맞아야 합니다.
