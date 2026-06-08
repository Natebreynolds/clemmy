/**
 * Run: npx tsx --test src/spaces/scheduler.test.ts
 *
 * Deterministic (fake clock, fixture runner, no network/LLM) coverage of the
 * Workspaces scheduler tick: a due data source fires + persists; it fires at
 * most once per minute (dedup); a paused workspace is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-sched-test-'));

const store = await import('./store.js');
const data = await import('./data-store.js');
const sched = await import('./scheduler.js');

function writeRunner(slug: string, file: string, body: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, 'utf-8');
}

test('a due (every-minute) data source fires and persists; dedupes within the minute', async () => {
  const slug = 'sched-due';
  store.spaceStore.save({
    id: slug, title: 'Due',
    dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: '* * * * *' }],
  });
  writeRunner(slug, 'r.mjs', 'process.stdout.write(JSON.stringify({n:1}))');

  const now = new Date('2026-06-08T08:00:00.000Z');
  const first = await sched.processSpaceSchedules(now);
  assert.equal(first.fired, 1);
  assert.deepEqual((data.readData(slug) as any).pull, { n: 1 });

  // Same minute again → no double fire (dedup).
  const second = await sched.processSpaceSchedules(now);
  assert.equal(second.fired, 0);

  // Archive so this every-minute source doesn't re-fire across the catch-up
  // window in later tests (they share one CLEMENTINE_HOME + schedule state).
  store.spaceStore.archive(slug);
});

test('a paused workspace is skipped by the scheduler', async () => {
  const slug = 'sched-paused';
  store.spaceStore.save({
    id: slug, title: 'Paused',
    status: 'paused',
    dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: '* * * * *' }],
  });
  writeRunner(slug, 'r.mjs', 'process.stdout.write(JSON.stringify({n:9}))');
  const res = await sched.processSpaceSchedules(new Date('2026-06-08T09:00:00.000Z'));
  // evaluated counts only active spaces' scheduled sources; paused contributes 0.
  assert.equal(res.fired, 0);
  assert.deepEqual(data.readData(slug), {});
});

test('a data source with no schedule never fires', async () => {
  const slug = 'sched-none';
  store.spaceStore.save({ id: slug, title: 'None', dataSources: [{ id: 'pull', runner: 'r.mjs' }] });
  writeRunner(slug, 'r.mjs', 'process.stdout.write(JSON.stringify({n:0}))');
  const res = await sched.processSpaceSchedules(new Date('2026-06-08T10:00:00.000Z'));
  assert.equal(res.fired, 0);
  assert.deepEqual(data.readData(slug), {});
});
