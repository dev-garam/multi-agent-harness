# Harness Showcase Demo

이 디렉터리는 실제 Codex/Claude CLI 없이 하네스 구조를 보여주기 위한 mock project입니다.

직접 이 디렉터리에서 실행하기보다, 아래 준비 스크립트로 임시 git repo를 만든 뒤 실행합니다.

```sh
node scripts/create-showcase-demo.cjs
```

출력된 repo 경로를 `DEMO_REPO`로 잡고 실행합니다.

```sh
DEMO_REPO=/tmp/harness-showcase-...
node ./bin/harness run --repo "$DEMO_REPO" --pipeline quick_fix --agent mock --workspace-mode patch "데모 문구를 생성해줘"
```

확인 포인트:

- `runs/<runId>/manifest.json`
- `runs/<runId>/changes.patch`
- `runs/<runId>/reporter.md`
- 원본 demo repo에는 `demo-output.txt`가 생기지 않음

Hermes approval flow:

```sh
node ./bin/harness hermes enqueue --repo "$DEMO_REPO" --pipeline quick_fix --agent mock "보호 브랜치에서 실행해줘"
node ./bin/harness hermes tick
node ./bin/harness hermes queue
```

`DEMO_REPO`는 `main` branch이고 `.harness.json`에 protected branch가 설정되어 있어 첫 tick은 `approval_pending`으로 이동합니다.
