/** Invoked only by workspace-script-authority.test.ts, with a disposable home
 * and production transport (all isolated-transport markers removed). */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [phase, mode] = process.argv.slice(2);
if ((phase !== 'execute' && phase !== 'replay') || (mode !== 'completed' && mode !== 'uncertain')) {
  throw new Error('Saved-script process fixture requires an explicit phase and mode.');
}
const home = process.env.CLEMENTINE_HOME;
if (!home || !path.basename(home).startsWith('clem-saved-script-process-')) {
  throw new Error('Saved-script process fixture requires its controlled disposable home.');
}
const store = await import('./store.js');
const carrier = await import('./workspace-script-carrier.js');
const authority = await import('./workspace-script-authority.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const capabilities = await import('../runtime/harness/reviewed-local-workflow-capability.js');
const slug = `process-${mode}`;
const stateFile = path.join(home, `${mode}.json`);
let saved: { args: Parameters<typeof authority.prepareWorkspaceScriptCall>[0]; approvalId: string;
  active: ReturnType<typeof authority.activateApprovedWorkspaceScriptCall> };
if (phase === 'execute') {
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [{ id: 'rows', runner: 'refresh.mjs', schedule: '* * * * *' }] });
  const directory = store.resolveInSpace(slug, 'data');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'refresh.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync('crossings.txt', 'x');
${mode === 'completed' ? 'console.log(JSON.stringify({ rows: ["verified"] }));' : 'process.exit(7);'}
`);
  const args = carrier.captureWorkspaceScriptArguments({ slug, source_id: 'rows', occurrence_id: `occurrence-${mode}`, cause: 'scheduled' });
  const prepared = authority.prepareWorkspaceScriptCall(args);
  eventlog.createSession({ id: prepared.sessionId, kind: 'workflow', title: 'Saved script production fixture' });
  const row = approvals.registerResumable({ sessionId: prepared.sessionId,
    subject: 'Run this controlled saved script once, with its possible local effects.',
    tool: prepared.consent.tool, args: { ...prepared.consent.args }, resumeKey: prepared.consent.resumeKey }).row;
  if (!approvals.resolve(row.approvalId, 'approved', 'script-process-fixture').ok) throw new Error('Fixture consent failed.');
  const active = authority.activateApprovedWorkspaceScriptCall({ args, approvalId: row.approvalId });
  saved = { args, approvalId: row.approvalId, active };
  writeFileSync(stateFile, JSON.stringify(saved));
} else saved = JSON.parse(readFileSync(stateFile, 'utf8'));
const capability = capabilities.ensureReviewedLocalWorkflowCapability({ operationId: 'workspace_source_script', args: saved.args });
if (!capability.ok) throw new Error('Production capability missing.');
const port = ports.resolveProductionPortsForManifest(capability.manifest);
if (!port) throw new Error('Production port missing.');
const provenance = shipped.peekShippedProvenance(port.invoke);
const result = await kernel.executeWorkflowV3Call(saved.active);
if (phase === 'execute' && mode === 'completed') unlinkSync(store.resolveInSpace(slug, 'data/refresh.mjs'));
const db = eventlog.openEventLog();
const counts = Object.fromEntries(['logical_tool_calls', 'physical_dispatches', 'logical_call_settlements'].map(table => [table,
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(`workspace-script:${slug}`) as { n: number }).n]));
process.stdout.write(`SAVED_SCRIPT_PROCESS_RESULT ${JSON.stringify({ result, counts, provenance,
  crossings: readFileSync(store.resolveInSpace(slug, 'data/crossings.txt'), 'utf8') })}\n`);
eventlog.closeEventLog();
