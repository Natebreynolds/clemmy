/**
 * A pre-dispatch refusal must settle its logical call, so the host's
 * `nested_owned` adoption finds a record and the model gets its corrective.
 *
 * Run: npx tsx --test src/tools/call-tool-arg-refusal-settlement.test.ts
 *
 * The live shape (2026-08-24): the model called workflow_run through call_tool
 * with `{"workflow_id": ...}` instead of `{"name": ...}`. The carrier documents
 * that case as recoverable — "returns the schema and an error and makes NO
 * change" — but the refusal wrote no durable settlement, because the settle
 * call was guarded on a target resolved only later in the flow. The host then
 * failed closed on "nested-owned logical settlement is missing" and killed the
 * whole turn. Every call_tool failure ever recorded on this machine was this:
 * a wrong argument NAME escalated into a dead turn, discarding the very schema
 * the model needed to correct itself.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-call-tool-arg-refusal-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-arg-refusal\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  wrapToolForHarness,
  withHarnessRunContext,
  ToolCallsCounter,
} = await import('../runtime/harness/brackets.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const { buildCallTool } = await import('./call-tool.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

test('an inner argument-shape refusal settles into a record the host can adopt', async () => {
  const session = eventlog.createSession({ id: 'arg-refusal-1', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'run the morning activity update' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture graph persisted');
  const acceptedTaskId = acceptedTaskIdFor(session.id, source.seq);

  const callId = 'call_arg_refusal_1';
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['workflow_run']) }) as never,
  ) as unknown as ToolLike;

  const output = await withHarnessRunContext(
    {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new ToolCallsCounter(50),
      // The production shape. Under the host runner the wrapper deliberately
      // does NOT settle (the host owns the deadline and adopts the inner
      // record instead), so the refusal itself is the only thing that can
      // write one. Without this flag the outer wrapper settles and the pin
      // passes for the wrong reason.
      hostOwnsToolDeadlineAndSettlement: true,
    },
    () => wrapped.invoke!(
      { context: { sessionId: session.id } },
      JSON.stringify({
        name: 'workflow_run',
        // The exact live mistake: a plausible but wrong argument NAME.
        args_json: JSON.stringify({ workflow_id: 'team-activity-slack-updates' }),
      }),
      // The host supplies its own abort signal on this path.
      { toolCall: { callId }, signal: new AbortController().signal },
    ),
  );

  // FIXTURE PROOF — the model received the recoverable corrective, with the
  // schema it needs to fix itself, and nothing was dispatched.
  assert.match(
    String(output),
    /arg_validation/,
    `expected an argument-validation refusal; got:\n${String(output).slice(0, 400)}`,
  );

  // TARGET — the refusal left a durable settlement the host can ADOPT.
  // Without it the carrier's nested_owned boundary fails closed and the whole
  // turn dies for a mistake the model could have corrected on the next call.
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: callId,
  });
  assert.equal(
    redeemed.status,
    'ok',
    `a pre-dispatch refusal must settle its logical call — got ${JSON.stringify(redeemed)}`,
  );
  assert.equal(
    redeemed.settlement.executionKind,
    'refused_pre_dispatch',
    'the refusal must settle as a pre-dispatch refusal, not as executed work',
  );
  assert.equal(
    redeemed.settlement.physicalCrossingCount,
    0,
    'nothing was dispatched, so the record must claim no crossing',
  );
});
