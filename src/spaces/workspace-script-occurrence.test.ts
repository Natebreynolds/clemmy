import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-script-occurrence-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const store = await import('./store.js');
const journal = await import('./workspace-script-occurrence.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const workspaces = await import('./workspace-db.js');
const dataStore = await import('./data-store.js');
const schema = await import('../runtime/harness/eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('../runtime/harness/schema-version.js');

test.after(() => { eventlog.closeEventLog(); workspaces.closeWorkspaceDb(); rmSync(home, { recursive: true, force: true }); });
test.afterEach(() => {
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  kernel.setWorkflowCallKernelCrashPointForTests(null);
});
function fixture(slug: string, body = 'console.log(JSON.stringify({ rows: [1, 2] }));') {
  const source = { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'America/Los_Angeles' };
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [source] });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, source.runner);
  const marker = path.join(dir, 'crossings.txt');
  writeFileSync(script, `import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); ${body}`);
  const key = { slug, sourceId: source.id, occurrenceId: `tick:${slug}` };
  return { key, source, marker, script };
}
function reserve(item: ReturnType<typeof fixture>) {
  const reservation = journal.reserveWorkspaceScriptOccurrence({ ...item.key, cause: 'scheduled' });
  assert.notEqual(reservation.status, 'blocked');
  if (reservation.status === 'blocked') throw new Error(reservation.reason);
  return reservation;
}
function approve(item: ReturnType<typeof fixture>, decision: 'approved' | 'rejected' | null = 'approved') {
  const reserved = reserve(item);
  const row = approvals.registerResumable({ sessionId: reserved.sessionId, subject: 'Execute a controlled script once',
    tool: reserved.consent.tool, args: { ...reserved.consent.args }, resumeKey: reserved.consent.resumeKey }).row;
  if (decision) assert.equal(approvals.resolve(row.approvalId, decision, 'script-occurrence-fixture').ok, true);
  return row.approvalId;
}
function counts(item: ReturnType<typeof fixture>) {
  const db = eventlog.openEventLog();
  return Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(`workspace-script:${item.key.slug}`) as { n: number }).n]));
}
function closeDatabases() { eventlog.closeEventLog(); workspaces.closeWorkspaceDb(); }

test('migration from v84 preserves existing rows and installs one unpublished source constraint', () => {
  const db = new Database(':memory:');
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db, 84);
    const before = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM schema_version WHERE version <= 84 ORDER BY version').all(), before);
    assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, HARNESS_SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_script_one_unpublished_source_v1'").get());
    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_script_occurrences_v1').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('one durable source owner spans repeated ticks and refuses cause changes', () => {
  const item = fixture('journal-owner');
  assert.equal(reserve(item).status, 'reserved');
  closeDatabases();
  assert.equal(reserve(item).status, 'existing');
  assert.throws(() => journal.reserveWorkspaceScriptOccurrence({ ...item.key, cause: 'manual' }), /change its refresh cause/);
  const later = journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' });
  assert.equal(later.status, 'blocked');
  if (later.status === 'blocked') assert.equal(later.occurrenceId, item.key.occurrenceId);
  assert.equal(existsSync(item.marker), false);
});

test('session cleanup neither fails nor erases an unfinished source occurrence', () => {
  const item = fixture('journal-session-retention');
  const reservation = reserve(item);
  eventlog.openEventLog().prepare('DELETE FROM sessions WHERE id = ?').run(reservation.sessionId);
  closeDatabases();
  const later = journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'new-minute', cause: 'scheduled' });
  assert.equal(later.status, 'blocked');
  if (later.status === 'blocked') assert.equal(later.occurrenceId, item.key.occurrenceId);
  assert.equal(existsSync(item.marker), false);
});

for (const decision of [null, 'rejected'] as const) test(`${decision ?? 'pending'} consent cannot activate or publish`, async () => {
  const item = fixture(`journal-${decision ?? 'pending'}`);
  const id = approve(item, decision);
  assert.throws(() => journal.activateWorkspaceScriptOccurrence(item.key, id), /lacks approval/);
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'held');
  assert.equal(existsSync(item.marker), false);
});

test('activation journal recovery does not re-prepare changed scripts after a crash', async () => {
  const item = fixture('journal-arm-crash');
  const id = approve(item);
  journal.setWorkspaceScriptOccurrenceFaultForTests('after_activation');
  assert.throws(() => journal.activateWorkspaceScriptOccurrence(item.key, id), /saved-script crash/);
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  closeDatabases();
  const active = journal.activateWorkspaceScriptOccurrence(item.key, id);
  assert.ok(active);
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'published');
  rmSync(item.script);
  closeDatabases();
  assert.equal(journal.activateWorkspaceScriptOccurrence(item.key, id), active);
  const replayed = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(replayed.status, 'published');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.deepEqual(counts(item), { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
});

test('an unrelated approval cannot poison the occurrence before its correct approval arrives', async () => {
  const item = fixture('journal-approval-match');
  const other = fixture('journal-approval-other');
  const correct = approve(item);
  const wrong = approve(other);
  assert.throws(() => journal.activateWorkspaceScriptOccurrence(item.key, wrong), /lacks approval/);
  journal.activateWorkspaceScriptOccurrence(item.key, correct);
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'published');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.equal(existsSync(other.marker), false);
});

test('the last good file-backed dataset is preserved before any process can start', async () => {
  const item = fixture('journal-baseline', "import { writeFileSync } from 'node:fs'; writeFileSync('../data.json', JSON.stringify({ rows: { injected: true } })); console.log(JSON.stringify({ final: true }));");
  assert.equal(dataStore.writeData(item.key.slug, { rows: { previous: true } }).ok, true);
  const id = approve(item);
  const before = workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' });
  assert.equal(before.length, 1);
  assert.deepEqual(workspaces.getWorkspaceObservationDocument(item.key.slug, before[0]!.id), { previous: true });
  assert.equal(existsSync(item.marker), false);
  journal.activateWorkspaceScriptOccurrence(item.key, id);
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'published');
  const after = workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' });
  assert.equal(after.length, 2);
  assert.deepEqual(workspaces.getWorkspaceObservationDocument(item.key.slug, before[0]!.id), { previous: true });
  assert.deepEqual((dataStore.readData(item.key.slug) as Record<string, unknown>).rows, { final: true });
});

test('matching provenance cannot pass off conflicting stored data as a successful publication', async () => {
  const item = fixture('journal-content-proof');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  journal.setWorkspaceScriptOccurrenceFaultForTests('after_observation');
  await assert.rejects(journal.executeWorkspaceScriptOccurrence(item.key), /saved-script crash/);
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  const observation = workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' })[0]!;
  workspaces.openWorkspaceDb().prepare('UPDATE workspace_dataset_observations SET content_hash = ? WHERE id = ?').run('f'.repeat(64), observation.id);
  const result = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(result.status, 'held');
  if (result.status === 'held') assert.match(result.reason, /observation conflicts/);
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
});

test('a failed file projection after dataset commit heals from the retained result', async () => {
  const item = fixture('journal-projection-gap');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  const projection = store.resolveInSpace(item.key.slug, 'data.json');
  rmSync(projection, { force: true });
  mkdirSync(projection); // Atomic rename cannot replace a directory.
  const first = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(first.status, 'held', JSON.stringify(first));
  assert.equal(workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' }).length, 1);
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
  rmSync(projection, { recursive: true });
  rmSync(item.script);
  closeDatabases();
  const recovered = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(recovered.status, 'published', JSON.stringify(recovered));
  assert.deepEqual((dataStore.readData(item.key.slug) as Record<string, unknown>).rows, { rows: [1, 2] });
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.equal(workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' }).length, 1);
});

for (const point of ['after_kernel', 'after_observation'] as const) test(`crash ${point} publishes the retained result without another process`, async () => {
  const item = fixture(`journal-${point.replaceAll('_', '-')}`);
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  journal.setWorkspaceScriptOccurrenceFaultForTests(point);
  await assert.rejects(journal.executeWorkspaceScriptOccurrence(item.key), /saved-script crash/);
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  rmSync(item.script); // Recovery requires retained output, not a new script capture.
  closeDatabases();
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
  const result = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(result.status, 'published', JSON.stringify(result));
  assert.deepEqual((dataStore.readData(item.key.slug) as Record<string, unknown>).rows, { rows: [1, 2] });
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.deepEqual(counts(item), { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
  const observations = workspaces.listWorkspaceDatasetObservations(item.key.slug, { sourceKey: 'rows', status: 'ok' });
  assert.equal(observations.length, 1);
  writeFileSync(item.script, "console.log('null');");
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'reserved');
});

test('uncertain effects hold later ticks even when reentry itself has no body', async () => {
  const item = fixture('journal-uncertain', 'process.exit(7);');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'held');
  closeDatabases();
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'held');
  const newer = journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'new-minute', cause: 'scheduled' });
  assert.equal(newer.status, 'blocked');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
});

test('interruption after physical return cannot retry an effect without a settled result', async () => {
  const item = fixture('journal-return-gap');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  kernel.setWorkflowCallKernelCrashPointForTests('after_physical_settlement');
  await assert.rejects(journal.executeWorkspaceScriptOccurrence(item.key), /crash/);
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  closeDatabases();
  assert.equal((await journal.executeWorkspaceScriptOccurrence(item.key)).status, 'held');
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
});

test('source revision change after execution preserves the last good dataset and holds the occurrence', async () => {
  const item = fixture('journal-source-edit');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  journal.setWorkspaceScriptOccurrenceFaultForTests('after_kernel');
  await assert.rejects(journal.executeWorkspaceScriptOccurrence(item.key), /saved-script crash/);
  journal.setWorkspaceScriptOccurrenceFaultForTests(null);
  store.spaceStore.save({ id: item.key.slug, title: item.key.slug, dataSources: [{ ...item.source, schedule: '1 * * * *' }] });
  const result = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(result.status, 'held');
  if (result.status === 'held') assert.match(result.reason, /source changed/);
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.equal(journal.reserveWorkspaceScriptOccurrence({ ...item.key, occurrenceId: 'later', cause: 'scheduled' }).status, 'blocked');
});

test('parallel execution and publication converge on one process and one observation', async () => {
  const item = fixture('journal-race', 'await new Promise(resolve => setTimeout(resolve, 100)); console.log("null");');
  journal.activateWorkspaceScriptOccurrence(item.key, approve(item));
  await Promise.all([journal.executeWorkspaceScriptOccurrence(item.key), journal.executeWorkspaceScriptOccurrence(item.key)]);
  const result = await journal.executeWorkspaceScriptOccurrence(item.key);
  assert.equal(result.status, 'published', JSON.stringify(result));
  assert.equal(readFileSync(item.marker, 'utf8'), 'x');
  assert.deepEqual(counts(item), { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
});

for (const point of ['after_kernel', 'after_observation', 'uncertain'] as const) {
  test(`production process restart recovers ${point} without duplicating execution`, () => {
    const processHome = mkdtempSync(path.join(os.tmpdir(), 'clem-script-journal-process-'));
    try {
      const run = (phase: string) => {
        const env = { ...process.env, CLEMENTINE_HOME: processHome };
        delete env.CLEMMY_TEST_ISOLATED_HOME;
        delete env.NODE_TEST_CONTEXT;
        const child = spawnSync(process.execPath, ['--import', 'tsx',
          fileURLToPath(new URL('./workspace-script-occurrence-process.fixture.ts', import.meta.url)), phase, point],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
        const line = child.stdout.split('\n').find(line => line.startsWith('SCRIPT_JOURNAL_PROCESS_RESULT '));
        assert.ok(line, child.stdout);
        return JSON.parse(line.slice('SCRIPT_JOURNAL_PROCESS_RESULT '.length));
      };
      const first = run('execute');
      const second = run('recover');
      assert.equal(first.result.status, point === 'uncertain' ? 'held' : 'crashed');
      assert.equal(second.result.status, point === 'uncertain' ? 'held' : 'published', JSON.stringify(second));
      assert.equal(first.crossings, 'x');
      assert.equal(second.crossings, 'x');
      assert.deepEqual(first.counts, { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
      assert.deepEqual(second.counts, first.counts);
      assert.equal(second.observations, point === 'uncertain' ? 0 : 1);
      if (point === 'uncertain') assert.equal(second.later.status, 'blocked');
    } finally { rmSync(processHome, { recursive: true, force: true }); }
  });
}
