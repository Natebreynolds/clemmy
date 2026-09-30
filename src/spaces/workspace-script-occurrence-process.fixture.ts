/** Fresh-process crash/recovery fixture. Never runs against an owner home. */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [phase, point] = process.argv.slice(2);
const home = process.env.CLEMENTINE_HOME;
if (!home || !path.basename(home).startsWith('clem-script-journal-process-')
  || !['execute', 'recover'].includes(phase!) || !['after_kernel', 'after_observation', 'uncertain'].includes(point!)) {
  throw new Error('Saved script journal fixture requires its explicit disposable home and phase.');
}
const journal = await import('./workspace-script-occurrence.js');
const store = await import('./store.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const workspaces = await import('./workspace-db.js');
const key = { slug: 'journal-production', sourceId: 'rows', occurrenceId: 'durable-tick' };
const directory = store.resolveInSpace(key.slug, 'data');
if (phase === 'execute') {
  store.spaceStore.save({ id: key.slug, title: 'Journal production fixture', status: 'active',
    dataSources: [{ id: key.sourceId, runner: 'refresh.mjs', schedule: '* * * * *' }] });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'refresh.mjs'), `import { appendFileSync } from 'node:fs';
    appendFileSync('crossings.txt', 'x'); ${point === 'uncertain' ? 'process.exit(7)' : 'console.log(JSON.stringify({ rows: ["production"] }))'}`);
  const reserved = journal.reserveWorkspaceScriptOccurrence({ ...key, cause: 'scheduled' });
  if (reserved.status === 'blocked') throw new Error(reserved.reason);
  const approval = approvals.registerResumable({ sessionId: reserved.sessionId, subject: 'Controlled script process fixture',
    tool: reserved.consent.tool, args: { ...reserved.consent.args }, resumeKey: reserved.consent.resumeKey }).row;
  if (!approvals.resolve(approval.approvalId, 'approved', 'journal-fixture').ok) throw new Error('Fixture approval failed.');
  journal.activateWorkspaceScriptOccurrence(key, approval.approvalId);
  if (point !== 'uncertain') {
    // Configure only the crash seam with the test guard; transport and actual
    // execution still run without test markers through the emitted port.
    process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
    journal.setWorkspaceScriptOccurrenceFaultForTests(point as 'after_kernel' | 'after_observation');
    delete process.env.CLEMMY_TEST_ISOLATED_HOME;
  }
}
let result;
try { result = await journal.executeWorkspaceScriptOccurrence(key); }
catch (error) {
  if (phase !== 'execute' || !(error instanceof Error) || error.message !== `saved-script crash: ${point}`) throw error;
  result = { status: 'crashed', point };
}
if (phase === 'execute' && point !== 'uncertain') unlinkSync(path.join(directory, 'refresh.mjs'));
const db = eventlog.openEventLog();
const counts = Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(`workspace-script:${key.slug}`) as { n: number }).n]));
const later = point === 'uncertain' ? journal.reserveWorkspaceScriptOccurrence({ ...key, occurrenceId: 'later-tick', cause: 'scheduled' }) : null;
process.stdout.write(`SCRIPT_JOURNAL_PROCESS_RESULT ${JSON.stringify({ result, counts, later,
  crossings: readFileSync(path.join(directory, 'crossings.txt'), 'utf8'),
  observations: workspaces.listWorkspaceDatasetObservations(key.slug, { sourceKey: key.sourceId, status: 'ok' }).length })}\n`);
eventlog.closeEventLog();
workspaces.closeWorkspaceDb();
