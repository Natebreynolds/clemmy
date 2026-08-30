/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/verified-write-capability-store.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-verified-write-store-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const learned = await import('./verified-write-capability-store.js');
type VerifiedWriteCapabilityRecordV1 = import('./verified-write-capability-store.js').VerifiedWriteCapabilityRecordV1;

const REQUEST = 'Create one reversible local workspace proof';
const alias = learned.verifiedWriteAliasForPhrase(REQUEST);
assert.ok(alias);

const record: VerifiedWriteCapabilityRecordV1 = {
  version: 1,
  klass: 'capability_only',
  aliasDigest: alias.aliasDigest,
  terms: alias.terms,
  origin: {
    version: 1,
    sessionId: 'verified-write-store-origin',
    sourceUserSeq: 1,
    acceptedTaskId: 'task:verified-write-store-origin#1',
    logicalToolCallId: 'logical-write-1',
    receiptId: `write-evidence:v1:${'a'.repeat(64)}`,
    hostBindingDigest: 'b'.repeat(64),
    terminalEventId: 'terminal-event-1',
  },
  bindingKind: 'catalog_manifest',
  providerKind: 'fixture_provider',
  capabilityRef: 'cap:fixture:create_workspace',
  operationId: 'CREATE_WORKSPACE',
  effect: 'external_write',
  accountIdentity: 'fixture-account-1',
  localEnvelopeFingerprint: null,
};

test.after(() => {
  learned.closeVerifiedWriteCapabilityStoreForTests();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('strict capability-only shape has no argument, target, template, approval, or binding inheritance slot', () => {
  assert.deepEqual(learned.parseVerifiedWriteCapabilityRecord(record), record);
  for (const forbidden of [
    'args',
    'target',
    'template',
    'approvalId',
    'autoBindable',
    'consent',
    'invocation',
  ]) {
    assert.equal(
      learned.parseVerifiedWriteCapabilityRecord({ ...record, [forbidden]: 'forbidden' }),
      null,
      `${forbidden} must not fit the durable protocol`,
    );
  }
  const bytes = JSON.stringify(record).toLowerCase();
  for (const forbidden of ['approval', 'autobind', 'template', 'invocationargs']) {
    assert.equal(bytes.includes(forbidden), false);
  }
});

test('a capability-only identity survives process-handle restart and exact replay is idempotent', () => {
  const first = learned.storeVerifiedWriteCapability({ record });
  assert.equal(first.stored, true, JSON.stringify(first));
  if (!first.stored) return;
  assert.equal(first.inserted, true);

  learned.closeVerifiedWriteCapabilityStoreForTests();
  const afterRestart = learned.matchVerifiedWriteCapabilities(REQUEST);
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0]!.recordId, first.record.recordId);

  const replay = learned.storeVerifiedWriteCapability({ record });
  assert.equal(replay.stored, true, JSON.stringify(replay));
  if (replay.stored) assert.equal(replay.inserted, false);
});

test('paraphrase nomination needs two anchors and one uniquely best capability identity', () => {
  const fixture = (
    phrase: string,
    digit: string,
    operationId: string,
  ): VerifiedWriteCapabilityRecordV1 => {
    const intent = learned.verifiedWriteAliasForPhrase(phrase);
    assert.ok(intent);
    return {
      ...record,
      aliasDigest: intent.aliasDigest,
      terms: intent.terms,
      origin: {
        ...record.origin,
        sessionId: `verified-write-${digit}`,
        acceptedTaskId: `task:verified-write-${digit}#1`,
        logicalToolCallId: `logical-${digit}`,
        receiptId: `write-evidence:v1:${digit.repeat(64)}`,
        hostBindingDigest: digit.repeat(64),
        terminalEventId: `terminal-${digit}`,
      },
      capabilityRef: `cap:fixture:${operationId.toLowerCase()}`,
      operationId,
    };
  };
  const alpha = fixture('Update alpha ledger records', 'c', 'UPDATE_ALPHA_LEDGER');
  const beta = fixture('Update beta ledger records', 'd', 'UPDATE_BETA_LEDGER');
  assert.equal(learned.storeVerifiedWriteCapability({ record: alpha }).stored, true);
  assert.equal(learned.storeVerifiedWriteCapability({ record: beta }).stored, true);

  assert.deepEqual(learned.matchVerifiedWriteCapabilities('Create a quarterly forecast'), [],
    'a newer unrelated request sharing only one action verb must abstain');
  assert.deepEqual(learned.matchVerifiedWriteCapabilities('Update ledger records'), [],
    'two capability identities tied on the same anchors must abstain');
  assert.equal(
    learned.matchVerifiedWriteCapabilities('Update alpha ledger records')[0]?.operationId,
    alpha.operationId,
    'an exact normalized repeat remains a strong nomination',
  );
});

test('exact repeat selects one uniquely newest task origin and preserves its multi-capability bundle', () => {
  const exactRecord = (
    phrase: string,
    sessionId: string,
    sourceUserSeq: number,
    digit: string,
    operationId: string,
  ): VerifiedWriteCapabilityRecordV1 => {
    const intent = learned.verifiedWriteAliasForPhrase(phrase);
    assert.ok(intent);
    return {
      ...record,
      aliasDigest: intent.aliasDigest,
      terms: intent.terms,
      origin: {
        ...record.origin,
        sessionId,
        sourceUserSeq,
        acceptedTaskId: `task:${sessionId}#${sourceUserSeq}`,
        logicalToolCallId: `logical-${sessionId}-${operationId}`,
        receiptId: `write-evidence:v1:${digit.repeat(64)}`,
        hostBindingDigest: digit.repeat(64),
        terminalEventId: `terminal-${sessionId}`,
      },
      capabilityRef: `cap:fixture:${operationId.toLowerCase()}`,
      operationId,
    };
  };

  const phrase = 'Publish exact origin bundle';
  const fixtures = [
    exactRecord(phrase, 'exact-old-a', 1, '3', 'BUNDLE_OLD_A'),
    exactRecord(phrase, 'exact-old-b', 1, '4', 'BUNDLE_OLD_B'),
    exactRecord(phrase, 'exact-new', 9, '5', 'BUNDLE_NEW_A'),
    exactRecord(phrase, 'exact-new', 9, '6', 'BUNDLE_NEW_B'),
  ];
  for (const fixture of fixtures) {
    assert.equal(learned.storeVerifiedWriteCapability({ record: fixture }).stored, true);
  }
  const db = learned.__test__.database();
  db.prepare(`UPDATE verified_write_capabilities SET created_at = ? WHERE origin_session_id = ?`)
    .run('2026-08-27T01:00:00.000Z', 'exact-old-a');
  db.prepare(`UPDATE verified_write_capabilities SET created_at = ? WHERE origin_session_id = ?`)
    .run('2026-08-27T02:00:00.000Z', 'exact-old-b');
  db.prepare(`UPDATE verified_write_capabilities SET created_at = ? WHERE origin_session_id = ?`)
    .run('2026-08-27T03:00:00.000Z', 'exact-new');
  assert.deepEqual(
    learned.matchVerifiedWriteCapabilities(phrase).map((entry) => entry.operationId).sort(),
    ['BUNDLE_NEW_A', 'BUNDLE_NEW_B'],
    'older exact recipes cannot be merged into the newest successful task bundle',
  );

  const ambiguousPhrase = 'Publish tied exact origin';
  const tiedA = exactRecord(ambiguousPhrase, 'exact-tied-a', 1, '7', 'TIED_A');
  const tiedB = exactRecord(ambiguousPhrase, 'exact-tied-b', 1, '8', 'TIED_B');
  assert.equal(learned.storeVerifiedWriteCapability({ record: tiedA }).stored, true);
  assert.equal(learned.storeVerifiedWriteCapability({ record: tiedB }).stored, true);
  db.prepare(`
    UPDATE verified_write_capabilities SET created_at = ?
     WHERE origin_session_id IN (?, ?)
  `).run('2026-08-27T04:00:00.000Z', 'exact-tied-a', 'exact-tied-b');
  assert.deepEqual(learned.matchVerifiedWriteCapabilities(ambiguousPhrase), [],
    'an equal newest timestamp across task origins must abstain');
});

test('privacy-scope tampering cannot move a valid record into another partition', () => {
  const forgedScope = 'f'.repeat(40);
  const db = learned.__test__.database();
  db.prepare(`
    UPDATE verified_write_capabilities SET scope_digest = ?
     WHERE origin_session_id = ?
  `).run(forgedScope, record.origin.sessionId);
  assert.deepEqual(learned.matchVerifiedWriteCapabilities(REQUEST, { scopeDigest: forgedScope }), []);
});

test('tampered rows are unreadable rather than downgraded into a lexical nomination', () => {
  const db = learned.__test__.database();
  db.prepare(`
    UPDATE verified_write_capabilities
       SET record_json = json_set(record_json, '$.accountIdentity', 'attacker-account')
  `).run();
  assert.deepEqual(learned.matchVerifiedWriteCapabilities(REQUEST), []);
});
