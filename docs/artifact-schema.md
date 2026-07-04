# Artifact Schema

이 문서는 하네스 산출물을 다른 도구가 안정적으로 읽을 수 있도록 주요 JSON 계약을 정리합니다.

Status: draft

## Manifest

파일 위치:

```text
runs/<runId>/manifest.json
```

현재 schema version:

```json
{
  "schemaVersion": 1
}
```

주요 필드:

- `runId`: 실행 ID
- `repo`: 사용자가 지정한 원본 repo
- `executionRepo`: 실제 agent와 validation이 실행된 repo
- `request`: 사용자 요청
- `pipeline`: 시작 pipeline
- `pipelineSelection`: auto/explicit pipeline selection decision
- `completedPipeline`: 최종 pipeline
- `dryRun`: dry-run 여부
- `workspace`: workspace mode와 patch/worktree 정보
- `runtime`: selected runner와 runner contract
- `promptCache`: prompt/static context cache artifact metadata
- `policy`: policy config, request preflight decision, protected branch decision
- `trustBoundary`: local-first 신뢰 경계 요약
- `validationCommands`: 하네스가 실행한 validation 명령 목록
- `middleware`: hook event, run state, redaction/context/retry/budget config summary
- `usageSummary`: provider call/token/cost usage summary, best effort
- `tools`: tool setup/teardown lifecycle 결과
- `git`: 실행 전 git snapshot
- `gitAfter`: 실행 후 git snapshot
- `steps`: agent, validation, inspection step 결과
- `supervisorDecisions`: Hermes supervisor decision 목록
- `reporterSummary`: reporter가 마지막에 출력한 machine-readable JSON summary
- `pipelineChanges`: Hermes가 pipeline을 승격한 이력
- `cleanup`: cleanup hook 결과
- `status`: `succeeded | failed | incomplete`

## Step Result

### Agent Step

```json
{
  "type": "agent",
  "stepId": "coder",
  "status": "succeeded",
  "exitCode": 0,
  "agent": "codex",
  "command": "codex",
  "timedOut": false,
  "cancelled": false,
  "timeoutMs": 600000,
  "maxLogBytes": 1048576,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "lastOutputAt": null,
  "eventsPath": "runs/<runId>/coder.codex.stdout.log",
  "stderrPath": "runs/<runId>/coder.codex.stderr.log",
  "finalPath": "runs/<runId>/coder.md"
}
```

### Validation Step

```json
{
  "type": "validation",
  "stepId": "validation:test",
  "id": "test",
  "command": "npm test",
  "status": "succeeded",
  "exitCode": 0,
  "timedOut": false,
  "cancelled": false,
  "stdoutPath": "runs/<runId>/validation-test.stdout.log",
  "stderrPath": "runs/<runId>/validation-test.stderr.log"
}
```

### Inspection Step

```json
{
  "type": "inspection",
  "stepId": "inspection:after-coder",
  "id": "after-coder",
  "status": "succeeded",
  "changedFiles": [],
  "riskyFiles": [],
  "secretFindings": [],
  "diffStatPath": "runs/<runId>/inspection-after-coder.diffstat.log",
  "nameStatusPath": "runs/<runId>/inspection-after-coder.name-status.log",
  "detailsPath": "runs/<runId>/inspection-after-coder.json"
}
```

### Tool Lifecycle Step

```json
{
  "type": "tool",
  "toolId": "browser",
  "phase": "setup",
  "command": "npm run browser:start",
  "status": "succeeded",
  "exitCode": 0,
  "timedOut": false,
  "stdoutPath": "runs/<runId>/tool-browser-setup.stdout.log",
  "stderrPath": "runs/<runId>/tool-browser-setup.stderr.log"
}
```

Tool lifecycle results are stored in `manifest.tools.lifecycle`.

## Middleware Runtime

```json
{
  "middleware": {
    "state": {
      "counters": {
        "agentSteps": 1,
        "providerCalls": 1,
        "validationCommands": 1,
        "hookEvents": 4,
        "redactions": 0,
        "contextTruncations": 0,
        "retries": 0,
        "fallbacks": 0
      },
      "flags": {},
      "values": {}
    },
    "events": [
      {
        "type": "hook:run:start",
        "detail": {
          "pipeline": "code_fix"
        },
        "createdAt": "2026-07-04T00:00:00.000Z"
      }
    ],
    "config": {
      "redaction": {},
      "context": {},
      "budget": {},
      "retry": {}
    }
  }
}
```

This object is intended for debugging and downstream evaluation. Hook event names are additive and should be treated as an event stream rather than a closed enum.

Agent step entries may include:

- `usage`: best-effort provider token/cost usage with `provider` and `adapter`. If the provider log format is not recognized, `usage.status` is `unknown`.
- `retryable` and `retryReason`: classifier output used by retry/fallback middleware.
- `stderrTail`: short stderr tail used for retry classification. Full logs remain in `stderrPath`.

## Prompt Cache

Each run writes `prompt-cache.json` and references it from `manifest.promptCache`.

```json
{
  "schemaVersion": 1,
  "strategy": "static-context-hash",
  "reusable": true,
  "cacheKey": "sha256...",
  "staticContextHash": "sha256...",
  "templates": [
    {
      "stepId": "planner",
      "prompt": "prompts/planner.md",
      "templateHash": "sha256...",
      "templateBytes": 1024
    }
  ],
  "path": "runs/<runId>/prompt-cache.json"
}
```

This is a cache metadata artifact, not a provider-side prompt cache. It lets downstream tools compare whether static prompt context changed between runs.

## Hermes Supervisor Decision

Hermes supervisor output의 마지막 fenced JSON block은 아래 schema를 따라야 합니다.

```json
{
  "status": "success",
  "nextAction": "continue",
  "targetStep": null,
  "reason": "Validation passed.",
  "instructions": "Report the changed files and validation result."
}
```

허용 값:

- `status`: `success | success_with_risks | failed | incomplete`
- `nextAction`: `continue | run_validation | escalate_to_safe_fix | rerun_step | stop_failed | request_human_review`
- `targetStep`: `coder | qa | verifier | reviewer | null`

하네스는 이 decision을 정규화해 `manifest.supervisorDecisions`에 기록합니다. 파싱 실패나 지원하지 않는 action은 `request_human_review` decision으로 정규화합니다.

## Reporter Summary

Reporter output의 마지막 fenced JSON block은 아래 schema를 따라야 합니다.

```json
{
  "status": "success",
  "summary": "Validation passed and the requested change was completed.",
  "changedFiles": ["src/example.js"],
  "validation": [
    {
      "id": "test",
      "status": "succeeded",
      "exitCode": 0
    }
  ],
  "risks": []
}
```

하네스는 이 summary를 `manifest.reporterSummary`에 기록합니다.

허용 값:

- `status`: `success | success_with_risks | failed | incomplete`
- `changedFiles`: 문자열 배열
- `validation`: validation 요약 배열
- `risks`: 문자열 배열

파싱 실패 또는 schema 오류가 있으면 `valid: false`와 `schemaErrors`를 기록합니다.

## Compatibility

현재는 `schemaVersion: 1`만 지원합니다. 호환성을 깨는 변경이 필요하면 다음 중 하나를 선택합니다.

- `schemaVersion` 증가
- 새 필드를 optional로 추가
- 기존 필드를 유지하고 deprecated 문서화
