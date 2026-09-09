import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-refined-local-settlement-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'refined-local-settlement\n');

const eventlog = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const bindings = await import('../runtime/harness/host-call-capability-binding.js');
const invocation = await import('../runtime/harness/host-tool-invocation.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const batches = await import('../runtime/harness/accepted-model-batch-checkpoint.js');
const receipts = await import('../runtime/harness/logical-model-result-projection-receipt.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { buildCallTool } = await import('./call-tool.js');
const innerDispatch = await import('./inner-dispatch.js');
const { tool } = await import('@openai/agents');
const { z } = await import('zod');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test.after(() => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

for (const disposition of ['queued', 'disabled']) {
  test(`a ${disposition} workflow response survives argument defaults, settlement and checkpoint reopen`, async (t) => {
    const session = eventlog.createSession({ id: `refined-local-${disposition}`, kind: 'chat' });
    const text = 'Run the daily brief workflow.';
    const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
      type: 'user_input_received', data: { text } });
    const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
    const catalogRevisionDigest = digest('catalog');
    const bindingRevisionDigest = digest('bindings');
    assert.equal(authority.armHostCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
      catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 8, maxParallelCalls: 4 }).status, 'armed');
    const root = authority.acceptedTurnCallAuthorityFor(session.id, source.seq);
    assert.equal(root.status, 'ok');
    if (root.status !== 'ok') throw new Error(root.reason);
    const callId = `workflow-${disposition}`;
    const args = { name: 'workflow_run', args_json: JSON.stringify({ name: 'daily-brief' }) };
    const contract = contracts.durableLogicalCallContract(acceptedTaskId, 'call_tool', args)!;
    const admitted = batches.admitAcceptedModelBatch({ sessionId: session.id, sourceUserSeq: source.seq,
      preHistory: [{ role: 'user', content: text }], frameHistory: [{ type: 'function_call',
        callId, name: 'call_tool', arguments: JSON.stringify(args), status: 'completed' }] });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);
    const attestationBase = {
      sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId,
      sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
      logicalToolCallId: callId, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
      effect: 'local_write' as const, bindingKind: 'local_envelope' as const,
      capabilityId: 'call_tool', schemaFingerprint: digest('schema'), accountId: '',
      invokePortId: `configured-wrapper:${digest('schema')}`, operationId: 'call_tool',
      manifestId: '', manifestDigest: '', engineVersion: root.authority.engineVersion,
      surfaceVersion: root.authority.surfaceVersion, authorityDigest: root.authority.authorityDigest,
      authorityRevision: root.authority.revision, surfaceDigest: root.authority.surfaceDigest,
      catalogRevisionDigest, bindingRevisionDigest,
    };
    const attestation = { ...attestationBase, bindingDigest: bindings.hostCallAttestationBindingDigest(attestationBase) };
    let bodies = 0;
    const response = disposition === 'queued'
      ? 'Queued daily-brief. The result will arrive here.'
      : 'The daily-brief workflow is disabled. Carry out the request directly; do not retry this workflow.';
    innerDispatch._setInnerDispatchToolsForTests(new Map([['workflow_run', tool({
      name: 'workflow_run', description: 'Fixture workflow dispatcher; no background job is created.',
      parameters: z.object({ name: z.string(), inputs: z.string().nullable().optional() }),
      execute: async (input) => {
        bodies += 1;
        assert.equal(input.name, 'daily-brief');
        const binding = bindings.loadHostCallCapabilityBinding({ db: eventlog.openEventLog(),
          sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallId: callId });
        assert.equal(binding.status, 'ok');
        if (binding.status !== 'ok') throw new Error(binding.reason);
        assert.notEqual(binding.binding.effectiveArgumentDigest, contract.argumentDigest,
          'the real call_tool resolver must have materialized defaults, reproducing the live failure');
        return response;
      },
    }) as never]]));
    const carrier = brackets.wrapToolForHarness(buildCallTool({ reachableBuiltinNames: new Set(['workflow_run']) }) as never) as unknown as {
      invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
    };
    const parentLease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:parent` });
    try {
      const invoked = await authority.withHostCallAttestation(attestation, () => brackets.withHarnessRunContext({
        sessionId: session.id, sourceUserSeq: source.seq, turn: 1, counter: new brackets.ToolCallsCounter(20),
        dispatchLease: parentLease,
      }, () => invocation.invokeHostToolCall({
        identity: { sessionId: session.id, sourceUserSeq: source.seq, modelCallId: callId,
          toolName: 'call_tool', args, turn: 1 }, parentLease, effect: 'local_write',
        boundary: 'nested_owned', businessCall: false, deadlineMs: 5_000,
        invoke: ({ signal }) => withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq,
          callId, toolName: 'call_tool' }, async () => {
            const value = await carrier.invoke({ context: { sessionId: session.id } },
              JSON.stringify(args), { toolCall: { callId }, signal });
            if (value !== response) t.diagnostic(`Unexpected carrier result: ${String(value)}`);
            return value;
          }),
      })));
      assert.equal(bodies, 1);
      assert.equal(invoked.value, response);
      const settled = settlements.redeemDurableLogicalCallSettlementForHost({ sessionId: session.id,
        sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId: callId });
      assert.equal(settled.status, 'ok');
      if (settled.status !== 'ok') throw new Error(settled.reason);
      assert.equal(settled.settlement.recovery.mutating, true, 'local effect intent must retain the admitted classification');
      assert.equal(settled.settlement.recovery.businessCall, false);
      assert.equal(settled.settlement.physicalCrossingCount, 0);
      assert.equal(settled.settlement.hostCrossingCount, 1);
      const resultItem = { type: 'function_call_result' as const, callId, name: 'call_tool',
        status: 'completed' as const, output: { type: 'text' as const, text: String(invoked.value) } };
      assert.equal(receipts.recordLogicalModelResultProjectionReceipt({ admission: admitted.admission,
        resultItem }).status, 'recorded');
      const finalized = batches.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
      assert.equal(finalized.status, 'committed', JSON.stringify(finalized));
      eventlog.closeEventLog();
      const reopened = batches.reopenAcceptedModelBatch(admitted.admission);
      assert.equal(reopened.status, 'checkpointed', JSON.stringify(reopened));
      assert.equal(bodies, 1, 'reopening the checkpoint does not repeat the dispatch');
    } finally {
      leases.revokeDispatchLease(parentLease);
      innerDispatch._setInnerDispatchToolsForTests(null);
    }
  });
}
