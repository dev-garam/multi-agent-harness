import path from 'node:path';
import { existsSync } from 'node:fs';
import { cleanRuns, cleanWorktrees } from './clean.js';
import { runDoctor } from './doctor.js';
import { writeText } from './fs-utils.js';
import { installIdeTask } from './ide.js';
import { runWatch } from './watch.js';
import { runHermesCommand } from './hermes.js';
import { runPipeline } from './runner.js';
import { showRun } from './show.js';

function usage() {
  return [
    'Usage:',
    '  harness run --repo <path> [options] "<request>"',
    '  harness install-ide-task --repo <path>',
    '  harness init-project --repo <path>',
    '  harness doctor [--repo <path>] [--agent <provider>]',
    '  harness show [--latest|<runId>] [--json]',
    '  harness hermes <subcommand> [options] [request]',
    '  harness watch [--interval <ms>] [--once] [--include-existing]',
    '  harness clean [--days <n>] [--keep <n>] [--dry-run] [--worktrees]',
    '',
    'Run options:',
    '  --pipeline <name>                 quick_fix | code_fix | safe_fix | review_only',
    '  --agent <provider>                codex | claude | antigravity | custom provider name',
    '  --workspace-mode <mode>           direct | worktree | patch',
    '  --runner <mode>                   local | docker',
    '  --runner-image <image>            Docker image used when --runner docker is selected',
    '  --dry-run                         Render prompts and manifest without running agents',
    '  --policy-approved                 Override direct-run policy approval gate',
    '',
    'Hermes subcommands:',
    '  status                            Show queue and memory status',
    '  plan <request>                    Recommend pipeline/agent strategy without running',
    '  enqueue [options] <request>       Add a task to the Hermes queue',
    '  queue                             Show queued tasks',
    '  approve --task <id>               Approve a pending task',
    '  reject --task <id>                Reject a pending task',
    '  tick [--limit <n>]                Process queued tasks',
    '  memory                            Show Hermes memory',
    '  feedback --run <id> --rating <n>  Record run feedback',
    '  promote                           Promote learned memory candidates',
    '  report                            Print Hermes operations report',
    '',
    'Shared options:',
    '  --repo <path>                     Target repository, defaults to current directory where supported',
    '  --json                            Emit machine-readable output where supported',
    '  --latest                          Select latest run for show',
    '  --days <n> --keep <n>             Cleanup retention policy',
    '  --worktrees                       Clean isolated worktrees instead of run directories',
    '  --interval <ms>                   Watch polling interval',
    '  --once                            Watch once and exit',
    '  --include-existing                Include already completed runs in watch output',
    '',
    'Examples:',
    '  harness run --repo "$PWD" --agent codex "Fix failing tests"',
    '  harness run --repo "$PWD" --workspace-mode patch --runner docker --runner-image node:22 "Fix failing tests"',
    '  harness show --latest',
    '  harness hermes enqueue --repo "$PWD" --pipeline quick_fix "Small fix"',
    '  harness clean --worktrees --days 7 --keep 5',
    '  harness install-ide-task --repo "$PWD"'
  ].join('\n');
}

function parseArgs(args) {
  const command = args.shift();
  const options = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo') {
      options.repo = args[++index];
    } else if (arg === '--pipeline') {
      options.pipeline = args[++index];
    } else if (arg === '--agent') {
      options.agent = args[++index];
    } else if (arg === '--workspace-mode') {
      options.workspaceMode = args[++index];
    } else if (arg === '--runner') {
      options.runner = args[++index];
    } else if (arg === '--runner-image') {
      options.runnerImage = args[++index];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--worktrees') {
      options.worktrees = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--days') {
      options.days = args[++index];
    } else if (arg === '--keep') {
      options.keep = args[++index];
    } else if (arg === '--interval') {
      options.interval = args[++index];
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--include-existing') {
      options.includeExisting = true;
    } else if (arg === '--limit') {
      options.limit = args[++index];
    } else if (arg === '--run') {
      options.run = args[++index];
    } else if (arg === '--rating') {
      options.rating = args[++index];
    } else if (arg === '--task') {
      options.task = args[++index];
    } else if (arg === '--policy-approved') {
      options.policyApproved = true;
    } else if (arg === '--latest') {
      options.latest = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      positionals.push(arg);
    }
  }

  return { command, options, request: positionals.join(' ').trim() };
}

function requireRepo(repo) {
  if (!repo) {
    throw new Error(`Missing --repo.\n\n${usage()}`);
  }

  const resolved = path.resolve(repo);
  if (!existsSync(resolved)) {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }

  return resolved;
}

async function initProject(repo) {
  const configPath = path.join(repo, '.harness.json');
  if (!existsSync(configPath)) {
    await writeText(configPath, JSON.stringify({
      pipeline: 'code_fix',
      agent: {
        provider: 'codex'
      },
      testCommand: '',
      buildCommand: '',
      validationCommands: [],
      supervisor: {
        enabled: true,
        maxSupervisorTurns: 3,
        maxStepRetries: 1
      },
      cleanup: {
        enabled: false,
        days: 7,
        keep: 20
      },
      runner: {
        mode: 'local'
      },
      protectedBranches: ['main', 'production']
    }, null, 2) + '\n');
  }
  return configPath;
}

export async function main(args) {
  const parsed = parseArgs([...args]);

  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    console.log(usage());
    return;
  }

  if (parsed.command === 'run') {
    await runPipeline(parsed.options, parsed.request);
    return;
  }

  if (parsed.command === 'install-ide-task') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const tasksPath = await installIdeTask(repo);
    console.log(`Installed IDE task: ${tasksPath}`);
    return;
  }

  if (parsed.command === 'init-project') {
    const repo = requireRepo(parsed.options.repo || process.cwd());
    const configPath = await initProject(repo);
    console.log(`Project harness config: ${configPath}`);
    return;
  }

  if (parsed.command === 'doctor') {
    await runDoctor({
      repo: parsed.options.repo || process.cwd(),
      agent: parsed.options.agent || null
    });
    return;
  }

  if (parsed.command === 'show') {
    const runId = parsed.options.latest ? '--latest' : parsed.request || '--latest';
    console.log(await showRun({
      runId,
      json: parsed.options.json === true
    }));
    return;
  }

  if (parsed.command === 'hermes') {
    const hermesArgs = parsed.request ? parsed.request.split(' ') : [];
    const subcommand = hermesArgs.shift() || 'status';
    const hermesRequest = hermesArgs.join(' ').trim();
    const output = await runHermesCommand({
      subcommand,
      request: hermesRequest,
      options: parsed.options
    });
    console.log(output);
    return;
  }

  if (parsed.command === 'clean') {
    const clean = parsed.options.worktrees ? cleanWorktrees : cleanRuns;
    await clean({
      days: parsed.options.days ?? 7,
      keep: parsed.options.keep ?? 5,
      dryRun: parsed.options.dryRun
    });
    return;
  }

  if (parsed.command === 'watch') {
    await runWatch({
      interval: parsed.options.interval ?? 1000,
      once: Boolean(parsed.options.once),
      includeExisting: Boolean(parsed.options.includeExisting)
    });
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
}
