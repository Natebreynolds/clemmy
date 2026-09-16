/**
 * Run: npx tsx --test src/tools/work-call.foreground-compute.test.ts
 *
 * A graphless foreground shell command classifies as `compute`, and the host
 * mints a `local_envelope` attestation with that effect. The work_call
 * authority check must admit the same envelope it was handed: a local
 * envelope covers non-mutating local work, read or compute. Effect and tool
 * mismatches still refuse.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-foreground-compute-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('../runtime/harness/eventlog.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const { graphlessForegroundReadAuthority } = await import('./work-call.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function acceptedSource(text: string) {
  const session = eventlog.createSession({ id: `foreground-compute-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** Arm the production host and run `work` under the exact local envelope the
 * host mints for a shell compute call: admitted logical call + durable binding. */
function underShellComputeEnvelope<T>(
  task: ReturnType<typeof acceptedSource>,
  logicalToolCallId: string,
  command: string,
  work: () => T,
): T {
  const armed = authority.armHostCallAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    catalogRevisionDigest: digest(`catalog:${task.sessionId}`),
    bindingRevisionDigest: digest(`bindings:${task.sessionId}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') throw new Error(JSON.stringify(armed));
  const tool = 'run_shell_command';
  const args = { command };
  const contract = contracts.durableLogicalCallContract(task.acceptedTaskId, tool, args);
  assert.ok(contract);
  if (!contract) throw new Error('no logical contract');
  const schemaFingerprint = digest(`schema:${tool}`);
  const base = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: armed.authority.sourceEventId,
    sourceEventDigest: armed.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'compute' as const,
    bindingKind: 'local_envelope' as const,
    capabilityId: tool,
    schemaFingerprint,
    accountId: '',
    invokePortId: `configured-wrapper:${schemaFingerprint}`,
    operationId: tool,
    manifestId: '',
    manifestDigest: '',
    engineVersion: armed.authority.engineVersion,
    surfaceVersion: armed.authority.surfaceVersion,
    authorityDigest: armed.authority.authorityDigest,
    authorityRevision: armed.authority.revision,
    surfaceDigest: armed.authority.surfaceDigest,
    catalogRevisionDigest: armed.authority.catalogRevisionDigest!,
    bindingRevisionDigest: armed.authority.bindingRevisionDigest!,
  };
  const attestation: import('../runtime/harness/accepted-turn-call-authority.js').HostCallAttestation = {
    ...base,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(base),
  };
  return authority.withHostCallAttestation(attestation, () => {
    const admitted = dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId }, tool, args,
    });
    assert.equal(admitted.status, 'inserted', JSON.stringify(admitted));
    const persisted = hostBindings.persistHostCallCapabilityBinding({
      db: eventlog.openEventLog(), attestation,
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId, logicalToolCallId,
      toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect: 'compute',
    });
    assert.equal(persisted.status, 'bound', JSON.stringify(persisted));
    return work();
  });
}

test('a graphless foreground shell compute call is admitted under its own local envelope', () => {
  const task = acceptedSource('List the current records with the local CLI.');
  const result = underShellComputeEnvelope(task, 'shell-compute-1', 'some-cli data list --json', () => (
    graphlessForegroundReadAuthority({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'shell-compute-1',
      operationId: 'run_shell_command',
      effect: 'compute',
    })
  ));
  assert.deepEqual(result, { ok: true });
});

test('the compute envelope does not admit a different effect or a different tool', () => {
  const task = acceptedSource('List the current records with the local CLI.');
  underShellComputeEnvelope(task, 'shell-compute-2', 'some-cli data list --json', () => {
    const wrongEffect = graphlessForegroundReadAuthority({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'shell-compute-2',
      operationId: 'run_shell_command',
      effect: 'read',
    });
    assert.equal(wrongEffect.ok, false);
    if (!wrongEffect.ok) assert.match(wrongEffect.reason, /foreground read lacks its exact current host attestation/);
    const wrongTool = graphlessForegroundReadAuthority({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'shell-compute-2',
      operationId: 'session_history',
      effect: 'compute',
    });
    assert.equal(wrongTool.ok, false);
    if (!wrongTool.ok) assert.match(wrongTool.reason, /foreground read lacks its exact current host attestation/);
  });
  // Outside the envelope there is no attestation at all.
  const bare = graphlessForegroundReadAuthority({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: 'shell-compute-2',
    operationId: 'run_shell_command',
    effect: 'compute',
  });
  assert.equal(bare.ok, false);
});
