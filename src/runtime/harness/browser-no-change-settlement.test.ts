/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/browser-no-change-settlement.test.ts
 *
 * A browser operation that proved it changed nothing is a repairable failure,
 * not a write of unknown fate. Its returned text says `ok:false`, which on its
 * own proves nothing; the tool's in-process non-write identity is the proof.
 * Settled as uncertain, the turn stopped with "its effect must be reconciled"
 * for a browser that never opened.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-browser-no-change-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'browser-no-change\n');

const events = await import('./eventlog.js');
const { getLocalDeferredDispatchTools } = await import('../../tools/local-runtime-tools.js');
const { HostLocalNonWriteResult, settleToolAttempt } = await import('./attempt-settlement.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const { browserbaseStoreFile } = await import('../../integrations/browserbase-setup.js');

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;

function accepted() {
  const session = events.createSession({ id: `browser-no-change-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Open a browser for me.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: acceptedTaskIdFor(session.id, source.seq) };
  assert.ok(recordTurnGraphShadow({ identity }));
  return identity;
}

async function invokeAndSettle(identity: ReturnType<typeof accepted>, logicalToolCallId: string,
  produce: () => Promise<unknown>) {
  const args = { session_name: null };
  const opened = dispatch.beginPhysicalDispatch({ identity: { ...identity, logicalToolCallId,
    physicalDispatchId: `host:${logicalToolCallId}`, ordinal: 0 },
    tool: 'browser_open', args, executionSite: 'host' });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('Host fixture admission failed');
  const result = await produce();
  assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity,
    tool: 'browser_open', outcome: 'returned' }).status, 'inserted');
  return { result, settlement: settleToolAttempt({ ...identity, callId: logicalToolCallId,
    toolName: 'browser_open', args, lane: 'agents_runner', mutating: true, businessCall: true, result }) };
}

const failedOpenText = JSON.stringify({
  ok: false,
  receipt: { version: 1, kind: 'browser_operation_receipt', operation: 'browser_open', backend: 'local_chrome',
    session_name: 'default', browser_id: null, target_id: null, requested_url: 'about:blank', effect: 'none', status: 'failed' },
  error: 'Chrome did not accept the connection.',
});

test('a browser open that proved nothing changed settles repairable, never uncertain', async () => {
  const identity = accepted();
  const { settlement } = await invokeAndSettle(identity, 'proven-no-change',
    async () => new HostLocalNonWriteResult(failedOpenText, 'browser_not_dispatched'));
  assert.equal(settlement.outcome.kind, 'invalid_arguments', JSON.stringify(settlement.outcome));
  assert.equal(settlement.outcome.detail, 'host_reported:browser_not_dispatched');
  assert.equal(settlement.outcome.directive.requiresReconciliation, false);
});

test('the same failure text without the tool\'s own identity stays uncertain', async () => {
  // The bytes alone are what any failed write looks like.
  const identity = accepted();
  const { settlement } = await invokeAndSettle(identity, 'bare-text', async () => failedOpenText);
  assert.equal(settlement.outcome.kind, 'uncertain_write');
  assert.equal(settlement.outcome.directive.requiresReconciliation, true);
});

test('with a cloud browser set up, the real local browser_open refuses without starting and settles repairable', async () => {
  const file = browserbaseStoreFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, revision: 1, resources: [],
    policy: { projectId: '00000000-0000-4000-8000-000000000001', idleSeconds: 300, sessionTimeoutSeconds: 1800 } }));
  try {
    const adapter = getLocalDeferredDispatchTools()
      .find((tool) => tool.type === 'function' && tool.name === 'browser_open');
    assert.ok(adapter, 'the actual deferred execution adapter exposes browser_open');
    const identity = accepted();
    const { result, settlement } = await invokeAndSettle(identity, 'cloud-is-the-browser',
      () => adapter!.invoke({ context: identity } as never, JSON.stringify({ session_name: null }),
        { toolCall: { callId: 'cloud-is-the-browser' } } as never));
    assert.ok(result instanceof HostLocalNonWriteResult, `typed non-write, got ${String(result)}`);
    assert.match(String(result), /cloud_browser_start/);
    assert.equal(settlement.outcome.kind, 'invalid_arguments', JSON.stringify(settlement.outcome));
    assert.equal(settlement.outcome.directive.requiresReconciliation, false);
  } finally {
    rmSync(file, { force: true });
  }
});
