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

test('E2: a runner _reengage signal fires a threshold re-engage once, dedupes, and re-fires after it clears', async () => {
  const slug = 'sched-rg';
  store.spaceStore.save({
    id: slug, title: 'Reengage',
    dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: '* * * * *' }],
    reengage: { triggers: ['threshold'] },
  });
  const emit = (re: string) => writeRunner(slug, 'r.mjs', `process.stdout.write(JSON.stringify({rows:[{a:1}],_reengage:${re}}))`);
  const fires = () => data.listAudit(slug).filter((a) => a.path === '/reengage/threshold').length;

  // T1: condition A crosses → fires once. (1-minute catch-up windows step by step.)
  emit('{"fire":true,"key":"cold-A","message":"3 deals cold"}');
  await sched.processSpaceSchedules(new Date('2026-06-08T10:01:00.000Z'));
  assert.equal(fires(), 1);

  // T2: same condition (key A) persists → deduped, no new fire.
  await sched.processSpaceSchedules(new Date('2026-06-08T10:02:00.000Z'));
  assert.equal(fires(), 1);

  // T3: a NEW condition (key B) → fires again.
  emit('{"fire":true,"key":"cold-B","message":"5 deals cold"}');
  await sched.processSpaceSchedules(new Date('2026-06-08T10:03:00.000Z'));
  assert.equal(fires(), 2);

  // T4: condition clears (fire:false) → no re-engage, dedup reset.
  emit('{"fire":false}');
  await sched.processSpaceSchedules(new Date('2026-06-08T10:04:00.000Z'));
  assert.equal(fires(), 2);

  // T5: condition A returns → re-fires (the cleared dedup allows it).
  emit('{"fire":true,"key":"cold-A","message":"back cold"}');
  await sched.processSpaceSchedules(new Date('2026-06-08T10:05:00.000Z'));
  assert.equal(fires(), 3);

  store.spaceStore.archive(slug);
});

test('E2: a source with no _reengage signal never fires a re-engage', async () => {
  const slug = 'sched-norg';
  store.spaceStore.save({
    id: slug, title: 'NoRe',
    dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: '* * * * *' }],
    reengage: { triggers: ['threshold'] },
  });
  writeRunner(slug, 'r.mjs', 'process.stdout.write(JSON.stringify({rows:[{a:1}]}))');
  await sched.processSpaceSchedules(new Date('2026-06-08T10:06:00.000Z'));
  assert.equal(data.listAudit(slug).filter((a) => a.path === '/reengage/threshold').length, 0);
  store.spaceStore.archive(slug);
});
