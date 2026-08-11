import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-nested-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-nested-identity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const settlement = await import('./attempt-settlement.js');
const contracts = await import('./logical-call-contract.js');

/** The ledger records a gateway call under its EFFECTIVE inner identity, which
 *  is what the live store showed for platform-49 (googlesheets_batch_update,
 *  not composio_execute_tool). Derive it rather than restate it. */
function effectiveName(task: { sessionId: string; sourceUserSeq: number }, tool: string, args: unknown): string {
  const contract = contracts.durableLogicalCallContract(
    identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    tool,
    args,
  );
  assert.ok(contract, 'fixture contract is safe');
  return contract!.toolName;
}

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/**
 * The platform-49 shape: a local orchestrator tool (space_refresh) whose work
 * is to execute a provider action. The inner dispatch opens its logical call
 * WITHOUT naming an id — exactly composio-tools.ts:2579 and
 * mcp-namespace-shim.ts:1768.
 */
const OUTER_TOOL = 'space_refresh';
const INNER_TOOL = 'composio_execute_tool';

let serial = 0;

interface NestedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  label: string;
}

function acceptTurn(label: string): NestedTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `nested-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the notes about project alpha.' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  return { ...task, label: `${label}-${id}` };
}

function settleHere(task: NestedTask, tool: string, args: unknown, result: unknown) {
  return settlement.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: tool,
    args,
    businessCall: true,
    mutating: false,
    result,
  });
}

function logicalRows(task: NestedTask): Array<{
  logical_tool_call_id: string;
  tool_name: string;
  state: string;
  conflict_reason: string | null;
}> {
  return eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, tool_name, state, conflict_reason
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(task.sessionId, task.sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    state: string;
    conflict_reason: string | null;
  }>;
}

test('a nested provider action does not adopt its caller\'s logical identity', async () => {
  const task = acceptTurn('identity');
  const outerArgs = { slug: 'platform-49-slack-review', source_id: null };
  const innerArgs = { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE', arguments: { spreadsheet_id: 's1' } };
  let outerId = '';
  let innerId = '';

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: OUTER_TOOL,
      args: outerArgs,
      logicalToolCallId: `call_outer_${task.label}`,
    },
    async (outer) => {
      outerId = outer.logicalToolCallId;
      // The inner dispatch names no id — the defect's entry point.
      await identities.withLogicalToolCall(
        {
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          tool: INNER_TOOL,
          args: innerArgs,
        },
        async (inner) => {
          innerId = inner.logicalToolCallId;
        },
      );
    },
  );

  assert.notEqual(innerId, outerId, 'different work never wears its caller\'s identity');
  const rows = logicalRows(task);
  assert.equal(rows.length, 2, 'two distinct logical calls exist');
  const innerName = effectiveName(task, INNER_TOOL, innerArgs);
  assert.deepEqual(
    rows.map((row) => row.tool_name).sort(),
    [innerName, OUTER_TOOL].sort(),
    'each row records the tool that actually ran',
  );
  assert.equal(
    rows.find((row) => row.logical_tool_call_id === outerId)?.tool_name,
    OUTER_TOOL,
    'the caller\'s row was never rewritten to the inner contract',
  );
});

test('the platform-49 shape settles clean: both calls close under their OWN contracts', async () => {
  const task = acceptTurn('platform49');
  const outerArgs = { slug: 'platform-49-slack-review', source_id: null };
  const innerArgs = { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE', arguments: { spreadsheet_id: 's1' } };

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: OUTER_TOOL,
      args: outerArgs,
      logicalToolCallId: `call_outer_${task.label}`,
    },
    async () => {
      await identities.withLogicalToolCall(
        {
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          tool: INNER_TOOL,
          args: innerArgs,
        },
        async () => {
          // The inner action settles inside its own frame, as its lane does.
          const inner = settleHere(task, INNER_TOOL, innerArgs, { successful: true, data: { updated: 1 } });
          assert.equal(inner.outcome.kind, 'succeeded', JSON.stringify(inner.outcome));
        },
      );
      // Then the caller settles its own work — the step that used to die.
      // Its outcome stays 'unknown': this call is not bound to a frozen
      // requirement, and host-execution evidence is deliberately scoped to
      // bound work. What matters here is that it SETTLES instead of finding
      // its own row poisoned by the call it just made.
      const outer = settleHere(task, OUTER_TOOL, outerArgs, { refreshed: 1, complete: true });
      assert.notEqual(outer.outcome.kind, 'succeeded');
      assert.ok(outer.outcome.kind, JSON.stringify(outer.outcome));
    },
  );

  const rows = logicalRows(task);
  assert.equal(rows.length, 2);
  const innerName = effectiveName(task, INNER_TOOL, innerArgs);
  assert.deepEqual(
    rows.map((row) => ({ tool: row.tool_name, state: row.state, why: row.conflict_reason })),
    [
      { tool: OUTER_TOOL, state: 'settled', why: null },
      { tool: innerName, state: 'settled', why: null },
    ],
    'neither call is poisoned and each settled under the contract it ran',
  );
  const settlements = eventlog.openEventLog().prepare(`
    SELECT l.tool_name, s.outcome_kind
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
     ORDER BY l.rowid
  `).all(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(settlements, [
    { tool_name: OUTER_TOOL, outcome_kind: 'unknown' },
    { tool_name: innerName, outcome_kind: 'succeeded' },
  ], 'both settlements exist, each under its own tool and its own verdict');
});

test('a transport wrapper re-entering the SAME contract still inherits one call', async () => {
  const task = acceptTurn('sameframe');
  const args = { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1' } };
  let outerId = '';
  let innerId = '';

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: INNER_TOOL,
      args,
      logicalToolCallId: `call_wrapped_${task.label}`,
    },
    async (outer) => {
      outerId = outer.logicalToolCallId;
      // The same invocation re-entering through a transport layer: same tool,
      // same arguments, no id. One model invocation stays one logical call.
      await identities.withLogicalToolCall(
        {
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          tool: INNER_TOOL,
          args,
        },
        async (inner) => {
          innerId = inner.logicalToolCallId;
        },
      );
      const settled = settleHere(task, INNER_TOOL, args, { successful: true, data: { messages: [] } });
      assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));
    },
  );

  assert.equal(innerId, outerId, 'one invocation is one logical call however many layers wrap it');
  const rows = logicalRows(task);
  assert.deepEqual(rows.map((row) => ({ tool: row.tool_name, state: row.state })), [
    { tool: effectiveName(task, INNER_TOOL, args), state: 'settled' },
  ], 'no second call was invented for a re-entrant wrapper');
});

test('a nested resolver may not refine — or poison — its caller\'s frame', async () => {
  // THE LIVE platform-49 FIRST CAUSE. Before any nested logical call is opened,
  // the Composio gateway calls authorizeResolvedLogicalCallContract to freeze
  // provider-ready args on the AMBIENT frame. Inside a local orchestrator tool
  // that frame belongs to the caller, so refinement hit
  // `row.tool_name !== effective.toolName` in refineLogicalCallContract and
  // called poisonResolution — flipping the caller's row to 'conflict' and its
  // resolution to 'legacy_ambiguous' before a single dispatch existed. That is
  // exactly the live signature: space_refresh 'conflict', tool_name unchanged,
  // zero crossings, resolution ambiguous.
  const task = acceptTurn('resolver');
  const outerArgs = { slug: 'platform-49-slack-review', source_id: null };
  let refined: unknown = 'not-called';

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: OUTER_TOOL,
      args: outerArgs,
      logicalToolCallId: `call_outer_${task.label}`,
    },
    async () => {
      // The inner gateway resolves a DIFFERENT tool against the caller's frame.
      refined = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool: INNER_TOOL,
        effectiveArgs: { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE', arguments: { spreadsheet_id: 's1' } },
      });
    },
  );

  assert.equal(refined, null, 'a foreign resolver refines nothing rather than rewriting the caller');
  const rows = logicalRows(task);
  assert.equal(rows.length, 1, 'the resolver opened no call of its own');
  assert.equal(rows[0]?.tool_name, OUTER_TOOL, 'the caller keeps its own contract');
  assert.notEqual(rows[0]?.state, 'conflict', 'the caller was NOT poisoned');
  assert.equal(rows[0]?.conflict_reason, null);
  const resolution = eventlog.openEventLog().prepare(`
    SELECT state FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { state: string } | undefined;
  assert.notEqual(resolution?.state, 'legacy_ambiguous', 'the accepted task resolution stays usable');

  // And the resolver still works for the frame it DOES own.
  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: INNER_TOOL,
      args: { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1' } },
      logicalToolCallId: `call_own_${task.label}`,
    },
    async () => {
      const own = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool: INNER_TOOL,
        effectiveArgs: { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1' } },
      });
      assert.ok(own, 'a resolver still refines its own call');
    },
  );
});
