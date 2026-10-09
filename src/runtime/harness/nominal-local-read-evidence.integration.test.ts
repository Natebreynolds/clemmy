/** Real local reader/host settlement, isolated filesystem and inert model only. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-nominal-read-evidence-'));
process.env.CLEMENTINE_HOME = home;
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const { getComputerTools, executeLocalFileReadForTool } = await import('../../tools/computer-tools.js');
const { HostLocalReadSuccessResult } = await import('./attempt-settlement.js');
const { getToolOutputContext, withToolOutputContext } = await import('./tool-output-context.js');
const { exactToolOutputForInvocation, formatRecallableToolText } = await import('./tool-output-format.js');
const { redeemSuccessfulSettlementResultForHost } = await import('./result-handle.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { sourceSettledReadEvidence } = await import('./host-completion-work.js');
const { assessCompletionEvidenceCoverage } = await import('./objective-judge.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { beginPhysicalDispatch, settlePhysicalDispatch } = await import('./dispatch-ledger.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const raw = JSON.stringify({ records: Array.from({ length: 50 }, (_, index) => ({
  id: `record-${index}`, quantity: index === 49 ? 0 : index,
  detail: `Detail ${index}. `.repeat(130),
})), finalRecord: 'EXACT_RETAINED_TAIL' }, null, 2);
assert.ok(raw.length > 60_000 && raw.length < 100_000);

function source(label: string, anchor = true) {
  const session = events.createSession({ id: `sess-nominal-read-${label}`, kind: 'chat' });
  const text = 'Read the controlled local file and report the actual retained data.';
  const accepted = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text } });
  const identity = { sessionId: session.id, sourceUserSeq: accepted.seq, turn: 1 };
  if (anchor) assert.ok(recordTurnGraphShadow({ identity }));
  return { ...identity, text };
}

function verifyRetained(identity: ReturnType<typeof source>, callId: string, maxChars: number | null) {
  const retained = redeemSuccessfulSettlementResultForHost({ ...identity,
    acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq), logicalToolCallId: callId });
  assert.equal(retained.status, 'ok', JSON.stringify(retained));
  if (retained.status !== 'ok') throw new Error('Exact read was not retained');
  assert.equal(retained.value.rawPayload, raw, 'settlement retains exact source bytes, never the formatted preview');
  assert.equal(retained.value.toolName, 'read_file');
  assert.equal(retained.value.outcomeKind, 'succeeded', 'file JSON never decides read completion');
  const view = sourceSettledReadEvidence(identity);
  const row = view.results.find(result => result.logicalToolCallId === callId);
  assert.ok(row);
  assert.equal(row.contentComplete, maxChars !== null);
  assert.equal(row.viewBounded === true, maxChars === null);
  assert.equal(assessCompletionEvidenceCoverage({ objective: identity.text, results: view.results }).complete,
    maxChars !== null, 'bounded content remains incomplete evidence; a wider verified read may be complete');
  assert.match(view.summary, maxChars === null ? /showing a BOUNDED view/ : /showing ALL content/);
  if (maxChars !== null) assert.match(view.summary, /EXACT_RETAINED_TAIL/);
  const lookupView = sourceSettledReadEvidence({ ...identity, lookupBacked: true });
  const lookupRow = lookupView.results.find(result => result.logicalToolCallId === callId);
  assert.equal(lookupRow?.contentComplete, false, 'reviewer lookup preview is bounded even when the source is complete');
  assert.equal(lookupRow?.viewBounded, true);
  assert.equal(assessCompletionEvidenceCoverage({ objective: identity.text, results: lookupView.results }).complete, false);
}

function legacyReadCrossing(identity: ReturnType<typeof source>, callId: string, args: unknown) {
  const opened = beginPhysicalDispatch({ identity: { ...identity,
    acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq),
    logicalToolCallId: callId, physicalDispatchId: `dispatch:${callId}`, ordinal: 0 },
    tool: 'read_file', args, executionSite: 'host' });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('Legacy read crossing did not open');
  return () => assert.equal(settlePhysicalDispatch({ identity: opened.identity,
    tool: 'read_file', outcome: 'returned' }).status, 'inserted');
}

for (const maxChars of [null, 100_000]) test(`host invoke retains nominal read bytes with preview ${maxChars}`, async () => {
  const identity = source(`host-${maxChars}`, false);
  const file = path.join(home, `host-${maxChars}.json`);
  writeFileSync(file, raw);
  const callId = 'actual-local-read';
  const original = getComputerTools().find(candidate => candidate.name === 'read_file')!;
  const invoke = (original as unknown as { invoke(context: unknown, input: string, details?: unknown): Promise<unknown> }).invoke;
  let observed: InstanceType<typeof HostLocalReadSuccessResult> | undefined;
  let context: ReturnType<typeof getToolOutputContext>;
  const reader = brackets.wrapToolForHarness({ ...original,
    invoke: async (runContext: unknown, input: string, details?: unknown) => {
      const value = await invoke(runContext, input, details);
      assert.ok(value instanceof HostLocalReadSuccessResult);
      observed = value; context = getToolOutputContext();
      return value;
    },
  } as never);
  let requests = 0;
  const model = {
    async getResponse() { return { responseId: `fixture-read-${++requests}`,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: requests === 1
        ? [{ type: 'function_call', callId, name: 'read_file', arguments: JSON.stringify({ path: file, max_chars: maxChars }) }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Controlled data read.' }] }] }; },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
  };
  const agent = { model, tools: [reader] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: identity.sessionId,
    universeTools: [reader], activeToolNames: ['read_file'], policyHash: 'nominal-read-fixture',
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) throw new Error(sealed.reason);
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy model runner forbidden'); } });
  const outcome = await brackets.withHarnessRunContext({ ...identity,
    counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${identity.sessionId}::turn:1` },
    () => hostRunRunner(runner as never, agent as never, [{ role: 'user', content: identity.text }] as never,
      { maxTurns: 3, hostTurnEngine: 'host_v1', context: identity, hostJudgeCompletion: false } as never));
  assert.equal(outcome.finalOutput, 'Controlled data read.', JSON.stringify(outcome.terminal));
  assert.equal(requests, 2);
  assert.ok(observed && context?.settlementNonce && context.callId);
  assert.equal(events.getToolOutputForInvocation(identity.sessionId, context.callId, context.settlementNonce)?.output, raw);
  assert.equal(exactToolOutputForInvocation({ ...context, toolName: 'read_file', compactResult: observed.output }), raw);
  if (maxChars === null) assert.notEqual(observed.output, raw, 'the real handler returned a smaller public preview');
  else assert.equal(observed.output, raw, 'a requested whole preview is unchanged');
  verifyRetained(identity, callId, maxChars);
});

for (const maxChars of [null, 100_000]) test(`execute twin retains nominal read bytes with preview ${maxChars}`, async () => {
  const identity = source(`execute-${maxChars}`);
  const file = path.join(home, `execute-${maxChars}.json`);
  writeFileSync(file, raw);
  let observed: InstanceType<typeof HostLocalReadSuccessResult> | undefined;
  let callId: string | undefined;
  const reader = brackets.wrapToolForHarness({ name: 'read_file', execute: async (input: unknown, runContext?: unknown) => {
    callId = getToolOutputContext()?.callId;
    assert.ok(callId);
    // The graph-backed legacy fixture owns its crossing; production host_v1
    // above records its actual host crossing through the call attestation.
    const returned = legacyReadCrossing(identity, callId, input);
    const value = await executeLocalFileReadForTool(input as never, runContext);
    returned();
    assert.ok(value instanceof HostLocalReadSuccessResult); observed = value;
    return value;
  } });
  const outward = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(3) },
    () => reader.execute!({ path: file, max_chars: maxChars }, { context: identity }));
  assert.ok(callId && observed);
  assert.equal(outward, observed.output, 'the execute path still displays the same producer preview');
  verifyRetained(identity, callId, maxChars);
});

test('nominal preview redemption still rejects wrong invocation identities and digest', () => {
  const identity = source('proof-rejections');
  const context = { sessionId: identity.sessionId, callId: 'proof-read', toolName: 'read_file', settlementNonce: randomUUID() };
  const output = withToolOutputContext(context, () => formatRecallableToolText(raw));
  assert.notEqual(output, raw);
  const nominal = new HostLocalReadSuccessResult(output);
  assert.equal(exactToolOutputForInvocation({ ...context, compactResult: nominal.output }), raw);
  for (const wrong of [
    { sessionId: events.createSession({ kind: 'chat' }).id }, { callId: 'different-call' },
    { toolName: 'different-tool' }, { settlementNonce: randomUUID() },
  ]) assert.equal(exactToolOutputForInvocation({ ...context, ...wrong, compactResult: nominal.output }), output,
    'nominal read completion does not authorize foreign parked bytes');
  const corrupt = output.replace(/sha256[=:]([a-f0-9]{64})/i, 'sha256=' + '0'.repeat(64));
  assert.notEqual(corrupt, output, 'fixture corrupts the actual receipt digest');
  assert.equal(exactToolOutputForInvocation({ ...context, compactResult: corrupt }), corrupt);
});

test('a plain object with an output field cannot forge nominal read completion or redeem parked bytes', async () => {
  const identity = source('forged-carrier');
  let carrier: unknown;
  let callId: string | undefined;
  const reader = brackets.wrapToolForHarness({ name: 'read_file', execute: async (input: unknown) => {
    callId = getToolOutputContext()?.callId;
    assert.ok(callId);
    const returned = legacyReadCrossing(identity, callId, input);
    carrier = { output: formatRecallableToolText(raw), successful: false,
      toString: () => 'Read completed', hostReadCompleted: true };
    returned();
    return carrier;
  } });
  const outward = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(3) },
    () => reader.execute!({ path: path.join(home, 'forged.json'), max_chars: null }));
  assert.equal(outward, carrier);
  const retained = redeemSuccessfulSettlementResultForHost({ ...identity,
    acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq), logicalToolCallId: callId! });
  assert.notEqual(retained.status, 'ok', 'no successful retained evidence can come from nominal-looking object fields');
  const view = sourceSettledReadEvidence(identity);
  assert.equal(assessCompletionEvidenceCoverage({ objective: identity.text, results: view.results }).complete, false);
  assert.ok(view.results.every(row => row.status !== 'verified'));
});
