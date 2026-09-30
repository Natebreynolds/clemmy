import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-controls-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const store = await import('./store.js');
const runner = await import('./runner.js');
const recovery = await import('./workspace-script-refresh.js');
const journal = await import('./workspace-script-occurrence.js');
const controls = await import('./workspace-source-controls.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const consent = await import('../runtime/harness/saved-source-consent.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const datasets = await import('./workspace-db.js');
const schema = await import('../runtime/harness/eventlog-schema.js');
test.after(async () => {
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  await recovery.recoverSavedScriptRefreshes();
  eventlog.closeEventLog(); datasets.closeWorkspaceDb(); rmSync(home, { recursive: true, force: true });
});
function fixture(slug: string, body = 'console.log(JSON.stringify({ ok: true }));') {
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [
    { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'UTC' },
  ] });
  const dir = store.resolveInSpace(slug, 'data'); mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'refresh.mjs'); const marker = path.join(dir, 'crossings.txt');
  const write = (text: string) => writeFileSync(script, `import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); ${text}`);
  write(body); return { slug, script, marker, write };
}
const view = (slug: string) => controls.listWorkspaceSourceControls(slug)[0]!;
const command = (slug: string, action: 'stop' | 'review' | 'resolve', extra = {}) =>
  ({ controlId: randomUUID(), expectedRevision: view(slug).revision, action, ...extra });
const crossings = (item: ReturnType<typeof fixture>) => existsSync(item.marker) ? readFileSync(item.marker, 'utf8') : '';
async function pending(slug: string) {
  const result = (await runner.refreshSpaceData(slug, 'rows', { cause: 'scheduled', refreshId: 'first' }))[0];
  assert.ok(result.pendingApprovalId, JSON.stringify(result)); return result.pendingApprovalId;
}
async function approve(id: string) { approvals.resolve(id, 'approved', 'fixture-owner'); await recovery.recoverSavedScriptRefreshes(); }

test('owner review supersedes a denial without executing or borrowing its old approval', async () => {
  const item = fixture('control-denied'); const old = await pending(item.slug);
  approvals.resolve(old, 'rejected', 'fixture-owner'); await recovery.recoverSavedScriptRefreshes();
  const request = command(item.slug, 'review');
  const result = await controls.controlWorkspaceSource(item.slug, 'rows', request);
  assert.ok(result.pendingApprovalId); assert.notEqual(result.pendingApprovalId, old);
  assert.equal(approvals.get(old)?.resolution, 'rejected'); assert.equal(crossings(item), '');
  const replay = await controls.controlWorkspaceSource(item.slug, 'rows', request);
  assert.equal(replay.pendingApprovalId, result.pendingApprovalId);
  await approve(result.pendingApprovalId);
  assert.equal(crossings(item), 'x');
  assert.equal(view(item.slug).permission, 'active');
  await controls.controlWorkspaceSource(item.slug, 'rows', request);
  assert.equal(crossings(item), 'x', 'replaying a reviewed command cannot start another occurrence');
});

test('stop survives script edits, cancels the obsolete card and requires a fresh approval', async () => {
  const item = fixture('control-edited'); const old = await pending(item.slug);
  const stop = command(item.slug, 'stop');
  await controls.controlWorkspaceSource(item.slug, 'rows', stop);
  assert.equal(approvals.get(old)?.resolution, 'cancelled_by_system');
  item.write('console.log(JSON.stringify({ changed: true }));');
  const tick = (await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled' }))[0];
  assert.equal(tick.ok, false); assert.equal(tick.pendingApprovalId, undefined); assert.equal(crossings(item), '');
  const reviewed = await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'review'));
  assert.ok(reviewed.pendingApprovalId); assert.notEqual(reviewed.pendingApprovalId, old);
  assert.equal(crossings(item), '');
  await controls.controlWorkspaceSource(item.slug, 'rows', stop);
  assert.equal(view(item.slug).permission, 'needs_review', 'replaying an old stop cannot overwrite a newer review');
  await approve(reviewed.pendingApprovalId);
  assert.equal(crossings(item), 'x');
});

test('revoking a grant stops the whole source even when its declaration changes', async () => {
  const item = fixture('control-revoked'); const old = await pending(item.slug); await approve(old);
  consent.revokeSavedSourceScriptGrant(consent.recordApprovedSavedSourceScriptGrant(old).grantId, 'Owner revoked');
  item.write('console.log(JSON.stringify({ next: true }));');
  const result = (await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'later' }))[0];
  assert.equal(result.ok, false); assert.equal(result.pendingApprovalId, undefined);
  assert.equal(view(item.slug).permission, 'stopped'); assert.equal(crossings(item), 'x');
  const reviewed = await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'review'));
  assert.ok(reviewed.pendingApprovalId); await approve(reviewed.pendingApprovalId);
  assert.equal(crossings(item), 'xx'); assert.equal(consent.recordApprovedSavedSourceScriptGrant(old).active, false);
});

test('an uncertain run needs explicit owner review and retains its original settlement', async () => {
  const item = fixture('control-uncertain', 'process.exit(7);'); const id = await pending(item.slug); await approve(id);
  const oldKey = journal.listUnpublishedWorkspaceScriptOccurrences(item.slug)[0]!;
  const before = eventlog.openEventLog().prepare('SELECT * FROM logical_call_settlements WHERE session_id = ?')
    .all(`workspace-script:${item.slug}`);
  assert.equal(view(item.slug).run?.phase, 'held');
  await assert.rejects(controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'review')), /held run/);
  await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'stop'));
  await assert.rejects(controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'resolve')), /Confirm you checked/);
  await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'resolve', { reviewedEffects: true, note: 'Checked the fixture marker; one partial run, no other effects.' }));
  assert.equal(view(item.slug).run, null); assert.equal(view(item.slug).permission, 'stopped');
  assert.equal((await journal.executeWorkspaceScriptOccurrence(oldKey)).status, 'held');
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT * FROM logical_call_settlements WHERE session_id = ?')
    .all(`workspace-script:${item.slug}`), before);
  assert.equal((await runner.refreshSpaceData(item.slug, 'rows'))[0].ok, false);
  item.write('console.log(JSON.stringify({ recovered: true }));');
  const reviewed = await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'review'));
  assert.equal(crossings(item), 'x'); assert.ok(reviewed.pendingApprovalId);
  await approve(reviewed.pendingApprovalId); assert.equal(crossings(item), 'xx');
  assert.equal(datasets.listWorkspaceDatasetObservations(item.slug, { sourceKey: 'rows', status: 'ok' }).length, 1);
});

test('stop cancels the running carrier and does not offer closure before its physical settlement', async () => {
  const item = fixture('control-running', 'setInterval(() => {}, 1000);'); const id = await pending(item.slug);
  approvals.resolve(id, 'approved', 'fixture-owner');
  for (let n = 0; n < 500 && !crossings(item); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(crossings(item), 'x'); assert.equal(view(item.slug).run?.phase, 'running');
  await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'stop'));
  await assert.rejects(controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'resolve',
    { reviewedEffects: true, note: 'Cannot declare a running process settled.' })), /wait for its execution/);
  await recovery.recoverSavedScriptRefreshes();
  assert.equal(view(item.slug).run?.phase, 'held'); assert.equal(view(item.slug).canResolve, true);
  assert.equal(crossings(item), 'x');
});

test('a changed source or competing device cannot reuse a stale decision or command identity', async () => {
  const item = fixture('control-cas'); const stale = command(item.slug, 'review');
  item.write('console.log(JSON.stringify({ changed: true }));');
  await assert.rejects(controls.controlWorkspaceSource(item.slug, 'rows', stale), /source changed/);
  assert.equal(eventlog.openEventLog().prepare('SELECT 1 FROM workspace_source_control_receipts_v1 WHERE control_id = ?').get(stale.controlId), undefined);
  const stop = command(item.slug, 'stop'); await controls.controlWorkspaceSource(item.slug, 'rows', stop);
  await assert.rejects(controls.controlWorkspaceSource(item.slug, 'rows', { ...stop, action: 'review' }), /different action/);
  assert.equal(crossings(item), '');
});

test('an armed but never dispatched source can be replaced only after closing its exact old authority', async () => {
  const item = fixture('control-armed'); const id = await pending(item.slug);
  journal.setWorkspaceScriptOccurrenceFaultForTests('after_activation');
  try { await approve(id); } finally { journal.setWorkspaceScriptOccurrenceFaultForTests(null); }
  const oldKey = journal.listUnpublishedWorkspaceScriptOccurrences(item.slug)[0]!;
  const reviewed = await controls.controlWorkspaceSource(item.slug, 'rows', command(item.slug, 'review'));
  assert.ok(reviewed.pendingApprovalId); assert.equal(crossings(item), '');
  assert.equal((await journal.executeWorkspaceScriptOccurrence(oldKey)).status, 'held');
  await approve(reviewed.pendingApprovalId); assert.equal(crossings(item), 'x');
});

test('v87 upgrade keeps existing barriers and releases only explicitly closed records', () => {
  const db = new Database(':memory:');
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db, 87);
    const insert = () => db.prepare(`INSERT INTO workspace_script_occurrences_v1
      (workspace_id, source_id, occurrence_id, session_id, logical_call_id, preparation_json, created_at)
      VALUES ('scope-upgrade', 'rows', ?, 'owner', ?, '{}', '2026-09-30')`);
    insert().run('first', 'call-first'); schema.applyHarnessMigrations(db); schema.applyHarnessMigrations(db);
    assert.throws(() => insert().run('second', 'call-second'), /UNIQUE/);
    assert.equal((db.prepare('SELECT resolution_json FROM workspace_script_occurrences_v1').get() as { resolution_json: string | null }).resolution_json, null);
    db.prepare(`UPDATE workspace_script_occurrences_v1 SET resolution_json = '{"fixtureOwnerReviewed":true}'`).run();
    insert().run('second', 'call-second');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_script_occurrences_v1').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM saved_source_script_grants_v1').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
