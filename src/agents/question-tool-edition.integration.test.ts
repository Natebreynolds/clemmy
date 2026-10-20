/** Controlled source-owned SDK/host fixtures; no live model/provider or command execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-question-wire-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
  MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true', OPENAI_AGENTS_DISABLE_TRACING: '1',
  CLEMMY_COMPLETION_REVIEW: 'off', MODEL_ROUTING_MODE: 'off', CLEMMY_UNIFIED_RECALL: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'off', CLEMMY_SEMANTIC_RECALL: 'off', CLEMMY_DEBATE_MODE: 'off' });
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const scope = await import('../runtime/harness/source-session-context-scope.js');
const { buildAskUserQuestionTool, buildOrchestratorAgent, userChoiceToolUseBehavior } = await import('./orchestrator.js');
const { parseQuestionToolWireEdition } = await import('./question-tools.js');
const { RunContext } = await import('@openai/agents');
const { withHarnessRunContext, ToolCallsCounter, harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const policy = await import('./proactivity-policy.js');
const pending = await import('../runtime/harness/pending-actions.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const { closeMemoryDb } = await import('../memory/db.js');
const { HostRecoveryState } = await import('../runtime/harness/host-turn-runner.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { discoveryGovernor } = await import('../runtime/harness/discovery-governor.js');
const { runConversation } = await import('../runtime/harness/loop.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const { redeemDurableLogicalCallSettlementForHost } = await import('../runtime/harness/logical-call-settlement-store.js');
const { redeemSuccessfulSettlementResultForHost } = await import('../runtime/harness/result-handle.js');
const { acceptedTurnCallAuthorityFor } = await import('../runtime/harness/accepted-turn-call-authority.js');
const { isDispatchLeaseCurrent, revokeDispatchLeaseBeforeRecovery } = await import('../runtime/harness/dispatch-lease.js');
const priorFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls += 1; throw new Error('Question wire fixture forbids network.'); }) as typeof fetch;
after(() => { globalThis.fetch = priorFetch; assert.equal(networkCalls, 0); closeMemoryDb(); events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function task(sessionId = events.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' }).id) {
  const source = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Inspect the controlled choices.' } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn } }),
    'the actual SDK dispatch requires the same persisted accepted-task graph as production');
  discoveryGovernor.initializeTask({ sessionId, sourceUserSeq: source.seq, knownCapability: false });
  return { sessionId, sourceUserSeq: source.seq };
}
function captured(input = task()) {
  const context = contexts.captureFreshSourceSessionContext(input); assert.ok(context); return { input, context };
}
function stored(input: { sessionId: string; sourceUserSeq: number }) {
  return events.openEventLog().prepare('SELECT identity_json,identity_digest FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?')
    .get(input.sessionId, input.sourceUserSeq) as { identity_json: string; identity_digest: string };
}
/** Insert an old-format immutable row using a current mount/source fixture.
 * This is a legacy-shaped compatibility fixture, not historical app acceptance. */
function retainedSibling(template: { sessionId: string; sourceUserSeq: number }, edition?: unknown) {
  const input = task(template.sessionId); const identity = JSON.parse(stored(template).identity_json);
  identity.sourceUserSeq = input.sourceUserSeq;
  if (edition === undefined) delete identity.questionToolWireEdition; else identity.questionToolWireEdition = edition;
  events.openEventLog().prepare('INSERT INTO source_session_contexts_v1(session_id,source_user_seq,identity_json,identity_digest) VALUES(?,?,?,?)')
    .run(input.sessionId, input.sourceUserSeq, JSON.stringify(identity), hash(identity));
  return input;
}
function toolOf(agent: { tools?: unknown[] }, name: string) {
  const tool = agent.tools?.find(item => (item as { name?: string }).name === name) as {
    name: string; parameters: Record<string, any>; description: string; invoke(context: unknown, input: string): Promise<unknown>;
  } | undefined;
  assert.ok(tool, `${name} is on the actual Agent surface`); return tool;
}
const decode = (value: unknown): any => {
  let result: any = value;
  for (let count = 0; count < 3; count++) {
    if (typeof result === 'string') { try { result = JSON.parse(result); continue; } catch { return result; } }
    if (Array.isArray(result?.content) && typeof result.content[0]?.text === 'string') { result = result.content[0].text; continue; }
    return result;
  }
  return result;
};
function purposeValues(schema: any): unknown[] {
  const purpose = schema.properties.purpose;
  return purpose.enum ?? purpose.anyOf?.flatMap((item: any) => item.enum ?? (Object.hasOwn(item, 'const') ? [item.const] : [])) ?? [];
}
async function build(context: import('../runtime/harness/source-session-context-scope.js').SourceSessionContext, includeSource = true) {
  return scope.withSourceSessionContext(context, () => buildOrchestratorAgent({ sessionId: context.sessionId,
    ...(includeSource ? { sourceUserSeq: context.sourceUserSeq } : {}), userInput: 'Inspect the controlled choices.', allowToolJit: true }));
}
async function invoke(context: import('../runtime/harness/source-session-context-scope.js').SourceSessionContext,
  tool: ReturnType<typeof toolOf>, args: unknown) {
  return scope.withSourceSessionContext(context, () => withHarnessRunContext({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
    turn: 1, counter: new ToolCallsCounter(20) }, () => tool.invoke(new RunContext({ sessionId: context.sessionId, turn: 1 }), JSON.stringify(args))));
}

// This literal hashes the pre-edition tool description, including shared guidance.
const LEGACY_DESCRIPTION = 'Ask the user one question and (normally) pause for the reply — a normal step, not a last resort. Ask BEFORE '
  + 'committing when an ambiguity changes the outcome (account/records, time window, destination, format) or a '
  + 'boundary needs their decision — name the gap and the closest thing you CAN do. Never ask what you can find '
  + 'out yourself, what would not change the outcome, or what this session already settled. Do the unblocked part '
  + 'first; ask ONE targeted question with 2-5 concrete options, recommendation first, no "other" option; batch '
  + 'independent questions. `purpose`: "clarification" = a fact only they have, or a choice between different '
  + 'ways forward. "approval" is a legacy compatibility value, not a way to request formal execution consent. '
  + 'This question tool gathers missing facts or choices; it does not create a formal execution card or grant execution consent. '
  + 'Prepared formal card: discover missing `pending_action_queue` schema; queue exact payload with `approvalIntent:"request_now"` before execution or a generic approval question. '
  + 'Already sealed work stays on `work_call`; never queue it again. The host validates consent.';

test('no-context/default construction preserves the exact legacy schema and description', async () => {
  const question = buildAskUserQuestionTool();
  assert.equal(question.description, LEGACY_DESCRIPTION);
  assert.deepEqual(new Set(purposeValues(question.parameters)), new Set(['clarification', 'approval']));
  assert.equal(question.parameters.properties.question.minLength, 4);
  assert.equal(question.parameters.properties.options.anyOf?.[0]?.maxItems ?? question.parameters.properties.options.maxItems, 5);
  assert.equal(scope.questionToolWireEditionForSource('no-context', 99), 'legacy_v1');
  assert.equal(parseQuestionToolWireEdition('future_v3'), null);
  assert.throws(() => buildAskUserQuestionTool('future_v3' as never), /Unknown question tool wire edition/);
  const agent = await buildOrchestratorAgent({ sessionId: task().sessionId, allowToolJit: true });
  assert.deepEqual(toolOf(agent, 'ask_user_question').parameters, question.parameters);
  assert.equal(toolOf(agent, 'ask_user_question').description, LEGACY_DESCRIPTION);
});

test('fresh captured source selects v2 through direct, scoped discovery and wrapped SDK invocation', async () => {
  const { input, context } = captured();
  assert.equal(JSON.parse(stored(input).identity_json).questionToolWireEdition, 'clarification_v2');
  const agent = await build(context); const direct = toolOf(agent, 'ask_user_question');
  assert.deepEqual(purposeValues(direct.parameters), ['clarification']);
  assert.doesNotMatch(direct.description, /"approval" is a legacy compatibility value/);
  const search = decode(await invoke(context, toolOf(agent, 'tool_search'), { query: 'ask_user_question', role_key: null,
    limit: 1, account_selection: null, cursor: null }));
  assert.ok(Array.isArray(search.results), `controlled scoped discovery returned ${JSON.stringify(search)}`);
  assert.ok(search.results.some((row: any) => row.name === 'ask_user_question'));
  assert.deepEqual(search.schemas.ask_user_question.properties.purpose, direct.parameters.properties.purpose);
  const good = { question: 'Which controlled format should I use?', options: ['Short', 'Detailed'], purpose: 'clarification' };
  const directResult = decode(await invoke(context, direct, good));
  assert.equal(directResult.kind, 'clementine.ask_user_question.candidate'); assert.equal(directResult.posted, false);
  const wrapped = toolOf(agent, 'call_tool');
  const wrappedResult = decode(await invoke(context, wrapped, { name: 'ask_user_question', args_json: good }));
  assert.equal(wrappedResult.kind, directResult.kind, `controlled wrapped question returned ${JSON.stringify(wrappedResult)}`);
  assert.equal(wrappedResult.purpose, 'clarification');
  const invalid = { ...good, purpose: 'approval' };
  const rejectedDirect = await invoke(context, direct, invalid);
  const rejectedWrapped = await invoke(context, wrapped, { name: 'ask_user_question', args_json: invalid });
  assert.notEqual(decode(rejectedDirect)?.kind, directResult.kind);
  assert.notEqual(decode(rejectedWrapped)?.kind, directResult.kind);
  assert.equal(events.listEvents(input.sessionId, { types: ['autonomy_note', 'approval_requested'] }).length, 0);
  assert.deepEqual(pending.listPendingActions({ sessionId: input.sessionId, status: 'all' }), []);
});

test('old identity bytes/digest stay unchanged, SDK legacy approval repair remains non-halting and a new source gets v2', async () => {
  const first = captured(); const old = retainedSibling(first.input); const before = stored(old);
  const legacy = contexts.readSourceSessionContext(old, before.identity_digest); assert.ok(legacy);
  assert.equal(scope.sourceQuestionToolWireEdition(legacy), 'legacy_v1');
  assert.equal(scope.sourceQuestionToolWireEdition(contexts.captureFreshSourceSessionContext(old)!), 'legacy_v1');
  assert.deepEqual(stored(old), before);
  policy.saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const agent = await build(legacy); const question = toolOf(agent, 'ask_user_question');
    assert.equal(question.description, LEGACY_DESCRIPTION);
    assert.deepEqual(question.parameters, buildAskUserQuestionTool().parameters);
    const result = await invoke(legacy, question, { question: 'Should I send the controlled update?', options: ['Yes', 'No'], purpose: 'approval' });
    assert.match(String(result), /conditional_formal_approval_preparation/);
    const wrappedResult = await invoke(legacy, toolOf(agent, 'call_tool'), {
      name: 'ask_user_question', args_json: { question: 'Should I send the controlled update?', options: ['Yes', 'No'], purpose: 'approval' } });
    assert.match(String(wrappedResult), /conditional_formal_approval_preparation/);
    assert.equal(events.listEvents(old.sessionId, { types: ['autonomy_note'] }).at(-1)?.data.classifier, 'typed');
    assert.deepEqual(pending.listPendingActions({ sessionId: old.sessionId, status: 'all' }), []);
    assert.equal(events.listEvents(old.sessionId, { types: ['approval_requested'] }).length, 0);
  } finally { policy.saveProactivityPolicy({ autoApproveScope: 'balanced' }); }
  const next = captured(task(old.sessionId)); assert.equal(scope.sourceQuestionToolWireEdition(next.context), 'clarification_v2');
  events.closeEventLog(); const reopened = contexts.readSourceSessionContext(old, before.identity_digest); assert.ok(reopened);
  assert.equal(scope.sourceQuestionToolWireEdition(reopened), 'legacy_v1'); assert.deepEqual(stored(old), before);
  assert.deepEqual(toolOf(await build(reopened), 'ask_user_question').parameters, buildAskUserQuestionTool().parameters);
});

test('unknown stored editions fail after valid digest verification without rewriting the row', () => {
  const first = captured(); const bad = retainedSibling(first.input, 'future_v3'); const before = stored(bad);
  assert.throws(() => contexts.readSourceSessionContext(bad, before.identity_digest), /wire edition is unavailable/);
  assert.deepEqual(stored(bad), before);
});

test('fresh capture whitelists source identity and ignores wider caller edition/version/context fields', () => {
  const input = task();
  const wider = { ...input, version: 99, questionToolWireEdition: 'legacy_v1', digest: 'f'.repeat(64),
    memoryScope: { projectId: 'foreign', agentKey: 'foreign' }, unexpectedSourceExtra: 'not durable' };
  const context = contexts.captureFreshSourceSessionContext(wider); assert.ok(context);
  const before = stored(input); const identity = JSON.parse(before.identity_json);
  assert.equal(identity.version, 1); assert.equal(identity.questionToolWireEdition, 'clarification_v2');
  assert.equal(Object.hasOwn(identity, 'unexpectedSourceExtra'), false);
  assert.equal(Object.hasOwn(context, 'version'), false); assert.equal(Object.hasOwn(context, 'unexpectedSourceExtra'), false);
  assert.notEqual(context.digest, wider.digest); assert.notDeepEqual(context.memoryScope, wider.memoryScope);
  assert.equal(scope.sourceQuestionToolWireEdition(context), 'clarification_v2');
  const reopened = contexts.readSourceSessionContext(input, context.digest); assert.ok(reopened);
  assert.equal(scope.sourceQuestionToolWireEdition(reopened), 'clarification_v2');
  assert.deepEqual(stored(input), before);
});

test('shape-spoofed/copied contexts cannot select v2; mutated references and foreign source are rejected', async () => {
  const { input, context } = captured();
  const clone = { ...context };
  assert.throws(() => scope.withSourceSessionContext(clone, () => scope.questionToolWireEditionForSource(input.sessionId, input.sourceUserSeq)), /not validated/);
  const forged = { ...clone, digest: 'f'.repeat(64) };
  assert.throws(() => scope.withSourceSessionContext(forged, () => scope.questionToolWireEditionForSource(input.sessionId, input.sourceUserSeq)), /not validated/);
  assert.throws(() => scope.withSourceSessionContext(context, () => scope.questionToolWireEditionForSource(input.sessionId, input.sourceUserSeq + 1)), /another accepted source/);
  const originalDigest = context.digest; context.digest = 'e'.repeat(64);
  try { assert.throws(() => scope.sourceQuestionToolWireEdition(context), /changed its accepted source/); }
  finally { context.digest = originalDigest; }
  const noEdition = { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: context.digest, mount: context.mount, memoryScope: context.memoryScope };
  assert.equal(scope.withSourceSessionContext(noEdition, () => scope.questionToolWireEditionForSource(input.sessionId, input.sourceUserSeq)), 'legacy_v1');
  assert.deepEqual(purposeValues(toolOf(await build(context, false), 'ask_user_question').parameters), ['clarification'],
    'omitted options.sourceUserSeq uses the exact validated active source, never a latest-session lookup');
});

test('helpers retain parent edition after reopen and a changed child edition cannot rebind it', () => {
  const first = captured(); const old = retainedSibling(first.input); const parent = contexts.readSourceSessionContext(old)!;
  const child = events.createSession({ kind: 'agent', metadata: { source: 'delegated_worker', workerScope: true,
    parentSessionId: old.sessionId, parentSourceUserSeq: old.sourceUserSeq } });
  const input = task(child.id); const context = contexts.captureFreshSourceSessionContext(input); assert.ok(context);
  assert.equal(scope.sourceQuestionToolWireEdition(context), 'legacy_v1');
  events.closeEventLog(); assert.equal(scope.sourceQuestionToolWireEdition(contexts.readSourceSessionContext(input)!), 'legacy_v1');
  const mismatched = retainedSibling(input, 'clarification_v2');
  assert.throws(() => contexts.readSourceSessionContext(mismatched), /worker lost its original question tool wire edition/);
  assert.equal(scope.sourceQuestionToolWireEdition(parent), 'legacy_v1');
});

test('verified approval continuation reads its original legacy source rather than capturing the new control as v2', async () => {
  const first = captured(); const old = retainedSibling(first.input); const card = approvals.register({ sessionId: old.sessionId,
    subject: 'Controlled continuation choice', tool: 'request_approval', args: {} });
  assert.equal(approvals.resolve(card.approvalId, 'approved', 'fixture').ok, true);
  const control = events.appendEvent({ sessionId: old.sessionId, turn: 0, role: 'user', type: 'user_input_received',
    data: { text: 'Approved', synthetic: true, source: 'approval_resume', approvalId: card.approvalId, decision: 'approve' } });
  const recovery = new HostRecoveryState(old.sessionId, old.sourceUserSeq, 'continue', [], [], [], undefined, undefined, 'host_v1', undefined, 0);
  events.updateSession(old.sessionId, { metadata: { __host_recovery_state: recovery.toString(), __host_recovery_owner: {
    sourceUserSeq: control.seq, approvalContinuation: { requestSourceUserSeq: old.sourceUserSeq, approvalId: card.approvalId, decision: 'approve' } } } });
  await contexts.withAcceptedSourceSessionContext({ sessionId: old.sessionId, sourceUserSeq: control.seq }, async execution => {
    assert.deepEqual(execution, old);
    const agent = await buildOrchestratorAgent({ ...execution, allowToolJit: true });
    assert.deepEqual(toolOf(agent, 'ask_user_question').parameters, buildAskUserQuestionTool().parameters);
  }, { newlyAccepted: true });
  assert.equal(stored({ sessionId: old.sessionId, sourceUserSeq: control.seq }), undefined, 'control does not mint a fresh composition or wire');
});

for (const mode of ['wrapped_only', 'duplicate_direct', 'wrapped_foreign_history', 'direct_foreign_history',
  'stop_before_post', 'revoked_before_post', 'caller_aborted', 'refused_no_handle', 'foreign_result'] as const) {
test(`real host wrapped clarification posts once and halts (${mode})`, async () => {
  const duplicateDirect = mode === 'duplicate_direct'; const directOnly = mode === 'direct_foreign_history';
  const historical = mode.endsWith('foreign_history');
  const ownerFailure = ['stop_before_post', 'revoked_before_post', 'caller_aborted'].includes(mode);
  const refused = mode === 'refused_no_handle';
  const controller = new AbortController();
  const session = events.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop', title: 'Controlled wrapped clarification fixture' });
  const args = { question: 'Which controlled output format do you prefer?', options: ['Short', 'Detailed'], purpose: 'clarification' };
  const candidateBytes = JSON.stringify({ kind: 'clementine.ask_user_question.candidate', status: 'staged', posted: false, ...args });
  const fixtureFile = path.join(home, `candidate-${session.id}.txt`);
  if (mode === 'foreign_result') writeFileSync(fixtureFile, candidateBytes);
  if (historical) {
    const old = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Previous controlled request.' } });
    events.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
      data: { question: 'An unrelated previous controlled question.', options: null, purpose: 'clarification', sourceUserSeq: old.seq } });
  }
  const attempt = events.beginRunAttempt(session.id, { runId: `question-wire:${session.id}` });
  const request = mode === 'foreign_result'
    ? `Read the controlled local text fixture at ${fixtureFile}, then ask which controlled output format I prefer.`
    : 'Ask which controlled output format I prefer before continuing.';
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: request, taskMode: { version: 1, kind: 'normal' } } }, { armRunInFlight: true });
  const composition = contexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(composition); assert.equal(scope.sourceQuestionToolWireEdition(composition), 'clarification_v2');
  const submittedArgs = refused ? { ...args, purpose: 'approval' } : args;
  const outerArgs = { name: 'ask_user_question', args_json: submittedArgs };
  let modelCalls = 0; let witnessed = 0; let callbackFailure: unknown;
  let completedWrapped: Parameters<typeof userChoiceToolUseBehavior>[1][number] | undefined;
  let completedCallbackContext: unknown; let completedOwner: ReturnType<typeof harnessRunContextStorage.getStore>;
  const model = {
    async getResponse() {
      modelCalls++;
      return { responseId: `question-wire-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: modelCalls === 1 ? [
          ...(mode === 'foreign_result' ? [{ type: 'function_call', callId: 'foreign-candidate-read', name: 'call_tool',
            arguments: JSON.stringify({ name: 'read_file', args_json: { path: fixtureFile, max_chars: null } }) }] : []),
          ...(!directOnly ? [{ type: 'function_call', callId: 'wrapped-question', name: 'call_tool', arguments: JSON.stringify(outerArgs) }] : []),
          ...(duplicateDirect || directOnly ? [{ type: 'function_call', callId: 'direct-question', name: 'ask_user_question', arguments: JSON.stringify(args) }] : []),
        ] : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The controlled fixture unexpectedly continued.' }] }] };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
  };
  const result = await runConversation({ sessionId: session.id, sourceUserSeq: source.seq, input: request, reuseRecordedUserInput: true,
    runAttemptId: attempt.attemptId, turnEngine: 'host_v1', maxSteps: 1, maxTurns: 3, toolCallsPerTurn: 6, judgeCompletion: false,
    buildAgent: async context => {
      const agent = await buildOrchestratorAgent({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
        hostFreshPlanning: context.hostFreshPlanning, userInput: request, allowToolJit: true, model: model as never });
      agent.toolUseBehavior = (async (callbackContext: unknown, results: Parameters<typeof userChoiceToolUseBehavior>[1]) => {
        try {
        const wrapped = results.find(row => row.type === 'function_output' && row.tool.name === 'call_tool'
          && (row.runItem as { rawItem?: { callId?: string } } | undefined)?.rawItem?.callId === 'wrapped-question');
        if (wrapped) {
          const actualOuter = JSON.parse(wrapped.argumentsJson!);
          assert.equal(actualOuter.name, 'ask_user_question');
          assert.deepEqual(decode(actualOuter.args_json), submittedArgs, 'the real host retains the exact inner arguments after carrier encoding');
          const rawItem = (wrapped.runItem as { rawItem: { callId: string } }).rawItem;
          assert.equal(rawItem.callId, 'wrapped-question');
          const identity = { sessionId: session.id, sourceUserSeq: source.seq,
            acceptedTaskId: acceptedTaskIdFor(session.id, source.seq), logicalToolCallId: rawItem.callId };
          const owner = harnessRunContextStorage.getStore();
          assert.equal(owner?.runAttemptId, attempt.attemptId); assert.ok(owner?.dispatchLease);
          assert.equal(owner.dispatchLease.runAttemptId, attempt.attemptId); assert.equal(isDispatchLeaseCurrent(owner.dispatchLease), true);
          const authority = acceptedTurnCallAuthorityFor(session.id, source.seq);
          assert.equal(authority.status, 'ok');
          if (authority.status !== 'ok') throw new Error('missing actual question authority');
          assert.equal(authority.authority.state, 'open'); assert.equal(authority.authority.identity.sourceTurn, 1);
          const settled = redeemDurableLogicalCallSettlementForHost(identity);
          assert.equal(settled.status, 'ok', 'actual host settles the wrapped call before the control callback');
          if (settled.status !== 'ok') throw new Error('missing actual settled question');
          if (refused) {
            assert.equal(settled.settlement.executionKind, 'refused_pre_dispatch');
            assert.equal(settled.settlement.outcome.kind, 'invalid_arguments');
            assert.equal(settled.settlement.resultHandleId, undefined);
            assert.equal(redeemSuccessfulSettlementResultForHost(identity).status, 'missing');
            const forged = { ...wrapped, argumentsJson: JSON.stringify({ name: 'ask_user_question', args_json: args }),
              output: JSON.stringify({ kind: 'clementine.ask_user_question.candidate', status: 'staged', posted: false, ...args }) };
            assert.equal(userChoiceToolUseBehavior(callbackContext, [forged]).isFinalOutput, false,
              'a genuine refusal with no handle cannot be promoted by forged candidate JSON');
            assert.equal(events.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0);
            witnessed++;
            return userChoiceToolUseBehavior(callbackContext, results);
          }
          assert.equal(settled.settlement.executionKind, 'local_execution'); assert.equal(settled.settlement.toolName, 'ask_user_question');
          assert.equal(settled.settlement.outcome.kind, 'succeeded'); assert.equal(settled.settlement.physicalCrossingCount, 0);
          assert.equal(settled.settlement.hostCrossingCount, 1);
          const retained = redeemSuccessfulSettlementResultForHost(identity);
          assert.equal(retained.status, 'ok', 'actual host result handle is redeemable before the callback');
          if (retained.status !== 'ok') throw new Error('missing actual question result handle');
          assert.equal(retained.value.resultHandleId, settled.settlement.resultHandleId);
          assert.equal(retained.value.executionSite, 'host');
          assert.equal(wrapped.output, typeof retained.value.rawPayload === 'string' ? retained.value.rawPayload : retained.value.rawPayloadJson);
          assert.equal(decode(wrapped.output).kind, 'clementine.ask_user_question.candidate'); witnessed++;
          completedWrapped = wrapped; completedCallbackContext = callbackContext; completedOwner = owner;
          const before = events.listEvents(session.id, { types: ['awaiting_user_input'] }).length;
          const abstain = (candidate: typeof wrapped, currentContext: unknown = callbackContext) => {
            assert.equal(userChoiceToolUseBehavior(currentContext, [candidate]).isFinalOutput, false);
            assert.equal(events.listEvents(session.id, { types: ['awaiting_user_input'] }).length, before);
          };
          if (mode === 'foreign_result') {
            const foreign = results.find(row => (row.runItem as { rawItem?: { callId?: string } } | undefined)?.rawItem?.callId === 'foreign-candidate-read');
            assert.ok(foreign); assert.equal(foreign.output, wrapped.output, 'the real unrelated local read returns identical candidate bytes');
            const foreignIdentity = { ...identity, logicalToolCallId: 'foreign-candidate-read' };
            const foreignSettlement = redeemDurableLogicalCallSettlementForHost(foreignIdentity);
            assert.equal(foreignSettlement.status, 'ok');
            if (foreignSettlement.status !== 'ok') throw new Error('missing actual foreign read settlement');
            assert.equal(foreignSettlement.settlement.toolName, 'read_file'); assert.equal(foreignSettlement.settlement.outcome.kind, 'succeeded');
            const foreignResult = redeemSuccessfulSettlementResultForHost(foreignIdentity);
            assert.equal(foreignResult.status, 'ok');
            if (foreignResult.status !== 'ok') throw new Error('missing actual foreign read result');
            assert.equal(foreignResult.value.rawPayload, candidateBytes);
            abstain({ ...foreign, argumentsJson: wrapped.argumentsJson }, callbackContext);
          }
          abstain({ ...wrapped, argumentsJson: JSON.stringify({ name: 'provider__read', args_json: args }) });
          abstain({ ...wrapped, output: ` ${wrapped.output}` });
          abstain({ ...wrapped, runItem: { rawItem: { callId: 'not-an-actual-settled-call' } } });
          abstain({ ...wrapped, argumentsJson: JSON.stringify({ name: 'ask_user_question', args_json: { ...args, question: 'A different controlled question?' } }) });
          abstain({ ...wrapped, argumentsJson: JSON.stringify({ name: 'ask_user_question', args_json: { agentSlug: 'fixture', question: args.question } }) });
          const callbackFields = (callbackContext as { context: Record<string, unknown> }).context;
          abstain(wrapped, { context: { ...callbackFields, sourceUserSeq: source.seq + 10_000 } });
          withHarnessRunContext({ ...owner, dispatchLease: undefined }, () => abstain(wrapped));
          const other = events.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
          const otherAttempt = events.beginRunAttempt(other.id, { runId: `question-wire-wrong-owner:${other.id}` });
          events.recordRunAttemptUserInput(otherAttempt, { turn: 1, role: 'user', data: { text: 'Different controlled owner.' } });
          // Even a live durable lease reference cannot borrow another attempt
          // just by changing its in-process runAttemptId fields.
          withHarnessRunContext({ ...owner, runAttemptId: otherAttempt.attemptId,
            dispatchLease: { ...owner.dispatchLease, runAttemptId: otherAttempt.attemptId } }, () => abstain(wrapped));
          if (mode === 'stop_before_post') events.requestKill(session.id, 'Controlled owner stop before question publication.', { attemptId: attempt.attemptId });
          if (mode === 'revoked_before_post') await revokeDispatchLeaseBeforeRecovery(owner.dispatchLease);
          if (mode === 'caller_aborted') {
            // Publisher-boundary proof only: preserve the actual host owner,
            // source and lease, supplying just the typed caller signal. This
            // does not qualify upstream bridge signal propagation.
            controller.abort(new Error('Controlled owner cancellation before publication.'));
            return withHarnessRunContext({ ...owner, callerCancelSignal: controller.signal },
              () => userChoiceToolUseBehavior(callbackContext, results));
          }
        }
        const decision = userChoiceToolUseBehavior(callbackContext, results);
        if (decision.isFinalOutput) {
          const repeated = userChoiceToolUseBehavior(callbackContext, results);
          assert.equal(repeated.isFinalOutput, true, 'repeated same-source arbitration remains terminal without a second post');
        }
        return decision;
        } catch (error) { callbackFailure = error; throw error; }
      }) as typeof agent.toolUseBehavior;
      return agent;
    },
    makeRunner: () => Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not run'); } }) as never,
  });
  if (ownerFailure) {
    assert.ok(callbackFailure instanceof Error, 'actual Stop/revocation/caller cancellation propagates instead of another model round');
    if (mode === 'stop_before_post') assert.equal(callbackFailure.name, 'KillRequested');
    if (mode === 'revoked_before_post') assert.equal(callbackFailure.name, 'StaleDispatchLeaseError');
    if (mode === 'caller_aborted') assert.equal(callbackFailure, controller.signal.reason);
  } else if (callbackFailure) throw callbackFailure;
  assert.equal(witnessed, directOnly ? 0 : 1, 'the actual SDK carrier result reached the host callback with exact durable proof');
  assert.equal(modelCalls, refused ? 2 : 1, refused ? 'the real schema refusal returns to the mock brain without inventing a question' : 'one public question ends the provider activation');
  const allQuestions = events.listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(allQuestions.length, ownerFailure || refused ? 0 : historical ? 2 : 1);
  if (ownerFailure || refused) return;
  const questions = allQuestions.filter(row => row.data.sourceUserSeq === source.seq);
  assert.equal(questions.length, 1); assert.equal(questions[0].data.question, args.question);
  assert.equal(questions[0].data.sourceUserSeq, source.seq); assert.equal(questions[0].data.purpose, 'clarification');
  assert.equal(questions[0].data.bundled, undefined, 'direct and wrapped copies of one question are deduplicated');
  if (completedWrapped && completedOwner) {
    const before = allQuestions.length;
    try {
      withHarnessRunContext(completedOwner, () => {
        assert.equal(userChoiceToolUseBehavior(completedCallbackContext, [completedWrapped!]).isFinalOutput, false,
          'a retained historical result cannot publish from a finished owner');
      });
    } catch (error) {
      assert.equal((error as Error).name, 'StaleDispatchLeaseError', 'an actually revoked unfinished owner propagates its typed boundary');
    }
    assert.equal(events.listEvents(session.id, { types: ['awaiting_user_input'] }).length, before);
  }
  assert.ok(result, 'production host returns the terminal result');
});
}
