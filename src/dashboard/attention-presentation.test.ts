import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-attention-presentation-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const { needsYouReferents, notificationAttentionHidden, notificationNeedsYou, summarizeNeedsYou,
  listAttentionPresentations, presentAttentionItem } = await import('./needs-you.js');
const { addNotification, getNotification, markNotificationRead } = await import('../runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');
const { attentionGeneration, attentionLifecycle, mutateAttentionPreference } = await import('./attention-presentation.js');
const NOW = Date.now();
const iso = (offset = 0) => new Date(NOW + offset).toISOString();

test.after(() => { resetEventLog(); rmSync(home, { recursive: true, force: true }); });
function item(key: string, nowMs = NOW) {
  const found = needsYouReferents(nowMs, { freshRuns: true }).attentionItems?.get(key);
  assert.ok(found, `Controlled attention item must exist: ${key}`);
  return found;
}
function notice(id: string, metadata: Record<string, unknown>, kind: 'execution' | 'workflow' = 'execution') {
  const row = { id, kind, title: `FRAMEWORK-TEST attention ${id}`, body: `Controlled pending material for ${id}`,
    createdAt: iso(), read: false, metadata };
  addNotification(row);
  return row;
}
function writeRun(id: string, workflow: string, status = 'blocked', extra: Record<string, unknown> = {}) {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const bytes = JSON.stringify({ id, workflow, workflowSlug: workflow, status, createdAt: iso(), ...extra });
  const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  writeFileSync(file, bytes);
  return { file, bytes };
}

test('workflow attention clears every carrier and exactly one count without changing the paused run or source notifications', async () => {
  const workflow = 'framework-test-attention-flow';
  const run = writeRun('FRAMEWORK-TEST-flow', workflow);
  const notices = [1, 2].map(index => notice(`FRAMEWORK-TEST-flow-${index}`, { workflow, runId: 'FRAMEWORK-TEST-flow', needsAttention: true }, 'workflow'));
  const key = `flow:${workflow}`;
  const current = item(key);
  const before = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(before.keys.filter(value => value === key).length, 1);
  assert.equal(before.attentionItems.find(value => value.key === key)?.lifecycle.generation, current.lifecycle.generation);
  const receipt = presentAttentionItem(key, 'dismiss', current.lifecycle.generation, undefined, NOW);
  assert.ok(receipt.ok);
  const after = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(after.total, before.total - 1);
  assert.equal(after.stoppedWorkflows, before.stoppedWorkflows - 1);
  assert.equal(after.unreadUpdates, before.unreadUpdates, 'a hidden ask does not become a newly unread update');
  const ref = needsYouReferents(NOW);
  for (const row of notices) {
    assert.equal(notificationAttentionHidden(row, ref), true);
    assert.equal(notificationNeedsYou(row, ref), false);
    assert.equal(getNotification(row.id)?.read, false, 'presentation never acknowledges the source carrier');
  }
  assert.equal(readFileSync(run.file, 'utf8'), run.bytes);
  const recovered = listAttentionPresentations(NOW).find(row => row.key === key)!;
  assert.equal(recovered.mutationToken, receipt.mutationToken);
  assert.equal(recovered.lifecycle.generation, receipt.generation);
  assert.equal(recovered.kind, 'workflow');
  assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW).ok, true);
  assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW).ok, true, 'identical Undo replay is idempotent');
  assert.equal((await summarizeNeedsYou({ nowMs: NOW })).keys.includes(key), true);
});

test('conversation and calendar attention use the same recoverable preference without answering the user or event', async () => {
  const chat = notice('FRAMEWORK-TEST-chat', { sessionId: 'FRAMEWORK-TEST-session', status: 'needs_input', needsAttention: true });
  const calendar = notice('FRAMEWORK-TEST-calendar', { watch: 'calendar', itemKey: 'FRAMEWORK-TEST-account|invite_unanswered|event',
    changeKind: 'invite_unanswered', startsAt: iso(86_400_000), needsAttention: true });
  for (const [row, key, kind] of [[chat, 'session:FRAMEWORK-TEST-session', 'conversation'],
    [calendar, 'calendar:FRAMEWORK-TEST-account|invite_unanswered|event', 'calendar']] as const) {
    const current = item(key);
    assert.equal(current.kind, kind);
    const receipt = presentAttentionItem(key, 'defer', current.lifecycle.generation, undefined, NOW);
    assert.ok(receipt.ok && receipt.until);
    assert.equal((await summarizeNeedsYou({ nowMs: NOW })).keys.includes(key), false);
    assert.equal(listAttentionPresentations(NOW).find(value => value.key === key)?.action, 'defer');
    assert.equal(getNotification(row.id)?.read, false);
    assert.equal(listAttentionPresentations(Date.parse(receipt.until)).some(value => value.key === key), false);
    assert.equal((await summarizeNeedsYou({ nowMs: Date.parse(receipt.until) })).keys.includes(key), true, 'expired deferral is visible again');
    assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW).ok, true);
  }
});

test('a newer phone preference fences an older desktop Undo for the unchanged attention generation', () => {
  const key = 'session:FRAMEWORK-TEST-two-devices';
  notice('FRAMEWORK-TEST-two-devices', { sessionId: 'FRAMEWORK-TEST-two-devices', status: 'needs_input' });
  const generation = item(key).lifecycle.generation;
  const desktop = presentAttentionItem(key, 'dismiss', generation, undefined, NOW);
  const phone = presentAttentionItem(key, 'defer', generation, undefined, NOW);
  assert.ok(desktop.ok && phone.ok);
  assert.notEqual(desktop.mutationToken, phone.mutationToken);
  assert.equal(presentAttentionItem(key, 'restore', generation, desktop.mutationToken, NOW).ok, false);
  assert.equal(notificationAttentionHidden(getNotification('FRAMEWORK-TEST-two-devices')!, needsYouReferents(NOW)), true);
  assert.equal(presentAttentionItem(key, 'restore', generation, phone.mutationToken, NOW).ok, true);
});

test('setting aside an ask preserves ordinary updates sharing its conversation identity', async () => {
  const sessionId = 'FRAMEWORK-TEST-ask-and-update';
  const ask = notice(`${sessionId}-ask`, { sessionId, status: 'needs_input' });
  const update = notice(`${sessionId}-update`, { sessionId, status: 'completed', needsAttention: false });
  const key = `session:${sessionId}`;
  const current = item(key);
  const before = await summarizeNeedsYou({ nowMs: NOW });
  assert.equal(presentAttentionItem(key, 'dismiss', current.lifecycle.generation, undefined, NOW).ok, true);
  const ref = needsYouReferents(NOW);
  assert.equal(notificationAttentionHidden(ask, ref), true);
  assert.equal(notificationAttentionHidden(update, ref), false);
  assert.equal((await summarizeNeedsYou({ nowMs: NOW })).unreadUpdates, before.unreadUpdates);
  assert.equal(getNotification(update.id)?.read, false);
});

test('a revised workflow stop invalidates old hide and restore receipts even within the cached run-index window', () => {
  const workflow = 'framework-test-revised-stop';
  const run = writeRun('FRAMEWORK-TEST-revised-stop', workflow, 'blocked', { error: 'Controlled first stop' });
  notice('FRAMEWORK-TEST-revised-stop-notice', { workflow, runId: 'FRAMEWORK-TEST-revised-stop', needsAttention: true }, 'workflow');
  const key = `flow:${workflow}`;
  const before = item(key);
  const receipt = presentAttentionItem(key, 'dismiss', before.lifecycle.generation, undefined, NOW);
  assert.ok(receipt.ok);
  // This changes an existing file, so directory mtime and the short cache can remain unchanged.
  writeFileSync(run.file, JSON.stringify({ id: 'FRAMEWORK-TEST-revised-stop', workflow, workflowSlug: workflow,
    status: 'blocked', createdAt: iso(), error: 'A different controlled stop' }));
  assert.equal(presentAttentionItem(key, 'dismiss', before.lifecycle.generation, undefined, NOW + 1).ok, false);
  assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW + 1).ok, false);
  assert.equal(listAttentionPresentations(NOW + 1).some(row => row.key === key), false, 'old saved content is not presented as current');
  const current = item(key, NOW + 1);
  assert.notEqual(current.lifecycle.generation, before.lifecycle.generation);
  assert.equal(notificationAttentionHidden(getNotification('FRAMEWORK-TEST-revised-stop-notice')!, needsYouReferents(NOW + 1)), false);
});

test('settled attention leaves recovery and a newer notification on the same subject is a fresh generation', () => {
  const key = 'session:FRAMEWORK-TEST-settled';
  notice('FRAMEWORK-TEST-settled-old', { sessionId: 'FRAMEWORK-TEST-settled', status: 'needs_input' });
  const old = item(key);
  const receipt = presentAttentionItem(key, 'dismiss', old.lifecycle.generation, undefined, NOW);
  assert.ok(receipt.ok);
  markNotificationRead('FRAMEWORK-TEST-settled-old');
  assert.equal(listAttentionPresentations(NOW).some(row => row.key === key), false);
  assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW).ok, false);
  notice('FRAMEWORK-TEST-settled-new', { sessionId: 'FRAMEWORK-TEST-settled', status: 'needs_input' });
  const next = item(key);
  assert.notEqual(next.lifecycle.generation, old.lifecycle.generation);
  assert.equal(notificationAttentionHidden(getNotification('FRAMEWORK-TEST-settled-new')!, needsYouReferents(NOW)), false);
});

test('damaged preference storage keeps all pending asks visible and refuses mutations without overwriting the bytes', async () => {
  const key = 'session:FRAMEWORK-TEST-damaged';
  const row = notice('FRAMEWORK-TEST-damaged', { sessionId: 'FRAMEWORK-TEST-damaged', status: 'needs_input' });
  const current = item(key);
  const receipt = presentAttentionItem(key, 'dismiss', current.lifecycle.generation, undefined, NOW);
  assert.ok(receipt.ok);
  const file = path.join(home, 'state', 'attention-presentation.json');
  const healthy = readFileSync(file, 'utf8');
  try {
    for (const bytes of ['{', 'null', JSON.stringify({ version: 1, entries: [] }), JSON.stringify({ version: 2, entries: {} })]) {
      writeFileSync(file, bytes);
      assert.equal(notificationAttentionHidden(row, needsYouReferents(NOW)), false);
      assert.ok((await summarizeNeedsYou({ nowMs: NOW })).keys.includes(key));
      assert.throws(() => listAttentionPresentations(NOW), /Saved attention settings are unavailable/);
      assert.throws(() => presentAttentionItem(key, 'dismiss', current.lifecycle.generation, undefined, NOW), /Saved attention settings are unavailable/);
      assert.equal(readFileSync(file, 'utf8'), bytes);
      assert.equal(getNotification(row.id)?.read, false);
    }
  } finally { writeFileSync(file, healthy); }
  assert.equal(presentAttentionItem(key, 'restore', receipt.generation, receipt.mutationToken, NOW).ok, true);
});

test('generic presentation never takes authority for decisions or exact questions, and never accepts a client-minted generation', () => {
  for (const key of ['approval:FRAMEWORK-TEST', 'plan:FRAMEWORK-TEST', 'trust:FRAMEWORK-TEST', 'chooser:FRAMEWORK-TEST',
    'proposal:FRAMEWORK-TEST', 'task:FRAMEWORK-TEST', 'checkin:FRAMEWORK-TEST', 'workflow:FRAMEWORK-TEST|question']) {
    assert.equal(presentAttentionItem(key, 'dismiss', 'a'.repeat(64), undefined, NOW).ok, false);
  }
  const key = 'session:FRAMEWORK-TEST-no-generation';
  notice('FRAMEWORK-TEST-no-generation', { sessionId: 'FRAMEWORK-TEST-no-generation', status: 'needs_input' });
  assert.equal(presentAttentionItem(key, 'dismiss', undefined, undefined, NOW).ok, false);
  assert.equal(presentAttentionItem(key, 'dismiss', 'b'.repeat(64), undefined, NOW).ok, false);
  assert.equal(presentAttentionItem(key, 'restore', item(key).lifecycle.generation, undefined, NOW).ok, false);
});

test('preference writes preserve another key instead of losing its newer device mutation', () => {
  const keys = ['notification:FRAMEWORK-TEST-independent-one', 'notification:FRAMEWORK-TEST-independent-two'];
  const items = keys.map(key => ({ key, kind: 'notification' as const, title: key, detail: 'Controlled', createdAt: iso(),
    lifecycle: attentionLifecycle(attentionGeneration(key)) }));
  for (const current of items) assert.ok(mutateAttentionPreference({ key: current.key, action: 'dismiss',
    generation: current.lifecycle.generation, nowMs: NOW }, () => items).ok);
  const bytes = JSON.parse(readFileSync(path.join(home, 'state', 'attention-presentation.json'), 'utf8')) as { entries: Record<string, unknown> };
  for (const key of keys) assert.ok(bytes.entries[key]);
});
