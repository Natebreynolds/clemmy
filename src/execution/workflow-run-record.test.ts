import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withWorkflowRunRecordLock } from './workflow-run-record.js';

const MODULE_URL = new URL('./workflow-run-record.ts', import.meta.url).href;
const CHILD_CODE = String.raw`
  import { writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_RUN_RECORD_MODULE_URL);
  try {
    mod.withWorkflowRunRecordLock(process.env.CLEM_RUN_RECORD_FILE, () => {
      writeFileSync(process.env.CLEM_RUN_RECORD_RESULT, 'acquired', 'utf-8');
    });
  } catch (error) {
    writeFileSync(process.env.CLEM_RUN_RECORD_RESULT, 'error:' + (error instanceof Error ? error.message : String(error)), 'utf-8');
  }
`;

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function contender(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', CHILD_CODE], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, CLEM_RUN_RECORD_MODULE_URL: MODULE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('two stale reclaimers cannot delete a successor lock generation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-run-record-lock-'));
  const file = path.join(root, 'race.json');
  const lockDir = `${file}.record-lock`;
  const staleToken = '00000000-0000-4000-8000-000000000000';
  const staleOwner = path.join(lockDir, `owner-2147483647-${staleToken}.json`);
  const aReady = path.join(root, 'a-stale.ready');
  const aRelease = path.join(root, 'a-stale.release');
  const aResult = path.join(root, 'a.result');
  const bReady = path.join(root, 'b-owned.ready');
  const bRelease = path.join(root, 'b-owned.release');
  const bResult = path.join(root, 'b.result');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(staleOwner, JSON.stringify({
    pid: 2_147_483_647,
    token: staleToken,
    acquiredAt: new Date(0).toISOString(),
  }), 'utf-8');

  const first = contender({
    CLEM_RUN_RECORD_FILE: file,
    CLEM_RUN_RECORD_RESULT: aResult,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_STALE_READY: aReady,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_STALE_RELEASE: aRelease,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS: '300',
  });
  let second: ChildProcess | undefined;
  try {
    await waitForFile(aReady);
    second = contender({
      CLEM_RUN_RECORD_FILE: file,
      CLEM_RUN_RECORD_RESULT: bResult,
      CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_READY: bReady,
      CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_RELEASE: bRelease,
    });
    await waitForFile(bReady);
    const successorOwners = readdirSync(lockDir).filter((entry) => entry.startsWith('owner-'));
    assert.equal(successorOwners.length, 1);
    assert.notEqual(successorOwners[0], path.basename(staleOwner));

    // Resume the older stale observer only after the second reclaimer owns a
    // replacement directory generation. It must time out behind that live
    // owner, never unlink the successor through the fixed pathname.
    writeFileSync(aRelease, 'continue', 'utf-8');
    const [firstCode] = await once(first, 'close') as [number | null];
    assert.equal(firstCode, 0);
    assert.match(readFileSync(aResult, 'utf-8'), /^error:Timed out acquiring/);
    assert.deepEqual(
      readdirSync(lockDir).filter((entry) => entry.startsWith('owner-')),
      successorOwners,
      'the successor generation remains owned while the stale observer exits',
    );

    writeFileSync(bRelease, 'continue', 'utf-8');
    const [secondCode] = await once(second, 'close') as [number | null];
    assert.equal(secondCode, 0);
    assert.equal(readFileSync(bResult, 'utf-8'), 'acquired');
  } finally {
    if (first.exitCode === null) first.kill('SIGKILL');
    if (second?.exitCode === null) second.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed or multiple run-record lock owners fail closed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-run-record-corrupt-'));
  const file = path.join(root, 'corrupt.json');
  const lockDir = `${file}.record-lock`;
  const previous = process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS;
  process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS = '20';
  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'owner-bad.json'), '{}', 'utf-8');
    assert.throws(
      () => withWorkflowRunRecordLock(file, () => undefined),
      /invalid owner record.*refusing unsafe reclamation/,
    );
    writeFileSync(path.join(lockDir, 'owner-also-bad.json'), '{}', 'utf-8');
    assert.throws(
      () => withWorkflowRunRecordLock(file, () => undefined),
      /multiple owner records.*refusing unsafe reclamation/,
    );
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'unexpected-entry'), 'stale-looking', 'utf-8');
    assert.throws(
      () => withWorkflowRunRecordLock(file, () => undefined),
      /unexpected lock entries.*refusing unsafe reclamation/,
    );
  } finally {
    if (previous === undefined) delete process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS;
    else process.env.CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a creator refuses a directory generation with an unexpected extra entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-run-record-create-evidence-'));
  const file = path.join(root, 'create.json');
  const ready = path.join(root, 'mkdir.ready');
  const release = path.join(root, 'mkdir.release');
  const result = path.join(root, 'result');
  const child = contender({
    CLEM_RUN_RECORD_FILE: file,
    CLEM_RUN_RECORD_RESULT: result,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_READY: ready,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_MKDIR_RELEASE: release,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_TIMEOUT_MS: '100',
  });
  try {
    await waitForFile(ready);
    writeFileSync(path.join(`${file}.record-lock`, 'unexpected-entry'), 'corrupt evidence', 'utf-8');
    writeFileSync(release, 'continue', 'utf-8');
    const [code] = await once(child, 'close') as [number | null];
    assert.equal(code, 0);
    assert.match(readFileSync(result, 'utf-8'), /^error:.*unexpected lock entries/);
    assert.equal(existsSync(path.join(`${file}.record-lock`, 'unexpected-entry')), true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
