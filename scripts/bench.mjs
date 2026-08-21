#!/usr/bin/env node
/**
 * 하네스가 실제로 무엇을 더 해주는지 재는 벤치마크 러너.
 *
 * 같은 깨진 fixture를 두 조건으로 돌리고 결과를 비교한다.
 *   solo    — agent CLI를 직접 1회 호출한다(스캐폴딩 없음)
 *   harness — `harness run`으로 돌린다(계획·검증·감독·재시도 포함)
 *
 * 판정은 fixture의 테스트 명령이 한다. exit 0이면 성공이고, 모델의 자기 보고나
 * 사람의 판단이 개입하지 않는다. 이게 이 벤치마크의 요점이다 — 하네스가 "고쳤다"고
 * 말하는지가 아니라 실제로 고쳤는지를 본다.
 *
 * 사용:
 *   node scripts/bench.mjs --mode harness --agent claude
 *   node scripts/bench.mjs --mode solo --agent claude --fixtures 01
 *   node scripts/bench.mjs --mode harness --agent mock --dry
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturesRoot = path.join(harnessRoot, 'test', 'fixtures', 'bench');

function parseArgs(argv) {
  const options = { mode: 'harness', agent: 'claude', fixtures: 'all', dry: false, model: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--agent') options.agent = argv[++index];
    else if (arg === '--fixtures') options.fixtures = argv[++index];
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--dry') options.dry = true;
  }
  return options;
}

function run(command, args, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** fixture를 임시 디렉터리에 복사하고 git repo로 만든다(원본은 건드리지 않는다). */
/** fixture의 .harness.json에 모델을 주입한다(원본 fixture는 건드리지 않는다). */
async function applyModel(workdir, model) {
  if (!model) return;
  const configPath = path.join(workdir, '.harness.json');
  if (!existsSync(configPath)) return;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.agent = { ...(config.agent || {}), model };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
}

async function materialize(fixtureName, model) {
  const source = path.join(fixturesRoot, fixtureName);
  const workdir = await mkdtemp(path.join(tmpdir(), `bench-${fixtureName}-`));
  await cp(source, workdir, { recursive: true });
  // 설정 주입은 baseline 커밋 전에 끝낸다. 그러지 않으면 러너가 만든 변경이
  // agent가 만든 변경과 섞여 changedFiles가 부풀고 판정이 흐려진다.
  await applyModel(workdir, model);
  await run('git', ['init', '-b', 'work'], { cwd: workdir });
  await run('git', ['config', 'user.email', 'bench@example.com'], { cwd: workdir });
  await run('git', ['config', 'user.name', 'bench'], { cwd: workdir });
  await run('git', ['add', '-A'], { cwd: workdir });
  await run('git', ['commit', '-m', 'bench baseline'], { cwd: workdir });
  return workdir;
}

/** 판정: fixture의 테스트 명령이 통과하는가. 모델 주장과 무관한 결정론적 채점. */
async function grade(workdir) {
  const result = await run('npm', ['test'], { cwd: workdir, timeoutMs: 2 * 60 * 1000 });
  return { passed: result.exitCode === 0, exitCode: result.exitCode };
}

/** 변경이 실제로 있었는지(아무것도 안 하고 통과했다고 주장하는 경우를 구분). */
async function changedFileCount(workdir) {
  const result = await run('git', ['status', '--porcelain'], { cwd: workdir });
  return result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

function sumClaudeUsage(text) {
  // claude --output-format json은 한 줄 JSON을 낸다. 여러 번 호출된 경우를 위해 모두 합산.
  let billedTokens = 0;
  let costUsd = 0;
  let turns = 0;
  let found = false;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const usage = parsed.usage;
      if (!usage) continue;
      found = true;
      billedTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      costUsd += parsed.total_cost_usd || 0;
      turns += parsed.num_turns || 0;
    } catch {
      // JSON이 아닌 로그 줄은 무시.
    }
  }
  return found ? { billedTokens, costUsd, turns } : null;
}

/** 하네스 run의 usage는 manifest에 이미 집계돼 있다. */
async function harnessUsage(stderr) {
  const match = stderr.match(/Run dir: (.+)/);
  if (!match) return { usage: null, runDir: null };
  const runDir = match[1].trim();
  try {
    const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
    const summary = manifest.usageSummary || {};
    return {
      runDir,
      usage: {
        billedTokens: summary.billedTokens || 0,
        costUsd: summary.costUsd || 0,
        turns: summary.agentTurns || 0
      },
      status: manifest.status,
      steps: (manifest.steps || []).filter((step) => step.type === 'agent').length
    };
  } catch {
    return { usage: null, runDir };
  }
}

async function runSolo({ workdir, request, agent, model }) {
  if (agent !== 'claude') {
    // 다른 provider는 인자 계약이 달라 별도 구현이 필요하다. 지금은 claude만 지원.
    return { skipped: `solo mode is only implemented for claude (got ${agent})` };
  }
  const result = await run('claude', [
    '-p', request,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(mkdir:*),Bash(touch:*),Bash(cp:*),Bash(mv:*)',
    ...(model ? ['--model', model] : [])
  ], { cwd: workdir });
  return { exitCode: result.exitCode, usage: sumClaudeUsage(result.stdout), timedOut: result.timedOut };
}

async function runHarness({ workdir, request, agent }) {
  const result = await run(process.execPath, [
    path.join(harnessRoot, 'bin', 'harness'), 'run',
    '--repo', workdir, '--agent', agent, request
  ], { cwd: harnessRoot });
  const info = await harnessUsage(result.stderr);
  return { exitCode: result.exitCode, timedOut: result.timedOut, ...info };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const available = (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const selected = options.fixtures === 'all'
    ? available
    : available.filter((name) => options.fixtures.split(',').some((token) => name.startsWith(token.trim())));

  if (selected.length === 0) {
    console.error(`No fixtures matched "${options.fixtures}". Available: ${available.join(', ')}`);
    process.exit(1);
  }

  console.error(`bench: mode=${options.mode} agent=${options.agent}${options.model ? ` model=${options.model}` : ''} fixtures=${selected.join(', ')}`);
  const results = [];

  for (const fixture of selected) {
    const workdir = await materialize(fixture, options.model);
    const request = (await readFile(path.join(fixturesRoot, fixture, 'TASK.md'), 'utf8')).trim();

    // 시작 상태가 정말 실패인지 확인한다. 이미 통과하면 fixture가 망가진 것이다.
    const before = await grade(workdir);
    if (before.passed) {
      console.error(`  ${fixture}: SKIP (fixture already passes — broken fixture)`);
      results.push({ fixture, skipped: 'fixture already passes' });
      continue;
    }

    if (options.dry) {
      console.error(`  ${fixture}: dry (workdir ${workdir})`);
      results.push({ fixture, dry: true, workdir });
      continue;
    }

    const startedAt = Date.now();
    const outcome = options.mode === 'solo'
      ? await runSolo({ workdir, request, agent: options.agent, model: options.model })
      : await runHarness({ workdir, request, agent: options.agent });
    const durationMs = Date.now() - startedAt;

    if (outcome.skipped) {
      console.error(`  ${fixture}: SKIP (${outcome.skipped})`);
      results.push({ fixture, skipped: outcome.skipped });
      continue;
    }

    const after = await grade(workdir);
    const changed = await changedFileCount(workdir);
    const record = {
      fixture,
      mode: options.mode,
      agent: options.agent,
      passed: after.passed,
      changedFiles: changed,
      durationMs,
      exitCode: outcome.exitCode,
      timedOut: Boolean(outcome.timedOut),
      usage: outcome.usage || null,
      runDir: outcome.runDir || null,
      workdir
    };
    results.push(record);
    const cost = outcome.usage ? ` ~$${outcome.usage.costUsd.toFixed(4)} / ${outcome.usage.billedTokens.toLocaleString()} billed` : '';
    console.error(`  ${fixture}: ${after.passed ? 'PASS' : 'FAIL'} (${changed} file(s) changed, ${Math.round(durationMs / 1000)}s)${cost}`);
  }

  const scored = results.filter((entry) => entry.passed !== undefined);
  const passed = scored.filter((entry) => entry.passed).length;
  const totalCost = scored.reduce((sum, entry) => sum + (entry.usage?.costUsd || 0), 0);
  const totalBilled = scored.reduce((sum, entry) => sum + (entry.usage?.billedTokens || 0), 0);

  const report = {
    schemaVersion: 1,
    mode: options.mode,
    agent: options.agent,
    model: options.model,
    fixtures: selected,
    passed,
    scored: scored.length,
    passRate: scored.length > 0 ? passed / scored.length : 0,
    totalBilledTokens: totalBilled,
    totalCostUsd: totalCost,
    results
  };

  const outDir = path.join(harnessRoot, '.harness', 'bench');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const modelTag = options.model ? `_${options.model.replace(/[^a-zA-Z0-9.-]/g, '-')}` : '';
  const outPath = path.join(outDir, `${stamp}_${options.mode}_${options.agent}${modelTag}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');

  console.error('');
  console.error(`Pass rate: ${passed}/${scored.length}${scored.length > 0 ? ` (${((passed / scored.length) * 100).toFixed(0)}%)` : ''}`);
  if (totalBilled > 0) {
    console.error(`Consumed:  ${totalBilled.toLocaleString()} billed tokens, ~$${totalCost.toFixed(4)} API-equivalent`);
  }
  console.error(`Report:    ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
