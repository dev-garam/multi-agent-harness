import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

export const harnessRoot = fileURLToPath(new URL('..', import.meta.url));

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  // 원자적 쓰기: 임시 파일에 기록·fsync 한 뒤 rename 한다.
  // 쓰기 도중 프로세스가 중단돼도 대상 파일이 truncate/손상되지 않는다.
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
}

export function timestampId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const padMs = (value) => String(value).padStart(3, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('') + '_' + padMs(date.getMilliseconds());
}

export async function runCapture(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', resolve);
  });

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
