/** Production-transport fixture, guarded against any real owner home. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [phase, mode] = process.argv.slice(2);
const home = process.env.CLEMENTINE_HOME;
if (!home || !path.basename(home).startsWith('clem-script-scope-process-')
  || !['first', 'second'].includes(phase!) || !['active', 'revoked'].includes(mode!)) {
  throw new Error('Saved source scope fixture requires its explicit disposable home and phase.');
}
const store = await import('./store.js');
const journal = await import('./workspace-script-occurrence.js');
const scripts = await import('./workspace-script-carrier.js');
const consent = await import('../runtime/harness/saved-source-consent.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const workspaceDb = await import('./workspace-db.js');
const key = { slug: 'scope-production', sourceId: 'rows', occurrenceId: 'first' };
const statePath = path.join(home, 'scope.json');
const directory = store.resolveInSpace(key.slug, 'data');
let grantId: string;
if (phase === 'first') {
  const source = { id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *', timezone: 'UTC' };
  store.spaceStore.save({ id: key.slug, title: key.slug, status: 'active', dataSources: [source] });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, source.runner), "import { appendFileSync } from 'node:fs'; appendFileSync('crossings.txt', 'x'); console.log(JSON.stringify({ rows: [1] }));");
  const reserved = journal.reserveWorkspaceScriptOccurrence({ ...key, cause: 'scheduled' });
  if (reserved.status === 'blocked') throw new Error(reserved.reason);
  const args = scripts.captureWorkspaceScriptArguments({ slug: key.slug, source_id: key.sourceId, occurrence_id: key.occurrenceId, cause: 'scheduled' });
  const scope = consent.savedSourceScriptScope.parse({ version: 1, workspaceId: key.slug, sourceId: key.sourceId,
    sourceDigest: args.source_digest, scriptSha256: args.script_sha256, runner: source.runner,
    schedule: { cron: source.schedule, timeZone: source.timezone }, occurrences: 'manual_and_saved_schedule',
    access: 'local_user_credentials_network_and_live_dependencies', validity: 'while_saved_source_and_script_match_unless_revoked' });
  const approval = approvals.registerResumable({ sessionId: reserved.sessionId, subject: 'Controlled recurring saved script fixture',
    tool: consent.SAVED_SOURCE_SCRIPT_CONSENT_TOOL, args: scope, resumeKey: consent.savedSourceScopeResumeKey(scope) }).row;
  approvals.resolve(approval.approvalId, 'approved', 'scope-process-fixture');
  grantId = consent.recordApprovedSavedSourceScriptGrant(approval.approvalId).grantId;
  writeFileSync(statePath, JSON.stringify({ grantId }));
  journal.activateWorkspaceScriptOccurrenceWithGrant(key, grantId);
} else grantId = JSON.parse(readFileSync(statePath, 'utf8')).grantId;
const first = await journal.executeWorkspaceScriptOccurrence(key);
let second: unknown = null;
if (phase === 'first' && mode === 'revoked') consent.revokeSavedSourceScriptGrant(grantId, 'Fixture owner revoked');
if (phase === 'second') {
  const next = { ...key, occurrenceId: 'second' };
  journal.reserveWorkspaceScriptOccurrence({ ...next, cause: 'scheduled' });
  try {
    journal.activateWorkspaceScriptOccurrenceWithGrant(next, grantId);
    second = await journal.executeWorkspaceScriptOccurrence(next);
  } catch (error) {
    if (mode !== 'revoked' || !(error instanceof Error) || !error.message.includes('revoked')) throw error;
    second = { status: 'revoked' };
  }
}
const counts = Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
  (eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(`workspace-script:${key.slug}`) as { n: number }).n]));
process.stdout.write(`SCRIPT_SCOPE_PROCESS_RESULT ${JSON.stringify({ first, second, counts,
  crossings: readFileSync(path.join(directory, 'crossings.txt'), 'utf8'),
  approvals: approvals.listPending({ sessionId: `workspace-script:${key.slug}`, status: 'any' }).length })}\n`);
eventlog.closeEventLog(); workspaceDb.closeWorkspaceDb();
