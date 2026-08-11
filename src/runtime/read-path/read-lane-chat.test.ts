/**
 * Run: npx tsx --test src/runtime/read-path/read-lane-chat.test.ts
 *
 * Focused accepted-source ownership tests for durable pending slot values.
 * Pending acquisition files intentionally outlive their creating turn, so the
 * warm resolver must never treat an old logical-key match as current task
 * context.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-lane-chat-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'read-lane-chat-machine\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  productionScope,
  resolveAcceptedTurnRead,
} = await import('./read-lane-chat.js');
const { promoteFromVerifiedReceipt } = await import('../../memory/procedure-receipts.js');
const { closeProcedureStoreForTests } = await import('../../memory/procedure-store.js');
const { persistPendingCapabilityTurn } = await import('../../memory/pending-capability-turns.js');
type DurableReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;
type AcceptedTurnReadPorts = import('./read-lane-chat.js').AcceptedTurnReadPorts;

test.after(() => {
  closeProcedureStoreForTests();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
});

const SESSION_ID = 'session-pending-slot-owner';
const PROVIDER = 'mailboxco';
const OPERATION = 'search_messages';
const IDENTIFIER = 'MAILBOXCO_SEARCH_MESSAGES';
const SCHEMA_FINGERPRINT = 'fp-mailboxco-search-messages';
const SCOPE = productionScope('person@example.com');

function pendingTurn(acceptedSource: string, query: string) {
  return {
    version: 1 as const,
    acceptedSource,
    scope: { ...SCOPE },
    provider: PROVIDER,
    operation: OPERATION,
    identifier: IDENTIFIER,
    schemaFingerprint: SCHEMA_FINGERPRINT,
    kind: 'composio' as const,
    templateArgs: { query: '{{query}}', limit: 20 },
    missingSlots: ['query'],
    knownSlotValues: { query },
    authorityDigest: `authority-for-${acceptedSource}`,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
}

test('warm active procedure ignores stale pending slots but preserves exact-current-source slots', async () => {
  const promotionReceipt: DurableReceiptRecord = {
    receiptId: 'receipt-seed-search-messages',
    at: '2026-08-08T00:00:00.000Z',
    provider: PROVIDER,
    operation: OPERATION,
    effectClass: 'read',
    identifier: IDENTIFIER,
    schemaFingerprint: SCHEMA_FINGERPRINT,
    scope: { ...SCOPE },
    dispatchOutcome: 'succeeded',
    readEvidenceRef: 'evidence-seed-search-messages',
  };
  const promoted = await promoteFromVerifiedReceipt({
    scope: { ...SCOPE },
    provider: PROVIDER,
    operation: OPERATION,
    effectClass: 'read',
    kind: 'composio',
    identifier: IDENTIFIER,
    templateArgs: { query: '{{query}}', limit: 20 },
    receiptId: promotionReceipt.receiptId,
    acquiredSchemaFingerprint: SCHEMA_FINGERPRINT,
  }, { resolve: (receiptId) => receiptId === promotionReceipt.receiptId ? promotionReceipt : undefined });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));

  const receipts = new Map<string, DurableReceiptRecord>();
  const dispatchedArgs: Array<Record<string, unknown>> = [];
  const ports: AcceptedTurnReadPorts = {
    scope: () => SCOPE,
    liveSchemaFingerprint: () => SCHEMA_FINGERPRINT,
    accountConnected: () => true,
    receipts: { resolve: (receiptId) => receipts.get(receiptId) },
    async dispatch(bound) {
      dispatchedArgs.push(bound.args);
      const receipt: DurableReceiptRecord = {
        receiptId: `receipt-dispatch-${dispatchedArgs.length}`,
        at: '2026-08-08T00:00:01.000Z',
        provider: bound.provider,
        operation: bound.operation,
        effectClass: 'read',
        identifier: bound.identifier,
        schemaFingerprint: bound.schemaFingerprint,
        scope: {
          tenant: bound.tenant,
          workspace: bound.workspace,
          accountIdentity: bound.accountIdentity,
        },
        dispatchOutcome: 'succeeded',
        readEvidenceRef: `evidence-dispatch-${dispatchedArgs.length}`,
      };
      receipts.set(receipt.receiptId, receipt);
      return { receiptId: receipt.receiptId };
    },
    async present() {
      return { draft: 'One matching message.' };
    },
    clock: () => 0,
  };

  // Logical-key lookup finds this file, but it belongs to an earlier accepted
  // request. The active artifact must remain unbound instead of searching for
  // the old private query.
  persistPendingCapabilityTurn(pendingTurn(`${SESSION_ID}:1`, 'stale-private-query'));
  const stale = await resolveAcceptedTurnRead({
    sessionId: SESSION_ID,
    seq: '2',
    message: 'mailboxco search messages',
  }, ports);
  assert.equal(stale.kind, 'declined');
  if (stale.kind === 'declined') assert.match(stale.reason, /needs_slots/);
  assert.deepEqual(dispatchedArgs, [], 'a later request inherited and dispatched stale pending slot values');

  // A physical retry of the same accepted source may reuse values extracted
  // under that source; the subtraction is ownership-based, not a blanket
  // removal of valid current-turn slots.
  persistPendingCapabilityTurn(pendingTurn(`${SESSION_ID}:2`, 'current-turn-query'));
  const current = await resolveAcceptedTurnRead({
    sessionId: SESSION_ID,
    seq: '2',
    message: 'mailboxco search messages',
  }, ports);
  assert.equal(current.kind, 'served', JSON.stringify(current));
  assert.deepEqual(dispatchedArgs, [{ query: 'current-turn-query', limit: 20 }]);
});
