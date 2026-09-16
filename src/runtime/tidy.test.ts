/**
 * Tidy plans the exact clutter first and settles only what it planned: unread
 * updates are marked read, a run blocked for over a day is stopped, and a
 * conversation nobody has spoken in for weeks is archived and leaves the
 * phone's list — nothing is deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tidy-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'workflows', 'runs'), { recursive: true });

const { HarnessSession } = await import('./harness/session.js');
const { listSessions, getSession } = await import('./harness/eventlog.js');
const { addNotification, loadNotifications } = await import('./notifications.js');
const { planTidy, applyTidy, summarizeTidyPlan, parseTidyClasses } = await import('./tidy.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('tidy plans exact clutter and settles only what it planned', async () => {
  const idle = HarnessSession.create({ kind: 'chat', title: 'an old conversation' });
  idle.recordUserInput('hello from weeks ago', 1);
  const fresh = HarnessSession.create({ kind: 'chat', title: 'today' });
  fresh.recordUserInput('hi', 1);
  const pinned = HarnessSession.create({ kind: 'chat', title: 'pinned', metadata: { pinned: true } });
  pinned.recordUserInput('keep me', 1);

  addNotification({ id: 'n-update', kind: 'workflow', title: 'Morning brief', body: 'done', createdAt: new Date().toISOString(), read: false });
  addNotification({ id: 'n-ask', kind: 'system', title: 'Something needs attention', body: 'answer me', createdAt: new Date().toISOString(), read: false, metadata: { needsAttention: true } });
  addNotification({ id: 'n-silent', kind: 'system', title: 'quiet', body: '', createdAt: new Date().toISOString(), read: false, silent: true } as never);

  const dayAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-stuck.json'), JSON.stringify({ id: 'run-stuck', workflow: 'weekly-review', status: 'blocked', createdAt: dayAgo, updatedAt: dayAgo }));
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-live.json'), JSON.stringify({ id: 'run-live', workflow: 'weekly-review', status: 'blocked', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-done.json'), JSON.stringify({ id: 'run-done', workflow: 'weekly-review', status: 'completed', createdAt: dayAgo, updatedAt: dayAgo }));

  // "Weeks later": the planner's clock moves, the store does not.
  const later = Date.now() + 30 * 86_400_000;
  const plan = await planTidy({}, later);
  const counts = summarizeTidyPlan(plan);
  assert.equal(counts.updates, 1, 'only the plain unread update; the open ask and the silent row are not clutter');
  assert.deepEqual(plan.updates.map((u) => u.id), ['n-update']);
  assert.equal(counts.stuckRuns, 2, 'from thirty days out both blocked runs are stuck; the completed one never is');
  const idleIds = plan.oldConversations.map((c) => c.id);
  assert.ok(idleIds.includes(idle.id) && idleIds.includes(fresh.id), 'from thirty days out, both unpinned chats are idle');
  assert.ok(!idleIds.includes(pinned.id), 'a pinned conversation is never archived');

  // Today, with the real clock, nothing is old yet.
  const now = await planTidy();
  assert.equal(summarizeTidyPlan(now).oldConversations, 0);
  assert.deepEqual(now.stuckRuns.map((r) => r.id), ['run-stuck'], 'only the run blocked for over a day is stuck today');

  const result = await applyTidy(plan, ['updates', 'oldConversations'], later);
  assert.equal(result.updatesCleared, 1);
  assert.equal(result.conversationsArchived, idleIds.length);
  assert.equal(result.runsStopped, 0, 'a class the surface did not choose is untouched');
  assert.deepEqual(result.errors, []);
  assert.equal(loadNotifications().find((n) => n.id === 'n-update')?.read, true);
  assert.equal(loadNotifications().find((n) => n.id === 'n-ask')?.read, false);
  assert.equal(getSession(idle.id)?.metadata.archived, true);
  assert.equal(getSession(pinned.id)?.metadata.archived, undefined);
  const visible = listSessions({ kind: 'chat', archived: false }).map((s) => s.id);
  assert.ok(!visible.includes(idle.id), 'an archived conversation leaves the list a person reads');
  assert.ok(visible.includes(pinned.id));
  assert.equal(listSessions({ kind: 'chat' }).some((s) => s.id === idle.id), true, 'nothing was deleted');

  // A "needs you" card whose ask is no longer live is an ask to settle; it
  // is never touched by the updates class.
  const asksPlan = await planTidy({}, later, 'all');
  assert.ok(asksPlan.staleAsks.some((ask) => ask.kind === 'notification' && ask.id === 'n-ask'), 'the open card is planned as an ask');
  const asksResult = await applyTidy(asksPlan, ['staleAsks'], later);
  assert.equal(asksResult.asksCancelled, 1);
  assert.equal(loadNotifications().find((n) => n.id === 'n-ask')?.read, true, 'the stale card was settled');

  // A second plan finds the settled items gone.
  const again = summarizeTidyPlan(await planTidy({}, later));
  assert.equal(again.updates, 0);
  assert.equal(again.oldConversations, 0);
});

test('class lists from a surface are validated, never trusted', () => {
  assert.deepEqual(parseTidyClasses(['updates', 'bogus']), ['updates']);
  assert.deepEqual(parseTidyClasses(undefined), ['updates', 'staleAsks', 'stuckRuns', 'oldConversations']);
  assert.deepEqual(parseTidyClasses([]), ['updates', 'staleAsks', 'stuckRuns', 'oldConversations']);
});
