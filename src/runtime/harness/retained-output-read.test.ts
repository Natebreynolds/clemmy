/**
 * A delegated worker reads a parent-shared result through any recall of it.
 *
 * A worker's recall that travelled through a carrier resolves, by lineage, to
 * the parent result it read. The worker holds no copy of that parent id, so
 * the read must be served by the parent's share of the RESOLVED id; the share
 * is still the only authority, so an unshared parent id stays unreadable.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/retained-output-read.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retained-output-read-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'retained-output-read\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { resolveRetainedOutputRead, resolveLocalRetainedOutputRead } = await import('./retained-output-read.js');
const { prepareWorkerResultShares } = await import('./worker-retained-results.js');
const { retainedResultRoutes } = await import('./retained-result-routes.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function carrierRecall(sessionId: string, callId: string, sourceId: string): void {
  eventlog.appendEvent({ sessionId, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId, tool: 'call_tool', effectiveTool: 'recall_tool_result', accounting: 'top_level',
    arguments: JSON.stringify({ name: 'recall_tool_result', args_json: JSON.stringify({ call_id: sourceId }) }),
  } });
  eventlog.writeToolOutput({ sessionId, callId, tool: 'call_tool', invocationNonce: `nonce-${callId}`,
    output: `Recalled chars 0–12 of 80 (more remains — continue with recall_tool_result {"call_id":"${sourceId}","offset":12})\n\nParent notes` });
}

test('a worker carrier recall of a parent-shared result reads the shared result, and only a shared one', () => {
  const parent = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'parent' });
  const sharedOutput = 'Parent notes: the orchard ledger has three open rows and one closed row.';
  eventlog.writeToolOutput({ sessionId: parent.id, callId: 'toolu_parent_shared', invocationNonce: 'nonce-parent-shared',
    tool: 'read_file', output: sharedOutput });
  eventlog.writeToolOutput({ sessionId: parent.id, callId: 'toolu_parent_private', invocationNonce: 'nonce-parent-private',
    tool: 'read_file', output: 'Parent notes that were never shared with any worker.' });
  const shares = prepareWorkerResultShares(parent.id, ['toolu_parent_shared'], (id) => {
    const resolved = resolveLocalRetainedOutputRead(parent.id, id);
    return resolved.receipt ?? eventlog.getToolOutput(parent.id, resolved.callId);
  });
  const worker = eventlog.createSession({ kind: 'agent', title: 'Worker: ledger',
    metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: parent.id, retainedResultShares: shares } });

  // A direct read of the shared id is served by the share, as before.
  const direct = resolveRetainedOutputRead(worker.id, 'toolu_parent_shared');
  assert.equal(direct.receipt?.output, sharedOutput);

  // A carrier recall of it resolves to the shared producer and reads it.
  carrierRecall(worker.id, 'toolu_worker_recall', 'toolu_parent_shared');
  const viaRecall = resolveRetainedOutputRead(worker.id, 'toolu_worker_recall');
  assert.equal(viaRecall.callId, 'toolu_parent_shared');
  assert.equal(viaRecall.receipt?.output, sharedOutput, 'the parent share of the resolved producer serves the read');
  const routes = retainedResultRoutes({ sessionId: worker.id, callId: 'toolu_worker_recall' });
  assert.ok(routes.length > 0, `a reader is offered for the shared result: ${JSON.stringify(routes)}`);
  for (const route of routes) assert.match(route.call, /"call_id":"toolu_parent_shared"/);

  // Authority is not widened: a recall naming an unshared parent id reads nothing of the parent.
  carrierRecall(worker.id, 'toolu_worker_recall_private', 'toolu_parent_private');
  const unshared = resolveRetainedOutputRead(worker.id, 'toolu_worker_recall_private');
  assert.equal(unshared.receipt, undefined);
  assert.notEqual(eventlog.getToolOutput(worker.id, unshared.callId)?.output, 'Parent notes that were never shared with any worker.');
});
