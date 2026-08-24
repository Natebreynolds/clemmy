import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tool } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-worker-carrier\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const contracts = await import('../runtime/harness/expected-work-contract.js');
const admission = await import('../runtime/harness/expected-work-admission.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const attempts = await import('../runtime/harness/attempt-outcome.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const brackets = await import('../runtime/harness/brackets.js');
const workCallModule = await import('../tools/work-call.js');
const { buildWorkerAgent } = await import('./sub-agents.js');
const { _setInnerDispatchToolsForTests } = await import('../tools/inner-dispatch.js');

test.after(() => {
  _setInnerDispatchToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** An accepted action whose per-item work is delegated to a fan-out worker. */
const ASK = 'Read every open lead and write a local follow-up draft file for each one.';
const SOURCE_TOOL = 'read_file';
const DRAFT_TOOL = 'write_file';
const PROFILE_READ_TOOL = 'user_profile_read';
const COMPUTE_TOOL = 'run_shell_command';
const EXTERNAL_SEND_TOOL = 'composio_execute_tool';

let serial = 0;

interface DelegatedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  label: string;
}

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read_leads',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_draft',
        effect: 'local_write' as const,
        dependsOn: ['read_leads'],
        dataFrom: ['read_leads'],
        cardinality: { kind: 'each' as const, universeId: 'leads' },
      },
    ],
    universes: [{
      id: 'leads',
      seal: 'complete_source_receipt' as const,
      producedBy: 'read_leads',
      memberIdPointer: '/id',
    }],
  };
}

function acceptDelegatedAction(label: string, options: { activate: boolean } = { activate: true }): DelegatedTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `worker-carrier-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  assert.equal(
    (graphEvent.data.graph as { classification: { route: string } }).classification.route,
    'act',
    'the delegated fixture ask must be an accepted action turn',
  );
  if (options.activate) {
    const activated = admission.activateActionExpectedWork(task);
    assert.ok(
      activated.status === 'activated' || activated.status === 'replayed',
      JSON.stringify(activated),
    );
  }
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

/** Freeze the contract and settle the producer read with redeemable evidence. */
function stageSealedSource(task: DelegatedTask, records: unknown[]): string {
  const args = { path: 'leads.json' };
  const logicalToolCallId = `logical:${task.label}:source`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: SOURCE_TOOL,
    args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  const bound = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: proposal(),
    requirementId: 'read_leads',
    tool: SOURCE_TOOL,
    args,
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));

  const physicalDispatchId = `dispatch:${logicalToolCallId}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId, ordinal: 0 },
    tool: SOURCE_TOOL,
    args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: SOURCE_TOOL,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: SOURCE_TOOL, args },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, complete: true, records } },
    outcome: attempts.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false, requirementId: 'read_leads' },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return logicalToolCallId;
}

function toolNamesOf(agent: { tools?: Array<{ name?: string }> }): string[] {
  return (agent.tools ?? []).map((toolRef) => toolRef.name ?? '').filter(Boolean);
}

type Invokable = Tool<unknown> & {
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

function invokable(agent: { tools?: Array<{ name?: string }> }, name: string): Invokable {
  const found = (agent.tools ?? []).find((toolRef) => toolRef.name === name) as Invokable | undefined;
  assert.ok(found, `missing ${name} on the worker surface`);
  return found;
}

test('a worker built under an activated action carries the bound carrier, not loose business tools', async () => {
  const task = acceptDelegatedAction('surface');
  const worker = await buildWorkerAgent({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const names = toolNamesOf(worker as { tools?: Array<{ name?: string }> });
  assert.ok(names.includes('work_call'), 'the delegated item has a door to walk through');
  assert.equal(names.includes('call_tool'), false, 'no second generic business carrier competes');
  assert.equal(names.includes(DRAFT_TOOL), false, 'business tools stay behind the carrier');
  assert.equal(names.includes('composio_execute_tool'), false, 'business tools stay behind the carrier');
  assert.ok(names.includes('tool_search'), 'control discovery remains directly callable');
});

test('a worker outside an accepted action keeps its historical surface', async () => {
  const session = eventlog.createSession({ id: `worker-carrier-retrieve-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the notes about project alpha.' },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.notEqual(
    (graphEvent?.data.graph as { classification: { route: string } }).classification.route,
    'act',
    'this fixture must be a non-action turn',
  );
  const retrieve = await buildWorkerAgent({ sessionId: session.id, sourceUserSeq: source.seq });
  const retrieveNames = toolNamesOf(retrieve as { tools?: Array<{ name?: string }> });
  assert.equal(retrieveNames.includes('work_call'), false, 'a non-action turn is not bound to a carrier');
  assert.ok(retrieveNames.includes(DRAFT_TOOL) || retrieveNames.includes('call_tool'));

  const anonymous = await buildWorkerAgent({});
  const anonymousNames = toolNamesOf(anonymous as { tools?: Array<{ name?: string }> });
  assert.equal(anonymousNames.includes('work_call'), false, 'a worker with no accepted identity is not bound');
  assert.ok(anonymousNames.includes(DRAFT_TOOL) || anonymousNames.includes('call_tool'));
});

test('an accepted action whose authority never activated fails closed instead of building an unbound surface', async () => {
  // The surface and the wall must answer to the same authority. Historically a
  // lane that could not prove activation just built loose business tools, which
  // is the permissive half of the same bug: an action turn doing contracted
  // work with no contract. Every brain lane already fails closed here.
  const unactivated = acceptDelegatedAction('unactivated', { activate: false });
  await assert.rejects(
    () => buildWorkerAgent({
      sessionId: unactivated.sessionId,
      sourceUserSeq: unactivated.sourceUserSeq,
    }),
    /action expected-work activation missing/,
  );
});

test('a worker per-item write binds to the parent contract and reaches its inner tool', async () => {
  const task = acceptDelegatedAction('bind');
  stageSealedSource(task, [{ id: 'lead-001' }, { id: 'lead-002' }]);

  const written: Array<Record<string, unknown>> = [];
  _setInnerDispatchToolsForTests(new Map([
    [DRAFT_TOOL, {
      name: DRAFT_TOOL,
      invoke: async (_ctx: unknown, raw: string) => {
        written.push(JSON.parse(raw) as Record<string, unknown>);
        return { successful: true };
      },
    }],
  ] as never));

  const worker = await buildWorkerAgent({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const workCall = invokable(worker as { tools?: Array<{ name?: string }> }, 'work_call');
  const args = { path: 'drafts/lead-001.md', content: 'Follow-up for lead-001', lead_id: 'lead-001' };

  // Exactly how the worker lane runs: the parent's accepted identity is ambient
  // and worker-scoped; no work_call frame is inherited from the parent.
  const output = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: null,
        requirement_id: 'write_draft',
        universe_item_id: 'lead-001',
        universe_selector: { argument_pointer: '/lead_id', member_id_pointer: null },
        name: DRAFT_TOOL,
        args_json: JSON.stringify(args),
      }),
      { toolCall: { callId: `worker-item-${task.label}` } },
    ),
  );

  const rendered = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  assert.doesNotMatch(rendered, /work_binding_required|ExpectedWorkBindingRequiredError/,
    'the delegated item no longer dies on a wall with no door');
  assert.doesNotMatch(rendered, /work_universe_unsealed|work_dependency_pending/, rendered);
  assert.equal(written.length, 1, 'the inner business tool actually ran');

  const binding = eventlog.openEventLog().prepare(`
    SELECT requirement_id, universe_item_id, universe_seal, effect_kind,
           cardinality_kind, input_source_kind
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND requirement_id = 'write_draft'
  `).all(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(binding, [{
    requirement_id: 'write_draft',
    universe_item_id: 'lead-001',
    universe_seal: 'complete_source_receipt',
    effect_kind: 'local_write',
    cardinality_kind: 'each',
    input_source_kind: 'complete_source_receipt',
  }], 'the worker call is bound to the sealed member, not exempted from the contract');
});

test('a worker item outside the sealed universe is still refused', async () => {
  const task = acceptDelegatedAction('stranger');
  stageSealedSource(task, [{ id: 'lead-001' }, { id: 'lead-002' }]);
  const ran: unknown[] = [];
  _setInnerDispatchToolsForTests(new Map([
    [DRAFT_TOOL, {
      name: DRAFT_TOOL,
      invoke: async () => { ran.push(1); return { successful: true }; },
    }],
  ] as never));

  const worker = await buildWorkerAgent({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const workCall = invokable(worker as { tools?: Array<{ name?: string }> }, 'work_call');
  const args = { path: 'drafts/lead-404.md', content: 'not in the source', lead_id: 'lead-404' };
  const output = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: null,
        requirement_id: 'write_draft',
        universe_item_id: 'lead-404',
        universe_selector: { argument_pointer: '/lead_id', member_id_pointer: null },
        name: DRAFT_TOOL,
        args_json: JSON.stringify(args),
      }),
      { toolCall: { callId: `worker-stranger-${task.label}` } },
    ),
  );
  const rendered = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  assert.match(rendered, /work_cardinality_mismatch/, rendered);
  assert.equal(ran.length, 0, 'an item outside the sealed universe crosses no tool boundary');
});

test('the gentle-call predicate excludes durable binding and authority refusals', () => {
  assert.equal(workCallModule.isReadComputeSemanticRefusal(
    'work_contract_conflict',
    'a different action topology is already frozen',
  ), true, 'a candidate proposal disagreement is semantic only');
  assert.equal(workCallModule.isReadComputeSemanticRefusal(
    'work_contract_conflict',
    'logical call already owns a different work binding',
  ), false, 'an actual persisted binding collision remains fail-closed');
  assert.equal(workCallModule.isReadComputeSemanticRefusal(
    'work_binding_required',
    'call logical:conflict is not bound to the frozen contract',
  ), false, 'a binding-authority refusal is never generalized into the fallback');
  assert.equal(workCallModule.isReadComputeSemanticRefusal(
    'work_authority_unavailable',
    'logical call is not the exact open normalized inner call',
  ), false);
  assert.equal(workCallModule.isReadComputeSemanticRefusal(
    'work_already_satisfied',
    'this requirement instance is already durably settled',
  ), false, 'a satisfied instance stays on the stored-result redemption lane');
});

test('a worker can execute an unbound host read through a conflicting proposal, but the same conflict cannot open an external write', async () => {
  const task = acceptDelegatedAction('conflicting-read-fallback');
  const boundSourceCallId = stageSealedSource(task, [{ id: 'lead-001' }]);
  assert.deepEqual(workCallModule.unboundReadComputeAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: boundSourceCallId,
    toolName: SOURCE_TOOL,
    args: { path: 'leads.json' },
  }), {
    ok: false,
    reason: 'logical call already owns a durable work binding',
  }, 'a conflicting proposal cannot mask an already-persisted binding from the fallback');

  let readExecutions = 0;
  let computeExecutions = 0;
  let sendExecutions = 0;
  _setInnerDispatchToolsForTests(new Map([
    [PROFILE_READ_TOOL, {
      name: PROFILE_READ_TOOL,
      invoke: async () => {
        readExecutions += 1;
        return { successful: true, data: { marker: 'worker-read-reached-provider' } };
      },
    }],
    [COMPUTE_TOOL, {
      name: COMPUTE_TOOL,
      invoke: async () => {
        computeExecutions += 1;
        return { successful: true, stdout: 'worker-compute-reached-provider' };
      },
    }],
    [EXTERNAL_SEND_TOOL, {
      name: EXTERNAL_SEND_TOOL,
      invoke: async () => {
        sendExecutions += 1;
        return { successful: true, data: { id: 'must-not-send' } };
      },
    }],
  ] as never));

  const worker = await buildWorkerAgent({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const workCall = invokable(worker as { tools?: Array<{ name?: string }> }, 'work_call');
  const conflictingOneOperationProposal = {
    version: 1,
    operations: [{
      id: 'inspect-profile',
      // Deliberately disagree with both the broader frozen contract and the
      // host-resolved read. Host effect truth, not proposal prose, decides
      // whether the fallback is safe.
      effect: 'compute',
      coverage: null,
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  };

  const readCallId = `worker-conflicting-read-${task.label}`;
  const readOutput = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: conflictingOneOperationProposal,
        requirement_id: 'inspect-profile',
        universe_item_id: null,
        universe_selector: null,
        name: PROFILE_READ_TOOL,
        args_json: '{}',
      }),
      { toolCall: { callId: readCallId } },
    ),
  );
  const renderedRead = typeof readOutput === 'string'
    ? readOutput
    : JSON.stringify(readOutput ?? null);
  assert.match(renderedRead, /worker-read-reached-provider/, renderedRead);
  assert.equal(readExecutions, 1, 'the host-classified read reaches its provider path once');
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, readCallId) as { n: number }).n,
    0,
    'the conflicting read is truthful unbound work, not a fabricated contract binding',
  );

  const computeCallId = `worker-conflicting-compute-${task.label}`;
  const computeOutput = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: conflictingOneOperationProposal,
        requirement_id: 'inspect-profile',
        universe_item_id: null,
        universe_selector: null,
        name: COMPUTE_TOOL,
        args_json: JSON.stringify({ command: 'echo worker-compute-reached-provider' }),
      }),
      { toolCall: { callId: computeCallId } },
    ),
  );
  const renderedCompute = typeof computeOutput === 'string'
    ? computeOutput
    : JSON.stringify(computeOutput ?? null);
  assert.match(renderedCompute, /worker-compute-reached-provider/, renderedCompute);
  assert.equal(computeExecutions, 1, 'the host-classified compute reaches its provider path once');
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, computeCallId) as { n: number }).n,
    0,
    'the conflicting compute also remains explicitly unbound',
  );

  const sendCallId = `worker-conflicting-send-${task.label}`;
  const sendOutput = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: conflictingOneOperationProposal,
        requirement_id: 'inspect-profile',
        universe_item_id: null,
        universe_selector: null,
        name: EXTERNAL_SEND_TOOL,
        args_json: JSON.stringify({
          tool_slug: 'OUTLOOK_SEND_EMAIL',
          arguments: JSON.stringify({
            to: 'prospect@example.test',
            subject: 'Contract isolation test',
            body: 'This must not dispatch.',
          }),
          connected_account_id: null,
        }),
      }),
      { toolCall: { callId: sendCallId } },
    ),
  );
  const renderedSend = typeof sendOutput === 'string'
    ? sendOutput
    : JSON.stringify(sendOutput ?? null);
  assert.match(renderedSend, /work_contract_conflict|work_contract_invalid/, renderedSend);
  assert.equal(sendExecutions, 0, 'a conflicting proposal still authorizes zero external writes');
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, sendCallId) as { n: number }).n,
    0,
    'the external write never crosses a provider boundary',
  );

  eventlog.openEventLog().prepare(`
    UPDATE accepted_task_authority
       SET state = 'conflict', revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ? AND state = 'armed'
  `).run(new Date().toISOString(), task.sessionId, task.sourceUserSeq);
  const closedReadOutput = await brackets.withHarnessRunContext(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      workerScope: true,
    },
    () => workCall.invoke(
      { context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: 1 } },
      JSON.stringify({
        proposal: conflictingOneOperationProposal,
        requirement_id: 'inspect-profile',
        universe_item_id: null,
        universe_selector: null,
        name: PROFILE_READ_TOOL,
        args_json: '{}',
      }),
      { toolCall: { callId: `worker-closed-read-${task.label}` } },
    ),
  );
  const renderedClosedRead = typeof closedReadOutput === 'string'
    ? closedReadOutput
    : JSON.stringify(closedReadOutput ?? null);
  assert.match(renderedClosedRead, /work_contract_conflict|work_authority_unavailable/, renderedClosedRead);
  assert.equal(readExecutions, 1, 'a conflicted accepted authority cannot use the read fallback');
});
