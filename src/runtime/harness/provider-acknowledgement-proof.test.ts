import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  ensureProviderAcknowledgementReceiptTable, loadProviderAcknowledgementReceipt,
  proveProviderAcknowledgement, type ProviderAcknowledgementReceipt,
} from './provider-acknowledgement-proof.js';

const hash = (value: unknown) => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');

function receiptFixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE events(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data_json TEXT)');
  ensureProviderAcknowledgementReceiptTable(db);
  const body = {
    version: 1 as const, proofKind: 'provider_acknowledgement_v1' as const,
    kind: 'commit' as const, obligation: 'commit_effect' as const,
    sessionId: 'session:proof', sourceUserSeq: 7, acceptedTaskId: 'task:proof',
    manifestId: 'manifest:v1:proof', nodeId: 'verify/create', workContractId: `expected-work:v1:${'a'.repeat(64)}`,
    logicalToolCallId: 'call:create', physicalDispatchId: 'physical:create', resultHandleId: 'rh_exact',
    rawPayloadSha256: 'b'.repeat(64), rawByteCount: 357,
    sealedBindingDigest: 'c'.repeat(64), hostBindingDigest: 'd'.repeat(64),
    accountId: 'account:chosen', providerManifestDigest: 'e'.repeat(64), argumentDigest: 'f'.repeat(64),
  };
  const receipt: ProviderAcknowledgementReceipt = { ...body, receiptId: `provider-acknowledgement:v1:${hash(body)}` };
  db.prepare('INSERT INTO events VALUES (?,?,?,?)').run('event:receipt', body.sessionId, 'evidence_receipt', JSON.stringify(receipt));
  db.prepare('INSERT INTO host_provider_acknowledgement_receipts_v1 VALUES (?,?,?,?,?,?,?)')
    .run(receipt.receiptId, body.sessionId, body.sourceUserSeq, body.manifestId, body.nodeId, JSON.stringify(receipt), 'event:receipt');
  return { db, receipt };
}

test('acknowledgement receipt persists exact authority identities without claiming artifact fields', () => {
  const { db, receipt } = receiptFixture();
  try {
    assert.deepEqual(loadProviderAcknowledgementReceipt(db, receipt.receiptId), receipt);
    assert.equal('createdId' in receipt, false);
    assert.equal('handle' in receipt, false);
    assert.equal('providerReceipt' in receipt, false);
    // Schema initialization is idempotent and does not migrate artifact rows.
    ensureProviderAcknowledgementReceiptTable(db);
    assert.deepEqual(loadProviderAcknowledgementReceipt(db, receipt.receiptId), receipt);
  } finally { db.close(); }
});

test('receipt metadata, mirror content and source scope are content-addressed', () => {
  for (const field of ['accountId', 'workContractId', 'rawPayloadSha256', 'sourceUserSeq', 'physicalDispatchId']) {
    const { db, receipt } = receiptFixture();
    try {
      db.prepare('UPDATE host_provider_acknowledgement_receipts_v1 SET receipt_json=?')
        .run(JSON.stringify({ ...receipt, [field]: field === 'sourceUserSeq' ? 8 : 'changed' }));
      assert.equal(loadProviderAcknowledgementReceipt(db, receipt.receiptId), null, field);
    } finally { db.close(); }
  }
  for (const query of [
    "UPDATE events SET data_json='{}'",
    "UPDATE events SET session_id='other'",
    "UPDATE events SET type='tool_returned'",
    "UPDATE host_provider_acknowledgement_receipts_v1 SET source_user_seq=8",
  ]) {
    const { db, receipt } = receiptFixture();
    try {
      db.exec(query);
      assert.equal(loadProviderAcknowledgementReceipt(db, receipt.receiptId), null, query);
    } finally { db.close(); }
  }
});

test('a valid stored acknowledgement is not execution authority without an exact host binding', () => {
  const { db, receipt } = receiptFixture();
  try {
    const node = { nodeId: receipt.nodeId, operationId: 'create', resolvedTool: 'example_create',
      effectKind: 'external_write' as const, reversibility: 'unknown' as const, operationMode: 'create' as const,
      writeEvidenceMode: 'provider_acknowledgement_v1' as const,
      obligations: ['commit_effect', 'execution_terminal'] as const };
    const proof = proveProviderAcknowledgement({ db, ...receipt,
      manifest: { identity: { sessionId: receipt.sessionId, sourceUserSeq: receipt.sourceUserSeq }, nodes: [node] } as never,
      node: { ...node, obligations: [...node.obligations] },
      result: { toolName: 'example_create', executionSite: 'provider', physicalDispatchId: receipt.physicalDispatchId,
        resultHandleId: receipt.resultHandleId, rawPayloadSha256: receipt.rawPayloadSha256, rawByteCount: receipt.rawByteCount },
    });
    assert.equal(proof.ok, false);
    if (!proof.ok) assert.match(proof.reason, /host binding/);
  } finally { db.close(); }
});
