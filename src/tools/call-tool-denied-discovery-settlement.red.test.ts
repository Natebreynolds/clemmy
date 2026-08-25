/**
 * RED — the production carrier path must leave a COHERENT settled record when
 * a refined inner call is denied and the outer wrapper settles with raw bytes.
 *
 * Run: npx tsx --test src/tools/call-tool-denied-discovery-settlement.red.test.ts
 *
 * The exact live shape (2026-08-11, platform-49 23:00Z class): the model calls
 * a discovery tool through the call_tool carrier; the bracket admits ONE
 * logical call under the unwrapped inner identity (raw digest); call_tool's
 * trusted resolver REFINES the contract to schema-normalized args; the inner
 * bracket inherits the same logical call and is denied by the discovery
 * governor BEFORE executing; the OUTER wrapper then settles with the raw
 * carrier bytes it still holds.
 *
 * Invariant under pin: that turn ends with exactly one logical call, settled
 * and unpoisoned, whose durable settlement REDEEMS as host authority. A record
 * the runtime itself just committed must never read back as corrupt.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-call-tool-denied-discovery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
// SDK lane with a key present so the composio statics assemble deterministically;
// no provider is ever reached — the denial fires before the tool body runs.
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.COMPOSIO_API_KEY = 'call-tool-denied-discovery-test-key';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-denied-discovery\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  wrapToolForHarness,
  withHarnessRunContext,
  ToolCallsCounter,
} = await import('../runtime/harness/brackets.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const { admitDiscoveryBoundary } = await import('../runtime/harness/discovery-boundary.js');
const { discoveryGovernor } = await import('../runtime/harness/discovery-governor.js');
const { buildCallTool } = await import('./call-tool.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

test('a denied inner discovery settles its carrier call into a redeemable record', async () => {
  const session = eventlog.createSession({ id: 'denied-discovery-1', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the right provider action for the team chat export.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture graph persisted');
  const acceptedTaskId = acceptedTaskIdFor(session.id, source.seq);

  // The denial this fixture used to rely on — spending a one-per-turn broad
  // discovery allowance so the NEXT search was refused — no longer exists: the
  // count budget was removed on 2026-08-25 because refusing a call the model
  // had already paid for bought only a reformulated retry (266 of 610 broad
  // attempts denied; one turn refused 37 times).
  //
  // The invariant under test is unchanged and still worth pinning: whatever
  // refuses an inner call, that turn must end with exactly ONE logical call,
  // settled and unpoisoned, redeemable as host authority. So drive it with a
  // refusal that DOES still exist — a task whose durable discovery policy was
  // never initialized is refused before any catalog or provider work.
  //
  // Deliberately does NOT call discoveryGovernor.initializeTask.

  const callId = 'call_denied_discovery_1';
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_search_tools']) }) as never,
  ) as unknown as ToolLike;

  const output = await withHarnessRunContext(
    {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new ToolCallsCounter(50),
    },
    () => wrapped.invoke!(
      { context: { sessionId: session.id } },
      JSON.stringify({
        name: 'composio_search_tools',
        args_json: JSON.stringify({ query: 'search the team chat history tools' }),
      }),
      { toolCall: { callId } },
    ),
  );

  // FIXTURE PROOF — the run really took the denied-discovery branch and the
  // model received the recoverable corrective, not a crash.
  assert.match(
    String(output),
    /discovery budget denied/,
    `the inner discovery call was not denied; the lane returned:\n${String(output).slice(0, 400)}`,
  );

  // ONE model invocation stayed ONE logical call through every wrapper, and
  // the trusted resolver really refined it (two distinct authorized digests).
  const rows = eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, tool_name, state, conflict_reason,
           argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).all(session.id, source.seq) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    state: string;
    conflict_reason: string | null;
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string | null;
  }>;
  assert.equal(rows.length, 1, `nested wrappers share one logical call; got ${JSON.stringify(rows)}`);
  const row = rows[0]!;
  assert.equal(row.logical_tool_call_id, callId, 'the carrier admitted under the model\'s own call id');
  assert.equal(row.tool_name, 'composio_search_tools', 'the durable row records the effective inner tool');
  assert.notEqual(
    row.effective_argument_digest,
    row.raw_argument_digest,
    'fixture: the trusted resolver refined the contract, so the call owns two digests',
  );
  assert.equal(row.argument_digest, row.effective_argument_digest);

  // The raw-bytes outer settlement is the same call settling: settled, once,
  // unpoisoned, with the accepted task still usable.
  assert.equal(row.state, 'settled', `the wrapper settlement must close the call: ${JSON.stringify(row)}`);
  assert.equal(row.conflict_reason, null, 'the call it refined was not poisoned');
  const settled = eventlog.listEvents(session.id, { types: ['tool_attempt_settled'] })
    .filter((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === source.seq);
  assert.equal(settled.length, 1, 'exactly one durable settlement exists for the turn');
  const resolution = eventlog.openEventLog().prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { state: string } | undefined;
  assert.notEqual(resolution?.state, 'legacy_ambiguous', 'the accepted task resolution stays usable');

  // TARGET — the record the runtime just committed must redeem as authority.
  // Terminal preparation and publication read settlements back through this
  // door; a settlement that reads as corrupt strands the whole turn's proof.
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: callId,
  });
  assert.equal(
    redeemed.status,
    'ok',
    `the committed settlement must redeem as host authority — got ${JSON.stringify(redeemed)}`,
  );
});
