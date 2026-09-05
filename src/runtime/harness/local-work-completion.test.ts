/** P3 completion-truth RED: frozen P2 accepted eight declared work items,
 * refused the worker before dispatch, and published the exact partial answer
 * as done because two unrelated preflight reads existed. No live model/tool. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { CAPTURED_ARGUMENTS, PROMPT } from './fixtures/p2-parallel-worker-capture.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-work-truth-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'local-work-truth-fixture\n');
const events = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const results = await import('./host-model-result-receipt.js');
const delivery = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { workerCallItems, workerPacketKey } = await import('../../agents/worker-job-packet.js');
const manifests = await import('./work-manifest.js');
after(() => { events.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

// Verbatim public reply of the captured conversation_completed, seq 85.
const FINAL_REPLY = 'The nonce batch cannot be completed: `run_worker` was refused before dispatch and then marked “unavailable for this request; do not retry.” No worker read occurred, so the eight nonce values are unavailable without inventing them.\n\nVerified preflight:\n- `clemmy` — 3.16.0\n- `@clemmy/desktop` — 3.16.0\n- Versions match.';
const CALL_ID = 'call_tBgF4tuqvCC6jxh3iTwnogOO';
let serial = 0;
function fixture(text = PROMPT, argsJson = CAPTURED_ARGUMENTS, toolName = 'run_worker') {
  const session = events.createSession({ id: `local-work-truth-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const hash = createHash('sha256').update(session.id).digest('hex');
  assert.equal(authority.armHostCallAuthority({ ...identity, catalogRevisionDigest: hash, bindingRevisionDigest: hash, maxLogicalCalls: 20, maxParallelCalls: 8 }).status, 'armed');
  preflight(identity);
  admitRefusal(identity, text, argsJson, toolName);
  return identity;
}

function admitRefusal(identity: { sessionId: string; sourceUserSeq: number; turn: number }, text: string, argsJson = CAPTURED_ARGUMENTS, toolName = 'run_worker') {
  const frame = [{ type: 'function_call', callId: CALL_ID, name: toolName, arguments: argsJson, status: 'completed' }] as AgentInputItem[];
  const admitted = checkpoints.admitAcceptedModelBatch({ ...identity, preHistory: [{ role: 'user', content: text }], frameHistory: frame, providerResponseId: `capture-${serial}` });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  // This is the actual P2 host disposition, including its original frame hash.
  const refusal = results.buildHostToolDispositionResult({ callId: CALL_ID, toolName, disposition: 'refused_pre_dispatch', frameDigest: '1ca0d9f8614bd33a30be36ecabfcc825f7d3f537638fef04cc057e19496ede65', frameIndex: 0, frameSize: 1, countsRefusal: true });
  results.recordHostModelResultReceipts({ admission: admitted.admission, resultItems: [refusal] });
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [refusal] });
  assert.equal(finalized.status, 'committed');
}

function preflight(identity: { sessionId: string; sourceUserSeq: number; turn: number }) {
  for (const [index, name] of ['clemmy', '@clemmy/desktop'].entries()) events.appendEvent({
    ...identity, role: 'system', type: 'tool_returned', data: { sourceUserSeq: identity.sourceUserSeq, accounting: 'top_level', tool: 'read_file', callId: `package-${serial}-${index}`, successfulBusinessResult: true, effect: 'read', result: { name, version: '3.16.0' } },
  });
}

function publish(identity: { sessionId: string; sourceUserSeq: number; turn: number }, text = FINAL_REPLY) {
  return delivery.commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false, presentation: { kind: 'answer', text } }, {
    terminalJudgeDisposition: 'deliver', // A judge's prose cannot erase item demand.
  });
}

test('captured P2 preflight plus zero worker receipts cannot publish eight-item task done', () => {
  const identity = fixture();
  const committed = publish(identity);
  assert.equal(committed.presentation.status, 'blocked');
  assert.equal(committed.presentation.resumable, true);
  assert.equal(committed.presentation.text, FINAL_REPLY, 'keep the honest partial report byte-for-byte');
  assert.notEqual(committed.event.data.reason, 'success');
  assert.ok(JSON.stringify(committed.event.data.verificationMissing).includes('audit-8'));
});

test('the production host completion and public boundary preserve the captured partial without certifying it done', async () => {
  const { hostRunRunner } = await import('./host-turn-runner.js');
  const brackets = await import('./brackets.js');
  const envelopes = await import('../../agents/capability-envelope.js');
  const catalogs = await import('./host-capability-catalog-factory.js');
  const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  try {
    const session = events.createSession({ id: `host-local-work-${++serial}`, kind: 'chat' });
    const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: PROMPT } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
    let modelCalls = 0;
    const model = {
      async getResponse() {
        modelCalls += 1;
        // Reconstruct the saved P2 admission under the real host's already
        // armed root. The host owns every acceptance/receipt API; only the
        // provider reply is mocked. There is no worker body or invented nonce.
        preflight(identity);
        admitRefusal(identity, PROMPT);
        return { responseId: `host-completion-${serial}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FINAL_REPLY }] }] };
      },
      async *getStreamedResponse() {
        const response = await this.getResponse();
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const agent = { model, tools: [] };
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [], activeToolNames: [], policyHash: 'local-completion-truth', budget: { maxUncachedTokens: 10_000, maxModelCalls: 2, maxToolCalls: 20, maxElapsedMs: 60_000 } });
    assert.ok(sealed.ok);
    if (!sealed.ok) return;
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not run'); } });
    const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: PROMPT }] as never, { maxTurns: 2, hostTurnEngine: 'host_v1', context: identity } as never));
    assert.equal(outcome.terminal?.status, 'blocked');
    assert.equal(outcome.terminal?.reason, 'local_work_incomplete');
    assert.equal(outcome.finalOutput, FINAL_REPLY);
    assert.equal(modelCalls, 1, 'ledger truth needs no extra model round trip');
    const committed = delivery.commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'blocked', resumable: true, presentation: { kind: 'blocked', text: String(outcome.finalOutput) } });
    assert.equal(committed.presentation.text, FINAL_REPLY);
    assert.equal(committed.presentation.status, 'blocked');
    assert.equal(committed.presentation.resumable, true);
  } finally {
    catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  }
});

test('an unrelated later successful read cannot discharge the accepted item demand', () => {
  const identity = fixture();
  preflight(identity);
  assert.equal(publish(identity).presentation.status, 'blocked');
});

test('all exact worker packet receipts complete, but a partial set does not', () => {
  for (const count of [7, 8]) {
    const identity = fixture();
    const packet = JSON.parse(CAPTURED_ARGUMENTS);
    const items = workerCallItems(packet)!;
    for (const item of items.slice(0, count)) events.appendEvent({ ...identity, role: 'system', type: 'worker_result', data: { item, ok: true, packetKey: workerPacketKey({ ...packet, item }), toolCallId: CALL_ID } });
    assert.equal(publish(identity, `${count} of eight exact worker results are available.`).presentation.status, count === 8 ? 'done' : 'blocked');
  }
});

test('alternate inline execution discharges canonical items through their existing manifest/result receipts', () => {
  const identity = fixture();
  const packet = JSON.parse(CAPTURED_ARGUMENTS);
  const items = workerCallItems(packet)!;
  manifests.declareWorkManifest({
    ...identity, manifestId: packet.workManifest.id, contractVersion: '1',
    phases: [{ id: 'read_nonce' }], items: items.map((id) => ({ id })),
  });
  for (const item of items) {
    const returned = events.appendEvent({
      ...identity, role: 'system', type: 'tool_returned', data: {
        sourceUserSeq: identity.sourceUserSeq, accounting: 'top_level',
        successfulBusinessResult: true, tool: 'read_file', callId: `inline-${item}`,
        effect: 'read', result: `ITEM=${item} NONCE=inline-${item}`,
      },
    });
    manifests.checkpointWorkItem({
      sessionId: identity.sessionId, manifestId: packet.workManifest.id, contractVersion: '1',
      phase: 'read_nonce', itemId: item, status: 'succeeded',
      evidence: [{ kind: 'tool_result', ref: `event:${returned.seq}` }],
    });
  }
  assert.equal(events.listEvents(identity.sessionId, { types: ['worker_result'] }).length, 0);
  assert.equal(publish(identity, 'All eight item results are available from the inline repair.').presentation.status, 'done');
});

test('manifest checkpoints with invented result refs cannot complete declared work', () => {
  const identity = fixture();
  const packet = JSON.parse(CAPTURED_ARGUMENTS);
  const items = workerCallItems(packet)!;
  manifests.declareWorkManifest({
    ...identity, manifestId: packet.workManifest.id, contractVersion: '1',
    phases: [{ id: 'read_nonce' }], items: items.map((id) => ({ id })),
  });
  for (const item of items) manifests.checkpointWorkItem({
    sessionId: identity.sessionId, manifestId: packet.workManifest.id, contractVersion: '1',
    phase: 'read_nonce', itemId: item, status: 'succeeded',
    evidence: [{ kind: 'tool_result', ref: 'invented-call' }],
  });
  assert.equal(publish(identity).presentation.status, 'blocked');
});

test('a new accepted source does not inherit a prior declared worker demand', () => {
  const prior = fixture();
  const source = events.appendEvent({ sessionId: prior.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Forget the nonce batch. Just tell me whether those package versions match.' } });
  const identity = { sessionId: prior.sessionId, turn: 2, sourceUserSeq: source.seq };
  assert.equal(publish(identity, 'Yes, both versions are 3.16.0.').presentation.status, 'done');
});

test('a refused discovery call does not turn an informational unavailable answer into unmet work', () => {
  const identity = fixture('Is the optional search connector available?', JSON.stringify({ query: 'optional connector availability' }), 'tool_search');
  assert.equal(publish(identity, 'That optional connector is unavailable here.').presentation.status, 'done');
});

test('a failed read followed by successful alternative remains completable', () => {
  const identity = fixture('Read the package version.', JSON.stringify({ path: '/missing/package.json' }), 'read_file');
  preflight(identity);
  assert.equal(publish(identity, 'Both package versions are 3.16.0.').presentation.status, 'done');
});

for (const variant of ['recover', 'worker_down'] as const) test(`the host completion consumer continues only the missing captured item (${variant})`, async () => {
  const { hostRunRunner } = await import('./host-turn-runner.js');
  const brackets = await import('./brackets.js');
  const envelopes = await import('../../agents/capability-envelope.js');
  const catalogs = await import('./host-capability-catalog-factory.js');
  const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  try {
    const session = events.createSession({ id: `host-local-continue-${variant}-${++serial}`, kind: 'chat' });
    const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: PROMPT } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
    const packet = JSON.parse(CAPTURED_ARGUMENTS);
    let calls = 0;
    const model = {
      async getResponse(request: unknown) {
        calls += 1;
        brackets.harnessRunContextStorage.getStore()!.counter.increment();
        if (calls === 1) {
          admitRefusal(identity, PROMPT);
          for (const item of workerCallItems(packet)!.slice(0, 7)) events.appendEvent({
            ...identity, role: 'system', type: 'worker_result',
            data: { sourceUserSeq: source.seq, item, ok: true, packetKey: workerPacketKey({ ...packet, item }), toolCallId: CALL_ID },
          });
        } else {
          assert.match(JSON.stringify(request), /Remaining accepted local items/);
          assert.match(JSON.stringify(request), /audit-8/);
          assert.equal(events.listEvents(session.id, { types: ['worker_result'] }).filter((event) => event.data.ok === true).length, 7);
          if (variant === 'recover') events.appendEvent({
            ...identity, role: 'system', type: 'worker_result',
            data: { sourceUserSeq: source.seq, item: 'audit-8', ok: true, packetKey: workerPacketKey({ ...packet, item: 'audit-8' }), toolCallId: 'repair-audit-8' },
          });
        }
        return { responseId: `local-continue-${serial}-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: calls > 1 && variant === 'recover' ? 'All eight worker results are available.' : 'Seven results are retained; audit-8 still needs its read.' }] }] };
      },
      async *getStreamedResponse(request: unknown) {
        const response = await this.getResponse(request);
        yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const agent = { model, tools: [] };
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [], activeToolNames: [], policyHash: 'local-continuation', budget: { maxUncachedTokens: 10_000, maxModelCalls: 4, maxToolCalls: 20, maxElapsedMs: 60_000 } });
    assert.ok(sealed.ok);
    if (!sealed.ok) return;
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not run'); } });
    const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: PROMPT }] as never, { maxTurns: 4, hostTurnEngine: 'host_v1', context: identity } as never));
    assert.equal(calls, 2, 'one same-loop repair is attempted; unchanged missing items cannot spin');
    assert.equal(outcome.terminal?.status, variant === 'recover' ? undefined : 'blocked');
    if (variant === 'worker_down') assert.equal(outcome.blockedDetail, 'no_progress');
    const committed = delivery.commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false, presentation: { kind: 'answer', text: String(outcome.finalOutput) } }, { terminalJudgeDisposition: 'deliver' });
    assert.equal(committed.presentation.status, variant === 'recover' ? 'done' : 'blocked', JSON.stringify(committed));
    assert.equal(events.listEvents(session.id, { types: ['user_input_received'] }).length, 1, 'the same accepted source owns the entire repair');
    const resumes = events.listEvents(session.id, { types: ['guardrail_tripped'] }).filter((event) => event.data.kind === 'local_work_continuation');
    assert.equal(resumes.length, 1);
    assert.deepEqual(resumes[0]!.data.missing, [`${packet.workManifest.id}/${packet.workManifest.phase}/audit-8`]);
    if (variant === 'worker_down') {
      const { pendingAcceptedLocalWork, pendingLocalWorkContinuation } = await import('./local-work-completion.js');
      const pending = pendingAcceptedLocalWork(identity)!;
      assert.deepEqual(pendingLocalWorkContinuation({ ...identity, pending, autoContinueOnLimit: true, toolCalls: 100 }),
        { resume: false, reason: 'no_progress' }, 'a fresh caller cannot reset the source-owned missing-item checkpoint');
    }
  } finally {
    catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  }
});

test('local continuation preserves preset and cap guards and only new item receipts count as progress', async () => {
  const { pendingAcceptedLocalWork, pendingLocalWorkContinuation } = await import('./local-work-completion.js');
  const identity = fixture();
  const pending = pendingAcceptedLocalWork(identity)!;
  const base = { ...identity, pending, autoContinueOnLimit: true, toolCalls: 1 };
  assert.deepEqual(pendingLocalWorkContinuation({ ...base, autoContinueOnLimit: false }), { resume: false, reason: 'preset_asks' });
  assert.deepEqual(pendingLocalWorkContinuation({ ...base, toolCalls: 0 }), { resume: false, reason: 'no_progress' });
  events.appendEvent({ ...identity, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'local_work_continuation', sourceUserSeq: identity.sourceUserSeq, missing: pending.missing, attempt: 1,
  } });
  assert.deepEqual(pendingLocalWorkContinuation(base), { resume: false, reason: 'no_progress' });
  const packet = JSON.parse(CAPTURED_ARGUMENTS);
  events.appendEvent({ ...identity, role: 'system', type: 'worker_result', data: {
    sourceUserSeq: identity.sourceUserSeq, item: 'audit-1', ok: true, packetKey: workerPacketKey({ ...packet, item: 'audit-1' }),
  } });
  const advanced = { ...base, pending: pendingAcceptedLocalWork(identity)! };
  assert.deepEqual(pendingLocalWorkContinuation(advanced), { resume: true, attempt: 2 });
  const previousCap = process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP;
  process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = '1';
  try {
    assert.deepEqual(pendingLocalWorkContinuation(advanced), { resume: false, reason: 'cap_exhausted' },
      'durably spent continuation cap survives re-entry even after some item progress');
  } finally {
    if (previousCap === undefined) delete process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP;
    else process.env.CLEMMY_CHAT_AUTO_CONTINUE_CAP = previousCap;
  }
});
