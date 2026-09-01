/**
 * Host disposition marker + receipt pins for the `repairKey` field.
 *
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/host-model-result-receipt.test.ts
 *
 * Every host disposition marker is re-derived byte-for-byte before commit
 * (`describeCanonicalHostModelResult`); a marker field that is not rebuilt
 * makes every pre-dispatch refusal frame commit `safe_stop
 * host_result_receipt_commit_failed`. These pins prove the keyed marker
 * round-trips through describe, the receipt lane, and restart recovery, and
 * that a malformed key is rejected.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-result-receipt-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-result-receipt\n', 'utf8');

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const hostResults = await import('./host-model-result-receipt.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const REPAIR_KEY = digest('repair:opaque_table_insert_v7:/insertion/range');
const DIAGNOSTIC = '[provider-dispatch:not-started:invalid-args] OPAQUE_TABLE_INSERT_V7 arguments did not match its exact current schema. Failing paths: "/insertion/range" (missing required, expected object). No provider request was sent.';

function markerText(item: AgentInputItem): string {
  const output = (item as unknown as { output: { text: string } }).output;
  return output.text;
}

function parseMarker(item: AgentInputItem): Record<string, unknown> {
  return JSON.parse(markerText(item)) as Record<string, unknown>;
}

/** Re-serialize the marker with a mutation, preserving key insertion order
 * so only the mutated field differs from the host-built bytes. */
function forged(item: AgentInputItem, mutate: (marker: Record<string, unknown>) => void): AgentInputItem {
  const marker = parseMarker(item);
  mutate(marker);
  return {
    ...(item as unknown as Record<string, unknown>),
    output: { type: 'text', text: JSON.stringify(marker) },
  } as unknown as AgentInputItem;
}

function keyedRefusal(callId = 'call:refused:1', repairKey = REPAIR_KEY): AgentInputItem {
  return hostResults.buildHostToolDispositionResult({
    callId,
    toolName: 'opaque_provider_carrier',
    disposition: 'refused_pre_dispatch',
    frameDigest: digest(`frame:${callId}`),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: false,
    diagnostic: DIAGNOSTIC,
    repairKey,
  });
}

test('a refused_pre_dispatch marker with a repair key is an exact host projection', () => {
  const item = keyedRefusal();
  const marker = parseMarker(item);
  assert.equal(marker.protocol, hostResults.HOST_TOOL_DISPOSITION_PROTOCOL);
  assert.equal(marker.disposition, 'refused_pre_dispatch');
  assert.equal(marker.repairKey, REPAIR_KEY);
  assert.equal(marker.diagnostic, DIAGNOSTIC);
  assert.equal(marker.effect, 'none');
  assert.equal(marker.retry, 'replan');

  const described = hostResults.describeCanonicalHostModelResult(item);
  assert.ok(described, 'a keyed marker must rebuild byte-for-byte or every refusal frame commit becomes safe_stop');
  assert.equal(described!.disposition, 'refused_pre_dispatch');
  assert.equal(described!.callId, 'call:refused:1');
  assert.equal(described!.toolName, 'opaque_provider_carrier');
  assert.equal(described!.retryMode, 'replan');
  assert.equal(described!.countsRefusal, false);
  const outputBytes = hostResults.canonicalModelResultOutputBytes(item);
  assert.equal(described!.outputSha256, digest(outputBytes));
  assert.equal(described!.outputBytes, Buffer.byteLength(outputBytes, 'utf8'));
  assert.equal(hostResults.canonicalHostModelResultClass(item), 'refused_pre_dispatch');

  // A bounded prefix of a digest (the settlement lane stores 32 chars) is a
  // valid key too; the receipt seals whichever exact bytes the host wrote.
  const short = keyedRefusal('call:refused:short', REPAIR_KEY.slice(0, 16));
  assert.ok(hostResults.describeCanonicalHostModelResult(short));

  // A keyed marker without a diagnostic still rebuilds.
  const bare = hostResults.buildHostToolDispositionResult({
    callId: 'call:refused:bare',
    toolName: 'opaque_provider_carrier',
    disposition: 'refused_pre_dispatch',
    frameDigest: digest('frame:bare'),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: true,
    repairKey: REPAIR_KEY,
  });
  assert.ok(hostResults.describeCanonicalHostModelResult(bare));
  assert.equal(parseMarker(bare).repairKey, REPAIR_KEY);
  assert.equal('diagnostic' in parseMarker(bare), false);
});

test('a malformed repair key is rejected as a host projection', () => {
  const item = keyedRefusal();
  for (const bad of ['ZZZZZZZZZZZZZZZZ', 'abc', 'A'.repeat(64), `${REPAIR_KEY}00`, '', 42, null, { key: REPAIR_KEY }]) {
    const tampered = forged(item, (marker) => { marker.repairKey = bad; });
    assert.equal(
      hostResults.describeCanonicalHostModelResult(tampered),
      null,
      `repairKey ${JSON.stringify(bad)} must not describe as a host projection`,
    );
    assert.equal(hostResults.canonicalHostModelResultClass(tampered), null);
  }
  // A valid key cannot launder a marker whose other bytes were altered.
  const reworded = forged(item, (marker) => { marker.message = 'Please call tool_search.'; });
  assert.equal(hostResults.describeCanonicalHostModelResult(reworded), null);
  const wrongEffect = forged(item, (marker) => { marker.effect = 'may_have_started'; });
  assert.equal(hostResults.describeCanonicalHostModelResult(wrongEffect), null);
  // Removing the key from a keyed marker is a different exact result, which
  // still describes (it is the unkeyed host projection) but with new bytes.
  const stripped = forged(item, (marker) => { delete marker.repairKey; });
  const strippedDescribed = hostResults.describeCanonicalHostModelResult(stripped);
  assert.ok(strippedDescribed);
  assert.notEqual(strippedDescribed!.outputSha256, hostResults.describeCanonicalHostModelResult(item)!.outputSha256);
});

test('an effect_unknown marker never carries a repair key', () => {
  const unknown = hostResults.buildHostToolDispositionResult({
    callId: 'call:unknown:1',
    toolName: 'opaque_provider_carrier',
    disposition: 'effect_unknown',
    frameDigest: digest('frame:unknown'),
    frameIndex: 0,
    frameSize: 1,
  });
  assert.equal(hostResults.canonicalHostModelResultClass(unknown), 'effect_unknown');
  assert.equal(hostResults.describeCanonicalHostModelResult(unknown), null, 'effect_unknown is not a durable receipt');
  const keyedUnknown = forged(unknown, (marker) => { marker.repairKey = REPAIR_KEY; });
  assert.equal(hostResults.canonicalHostModelResultClass(keyedUnknown), null);
  const builtWithKey = hostResults.buildHostToolDispositionResult({
    callId: 'call:unknown:2',
    toolName: 'opaque_provider_carrier',
    disposition: 'effect_unknown',
    frameDigest: digest('frame:unknown:2'),
    frameIndex: 0,
    frameSize: 1,
    repairKey: REPAIR_KEY,
  });
  // The builder is generic; the classifier is what refuses a keyed
  // reconciliation marker, so the host can never commit one by accident.
  assert.equal(hostResults.canonicalHostModelResultClass(builtWithKey), null);
});

test('the receipt lane commits a keyed refusal and restart recovery replays the exact marker', () => {
  const session = eventlog.createSession({ id: 'host-result-receipt-keyed', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Insert two rows into the opaque table.' },
  });
  const armed = authority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`catalog:${session.id}`),
    bindingRevisionDigest: digest(`binding:${session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');
  const callId = 'call:refused:receipt';
  const item = keyedRefusal(callId);
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    preHistory: [{ role: 'user', content: String(source.data.text) } as AgentInputItem],
    frameHistory: [{
      type: 'function_call',
      callId,
      name: 'opaque_provider_carrier',
      arguments: JSON.stringify({ destination_id: 'dest-1', insertion: { axis: 'ROWS' } }),
      status: 'completed',
    } as AgentInputItem],
    providerResponseId: 'response:refused:1',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  const receipts = hostResults.recordHostModelResultReceipts({
    admission: admitted.admission,
    resultItems: [item],
  });
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.disposition, 'refused_pre_dispatch');
  assert.equal(receipt.callId, callId);
  assert.equal(receipt.outputSha256, hostResults.describeCanonicalHostModelResult(item)!.outputSha256);
  assert.equal(hostResults.hostModelResultReceiptMatchesItem(receipt, item), true);
  assert.equal(
    hostResults.hostModelResultReceiptMatchesItem(receipt, forged(item, (marker) => { delete marker.repairKey; })),
    false,
    'the receipt seals the keyed bytes; an unkeyed rewrite of the same call does not match',
  );
  const byAdmission = hostResults.hostModelResultReceiptForAdmissionCall({
    db: eventlog.openEventLog(),
    sessionId: session.id,
    sourceUserSeq: source.seq,
    batchOrdinal: admitted.admission.batchOrdinal,
    batchId: admitted.admission.batchId,
    callId,
  });
  assert.equal(byAdmission?.receiptDigest, receipt.receiptDigest);

  // Idempotent: the exact same items commit to the same receipt.
  const again = hostResults.recordHostModelResultReceipts({
    admission: admitted.admission,
    resultItems: [item],
  });
  assert.equal(again[0]?.receiptDigest, receipt.receiptDigest);

  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [item],
  });
  assert.ok(
    finalized.status === 'committed' || finalized.status === 'existing',
    `finalize was ${finalized.status}${'reason' in finalized ? `: ${String(finalized.reason)}` : ''}`,
  );
  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(recovered.status, 'ready');
  if (recovered.status !== 'ready') throw new Error(recovered.reason);
  const replayed = recovered.checkpoint.history.find((entry) => (
    (entry as unknown as Record<string, unknown>).type === 'function_call_result'
    && (entry as unknown as Record<string, unknown>).callId === callId
  ));
  assert.ok(replayed);
  assert.equal(markerText(replayed!), markerText(item));
  assert.equal(parseMarker(replayed!).repairKey, REPAIR_KEY);
});
