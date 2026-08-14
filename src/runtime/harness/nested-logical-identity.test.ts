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
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const expectedWork = await import('./expected-work-admission.js');

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

function acceptActionTurn(label: string): NestedTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `nested-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Pull the top 5 Ventura restaurants, create a new Google Sheet, and email me the link.' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  const graph = (graphEvent!.data as { graph: { classification: { route: string } } }).graph;
  assert.equal(graph.classification.route, 'act', 'fixture owns action expected-work authority');
  const activated = expectedWork.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
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
      // Then the caller settles its own work — the step that used to die. A
      // returned host execution is truthfully succeeded even when it is not
      // bound to a frozen requirement; absence of a binding prevents it from
      // discharging work or minting evidence, not from reporting what ran.
      const outer = settleHere(task, OUTER_TOOL, outerArgs, { refreshed: 1, complete: true });
      assert.equal(outer.outcome.kind, 'succeeded', JSON.stringify(outer.outcome));
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
    { tool_name: OUTER_TOOL, outcome_kind: 'succeeded' },
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

test('work_call Composio refinement keeps the original binding through the provider callback', async () => {
  // LIVE source 47984: work_call opened one APIFY invocation from the raw
  // Composio carrier, then trusted resolution removed the carrier and froze
  // provider-ready args under a DIFFERENT digest. The durable row was refined,
  // but the ambient frame kept the raw digest. runComposioExecute therefore
  // mistook its direct re-entry for new work, minted an unbound child, and the
  // provider boundary refused `work_binding_required` before one callback.
  const task = acceptActionTurn('work-call-composio-refinement');
  const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const providerTool = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const providerArgs = {
    actorId: 'compass/crawler-google-places',
    runInput: {
      searchStringsArray: ['restaurants in Ventura County, California'],
      maxCrawledPlacesPerSearch: 5,
    },
  };
  const composioArgs = {
    tool_slug: providerTool,
    arguments: JSON.stringify(providerArgs),
    connected_account_id: null,
  };
  const proposal = {
    version: 1 as const,
    operations: [
      {
        id: 'fetch_ventura_from_apify',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_restaurants_to_sheet',
        effect: 'external_write' as const,
        dependsOn: ['fetch_ventura_from_apify'],
        dataFrom: ['fetch_ventura_from_apify'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const rawWorkCallArgs = {
    proposal,
    requirement_id: 'fetch_ventura_from_apify',
    universe_item_id: null,
    universe_selector: null,
    name: INNER_TOOL,
    args_json: JSON.stringify(composioArgs),
  };
  const originalId = `call_work_${task.label}`;
  const rawContract = contracts.durableLogicalCallContract(
    acceptedTaskId,
    'work_call',
    rawWorkCallArgs,
  );
  const providerContract = contracts.durableLogicalCallContract(
    acceptedTaskId,
    providerTool,
    providerArgs,
  );
  assert.ok(rawContract && providerContract, 'both live contract shapes are safe');
  assert.equal(rawContract!.toolName, providerContract!.toolName, 'resolution keeps the effective APIFY slug');
  assert.notEqual(rawContract!.argumentDigest, providerContract!.argumentDigest,
    'provider-ready refinement really changes the argument digest');

  let nestedProviderId = '';
  let foreignId = '';
  let physicalOwner = '';
  let providerEntries = 0;
  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: 'work_call',
      args: rawWorkCallArgs,
      logicalToolCallId: originalId,
    },
    async () => {
      const refined = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool: INNER_TOOL,
        effectiveArgs: composioArgs,
      });
      assert.ok(refined, 'the work_call frame accepts its Composio resolution');
      assert.equal(refined!.argumentDigest, providerContract!.argumentDigest,
        'the durable call owns provider-ready args');

      const admitted = expectedWork.admitExpectedWorkInvocation({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        logicalToolCallId: originalId,
        proposal,
        requirementId: 'fetch_ventura_from_apify',
        tool: INNER_TOOL,
        args: composioArgs,
      });
      assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
      if (admitted.status !== 'bound') return;

      await expectedWork.withExpectedWorkBinding(admitted.binding, async () => {
        // runComposioExecute re-enters under the resolved direct provider slug.
        await identities.withLogicalToolCall(
          {
            sessionId: task.sessionId,
            sourceUserSeq: task.sourceUserSeq,
            tool: providerTool,
            args: providerArgs,
          },
          async (inner) => {
            nestedProviderId = inner.logicalToolCallId;
            await identities.withPhysicalDispatch(
              {
                sessionId: task.sessionId,
                sourceUserSeq: task.sourceUserSeq,
                turn: task.turn,
                tool: providerTool,
                args: providerArgs,
              },
              async (physical) => {
                providerEntries += 1;
                physicalOwner = physical.logicalToolCallId;
                return { successful: true, data: [{ name: 'Restaurant A' }] };
              },
            );
          },
        );

        // A genuinely different nested invocation must still split. The bound
        // parent may authorize it, but it may neither borrow nor poison the
        // APIFY call's logical identity.
        await identities.withLogicalToolCall(
          {
            sessionId: task.sessionId,
            sourceUserSeq: task.sourceUserSeq,
            tool: 'SLACK_FETCH_CONVERSATION_HISTORY',
            args: { channel: 'C-foreign' },
          },
          async (foreign) => {
            foreignId = foreign.logicalToolCallId;
          },
        );
      });
    },
  );

  assert.equal(nestedProviderId, originalId, 'same resolved work keeps the original work_call identity');
  assert.equal(physicalOwner, originalId, 'the provider crossing consumes the original frozen binding');
  assert.equal(providerEntries, 1, 'authority reaches the provider callback exactly once');
  assert.notEqual(foreignId, originalId, 'foreign nested work still opens its own logical call');

  const rows = logicalRows(task);
  assert.equal(rows.length, 2, 'the same APIFY work did not invent a third logical row');
  const original = rows.find((row) => row.logical_tool_call_id === originalId);
  assert.deepEqual(original, {
    logical_tool_call_id: originalId,
    tool_name: providerContract!.toolName,
    state: 'open',
    conflict_reason: null,
  }, 'foreign nested work did not poison the refined parent');
  const binding = eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, tool_name, argument_digest
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    logical_tool_call_id: string;
    tool_name: string;
    argument_digest: string;
  } | undefined;
  assert.deepEqual(binding, {
    logical_tool_call_id: originalId,
    tool_name: providerContract!.toolName,
    argument_digest: providerContract!.argumentDigest,
  }, 'one durable binding remains attached to the original refined call');
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

test('a REFINED call settles under its pre-refinement identity, and a foreign contract still conflicts', async () => {
  // LIVE platform-49 23:00Z, the variant that survived the identity ring. The
  // call_tool wrapper admits a logical call, the gateway REFINES it to
  // provider-ready args (argument_digest is rewritten, raw_argument_digest is
  // not), the inner dispatch fails, and the outer wrapper then settles under
  // the identity it still holds. This seam accepted only the refined digest,
  // so the wrapper poisoned its own call and took the scheduled run with it —
  // while the dispatch ledger had always accepted either digest for the same
  // question. Three calls, no space_refresh: a different path to one bug.
  const task = acceptTurn('refined');
  const rawArgs = { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1' } };
  const effectiveArgs = { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel: 'C1', limit: 50 } };
  const callId = `call_refined_${task.label}`;

  await identities.withLogicalToolCall(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: INNER_TOOL,
      args: rawArgs,
      logicalToolCallId: callId,
    },
    async () => {
      // The gateway's trusted resolver rewrites to provider-ready arguments.
      const refined = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool: INNER_TOOL,
        effectiveArgs,
      });
      assert.ok(refined, 'the resolver refined its own call');

      // The inner dispatch fails, so the OUTER wrapper settles with the args it
      // still holds — the raw ones the call was admitted under.
      const settled = settleHere(task, INNER_TOOL, rawArgs, { successful: false, error: 'inner failed' });
      assert.notEqual(settled.outcome.kind, 'succeeded');
    },
  );

  const rows = logicalRows(task);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, 'settled', 'the wrapper no longer poisons the call it refined');
  assert.equal(rows[0]?.conflict_reason, null);

  // A genuinely DIFFERENT contract is still refused — the guard is narrowed to
  // the same call's own two digests, not loosened.
  const foreign = acceptTurn('foreign');
  const foreignCall = `call_foreign_${foreign.label}`;
  await identities.withLogicalToolCall(
    {
      sessionId: foreign.sessionId,
      sourceUserSeq: foreign.sourceUserSeq,
      tool: INNER_TOOL,
      args: rawArgs,
      logicalToolCallId: foreignCall,
    },
    async () => {
      const conflicted = settlements.commitLogicalCallSettlement({
        identity: {
          sessionId: foreign.sessionId,
          sourceUserSeq: foreign.sourceUserSeq,
          acceptedTaskId: identities.acceptedTaskIdFor(foreign.sessionId, foreign.sourceUserSeq),
          logicalToolCallId: foreignCall,
        },
        contract: { toolName: INNER_TOOL, args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C9' } } },
        execution: { kind: 'local_execution' },
        outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
        recovery: { businessCall: true, mutating: false },
        observer: { lane: 'agents_runner', turn: foreign.turn },
      });
      assert.equal(conflicted.status, 'conflict');
      if (conflicted.status !== 'conflict') throw new Error('a foreign contract settled');
      assert.match(conflicted.reason, /contract conflicts with its admission/);
    },
  );
});
