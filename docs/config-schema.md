# Project Config Schema

Project config lives at `.harness.json` in the target repository.

The harness validates this file before running agents. Invalid config stops `harness run` before any agent or validation command executes. `harness doctor` reports the same validation errors and warnings.

## Top-level Fields

- `pipeline`: optional string. Must match one of `quick_fix`, `code_fix`, `safe_fix`, `review_only`.
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
- `supervisor`: optional Hermes supervisor config.
- `cleanup`: optional run cleanup config.
- `configSuggestions`: optional config suggestion preference.
- `policy`: optional policy config.
- `protectedBranches`: optional array of branch names.

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

Docker runner bind mounts the execution repo and run directory into the container at the same absolute paths.

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
    "requireApprovalFor": ["auth", "payment", "database migration"]
  }
}
```

- Boolean fields must be boolean.
- `protectedBranches` and `requireApprovalFor` must be arrays of strings.
