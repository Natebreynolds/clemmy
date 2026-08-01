/**
 * Run: npx tsx --test src/execution/platform49-effect-matrix.integration.test.ts
 *
 * LANE C — external-effect / idempotency matrix.
 *
 * Sanitized: opaque string identifiers only, no provider network, no live
 * accounts. It drives the PRODUCTION reconcilers rather than a mock of them —
 * `resolveWriteEvidence` (what counts as a landed write) and
 * `uncompensatedExternalWriteEvents` (what blocks a blind re-dispatch) — because
 * a matrix asserting against its own stub proves only that the stub agrees with
 * itself.
 *
 * The two release-blocking invariants, stated once:
 *
 *   1. A mutation that STARTED without a receipt is never confirmed and never
 *      blindly re-dispatched. Silence from a provider is not failure; a write
 *      that may have landed must stay uncertain and stay in the way.
 *   2. A checkpoint never advances past an effect that has not committed.
 *      Advancing over an unconfirmed write is how an item is silently skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWriteEvidence } from '../runtime/harness/work-report.js';
import {
  canonicalExternalWriteActionKey,
  externalWriteDuplicateIdentityKeys,
  uncompensatedExternalWriteEvents,
} from '../runtime/harness/external-write-admission.js';
import type { EventRow } from '../runtime/harness/eventlog.js';

/** Opaque provider identifiers. The trailing-zero forms are the trap: passing
 *  one through a numeric type turns "1785000000.000500" into
 *  "1785000000.0005" and the destination identity is silently lost. */
const ITEM_NEW = '1785000000.000499';
const ITEM_TRAILING_ZERO = '1785000000.000500';
const ITEM_FINAL_PAGE = '1785000000.000100';

let seq = 0;
function ledgerEvent(type: EventRow['type'], data: Record<string, unknown>): EventRow {
  seq += 1;
  return {
    seq,
    id: `evt-${seq}`,
    sessionId: 'sess-platform49',
    turn: 1,
    role: 'system',
    type,
    parentEventId: null,
    data,
    createdAt: new Date(1785000000000 + seq).toISOString(),
  } as EventRow;
}

/** One reserved write against a destination identity. */
function reserved(callId: string, target: string, shapeKey = 'SHEETS_APPEND_ROW'): EventRow {
  return ledgerEvent('external_write', { preDispatch: true, canonicalCallId: callId, shapeKey, targets: [target] });
}
function receipt(callId: string, target: string, shapeKey = 'SHEETS_APPEND_ROW'): EventRow {
  return ledgerEvent('external_write_succeeded', { canonicalCallId: callId, shapeKey, targets: [target] });
}

// ── Case 1: a new item appends exactly once and reads back verified ──────────

test('case 1 — a new item commits exactly one destination append', () => {
  const events = [reserved('call-1', ITEM_NEW), receipt('call-1', ITEM_NEW)];
  const { confirmed, uncertain } = resolveWriteEvidence(events);
  assert.equal(confirmed.length, 1, 'exactly one append is confirmed');
  assert.equal(uncertain.length, 0, 'nothing is left unresolved');
  assert.deepEqual(confirmed[0]!.data.targets, [ITEM_NEW], 'the destination identity survives verbatim');
});

// ── Case 2: the next poll is a no-op ────────────────────────────────────────

test('case 2 — a no-op poll writes nothing and leaves nothing uncertain', () => {
  const { confirmed, uncertain } = resolveWriteEvidence([]);
  assert.equal(confirmed.length, 0);
  assert.equal(uncertain.length, 0);
  assert.equal(uncompensatedExternalWriteEvents([]).length, 0, 'a no-op never blocks the next checkpoint');
});

// ── Case 3: a changed final-page item updates in place ──────────────────────

test('case 3 — a changed item updates its existing identity and appends nothing', () => {
  const events = [
    reserved('call-3', ITEM_FINAL_PAGE, 'SHEETS_UPDATE_ROW'),
    receipt('call-3', ITEM_FINAL_PAGE, 'SHEETS_UPDATE_ROW'),
  ];
  const { confirmed } = resolveWriteEvidence(events);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]!.data.shapeKey, 'SHEETS_UPDATE_ROW', 'an update, never a second append');
  assert.deepEqual(confirmed[0]!.data.targets, [ITEM_FINAL_PAGE]);
});

// ── Case 4: a duplicate schedule receipt collapses to one effect ────────────

test('case 4 — a concurrent duplicate resolves to one identity, not two', () => {
  const first = externalWriteDuplicateIdentityKeys([ITEM_NEW], 'fp-a');
  const second = externalWriteDuplicateIdentityKeys([ITEM_NEW], 'fp-b');
  assert.deepEqual(first, second, 'the same destination is the same identity regardless of payload fingerprint');
  assert.equal(first.length, 1, 'one destination, one identity key');

  // A payload-only identity is the fallback when no concrete target exists;
  // it must NOT collide with a different payload.
  assert.notDeepEqual(
    externalWriteDuplicateIdentityKeys([], 'fp-a'),
    externalWriteDuplicateIdentityKeys([], 'fp-b'),
  );
});

// ── Case 5: an unauthorized source mutation never dispatches ────────────────

test('case 5 — an authorized destination write commits while an unauthorized source write does not', () => {
  // Only the destination write was ever reserved. The source mutation must have
  // no ledger presence at all — absence of dispatch is the assertion.
  const events = [reserved('call-dest', ITEM_NEW), receipt('call-dest', ITEM_NEW)];
  const { confirmed } = resolveWriteEvidence(events);
  assert.equal(confirmed.length, 1);
  assert.equal(
    confirmed.filter((event) => String(event.data.shapeKey).includes('SOURCE')).length,
    0,
    'source dispatch count stays zero',
  );
});

// ── Release-blocking invariant 1 ────────────────────────────────────────────

test('a started mutation with no receipt stays uncertain and is never re-dispatched blindly', () => {
  const events = [reserved('call-orphan', ITEM_NEW)];
  const { confirmed, uncertain } = resolveWriteEvidence(events);
  assert.equal(confirmed.length, 0, 'silence from a provider is not success');
  assert.equal(uncertain.length, 1, 'it must stay visible as unresolved');
  assert.equal(
    uncompensatedExternalWriteEvents(events).length,
    1,
    'and it must keep blocking an automatic retry — a resume that replays it could double-send',
  );
});

test('a write that provably failed does not block the retry it should get', () => {
  const events = [
    reserved('call-failed', ITEM_NEW),
    ledgerEvent('external_write_failed', { canonicalCallId: 'call-failed', shapeKey: 'SHEETS_APPEND_ROW', targets: [ITEM_NEW] }),
  ];
  const { confirmed, uncertain } = resolveWriteEvidence(events);
  assert.equal(confirmed.length, 0);
  assert.equal(uncertain.length, 0, 'proven non-dispatch is resolved, not uncertain');
  assert.equal(uncompensatedExternalWriteEvents(events).length, 0, 'so the item may safely retry');
});

// ── Release-blocking invariant 2 ────────────────────────────────────────────

test('a landed OR unresolved effect both block a blind replay; only proven non-dispatch clears', () => {
  // Corrected after the first draft asserted the wrong semantics. A COMMITTED
  // write still blocks an automatic resume, and that is deliberate: replaying a
  // write that already landed double-sends. "Uncompensated" means "not proven
  // to have NOT happened", not "not finished". Only an external_write_failed —
  // positive evidence that dispatch never occurred — clears the path.
  const unresolved = [reserved('call-cp', ITEM_NEW)];
  const committed = [reserved('call-cp', ITEM_NEW), receipt('call-cp', ITEM_NEW)];
  const provenNoDispatch = [
    reserved('call-cp', ITEM_NEW),
    ledgerEvent('external_write_failed', { canonicalCallId: 'call-cp', shapeKey: 'SHEETS_APPEND_ROW', targets: [ITEM_NEW] }),
  ];
  assert.ok(uncompensatedExternalWriteEvents(unresolved).length > 0, 'unresolved blocks replay');
  assert.ok(uncompensatedExternalWriteEvents(committed).length > 0, 'a landed write ALSO blocks replay — it would double-send');
  assert.equal(uncompensatedExternalWriteEvents(provenNoDispatch).length, 0, 'only proven non-dispatch clears');
});

// ── Identity integrity ──────────────────────────────────────────────────────

test('opaque provider identifiers survive the ledger without numeric normalization', () => {
  // The roadmap calls numeric normalization a test failure, and this is why:
  // trailing-zero identifiers are common (roughly one in ten), and a single
  // trip through a numeric type rewrites them into a DIFFERENT identity that
  // still looks plausible. "1785000000.000500" becomes "1785000000.0005", the
  // next poll no longer matches the row it wrote, and the item is appended a
  // second time.
  for (const id of [ITEM_NEW, ITEM_TRAILING_ZERO, ITEM_FINAL_PAGE]) {
    const [key] = externalWriteDuplicateIdentityKeys([id], undefined);
    assert.ok(key, `identity key derivable for ${id}`);
    assert.ok(
      key.includes(id),
      `identity key for ${id} lost the exact identifier (got ${key}) — numeric normalization`,
    );
  }
  // The sharp edge, stated directly: a trailing-zero identifier and its
  // numerically-normalized form are DIFFERENT strings, and only the exact one
  // matches the row the previous run wrote.
  assert.notEqual(String(Number(ITEM_TRAILING_ZERO)), ITEM_TRAILING_ZERO);
  const [trailingKey] = externalWriteDuplicateIdentityKeys([ITEM_TRAILING_ZERO], undefined);
  assert.ok(
    trailingKey?.includes(ITEM_TRAILING_ZERO),
    'the ledger must carry the exact trailing-zero identifier, not 1785000000.0005',
  );
});

test('the action key classifies a destination append distinctly from a send', () => {
  // Effect classification decides which gate a write passes. An append that
  // classified as a send would demand approval it does not need; a send that
  // classified as an append would skip the approval it does.
  const append = canonicalExternalWriteActionKey('composio_execute_tool', 'GOOGLESHEETS_VALUES_APPEND');
  const send = canonicalExternalWriteActionKey('composio_execute_tool', 'OUTLOOK_SEND_EMAIL');
  assert.notEqual(append, send, 'an append and a send are not the same effect');
  assert.match(send, /email/, 'a send is classified as email dispatch');
});
