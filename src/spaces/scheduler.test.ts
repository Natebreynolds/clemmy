/**
 * Run: npx tsx --test src/spaces/scheduler.test.ts
 *
 * Deterministic (fake clock, fixture runner, no network/LLM) coverage of the
 * Workspaces scheduler tick: a due data source fires + persists; it fires at
 * most once per minute (dedup); a paused workspace is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-sched-test-'));

const store = await import('./store.js');
const data = await import('./data-store.js');
const sched = await import('./scheduler.js');
const runner = await import('./runner.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');

function writeRunner(slug: string, file: string, body: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, 'utf-8');
}

async function approveInstalledRunnerFixture(
  slug: string,
  source: Parameters<typeof runner.runSpaceDataSource>[1],
): Promise<void> {
  const blocked = await runner.runSpaceDataSource(slug, source);
  assert.equal(blocked.ok, false);
  const card = approvals.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  }).find((row) => row.args?.sourceId === source.id);
  assert.ok(card);
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('scheduler-runner-fixture', new Date().toISOString(), card.approvalId);
}

test('a due approved local source is contained and still dedupes within the minute', async () => {
  const slug = 'sched-due';
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '* * * * *' };
  store.spaceStore.save({
    id: slug, title: 'Due',
    dataSources: [source],
  });
  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({n:1}));`);
  await approveInstalledRunnerFixture(slug, source);
  try {
    const now = new Date('2026-06-08T08:00:00.000Z');
    const first = await sched.processSpaceSchedules(now);
    assert.equal(first.fired, 0);
    assert.equal(first.errors, 1);
    assert.equal(Object.hasOwn(data.readData(slug) as object, 'pull'), false);

    // Same minute again → no double fire (dedup).
    const second = await sched.processSpaceSchedules(now);
    assert.equal(second.fired, 0);
  } finally {
    // Archive so this every-minute source doesn't re-fire across later tests.
    store.spaceStore.archive(slug);
  }
});

test('a 24-hour hourly backlog contains one latest occurrence without starting a process', async () => {
  const slug = 'sched-hourly-collapse';
  const stateFile = path.join(process.env.CLEMENTINE_HOME!, 'state', 'space-schedule-state.json');
  const beforeOutage = new Date('2026-06-08T11:01:00.000Z');
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    lastEvaluatedAtMs: beforeOutage.getTime(),
    lastRunByMinute: {},
    lastReengageByKey: {},
    pausedRetryBySlug: {},
  }), 'utf-8');

  store.spaceStore.save({
    id: slug,
    title: 'Hourly collapse',
    dataSources: [{ id: 'pull', runner: 'pull.mjs', schedule: '0 * * * *' }],
  });

  const source = store.spaceStore.get(slug)!.dataSources[0]!;
  writeRunner(slug, 'pull.mjs', `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const url = new URL('./dispatch-count.txt', import.meta.url);
const dispatches = existsSync(url) ? Number(readFileSync(url, 'utf8')) + 1 : 1;
writeFileSync(url, String(dispatches));
process.stdout.write(JSON.stringify({dispatches}));`);
  await approveInstalledRunnerFixture(slug, source);

  try {
    const wake = new Date('2026-06-09T11:01:00.000Z');
    const first = await sched.processSpaceSchedules(wake);
    assert.equal(first.fired, 0);
    assert.equal(first.errors, 1, 'the collapsed latest occurrence reports one contained failure');
    assert.equal(
      (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/dispatch-count.txt')),
      false,
      '24 matched hourly minutes collapse without starting the approved local body',
    );
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      lastRunByMinute?: Record<string, string>;
    };
    assert.equal(
      persisted.lastRunByMinute?.[`${slug}:pull`],
      '2026-06-09T11:00',
      'collapse commits the latest missed occurrence, not the first one in the scan',
    );

    const sameMinute = await sched.processSpaceSchedules(wake);
    assert.equal(sameMinute.fired, 0, 'the latest occurrence remains idempotent');
    assert.equal(
      (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/dispatch-count.txt')),
      false,
      'same-minute reevaluation remains zero-process',
    );
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('a paused workspace is skipped by the scheduler', async () => {
  const slug = 'sched-paused';
  store.spaceStore.save({
    id: slug, title: 'Paused',
    status: 'paused',
    dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS', schedule: '* * * * *' }],
  });
  const res = await sched.processSpaceSchedules(new Date('2026-06-08T09:00:00.000Z'));
  // evaluated counts only active spaces' scheduled sources; paused contributes 0.
  assert.equal(res.fired, 0);
  assert.deepEqual(data.readData(slug), {});
});

test('a data source with no schedule never fires', async () => {
  const slug = 'sched-none';
  store.spaceStore.save({ id: slug, title: 'None', dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' }] });
  const res = await sched.processSpaceSchedules(new Date('2026-06-08T10:00:00.000Z'));
  assert.equal(res.fired, 0);
  assert.deepEqual(data.readData(slug), {});
});

test('a due installed legacy runner requests one decision without counting as a scheduler error', async () => {
  const slug = 'sched-legacy-trust';
  store.spaceStore.save({
    id: slug,
    title: 'Legacy schedule',
    dataSources: [{ id: 'pull', runner: 'pull.mjs', schedule: '* * * * *' }],
  });
  writeRunner(
    slug,
    'pull.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./must-not-run.txt', import.meta.url), 'no');
process.stdout.write('{}');`,
  );

  const res = await sched.processSpaceSchedules(new Date('2026-06-08T10:00:00.000Z'));
  assert.equal(res.fired, 0);
  assert.equal(res.errors, 0);
  assert.equal(res.awaitingApproval, 1);
  assert.equal(
    approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
  );
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/must-not-run.txt')),
    false,
  );
  store.spaceStore.archive(slug);
});

test('E2: contained local source output cannot manufacture a re-engage signal', async () => {
  const slug = 'sched-rg';
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '* * * * *' };
  store.spaceStore.save({
    id: slug, title: 'Reengage',
    dataSources: [source],
    reengage: { triggers: ['threshold'] },
  });
  writeRunner(slug, source.runner, `
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(new URL('./current.json', import.meta.url), 'utf8'));`);
  const emit = (re: string) => {
    writeFileSync(
      store.resolveInSpace(slug, 'data/current.json'),
      JSON.stringify({ rows: [{ a: 1 }], _reengage: JSON.parse(re) }),
      'utf8',
    );
  };
  const fires = () => data.listAudit(slug).filter((a) => a.path === '/reengage/threshold').length;
  emit('{"fire":false}');
  await approveInstalledRunnerFixture(slug, source);

  try {
    // T1: condition A crosses → fires once. (1-minute catch-up windows step by step.)
    emit('{"fire":true,"key":"cold-A","message":"3 deals cold"}');
    await sched.processSpaceSchedules(new Date('2026-06-08T10:01:00.000Z'));
    assert.equal(fires(), 0);

    // T2: same condition (key A) persists → deduped, no new fire.
    await sched.processSpaceSchedules(new Date('2026-06-08T10:02:00.000Z'));
    assert.equal(fires(), 0);

    // T3: a NEW condition (key B) → fires again.
    emit('{"fire":true,"key":"cold-B","message":"5 deals cold"}');
    await sched.processSpaceSchedules(new Date('2026-06-08T10:03:00.000Z'));
    assert.equal(fires(), 0);

    // T4: condition clears (fire:false) → no re-engage, dedup reset.
    emit('{"fire":false}');
    await sched.processSpaceSchedules(new Date('2026-06-08T10:04:00.000Z'));
    assert.equal(fires(), 0);

    // T5: condition A returns → re-fires (the cleared dedup allows it).
    emit('{"fire":true,"key":"cold-A","message":"back cold"}');
    await sched.processSpaceSchedules(new Date('2026-06-08T10:05:00.000Z'));
    assert.equal(fires(), 0);
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('E2: a source with no _reengage signal never fires a re-engage', async () => {
  const slug = 'sched-norg';
  const source = { id: 'pull', runner: 'pull.mjs', schedule: '* * * * *' };
  store.spaceStore.save({
    id: slug, title: 'NoRe',
    dataSources: [source],
    reengage: { triggers: ['threshold'] },
  });
  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[{a:1}]}));`);
  await approveInstalledRunnerFixture(slug, source);
  try {
    await sched.processSpaceSchedules(new Date('2026-06-08T10:06:00.000Z'));
    assert.equal(data.listAudit(slug).filter((a) => a.path === '/reengage/threshold').length, 0);
  } finally {
    store.spaceStore.archive(slug);
  }
});

test('paused-build auto-retry spends its bounded attempts but cannot start a local runner', async () => {
  // Archive paused leftovers from earlier tests (shared CLEMENTINE_HOME) so the
  // retry counters below see exactly this test's workspace.
  for (const s of store.spaceStore.list()) if (s.status === 'paused') store.spaceStore.archive(s.id);
  const slug = 'retry-paused';
  const source = { id: 'pull', runner: 'pull.mjs' };
  store.spaceStore.save({
    id: slug, title: 'Retry Me',
    dataSources: [source],
  });
  writeRunner(slug, source.runner, `
import { readFileSync } from 'node:fs';
if (readFileSync(new URL('./outage.txt', import.meta.url), 'utf8').trim() === 'on') {
  process.stderr.write('api down');
  process.exit(1);
}
process.stdout.write(JSON.stringify({rows:[1,2]}));`);
  const outagePath = store.resolveInSpace(slug, 'data/outage.txt');
  writeFileSync(outagePath, 'on', 'utf8');
  await approveInstalledRunnerFixture(slug, source);
  store.spaceStore.update(slug, { status: 'paused' });

  // Too fresh (< 5 min since pause) → not touched.
  const now0 = new Date(Date.parse(store.spaceStore.get(slug)!.updatedAt) + 60_000);
  const early = await sched.retryPausedSpaces(now0);
  assert.equal(early.examined, 0, 'never races the authoring turn');

  // Attempt 1 (outage still on) → stays paused, budget spent.
  const now1 = new Date(now0.getTime() + 10 * 60_000);
  const first = await sched.retryPausedSpaces(now1);
  assert.equal(first.examined, 1);
  assert.equal(first.stillPaused, 1);
  assert.equal(store.spaceStore.get(slug)!.status, 'paused');

  // Immediately again → spacing gate holds (no burn-through).
  const spaced = await sched.retryPausedSpaces(new Date(now1.getTime() + 60_000));
  assert.equal(spaced.examined, 0, '15-min spacing between attempts');

  // Even if the runner's own outage fixture clears, attempt 2 remains
  // contained because no shared-kernel authority exists.
  writeFileSync(outagePath, 'off', 'utf8');
  const now2 = new Date(now1.getTime() + 16 * 60_000);
  const second = await sched.retryPausedSpaces(now2);
  assert.equal(second.reactivated, 0);
  assert.equal(second.stillPaused, 1);
  assert.equal(store.spaceStore.get(slug)!.status, 'paused');
  assert.equal(Object.hasOwn(data.readData(slug) as object, 'pull'), false);

  // Budget exhausted → nothing left to retry.
  const done = await sched.retryPausedSpaces(new Date(now2.getTime() + 20 * 60_000));
  assert.equal(done.examined, 0);
  store.spaceStore.archive(slug);
});

test('paused-build auto-retry: a genuinely-broken source exhausts 2 attempts and stays paused (human decision)', async () => {
  const slug = 'retry-exhaust';
  store.spaceStore.save({
    id: slug, title: 'Broken',
    dataSources: [{ id: 'pull', runner: 'broken.mjs' }],
  });
  writeRunner(slug, 'broken.mjs', 'console.error("always fails"); process.exit(1);');
  store.spaceStore.update(slug, { status: 'paused' });

  const base = Date.parse(store.spaceStore.get(slug)!.updatedAt) + 10 * 60_000;
  const a1 = await sched.retryPausedSpaces(new Date(base));
  const a2 = await sched.retryPausedSpaces(new Date(base + 20 * 60_000));
  const a3 = await sched.retryPausedSpaces(new Date(base + 40 * 60_000));
  assert.equal(a1.examined + a2.examined + a3.examined, 2, 'budget = 2 attempts, then stop');
  assert.equal(store.spaceStore.get(slug)!.status, 'paused', 'a real bug stays a human decision');
  store.spaceStore.archive(slug);
});
