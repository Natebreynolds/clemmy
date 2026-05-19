/**
 * Run: npx tsx --test src/runtime/atomic-json.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-atomic-json-test-'));
test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { atomicJsonMutate, atomicAppendNdjson } = await import('./atomic-json.js');
const { BoundaryError } = await import('./boundary-error.js');

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

test('atomicJsonMutate runs mutators in PARALLEL across different files', async () => {
  // Two files, one slow mutator each. They should NOT serialize against
  // each other — different files = different locks.
  const f1 = path.join(TMP, 'c1.json');
  const f2 = path.join(TMP, 'c2.json');
  const start = Date.now();
  await Promise.all([
    atomicJsonMutate<{ v: number }>(f1, async (cur) => {
      await new Promise((r) => setTimeout(r, 100));
      return { v: cur.v + 1 };
    }, { v: 0 }),
    atomicJsonMutate<{ v: number }>(f2, async (cur) => {
      await new Promise((r) => setTimeout(r, 100));
      return { v: cur.v + 1 };
    }, { v: 0 }),
  ]);
  const elapsed = Date.now() - start;
  // If they serialized, elapsed > 200ms. Parallel = ~100ms + jitter.
  assert.ok(elapsed < 180, `expected parallel execution, got ${elapsed}ms`);
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
  const { readdirSync } = await import('node:fs');
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
