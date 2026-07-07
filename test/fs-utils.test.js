import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText } from '../src/fs-utils.js';

// writeText 는 원자적 쓰기(임시파일 + fsync + rename)여야 한다.
const dir = await mkdtemp(path.join(tmpdir(), 'harness-fsutils-'));
try {
  const target = path.join(dir, 'sub', 'a.txt');

  // 내용을 쓰고, 없는 하위 디렉토리를 자동 생성한다.
  await writeText(target, 'hello');
  assert.equal(await readFile(target, 'utf8'), 'hello', 'writes content and creates parent dir');

  // 덮어쓰기.
  await writeText(target, 'world');
  assert.equal(await readFile(target, 'utf8'), 'world', 'overwrites');

  // rename 으로 대체되므로 임시(.tmp) 파일이 남지 않는다.
  const entries = await readdir(path.join(dir, 'sub'));
  assert.deepEqual(entries, ['a.txt'], 'no leftover temp files after atomic write');

  console.log('fs-utils tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
