/** Cold production caller proof. Never usable against the live owner home. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [phase, mode] = process.argv.slice(2);
const home = process.env.CLEMENTINE_HOME;
if (!home || !path.basename(home).startsWith('clem-script-refresh-process-')
  || !['first', 'second', 'third'].includes(phase!) || !['approved-offline', 'publication-gap'].includes(mode!)) {
  throw new Error('Refresh process fixture requires its explicit disposable home and phase.');
}
const store = await import('./store.js');
const runner = await import('./runner.js');
const recovery = await import('./workspace-script-refresh.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const datasets = await import('./workspace-db.js');
const slug = 'refresh-cold-process'; const sessionId = `workspace-script:${slug}`;
const dir = store.resolveInSpace(slug, 'data'); const marker = path.join(dir, 'crossings.txt');
if (phase === 'first') {
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [
    { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'UTC' },
  ] });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'refresh.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); console.log(JSON.stringify({ rows: [1] }));");
  const result = await runner.refreshSpaceData(slug, 'rows', { cause: 'scheduled', refreshId: 'first' });
  const approvalId = result[0]?.pendingApprovalId;
  if (!approvalId) throw new Error(JSON.stringify(result));
  if (mode === 'approved-offline') {
    // A decision persisted while no resolution listener was available.
    eventlog.openEventLog().prepare(`UPDATE pending_approvals SET status = 'resolved', resolution = 'approved',
      resolver = 'fixture-owner', resolved_at = ? WHERE approval_id = ?`).run(new Date().toISOString(), approvalId);
  } else {
    eventlog.openEventLog().exec(`CREATE TRIGGER fixture_publication_gap BEFORE UPDATE OF observation_id
      ON workspace_script_occurrences_v1 BEGIN SELECT RAISE(FAIL, 'fixture publication gap'); END`);
    approvals.resolve(approvalId, 'approved', 'fixture-owner');
    await recovery.recoverSavedScriptRefreshes();
    if (!existsSync(marker)) throw new Error('Production process did not execute before publication gap');
    unlinkSync(path.join(dir, 'refresh.mjs'));
  }
} else {
  eventlog.openEventLog().exec('DROP TRIGGER IF EXISTS fixture_publication_gap');
  await recovery.recoverSavedScriptRefreshes();
}
const counts = Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
  (eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n]));
process.stdout.write(`SCRIPT_REFRESH_PROCESS_RESULT ${JSON.stringify({ counts,
  crossings: existsSync(marker) ? readFileSync(marker, 'utf8') : '',
  approvals: approvals.listPending({ sessionId, status: 'any' }).length,
  observations: datasets.listWorkspaceDatasetObservations(slug, { sourceKey: 'rows', status: 'ok' }).length,
  reports: eventlog.listEvents(sessionId, { types: ['user_input_received'] }).filter(event => event.data.source === 'outcome' && event.data.status === 'done').length,
})}\n`);
eventlog.closeEventLog(); datasets.closeWorkspaceDb();
