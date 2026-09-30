import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SavedSourceScriptScope } from '../runtime/harness/saved-source-consent.js';
import Database from 'better-sqlite3';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-script-scope-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const store = await import('./store.js');
const carrier = await import('./workspace-script-carrier.js');
const scripts = await import('./workspace-script-authority.js');
const journal = await import('./workspace-script-occurrence.js');
const consent = await import('../runtime/harness/saved-source-consent.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const executor = await import('../execution/workflow-node-invocation-executor.js');
const workspaceDb = await import('./workspace-db.js');
const schema = await import('../runtime/harness/eventlog-schema.js');
test.after(() => { eventlog.closeEventLog(); workspaceDb.closeWorkspaceDb(); rmSync(home, { recursive: true, force: true }); });

function fixture(slug: string, body = 'console.log(JSON.stringify({ rows: [1, 2] }));') {
  const source = { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'America/Los_Angeles' };
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [source] });
  const dir = store.resolveInSpace(slug, 'data'); mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'refresh.mjs'); const marker = path.join(dir, 'crossings.txt');
  writeFileSync(script, `import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); ${body}`);
  const key = { slug, sourceId: source.id, occurrenceId: 'first-tick' };
  const args = carrier.captureWorkspaceScriptArguments({ slug, source_id: source.id, occurrence_id: key.occurrenceId, cause: 'scheduled' });
  const scope: SavedSourceScriptScope = { version: 1, workspaceId: slug, sourceId: source.id,
    sourceDigest: args.source_digest, scriptSha256: args.script_sha256, runner: source.runner,
    schedule: { cron: source.schedule, timeZone: source.timezone }, occurrences: 'manual_and_saved_schedule',
    access: 'local_user_credentials_network_and_live_dependencies', validity: 'while_saved_source_and_script_match_unless_revoked' };
  return { key, scope, args, script, marker, source };
}
function approve(item: ReturnType<typeof fixture>, decision: 'approved' | 'rejected' | null = 'approved') {
  const reserved = journal.reserveWorkspaceScriptOccurrence({ ...item.key, cause: item.args.cause });
  assert.notEqual(reserved.status, 'blocked');
  if (reserved.status === 'blocked') throw new Error(reserved.reason);
  const row = approvals.registerResumable({ sessionId: reserved.sessionId,
    subject: 'Run this exact saved script manually and on its saved schedule until revoked or changed. Local credentials, network and imported dependencies remain live.',
    tool: consent.SAVED_SOURCE_SCRIPT_CONSENT_TOOL, args: item.scope,
    resumeKey: consent.savedSourceScopeResumeKey(item.scope) }).row;
  if (decision) assert.equal(approvals.resolve(row.approvalId, decision, 'scope-fixture').ok, true);
  return row.approvalId;
}
function counts(item: ReturnType<typeof fixture>) {
  return Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
    (eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(`workspace-script:${item.key.slug}`) as { n: number }).n]));
}

test('scope migration preserves existing unfinished source ownership', () => {
  const db = new Database(':memory:');
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db, 85);
    db.prepare(`INSERT INTO workspace_script_occurrences_v1
      (workspace_id, source_id, occurrence_id, session_id, logical_call_id, preparation_json, created_at)
      VALUES ('saved-workspace', 'rows', 'pending-tick', 'retained-session', 'retained-call', '{}', '2026-09-30T00:00:00Z')`).run();
    const before = db.prepare('SELECT * FROM workspace_script_occurrences_v1').all()
      .map(row => ({ ...(row as Record<string, unknown>), resolution_json: null }));
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM workspace_script_occurrences_v1').all(), before);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM saved_source_script_grants_v1').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_v3_saved_source_consent_v1').get() as { n: number }).n, 0);
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM workspace_script_occurrences_v1').all(), before);
  } finally { db.close(); }
});

test('one explicit scope approval covers later exact ticks without fabricating per-tick cards', async () => {
  const item = fixture('scope-repeated');
  const approvalId = approve(item);
  const grant = consent.recordApprovedSavedSourceScriptGrant(approvalId);
  assert.equal(approvals.get(approvalId)?.consumedAt !== null, true);
  for (const [occurrenceId, cause] of [['first-tick', 'scheduled'], ['manual-refresh', 'manual'], ['second-tick', 'scheduled']] as const) {
    const key = { ...item.key, occurrenceId };
    assert.notEqual(journal.reserveWorkspaceScriptOccurrence({ ...key, cause }).status, 'blocked');
    journal.activateWorkspaceScriptOccurrenceWithGrant(key, grant.grantId);
    const result = await journal.executeWorkspaceScriptOccurrence(key);
    assert.equal(result.status, 'published', JSON.stringify(result));
    eventlog.closeEventLog(); workspaceDb.closeWorkspaceDb();
  }
  assert.equal(approvals.listPending({ sessionId: `workspace-script:${item.key.slug}`, status: 'any' }).length, 1);
  assert.equal(readFileSync(item.marker, 'utf8'), 'xxx');
  assert.deepEqual(counts(item), { logical_tool_calls: 3, physical_dispatches: 3, logical_call_settlements: 3 });
  const rows = eventlog.openEventLog().prepare('SELECT grant_id FROM workflow_v3_saved_source_consent_v1 WHERE session_id = ?')
    .all(`workspace-script:${item.key.slug}`) as { grant_id: string }[];
  assert.deepEqual(rows.map(row => row.grant_id), [grant.grantId, grant.grantId, grant.grantId]);
});

for (const decision of [null, 'rejected'] as const) test(`${decision ?? 'pending'} scope approval grants no execution`, () => {
  const item = fixture(`scope-${decision ?? 'pending'}`);
  const id = approve(item, decision);
  assert.throws(() => consent.recordApprovedSavedSourceScriptGrant(id), /not approved/);
  assert.equal(existsSync(item.marker), false);
  assert.equal(approvals.get(id)?.consumedAt, null);
});

test('a one-shot approval cannot become a recurring grant', () => {
  const item = fixture('scope-one-shot');
  journal.reserveWorkspaceScriptOccurrence({ ...item.key, cause: 'scheduled' });
  const prepared = scripts.prepareWorkspaceScriptCall(item.args);
  const row = approvals.registerResumable({ sessionId: prepared.sessionId, subject: 'Once',
    tool: prepared.consent.tool, args: { ...prepared.consent.args }, resumeKey: prepared.consent.resumeKey }).row;
  approvals.resolve(row.approvalId, 'approved', 'scope-fixture');
  assert.throws(() => consent.recordApprovedSavedSourceScriptGrant(row.approvalId));
  assert.equal(approvals.get(row.approvalId)?.consumedAt, null);
});

test('an unreserved occurrence or different source cannot borrow the recurring grant', () => {
  const item = fixture('scope-unreserved');
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(item));
  const unreserved = scripts.prepareWorkspaceScriptCall({ ...item.args, occurrence_id: 'bypasses-owner' });
  assert.throws(() => executor.authorizePreparedSavedSourceWorkflowCall({ sessionId: unreserved.sessionId,
    prepared: unreserved.prepared.prepared, proof: unreserved.prepared.proof, grantId: grant.grantId }), /does not cover/);
  const other = fixture('scope-other-source'); approve(other);
  assert.throws(() => journal.activateWorkspaceScriptOccurrenceWithGrant(other.key, grant.grantId), /does not cover/);
  assert.equal(existsSync(item.marker), false); assert.equal(existsSync(other.marker), false);
});

test('revocation between opaque authorization and activation leaves no new authority root', () => {
  const item = fixture('scope-revocation-race');
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(item));
  const current = scripts.prepareWorkspaceScriptCall(item.args);
  const token = executor.authorizePreparedSavedSourceWorkflowCall({ sessionId: current.sessionId,
    prepared: current.prepared.prepared, proof: current.prepared.proof, grantId: grant.grantId });
  const clone = executor.activatePreparedWorkflowNodeCall({ sessionId: current.sessionId,
    prepared: current.prepared.prepared, proof: current.prepared.proof, savedSourceConsentAuthorization: { ...token } });
  assert.equal(clone.executable, false);
  assert.equal(consent.revokeSavedSourceScriptGrant(grant.grantId, 'Owner revoked'), true);
  const armed = executor.activatePreparedWorkflowNodeCall({ sessionId: current.sessionId,
    prepared: current.prepared.prepared, proof: current.prepared.proof, savedSourceConsentAuthorization: token });
  assert.equal(armed.executable, false);
  assert.equal(existsSync(item.marker), false);
  assert.equal(consent.recordApprovedSavedSourceScriptGrant(grant.approvalId).active, false);
});

test('revoked scope prevents launch but does not erase completed result replay', async () => {
  const done = fixture('scope-completed-revoke');
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(done));
  journal.activateWorkspaceScriptOccurrenceWithGrant(done.key, grant.grantId);
  assert.equal((await journal.executeWorkspaceScriptOccurrence(done.key)).status, 'published');
  consent.revokeSavedSourceScriptGrant(grant.grantId, 'Owner revoked');
  assert.equal((await journal.executeWorkspaceScriptOccurrence(done.key)).status, 'published');
  assert.equal(readFileSync(done.marker, 'utf8'), 'x');

  const pending = fixture('scope-before-launch-revoke');
  const grant2 = consent.recordApprovedSavedSourceScriptGrant(approve(pending));
  journal.activateWorkspaceScriptOccurrenceWithGrant(pending.key, grant2.grantId);
  consent.revokeSavedSourceScriptGrant(grant2.grantId, 'Owner revoked');
  assert.equal((await journal.executeWorkspaceScriptOccurrence(pending.key)).status, 'held');
  assert.equal(existsSync(pending.marker), false);
});

test('revoking a running scope stops the owned process and holds its uncertain effects', async () => {
  const item = fixture('scope-running-revoke', 'await new Promise(resolve => setTimeout(resolve, 10000)); console.log("null");');
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(item));
  journal.activateWorkspaceScriptOccurrenceWithGrant(item.key, grant.grantId);
  const running = journal.executeWorkspaceScriptOccurrence(item.key);
  const until = Date.now() + 5000;
  while (!existsSync(item.marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(item.marker), true);
  consent.revokeSavedSourceScriptGrant(grant.grantId, 'Owner revoked while running');
  assert.equal((await running).status, 'held');
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
});

for (const drift of ['code', 'schedule', 'timezone'] as const) test(`approved ${drift} cannot drift into an occurrence`, () => {
  const item = fixture(`scope-${drift}-edit`);
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(item));
  if (drift === 'code') writeFileSync(item.script, 'console.log("null");');
  else store.spaceStore.save({ id: item.key.slug, title: item.key.slug, dataSources: [{ ...item.source,
    ...(drift === 'schedule' ? { schedule: '1 * * * *' } : { timezone: 'UTC' }) }] });
  assert.throws(() => journal.activateWorkspaceScriptOccurrenceWithGrant(item.key, grant.grantId), /changed/);
  assert.equal(existsSync(item.marker), false);
});

for (const field of ['runner', 'cron', 'timeZone'] as const) test(`a misleading ${field} scope cannot authorize the saved program`, () => {
  const item = fixture(`scope-false-${field.toLowerCase()}`);
  if (field === 'runner') item.scope.runner = 'something-else.mjs';
  else if (field === 'cron') item.scope.schedule.cron = '0 0 1 1 *';
  else item.scope.schedule.timeZone = 'UTC';
  const grant = consent.recordApprovedSavedSourceScriptGrant(approve(item));
  const current = scripts.prepareWorkspaceScriptCall(item.args);
  assert.throws(() => executor.authorizePreparedSavedSourceWorkflowCall({ sessionId: current.sessionId,
    prepared: current.prepared.prepared, proof: current.prepared.proof, grantId: grant.grantId }), /does not cover/);
  assert.equal(existsSync(item.marker), false);
});

for (const mode of ['active', 'revoked']) test(`a fresh production process preserves ${mode} recurring consent and one approval`, () => {
  const processHome = mkdtempSync(path.join(os.tmpdir(), 'clem-script-scope-process-'));
  try {
    const run = (phase: string) => {
      const env = { ...process.env, CLEMENTINE_HOME: processHome };
      delete env.CLEMMY_TEST_ISOLATED_HOME; delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--import', 'tsx',
        fileURLToPath(new URL('./workspace-script-consent-process.fixture.ts', import.meta.url)), phase, mode],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
      const line = child.stdout.split('\n').find(line => line.startsWith('SCRIPT_SCOPE_PROCESS_RESULT '));
      assert.ok(line, child.stdout);
      return JSON.parse(line.slice('SCRIPT_SCOPE_PROCESS_RESULT '.length));
    };
    const first = run('first'); const next = run('second');
    assert.equal(first.first.status, 'published');
    assert.equal(next.first.status, 'published');
    assert.equal(next.second.status, mode === 'active' ? 'published' : 'revoked');
    assert.equal(first.approvals, 1); assert.equal(next.approvals, 1);
    assert.equal(first.crossings, 'x'); assert.equal(next.crossings, mode === 'active' ? 'xx' : 'x');
    const n = mode === 'active' ? 2 : 1;
    assert.deepEqual(next.counts, { logical_tool_calls: n, physical_dispatches: n, logical_call_settlements: n });
  } finally { rmSync(processHome, { recursive: true, force: true }); }
});
