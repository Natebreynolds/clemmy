import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-operation-obligations-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-operation-obligations\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const resolution = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function compileFor(
  text: string,
  operations: Array<{ operationId: string; resolvedTool: string }>,
) {
  const session = eventlog.createSession({ id: `op-contract-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent);
  const graph = (graphEvent.data as { graph: {
    nodes: Array<{ id: string; kind: string }>;
  } }).graph;
  const work = graph.nodes.find((node) =>
    node.kind === 'retrieve' || node.kind === 'execute' || node.kind === 'fanout');
  assert.ok(work, 'fixture requires one work node');
  for (const operation of operations) {
    assert.equal(resolution.recordResolvedOperation({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      nodeId: work.id,
      operationId: operation.operationId,
      resolvedTool: operation.resolvedTool,
      logicalToolCallId: `call:${operation.operationId}`,
    }), true);
  }
  assert.equal(resolution.finalizeResolution({
    sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
  }), true);
  const compiled = manifests.compileObligationManifest({ graph: graph as never });
  assert.equal(compiled.validation.ok, true, compiled.validation.errors.join('; '));
  assert.equal(compiled.manifest.readiness, 'ready');
  return compiled.manifest;
}

test('a point lookup owes observation, not pagination exhaustion', () => {
  const manifest = compileFor('look up the contact by id', [
    { operationId: 'contact', resolvedTool: 'crm_get_contact_by_id' },
  ]);
  assert.equal(manifest.nodes[0]?.operationMode, 'point_read');
  assert.deepEqual(manifest.nodes[0]?.obligations, ['source_observed']);
});

test('an append with no source read owes no fabricated derivation or stale cleanup', () => {
  const manifest = compileFor('append this row to the spreadsheet', [
    { operationId: 'append', resolvedTool: 'sheets_append_rows' },
  ]);
  const node = manifest.nodes[0];
  assert.equal(node?.operationMode, 'append');
  assert.ok(node?.obligations.includes('commit_effect'));
  assert.ok(node?.obligations.includes('verify_committed_readback'));
  assert.ok(!node?.obligations.includes('derivation_from_current_source'));
  assert.ok(!node?.obligations.includes('stale_destination_reconciled'));
});

test('a source-backed replacement still owes derivation and stale reconciliation', () => {
  const manifest = compileFor('read the source and replace the destination rows', [
    { operationId: 'read', resolvedTool: 'source_list_records' },
    { operationId: 'replace', resolvedTool: 'sheets_replace_rows' },
  ]);
  const write = manifest.nodes.find((node) => node.operationId === 'replace');
  assert.equal(write?.operationMode, 'replace');
  assert.ok(write?.obligations.includes('derivation_from_current_source'));
  assert.ok(write?.obligations.includes('stale_destination_reconciled'));
  assert.ok(manifest.edges.some((edge) =>
    edge.toNodeId === write?.nodeId
    && edge.toObligation === 'derivation_from_current_source'
    && edge.fromObligation === 'source_completeness'));
});
