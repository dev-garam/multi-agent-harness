# Project Config Schema

Project config lives at `.harness.json` in the target repository.

The harness validates this file before running agents. Invalid config stops `harness run` before any agent or validation command executes. `harness doctor` reports the same validation errors and warnings.

## Top-level Fields

- `pipeline`: optional string. Must be `auto` or match one of `quick_fix`, `code_fix`, `safe_fix`, `review_only`.
- `pipelineSelection`: optional deterministic auto-pipeline selection config.
- `workspaceMode`: optional string. One of `direct`, `worktree`, `patch`.
- `workspace.mode`: optional alternative to `workspaceMode`.
- `agent`: optional provider string or agent object.
- `agents`: optional object keyed by step id. Each value must be an agent object.
- `runner`: optional runner string or runner object.
- `dockerRunner`: optional Docker runner config object.
- `runtime.runner`: optional alternative to `runner`.
- `runtime.docker`: optional alternative to `dockerRunner`.
- `buildCommand`: optional shell command string.
- `testCommand`: optional shell command string.
- `validationCommands`: optional array of command strings or command objects.
- `resources`: optional resource limits.
- `redaction`: optional prompt/output redaction config.
- `context`: optional context budget config.
- `retry`: optional retry and fallback config.
- `budget`: optional run budget config.
- `tools`: optional setup/teardown tool lifecycle config.
- `supervisor`: optional Hermes supervisor config.
- `cleanup`: optional run cleanup config.
- `configSuggestions`: optional config suggestion preference.
- `policy`: optional policy config.
- `protectedBranches`: optional array of branch names.

## Pipeline Selection

```json
{
  "pipeline": "auto",
  "pipelineSelection": {
    "mode": "deterministic",
    "defaultPipeline": "quick_fix",
    "riskThreshold": 3,
    "complexityThreshold": 3
  }
}
```

- `pipeline: "auto"` uses deterministic keyword scoring before selecting a concrete pipeline.
- `pipelineSelection.mode` currently supports `deterministic`.
- `defaultPipeline` is used when no risk/complexity/review signal crosses a threshold.
- Explicit `--pipeline <name>` still wins over `.harness.json`.

## Agent Object

```json
{
  "provider": "mock",
  "command": "node",
  "versionArgs": ["--version"],
  "outputMode": "file",
  "args": ["./mock-agent.cjs", "{{stepId}}", "{{finalPath}}"]
}
```

- `provider` or `name`: optional non-empty string.
- `command`: optional non-empty string.
- `versionArgs`: optional array of strings.
- `outputMode`: optional `file` or `stdout`.
- `defaultTimeoutMs`: optional positive number.
- `args`: optional string or array of strings.

Built-in providers are `codex`, `claude`, and `antigravity`. Unknown providers must set `command`.

Custom `command` and `args` execute through the selected runtime runner.

## Runtime Runner

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

- `runner`: optional `local`, `docker`, or object.
- `runner.mode`: optional `local` or `docker`.
- `runner.image`: required when `runner.mode` is `docker`.
- `runner.network`: optional `default`, `none`, or `host`.
- `runner.envAllowlist`: optional array of environment variable names to pass into Docker.
- `runner.mounts`: optional extra host paths to bind mount into Docker.
- `runner.user`: optional `--user` value. Defaults to the host `uid:gid` (non-root, so bind-mount writes are owned correctly). Set to `"root"` or `false` to opt out, or a `"uid:gid"` string to pin a specific user.
- `runner.readOnly`: optional boolean forcing a read-only container rootfs (`--read-only` plus a `/tmp` tmpfs). Defaults to `true` for the `review_only` pipeline, `false` otherwise.
- `runner.repoReadOnly`: optional boolean mounting the execution repo read-only (`:ro`). Defaults to `true` for `review_only`, `false` otherwise. The run directory always stays writable for artifacts.

Docker runner bind mounts the execution repo and run directory into the container at the same absolute paths.

### Docker hardening

By default the Docker runner drops container privileges: it runs as the host `uid:gid` (non-root). Because `review_only` pipelines never write source, they additionally lock the rootfs (`--read-only` + `/tmp` tmpfs) and mount the repo read-only. Writable pipelines keep the repo writable so agents can edit code. Every default is overridable via `runner.user` / `runner.readOnly` / `runner.repoReadOnly` (also accepted under `runner.docker.*`, `dockerRunner.*`, `runtime.docker.*`).

## Validation Commands

```json
{
  "validationCommands": [
    "npm test",
    {
      "id": "lint",
      "command": "npm run lint",
      "timeoutMs": 300000,
      "maxLogBytes": 1048576
    }
  ]
}
```

- Command strings must be non-empty.
- Command objects need a non-empty `command`.
- `timeoutMs` and `maxLogBytes`, when present, must be positive numbers.

Validation commands execute through the selected runtime runner. In local mode they use the local shell. In Docker mode they run as `sh -lc <command>` inside the configured image.

## Resources

```json
{
  "resources": {
    "agentTimeoutMs": 600000,
    "validationTimeoutMs": 300000,
    "maxLogBytes": 1048576
  }
}
```

All resource values must be positive numbers.

## Middleware Runtime

These fields configure the harness runtime layer around agent, validation, and tool execution.

```json
{
  "redaction": {
    "enabled": true,
    "mode": "mask",
    "patterns": [
      {
        "id": "internal-token",
        "pattern": "TOKEN_[A-Z0-9]+"
      }
    ]
  },
  "context": {
    "maxPreviousOutputBytes": 262144,
    "maxStepOutputBytes": 65536,
    "summarizer": {
      "enabled": true,
      "mode": "deterministic",
      "headBytes": 8192,
      "tailBytes": 24576
    }
  },
  "retry": {
    "agentRetries": 1,
    "validationRetries": 1,
    "backoffMs": 1000,
    "retryOnExitCodes": [124],
    "retryOnStderrPatterns": ["rate limit", "timeout"],
    "fallbackAgents": [
      {
        "provider": "claude"
      }
    ]
  },
  "budget": {
    "maxAgentSteps": 20,
    "maxProviderCalls": 20,
    "maxValidationCommands": 30,
    "maxRuntimeMs": 1800000
  },
  "tools": [
    {
      "id": "browser",
      "setupCommand": "npm run browser:start",
      "teardownCommand": "npm run browser:stop",
      "timeoutMs": 120000,
      "maxLogBytes": 524288,
      "envAllowlist": ["BROWSER_TOKEN"]
    }
  ]
}
```

- `redaction.enabled` must be boolean. `mode` must be `mask` or `hash`.
- `context.maxPreviousOutputBytes` and `context.maxStepOutputBytes` must be positive numbers.
- `context.summarizer.enabled` enables deterministic head/tail context compaction. `mode` must be `deterministic` or `model`; current runtime safely records `model` config but uses deterministic compaction behavior.
- `retry.agentRetries` and `retry.validationRetries` must be non-negative integers.
- `retry.backoffMs` must be a non-negative number.
- `retry.retryOnExitCodes` must be non-negative integers. Default is `[124]`.
- `retry.retryOnStderrPatterns` must be non-empty strings. Defaults cover timeout, rate limit, and common transient network/provider failures.
- `retry.fallbackAgents` uses the same agent object shape as `agent`.
- `budget` values must be positive numbers.
- `tools` setup and teardown commands run through the selected runtime runner and are recorded in `manifest.tools.lifecycle`.
- `tools[].envAllowlist`, when set, further restricts env passed to that tool. In Docker mode it is intersected with runner-level `envAllowlist`.

## Supervisor

```json
{
  "supervisor": {
    "enabled": true,
    "maxSupervisorTurns": 3,
    "maxStepRetries": 1,
    "agent": {
      "provider": "mock",
      "command": "node",
      "outputMode": "file",
      "args": ["./mock-agent.cjs", "{{stepId}}", "{{finalPath}}"]
    }
  }
}
```

- `enabled` must be boolean.
- `maxSupervisorTurns` and `maxStepRetries` must be non-negative integers.
- `agent`, when present, must be an agent object.

## Cleanup

```json
{
  "cleanup": {
    "enabled": false,
    "days": 7,
    "keep": 20,
    "dryRun": true
  }
}
```

- `enabled` and `dryRun` must be boolean.
- `days` and `keep` must be positive numbers.

## Config Suggestions

```json
{
  "configSuggestions": {
    "enabled": true,
    "mode": "ask"
  }
}
```

- `enabled` must be boolean.
- `mode`, when present, must be `ask`.

When enabled, the harness may ask before adding helpful project config during future work. It should not silently edit `.harness.json`.

## Policy

```json
{
  "policy": {
    "allowAutonomousRun": true,
    "allowEdits": true,
    "allowDestructiveCommands": false,
    "enforceApprovalForDirectRun": false,
    "protectedBranches": ["main", "production"],
    "requireApprovalFor": ["auth", "payment", "database migration"],
    "approvalRiskRuleIds": ["migration", "security-sensitive-path", "environment-file"],
    "destructiveCommandPatterns": ["rm -rf", "git push --force"],
    "allowedCommands": ["rm -rf build"]
  }
}
```

- Boolean fields must be boolean.
- `protectedBranches` and `requireApprovalFor` must be arrays of strings.

### Change-grounded policy (C2b)

Beyond request-text keywords, the harness grounds approval in what actually changed. After each write step the inspection stage runs `evaluateChangeRisk`, which raises an approval requirement — recorded as `policyAssessment` on the inspection manifest step — when:

- a changed file matches an `approvalRiskRuleIds` category (default: `migration`, `security-sensitive-path`, `environment-file`), or
- a potential secret appears in the diff, or
- a proposed command matches `destructiveCommandPatterns` (default covers `rm -r/-f`, `git push --force`, `git reset --hard`, `drop/truncate/delete` SQL, `mkfs`, `dd if=`) and is not in `allowedCommands`.

This assessment is **additive**: it only ever adds approval requirements, never removes the existing text/branch gates. Protected-branch evaluation also fails safe on a **detached HEAD** — because the checkout cannot be confirmed to be off a protected branch, it requires human approval.

By default the assessment is **observational** — it is recorded as `policyAssessment` and surfaced to the supervisor, but does not stop the run. Set `policy.blockOnChangeRisk: true` to make it a **hard gate**: when the inspection of the real diff requires approval, the run is blocked (stopped and marked failed with `policyBlock` in the manifest) instead of completing. The harness never auto-commits or auto-merges, so a block simply withholds the success signal; in `worktree`/`patch` mode the risky diff is still preserved as `changes.patch` for review. Re-run with `--policy-approved` (or supply approval) to proceed.

## Eval Spec

Fixture repositories may include `.harness-eval.json`. This file is read by `harness eval` and is not part of the runtime `.harness.json` contract.

```json
{
  "expected": {
    "status": "passed",
    "minScore": 1,
    "checks": {
      "project-config-schema": "pass",
      "validation-coverage": "pass"
    }
  },
  "policyCases": [
    {
      "id": "safe-doc-change",
      "request": "README 문구를 정리해줘",
      "mode": "direct",
      "expected": {
        "allowed": true,
        "requiresApproval": false
      }
    }
  ],
  "pipelineCases": [
    {
      "id": "review-only",
      "request": "이번 변경을 리뷰만 해줘",
      "expected": {
        "selected": "review_only",
        "mode": "deterministic",
        "minComplexity": 0,
        "minRisk": 0
      }
    }
  ],
  "supervisorCases": [
    {
      "id": "unparseable-collapses-to-human-review",
      "output": "the model never emitted a decision block",
      "expected": {
        "valid": false,
        "nextAction": "request_human_review"
      }
    }
  ]
}
```

- `expected.status` checks the final eval status.
- `expected.minScore` checks the readiness score lower bound.
- `expected.checks` maps check ids to expected statuses.
- `policyCases` runs deterministic policy decisions against the fixture config.
- `pipelineCases` freezes pipeline selection as golden regression: `selected`/`mode` are matched exactly, `minComplexity`/`minRisk` assert score lower bounds. Optional `requestedPipeline` forces an explicit selection.
- `supervisorCases` freezes supervisor decision parsing (`parseSupervisorDecision`) as golden regression: `output` is the raw model text, and `valid`/`nextAction`/`status`/`targetStep` are matched against the normalized decision — including safe collapse to `request_human_review` on unparseable or invalid output.

`policyCases`, `pipelineCases`, and `supervisorCases` move eval beyond readiness checks into judgment-quality regression: they measure whether the harness's routing and supervision decisions still match known-good golden outputs.
