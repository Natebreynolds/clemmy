/**
 * RED PIN — telemetry separation at the proof scorer.
 *
 * Invariant: a proof report must state each work class in its own counter —
 * canonical logical calls, physical provider dispatches, retry dispatches,
 * and repeated identical payloads — so a run that paid three crossings (or
 * re-asked the same question three times) can never score identically to a
 * run that did the work once. The durable ledger already records physical
 * crossings (physical_dispatches + provider_dispatch_* mirror events); the
 * scorer must surface them instead of dropping them on the switch floor.
 *
 * The fixture home is built by the REAL runtime (eventlog migrations +
 * dispatch ledger), so whichever store the fix reads — the durable tables or
 * the mirrored events — the rows are production-shaped.
 *
 * Guards in this file pin behavior that is already correct and must survive
 * the fix: per-tool evidence stays mirror-INCLUSIVE by documented intent
 * (proofs assert the inner deferred tool was reached), while every logical
 * counter excludes transport mirrors. Separation means NEW fields, never a
 * redefinition of `toolCalls`.
 *
 * Run: npx tsx --test scripts/proof/score-dispatch-telemetry-separation.red.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-score-dispatch-separation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-score-dispatch-separation\n', 'utf8');

const eventlog = await import('../../src/runtime/harness/eventlog.js');
const shadow = await import('../../src/runtime/graph/turn-graph-shadow.js');
const identities = await import('../../src/runtime/harness/attempt-identity.js');
const { openHarnessDb, sessionMetrics } = await import('./score.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function accept(text = 'Find the current alpha records.') {
  const session = eventlog.createSession({ id: `score-separation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

/** The separated counters the invariant requires. Optional here because the
 * defect under pin is exactly their absence from SessionMetrics. */
type SeparatedCounters = Partial<Record<
  'physicalDispatches' | 'retryDispatches' | 'repeatedIdenticalCalls',
  number
>>;

function metricsFor(sessionId: string) {
  const db = openHarnessDb(TMP_HOME);
  try {
    const metrics = sessionMetrics(db, sessionId);
    assert.ok(metrics, 'fixture: the session must be readable by the scorer');
    return metrics as NonNullable<typeof metrics> & SeparatedCounters;
  } finally {
    db.close();
  }
}

/** ONE canonical logical call that paid TWO provider crossings: a primary
 * dispatch and a retry of it, recorded by the durable dispatch ledger
 * (physical_dispatches rows + provider_dispatch_started/settled events),
 * plus the single canonical tool_called event the model/SDK layer saw. */
async function primaryPlusRetrySession(): Promise<string> {
  const task = accept();
  let primaryDispatchId = '';
  await identities.withLogicalToolCall({
    ...task,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  }, async () => {
    await identities.withPhysicalDispatch({
      ...task,
      tool: 'alpha_records_search',
      args: { query: 'alpha' },
    }, async (crossing) => {
      primaryDispatchId = crossing.physicalDispatchId;
      return 'primary';
    });
    await identities.withPhysicalDispatch({
      ...task,
      tool: 'alpha_records_search',
      args: { query: 'alpha' },
      relation: 'retry',
      retryOf: primaryDispatchId,
    }, async () => 'retry');
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'alpha_records_search',
      callId: `call-alpha-${serial}`,
      accounting: 'top_level',
      arguments: JSON.stringify({ query: 'alpha' }),
    },
  });
  return task.sessionId;
}

test('session metrics report physical dispatches as their own counter, distinct from canonical logical calls', async () => {
  const metrics = metricsFor(await primaryPlusRetrySession());
  assert.equal(metrics.toolCallTotal, 1, 'fixture: exactly one canonical logical call');
  assert.equal(
    metrics.physicalDispatches,
    2,
    'proof session metrics must report provider crossings (physical dispatches) as their own counter, '
    + 'distinct from canonical logical calls — the durable ledger recorded 2 crossings for this 1 logical call '
    + 'and the scorer must not collapse or drop them',
  );
});

test('session metrics report retry dispatches as their own counter', async () => {
  const metrics = metricsFor(await primaryPlusRetrySession());
  assert.equal(metrics.toolCallTotal, 1, 'fixture: exactly one canonical logical call');
  assert.equal(
    metrics.retryDispatches,
    1,
    'retry crossings are their own counter: a leg that needed a retry to succeed must not score '
    + 'identically to a leg that succeeded on the primary dispatch',
  );
});

test('repeated identical payloads are reported as their own counter, not hidden inside the call total', async () => {
  const task = accept('Search the alpha records, then search them again, then the beta records.');
  const search = (callId: string, query: string) => eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_search_tools',
      callId,
      accounting: 'top_level',
      arguments: JSON.stringify({ query }),
    },
  });
  // Three canonical calls; two share the exact (tool, payload) signature.
  search('search-1', 'alpha records');
  search('search-2', 'alpha records');
  search('search-3', 'beta records');

  const metrics = metricsFor(task.sessionId);
  assert.equal(metrics.toolCallTotal, 3, 'fixture: three canonical calls');
  assert.equal(
    metrics.repeatedIdenticalCalls,
    1,
    'identical (tool, payload) re-issues beyond the first must be reported as their own counter: '
    + 'a run with N identical re-asks currently scores identically to a run with N distinct calls '
    + 'in every proof metric except token totals',
  );
});

test('guard: per-tool evidence stays mirror-inclusive while every logical counter excludes mirrors', async () => {
  const task = accept('Find the outlook draft tool.');
  // Production shape on the gated Claude lane: one provider-level call_tool
  // row plus its inner local-MCP copy stamped transport_mirror.
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'call_tool',
      effectiveTool: 'composio_search_tools',
      callId: 'wrapper-1',
      accounting: 'top_level',
      arguments: JSON.stringify({ name: 'composio_search_tools', args_json: '{"query":"outlook draft"}' }),
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_search_tools',
      callId: 'mirror-1',
      accounting: 'transport_mirror',
      canonicalCallId: 'wrapper-1',
      args: { query: 'outlook draft' },
    },
  });

  const metrics = metricsFor(task.sessionId);
  // Mirror-INCLUSIVE per-tool evidence is documented intent: a proof must be
  // able to assert the exact deferred inner tool was reached.
  assert.equal(metrics.toolCalls['composio_search_tools'], 1, 'inner-tool evidence stays queryable');
  assert.equal(metrics.toolCalls['call_tool'], 1);
  // But no logical counter may ever count the mirror as work.
  assert.equal(metrics.logicalToolCalls['composio_search_tools'] ?? 0, 0, 'transport mirrors never inflate logical dispatches');
  assert.equal(metrics.toolCallTotal, 1, 'one physical decision, not two');
});
