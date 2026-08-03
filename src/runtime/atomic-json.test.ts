/**
 * Run: npx tsx --test src/runtime/atomic-json.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-atomic-json-test-'));
test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  atomicJsonMutate,
  atomicAppendNdjson,
  withFileLock,
  withFileLockSyncStrict,
} = await import('./atomic-json.js');
const { BoundaryError } = await import('./boundary-error.js');

const atomicJsonModuleUrl = pathToFileURL(path.resolve('src/runtime/atomic-json.ts')).href;

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function childResult(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, stderr };
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, stderr };
}

function deletionGuardMarkerNames(target: string): string[] {
  const prefix = `${path.basename(target)}.lock.reclaim-`;
  return readdirSync(path.dirname(target)).filter((name) => name.startsWith(prefix));
}

function spawnStrictLockParticipant(input: {
  target: string;
  enteredMarker: string;
  workReleaseMarker: string;
  staleObservedMarker?: string;
  staleObservedReleaseMarker?: string;
  deleteValidatedMarker?: string;
  deleteValidatedReleaseMarker?: string;
}): ChildProcess {
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    const { withFileLockSyncStrict } = await import(${JSON.stringify(atomicJsonModuleUrl)});
    const wait = new Int32Array(new SharedArrayBuffer(4));
    withFileLockSyncStrict(${JSON.stringify(input.target)}, () => {
      writeFileSync(${JSON.stringify(input.enteredMarker)}, String(process.pid));
      while (!existsSync(${JSON.stringify(input.workReleaseMarker)})) {
        Atomics.wait(wait, 0, 0, 10);
      }
    });
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(input.staleObservedMarker
        ? { CLEMENTINE_TEST_FILE_LOCK_STALE_OBSERVED_MARKER: input.staleObservedMarker }
        : {}),
      ...(input.staleObservedReleaseMarker
        ? { CLEMENTINE_TEST_FILE_LOCK_STALE_OBSERVED_RELEASE: input.staleObservedReleaseMarker }
        : {}),
      ...(input.deleteValidatedMarker
        ? { CLEMENTINE_TEST_FILE_LOCK_DELETE_VALIDATED_MARKER: input.deleteValidatedMarker }
        : {}),
      ...(input.deleteValidatedReleaseMarker
        ? { CLEMENTINE_TEST_FILE_LOCK_DELETE_VALIDATED_RELEASE: input.deleteValidatedReleaseMarker }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('atomicJsonMutate creates the file from fallback when missing', async () => {
  const file = path.join(TMP, 'a.json');
  await atomicJsonMutate<{ count: number }>(file, (cur) => ({ count: cur.count + 1 }), { count: 0 });
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).count, 1);
});

test('atomicJsonMutate serializes concurrent mutators on the same file', async () => {
  // 50 concurrent +1 increments on the same key. Without the lock,
  // last-writer-wins would land somewhere between 1 and 50; with the
  // lock, every mutator sees the post-prior value and the result is
  // exactly 50.
  const file = path.join(TMP, 'b.json');
  const bumps = Array.from({ length: 50 }, () =>
    atomicJsonMutate<{ n: number }>(file, (cur) => ({ n: cur.n + 1 }), { n: 0 }),
  );
  await Promise.all(bumps);
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).n, 50);
});

test('same-key async lock recursion fails fast instead of deadlocking before timeout accounting', async () => {
  const target = path.join(TMP, 'non-reentrant.json');
  const startedAt = Date.now();
  await assert.rejects(
    withFileLock(target, () => withFileLock(target, () => undefined)),
    (err: unknown) => err instanceof BoundaryError
      && err.kind === 'state.write_failed'
      && err.context.reason === 'non_reentrant_lock',
  );
  assert.ok(Date.now() - startedAt < 1_000, 'recursive acquisition must fail without a lock timeout');
  assert.equal(existsSync(`${target}.lock`), false, 'outer owner still releases after rejection');
});

test('strict lock release cannot unlink a replacement owner generation', () => {
  const target = path.join(TMP, 'owner-token-release.json');
  const lockPath = `${target}.lock`;
  const replacementToken = `${process.pid}:${Date.now()}:replacement-generation`;

  withFileLockSyncStrict(target, () => {
    assert.ok(readFileSync(lockPath, 'utf-8').includes(String(process.pid)));
    // Model a stale-takeover boundary: this holder resumes after another owner
    // has replaced the canonical pathname. Its finally block may release only
    // the generation it actually acquired.
    unlinkSync(lockPath);
    writeFileSync(lockPath, replacementToken, 'utf-8');
  });

  assert.equal(readFileSync(lockPath, 'utf-8'), replacementToken);
  unlinkSync(lockPath);
});

test('a paused stale observer cannot evict an intervening live strict-lock owner', async () => {
  const target = path.join(TMP, 'stale-observer-race.json');
  const lockPath = `${target}.lock`;
  const observerStaleMarker = path.join(TMP, 'stale-observer-observed');
  const observerStaleRelease = path.join(TMP, 'stale-observer-release');
  const observerEntered = path.join(TMP, 'stale-observer-entered');
  const observerWorkRelease = path.join(TMP, 'stale-observer-work-release');
  const winnerEntered = path.join(TMP, 'stale-winner-entered');
  const winnerWorkRelease = path.join(TMP, 'stale-winner-work-release');

  // A definitely-dead PID makes the initial generation reclaimable without a
  // wall-clock wait. The observer pauses after deciding it is stale.
  writeFileSync(lockPath, '2147483647:1:00000000-0000-4000-8000-000000000001', 'utf-8');
  const observer = spawnStrictLockParticipant({
    target,
    enteredMarker: observerEntered,
    workReleaseMarker: observerWorkRelease,
    staleObservedMarker: observerStaleMarker,
    staleObservedReleaseMarker: observerStaleRelease,
  });
  let winner: ChildProcess | undefined;
  try {
    await waitForFile(observerStaleMarker);
    winner = spawnStrictLockParticipant({
      target,
      enteredMarker: winnerEntered,
      workReleaseMarker: winnerWorkRelease,
    });
    await waitForFile(winnerEntered);

    // Resume the process whose stale decision names the old/dead generation.
    // It must revalidate under the deletion guard and wait for the live winner.
    writeFileSync(observerStaleRelease, 'release', 'utf-8');
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(
      existsSync(observerEntered),
      false,
      'the stale observation must not delete the replacement generation',
    );

    writeFileSync(winnerWorkRelease, 'release', 'utf-8');
    await waitForFile(observerEntered);
    writeFileSync(observerWorkRelease, 'release', 'utf-8');
  } finally {
    // Never strand a child if an assertion fails; each marker is idempotent.
    writeFileSync(observerStaleRelease, 'release', 'utf-8');
    writeFileSync(winnerWorkRelease, 'release', 'utf-8');
    writeFileSync(observerWorkRelease, 'release', 'utf-8');
  }

  const [observerExit, winnerExit] = await Promise.all([
    childResult(observer),
    childResult(winner!),
  ]);
  assert.equal(observerExit.code, 0, observerExit.stderr);
  assert.equal(winnerExit.code, 0, winnerExit.stderr);
  assert.equal(existsSync(lockPath), false, 'the final owner releases its own generation');
  assert.deepEqual(deletionGuardMarkerNames(target), [], 'no deletion guard ticket is stranded');
});

test('a live deletion-guard owner cannot be age-evicted after its final generation check', async () => {
  const target = path.join(TMP, 'live-delete-guard.json');
  const lockPath = `${target}.lock`;
  const deleteValidated = path.join(TMP, 'live-delete-guard-validated');
  const deleteRelease = path.join(TMP, 'live-delete-guard-release');
  const firstEntered = path.join(TMP, 'live-delete-first-entered');
  const firstWorkRelease = path.join(TMP, 'live-delete-first-work-release');
  const secondEntered = path.join(TMP, 'live-delete-second-entered');
  const secondWorkRelease = path.join(TMP, 'live-delete-second-work-release');

  writeFileSync(lockPath, '2147483647:1:00000000-0000-4000-8000-000000000002', 'utf-8');
  const first = spawnStrictLockParticipant({
    target,
    enteredMarker: firstEntered,
    workReleaseMarker: firstWorkRelease,
    deleteValidatedMarker: deleteValidated,
    deleteValidatedReleaseMarker: deleteRelease,
  });
  let second: ChildProcess | undefined;
  try {
    await waitForFile(deleteValidated);

    // Exceed the former one-second age-only guard lease. A second reaper must
    // still respect the first reaper's live PID and remain outside the work.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_250));
    second = spawnStrictLockParticipant({
      target,
      enteredMarker: secondEntered,
      workReleaseMarker: secondWorkRelease,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(secondEntered), false, 'live deletion guard must not be age-evicted');

    writeFileSync(deleteRelease, 'release', 'utf-8');
    await waitForFile(firstEntered);
    assert.equal(existsSync(secondEntered), false, 'only the first participant owns the replacement lock');
    writeFileSync(firstWorkRelease, 'release', 'utf-8');
    await waitForFile(secondEntered);
    writeFileSync(secondWorkRelease, 'release', 'utf-8');
  } finally {
    writeFileSync(deleteRelease, 'release', 'utf-8');
    writeFileSync(firstWorkRelease, 'release', 'utf-8');
    writeFileSync(secondWorkRelease, 'release', 'utf-8');
  }

  const [firstExit, secondExit] = await Promise.all([
    childResult(first),
    childResult(second!),
  ]);
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(deletionGuardMarkerNames(target), [], 'all UUID-scoped guard tickets are released');
});

test('a crashed deletion-guard owner does not strand canonical stale-lock recovery', async () => {
  const target = path.join(TMP, 'crashed-delete-guard.json');
  const lockPath = `${target}.lock`;
  const deleteValidated = path.join(TMP, 'crashed-delete-guard-validated');
  const neverReleaseDelete = path.join(TMP, 'crashed-delete-guard-never-release');
  const crashedEntered = path.join(TMP, 'crashed-delete-guard-first-entered');
  const crashedWorkRelease = path.join(TMP, 'crashed-delete-guard-first-work-release');
  const recoveryEntered = path.join(TMP, 'crashed-delete-guard-recovery-entered');
  const recoveryRelease = path.join(TMP, 'crashed-delete-guard-recovery-release');

  writeFileSync(lockPath, '2147483647:1:00000000-0000-4000-8000-000000000003', 'utf-8');
  const crashed = spawnStrictLockParticipant({
    target,
    enteredMarker: crashedEntered,
    workReleaseMarker: crashedWorkRelease,
    deleteValidatedMarker: deleteValidated,
    deleteValidatedReleaseMarker: neverReleaseDelete,
  });
  await waitForFile(deleteValidated);
  crashed.kill('SIGKILL');
  const crashedResult = await childResult(crashed);
  assert.notEqual(crashedResult.code, 0, 'the guard owner is deliberately crash-stopped');

  const recovery = spawnStrictLockParticipant({
    target,
    enteredMarker: recoveryEntered,
    workReleaseMarker: recoveryRelease,
  });
  try {
    await waitForFile(recoveryEntered);
    writeFileSync(recoveryRelease, 'release', 'utf-8');
  } finally {
    writeFileSync(recoveryRelease, 'release', 'utf-8');
  }
  const recoveryResult = await childResult(recovery);
  assert.equal(recoveryResult.code, 0, recoveryResult.stderr);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(deletionGuardMarkerNames(target), [], 'dead owner ticket is safely collected by unique name');
});

test('malformed numeric-prefix owner text is not mistaken for a dead PID lease', async () => {
  const target = path.join(TMP, 'strict-owner-token.json');
  const lockPath = `${target}.lock`;
  const entered = path.join(TMP, 'strict-owner-token-entered');
  const workRelease = path.join(TMP, 'strict-owner-token-release');
  writeFileSync(lockPath, '2147483647garbage', 'utf-8');

  const participant = spawnStrictLockParticipant({ target, enteredMarker: entered, workReleaseMarker: workRelease });
  let seededLockRemoved = false;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(entered), false, 'fresh malformed state follows the conservative stale-age policy');
    unlinkSync(lockPath);
    seededLockRemoved = true;
    await waitForFile(entered);
    writeFileSync(workRelease, 'release', 'utf-8');
  } finally {
    if (!seededLockRemoved) {
      try { unlinkSync(lockPath); } catch { /* unblock failed assertion cleanup */ }
    }
    writeFileSync(workRelease, 'release', 'utf-8');
  }
  const result = await childResult(participant);
  assert.equal(result.code, 0, result.stderr);
});

test('atomicJsonMutate runs mutators in PARALLEL across different files', async () => {
  // Two files, one slow mutator each. They should NOT serialize against
  // each other — different files = different locks.
  const f1 = path.join(TMP, 'c1.json');
  const f2 = path.join(TMP, 'c2.json');
  const intervals: Array<{ name: string; start: number; end: number }> = [];
  const slowMutator = (name: string) => async (cur: { v: number }) => {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 100));
    const end = performance.now();
    intervals.push({ name, start, end });
    return { v: cur.v + 1 };
  };

  await Promise.all([
    atomicJsonMutate<{ v: number }>(f1, slowMutator('c1'), { v: 0 }),
    atomicJsonMutate<{ v: number }>(f2, slowMutator('c2'), { v: 0 }),
  ]);

  assert.equal(intervals.length, 2);
  const [a, b] = intervals;
  assert.ok(a && b);
  const overlapped = a.start < b.end && b.start < a.end;
  assert.ok(
    overlapped,
    `expected mutators for different files to overlap, got ${JSON.stringify(intervals)}`,
  );
});

test('atomicJsonMutate skips the write when mutator returns undefined', async () => {
  const file = path.join(TMP, 'd.json');
  writeFileSync(file, JSON.stringify({ untouched: true }, null, 2));
  await atomicJsonMutate(file, () => undefined, { untouched: false });
  const after = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(after.untouched, true);
});

test('atomicJsonMutate quarantines corrupted JSON instead of silent-overwriting', async () => {
  const file = path.join(TMP, 'e.json');
  writeFileSync(file, '{this-is-not-json');
  let caught: unknown;
  try {
    await atomicJsonMutate(file, (cur) => cur, { ok: true });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof BoundaryError, 'should throw BoundaryError');
  assert.equal((caught as InstanceType<typeof BoundaryError>).kind, 'state.read_corrupted');
  // The corrupted file is preserved with a .corrupt-<ts> suffix.
  // (We don't know the exact timestamp, but the original is gone and a
  // sibling with `.corrupt-` prefix exists.)
  const siblings = readdirSync(TMP).filter((n) => n.startsWith('e.json.corrupt-'));
  assert.equal(siblings.length, 1);
});

test('atomicJsonMutate propagates errors from the mutator', async () => {
  const file = path.join(TMP, 'f.json');
  await atomicJsonMutate<{ n: number }>(file, () => ({ n: 5 }), { n: 0 });
  let caught: unknown;
  try {
    await atomicJsonMutate<{ n: number }>(file, () => {
      throw new Error('mutator boom');
    }, { n: 0 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal((caught as Error).message, 'mutator boom');
  // The file should NOT have changed.
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).n, 5);
});

test('atomicAppendNdjson appends one line per call, in order, under concurrency', async () => {
  const file = path.join(TMP, 'g.ndjson');
  const writes = Array.from({ length: 30 }, (_, i) =>
    atomicAppendNdjson(file, JSON.stringify({ i })),
  );
  await Promise.all(writes);
  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 30);
  // Every JSON line must parse — no interleaved garbage.
  const seenIds = new Set<number>();
  for (const line of lines) {
    const parsed = JSON.parse(line) as { i: number };
    assert.ok(typeof parsed.i === 'number');
    seenIds.add(parsed.i);
  }
  // No drops, no duplicates.
  assert.equal(seenIds.size, 30);
});

test('atomicAppendNdjson rejects multi-line input (caller bug)', async () => {
  const file = path.join(TMP, 'h.ndjson');
  let caught: unknown;
  try {
    await atomicAppendNdjson(file, 'a\nb');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof BoundaryError);
  assert.equal((caught as InstanceType<typeof BoundaryError>).kind, 'state.write_failed');
  assert.ok(!existsSync(file), 'file should not be created on caller-input error');
});
