import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-script-refresh-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const store = await import('./store.js');
const runner = await import('./runner.js');
const refresh = await import('./workspace-script-refresh.js');
const journal = await import('./workspace-script-occurrence.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const consent = await import('../runtime/harness/saved-source-consent.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const datasets = await import('./workspace-db.js');
const data = await import('./data-store.js');
const { seedLegacySpaceTrustApproval } = await import('./legacy-space-trust.fixture.js');
test.after(async () => {
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  await refresh.recoverSavedScriptRefreshes();
  eventlog.closeEventLog(); datasets.closeWorkspaceDb(); rmSync(home, { recursive: true, force: true });
});
function fixture(slug: string, body = 'console.log(JSON.stringify({ rows: [1, 2] }));') {
  const source = { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'UTC' };
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [source] });
  const dir = store.resolveInSpace(slug, 'data'); mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'refresh.mjs'); const marker = path.join(dir, 'crossings.txt');
  writeFileSync(script, `import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); ${body}`);
  return { slug, source, script, marker };
}
function cards(slug: string) {
  return approvals.listPending({ sessionId: `workspace-script:${slug}`, status: 'any' });
}
function crossings(item: ReturnType<typeof fixture>) { return existsSync(item.marker) ? readFileSync(item.marker, 'utf8') : ''; }
async function request(item: ReturnType<typeof fixture>, refreshId = 'first-tick') {
  const results = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId });
  assert.equal(results.length, 1); assert.equal(results[0].ok, false);
  assert.ok(results[0].pendingApprovalId, JSON.stringify(results));
  assert.equal(crossings(item), '');
  return results[0].pendingApprovalId;
}
async function approve(id: string) {
  assert.equal(approvals.resolve(id, 'approved', 'source-refresh-fixture').ok, true);
  await refresh.recoverSavedScriptRefreshes();
}
function observations(slug: string) { return datasets.listWorkspaceDatasetObservations(slug, { sourceKey: 'rows', status: 'ok' }); }

test('public refresh coalesces pending clicks, resumes from its approval and reuses one scope for later ticks', async () => {
  const item = fixture('refresh-one-card');
  const id = await request(item);
  const duplicate = await Promise.all([
    runner.refreshSpaceData(item.slug, 'rows'),
    runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'later-while-pending' }),
  ]);
  assert.deepEqual(duplicate.map(rows => rows[0].pendingApprovalId), [id, id]);
  assert.equal(cards(item.slug).length, 1);
  assert.equal(eventlog.listEvents(`workspace-script:${item.slug}`, { types: ['approval_requested'] }).length, 1);
  assert.match(approvals.get(id)!.subject, /local credentials, network and live dependencies/);
  await approve(id);
  assert.equal(crossings(item), 'x');
  assert.equal(observations(item.slug).length, 1);
  assert.deepEqual((data.readData(item.slug) as Record<string, unknown>).rows, { rows: [1, 2] });
  const replay = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'first-tick' });
  assert.equal(replay[0].ok, true, JSON.stringify(replay));
  assert.equal(replay[0].write?.ok, true);
  assert.equal(crossings(item), 'x'); assert.equal(observations(item.slug).length, 1);
  for (const cause of ['manual', 'scheduled'] as const) {
    const result = await runner.refreshSpaceData(item.slug, 'rows', { cause, refreshId: `${cause}-next` });
    assert.equal(result[0].ok, true, JSON.stringify(result));
  }
  assert.equal(crossings(item), 'xxx'); assert.equal(cards(item.slug).length, 1);
  assert.equal(observations(item.slug).length, 3);
  for (const table of ['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements']) {
    assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
      .get(`workspace-script:${item.slug}`) as { n: number }).n, 3);
  }
  const mismatch = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'manual', refreshId: 'first-tick' });
  assert.equal(mismatch[0].ok, false); assert.equal(crossings(item), 'xxx');
});

test('decline is preserved across refreshes and restart recovery without a replacement card', async () => {
  const item = fixture('refresh-declined'); const id = await request(item);
  approvals.resolve(id, 'rejected', 'source-refresh-fixture');
  for (const cause of ['manual', 'scheduled'] as const) {
    const result = await runner.refreshSpaceData(item.slug, 'rows', { cause });
    assert.equal(result[0].ok, false); assert.equal(result[0].pendingApprovalId, undefined);
    assert.match(result[0].error!, /rejected/);
  }
  await refresh.recoverSavedScriptRefreshes();
  assert.equal(cards(item.slug).length, 1); assert.equal(crossings(item), '');
});

test('legacy rejection cannot be erased by introducing the supported executor', async () => {
  const item = fixture('refresh-legacy-no');
  const row = seedLegacySpaceTrustApproval(item.slug, item.source);
  approvals.resolve(row.approvalId, 'rejected', 'source-refresh-fixture');
  const result = await runner.refreshSpaceData(item.slug, 'rows');
  assert.equal(result[0].ok, false); assert.equal(result[0].pendingApprovalId, undefined);
  assert.match(result[0].error!, /Earlier approval.*declined/);
  assert.equal(cards(item.slug).length, 0); assert.equal(crossings(item), '');
});

test('revocation stops new ticks and does not silently ask again', async () => {
  const item = fixture('refresh-revoked'); const id = await request(item); await approve(id);
  const grant = consent.recordApprovedSavedSourceScriptGrant(id);
  consent.revokeSavedSourceScriptGrant(grant.grantId, 'Owner stopped this source');
  const result = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'next' });
  assert.equal(result[0].ok, false); assert.match(result[0].error!, /revoked/);
  assert.equal(result[0].pendingApprovalId, undefined); assert.equal(cards(item.slug).length, 1);
  assert.equal(crossings(item), 'x');
});

test('a process failure holds later ticks instead of running a replacement', async () => {
  const item = fixture('refresh-uncertain', 'process.exit(7);'); const id = await request(item); await approve(id);
  assert.equal(crossings(item), 'x');
  const result = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'next' });
  assert.equal(result[0].ok, false); assert.equal(result[0].pendingApprovalId, undefined);
  await refresh.recoverSavedScriptRefreshes();
  assert.equal(crossings(item), 'x'); assert.equal(observations(item.slug).length, 0);
});

test('source edits while a card is pending cannot execute under the old answer', async () => {
  const item = fixture('refresh-stale'); const id = await request(item);
  writeFileSync(item.script, 'console.log(JSON.stringify({ wrong: true }));');
  await approve(id);
  const result = await runner.refreshSpaceData(item.slug, 'rows');
  assert.equal(result[0].ok, false); assert.match(result[0].error!, /changed/);
  assert.equal(crossings(item), ''); assert.equal(observations(item.slug).length, 0);
});

for (const gap of ['after_activation', 'after_kernel', 'after_observation'] as const) {
  test(`public recovery closes ${gap} without redispatch or duplicate publication`, async () => {
    const item = fixture(`refresh-gap-${gap.replaceAll('_', '-')}`); const id = await request(item);
    journal.setWorkspaceScriptOccurrenceFaultForTests(gap);
    try { await approve(id); } finally { journal.setWorkspaceScriptOccurrenceFaultForTests(null); }
    await refresh.recoverSavedScriptRefreshes();
    assert.equal(crossings(item), 'x'); assert.equal(observations(item.slug).length, 1);
    assert.equal(journal.listUnpublishedWorkspaceScriptOccurrences(item.slug).length, 0);
  });
}

test('mixed refresh batches keep result alignment and do not publish a script result twice', async () => {
  const item = fixture('refresh-mixed'); const id = await request(item); await approve(id);
  store.spaceStore.save({ ...store.spaceStore.get(item.slug)!, dataSources: [
    { id: 'missing', cliArgv: ['not-a-supported-cli', 'list'] }, item.source,
    { id: 'other', cliArgv: ['another-unsupported-cli', 'list'] },
  ] });
  const results = await runner.refreshSpaceData(item.slug);
  assert.deepEqual(results.map(result => [result.sourceId, result.ok]), [['missing', false], ['rows', true], ['other', false]]);
  assert.equal(results[1].write?.ok, true); assert.ok(results[1].observationId);
  assert.equal(crossings(item), 'xx'); assert.equal(observations(item.slug).length, 2);
});

test('retained scope grants survive approval registry retention', async () => {
  const item = fixture('refresh-retained-scope'); const id = await request(item); await approve(id);
  eventlog.openEventLog().prepare('DELETE FROM pending_approvals WHERE approval_id = ?').run(id);
  const result = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled', refreshId: 'next' });
  assert.equal(result[0].ok, true, JSON.stringify(result));
  assert.equal(cards(item.slug).length, 0); assert.equal(crossings(item), 'xx');
});

test('unsupported scheduled requests do not offer an approval that cannot run', async () => {
  const item = fixture('refresh-no-schedule');
  store.spaceStore.save({ ...store.spaceStore.get(item.slug)!, dataSources: [{ id: 'rows', runner: 'refresh.mjs' }] });
  const result = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'scheduled' });
  assert.equal(result[0].ok, false); assert.match(result[0].error!, /no saved schedule/);
  assert.equal(cards(item.slug).length, 0); assert.equal(crossings(item), '');
  assert.equal(journal.listUnpublishedWorkspaceScriptOccurrences(item.slug).length, 0);
});

test('a current scope card retires its obsolete pending legacy card', async () => {
  const item = fixture('refresh-legacy-pending');
  const old = seedLegacySpaceTrustApproval(item.slug, item.source);
  const id = await request(item);
  assert.notEqual(id, old.approvalId);
  assert.equal(approvals.get(old.approvalId)?.resolution, 'cancelled_by_system');
  assert.equal(cards(item.slug).filter(row => row.status === 'pending').length, 1);
  assert.equal(crossings(item), '');
});

test('automatic retry can recover an addressed run but cannot manufacture a new manual occurrence', async () => {
  const item = fixture('refresh-retry-owner');
  const noOwner = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'retry' });
  assert.equal(noOwner[0].ok, false); assert.equal(cards(item.slug).length, 0);
  assert.equal(journal.listUnpublishedWorkspaceScriptOccurrences(item.slug).length, 0);
  const id = await request(item); await approve(id);
  const replay = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'retry', refreshId: 'first-tick' });
  assert.equal(replay[0].ok, true);
  const next = await runner.refreshSpaceData(item.slug, 'rows', { cause: 'retry', refreshId: 'different-tick' });
  assert.equal(next[0].ok, false); assert.match(next[0].error!, /No saved refresh/);
  assert.equal(crossings(item), 'x'); assert.equal(cards(item.slug).length, 1);
  assert.equal(observations(item.slug).length, 1);
});

for (const mode of ['approved-offline', 'publication-gap']) test(`cold production refresh recovers ${mode} exactly once`, () => {
  const processHome = mkdtempSync(path.join(os.tmpdir(), 'clem-script-refresh-process-'));
  try {
    const run = (phase: string) => {
      const env = { ...process.env, CLEMENTINE_HOME: processHome };
      delete env.CLEMMY_TEST_ISOLATED_HOME; delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--import', 'tsx',
        fileURLToPath(new URL('./workspace-script-refresh-process.fixture.ts', import.meta.url)), phase, mode],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
      const line = child.stdout.split('\n').find(line => line.startsWith('SCRIPT_REFRESH_PROCESS_RESULT '));
      assert.ok(line, child.stdout);
      return JSON.parse(line.slice('SCRIPT_REFRESH_PROCESS_RESULT '.length));
    };
    const first = run('first'); const second = run('second'); const third = run('third');
    assert.equal(first.crossings, mode === 'approved-offline' ? '' : 'x');
    assert.equal(second.crossings, 'x'); assert.equal(second.observations, 1); assert.equal(second.reports, 1);
    assert.equal(second.approvals, 1);
    assert.deepEqual(second.counts, { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
    assert.deepEqual(third, second);
  } finally { rmSync(processHome, { recursive: true, force: true }); }
});
