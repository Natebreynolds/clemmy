/**
 * Run: npx tsx --test src/tools/tool-contract-store.test.ts
 *
 * Knowing WHICH tool never stopped the searching, because a name is not a
 * callable thing. Measured live (2026-08-07): a single-email task made
 * forty-eight tool calls, fifteen of them discovery, for work that needed
 * about four — and the schema cache that would have answered died with the
 * process. These pins hold the two properties that make a durable contract
 * safe to lean on: it survives a restart, and it never becomes a place where
 * the user's data quietly accumulates.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-contracts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'contract-machine\n');

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  saveToolContract, saveToolContractExample, loadToolContract, redactExample, fingerprintSchema,
  contractFileName, _clearToolContractsForTests,
} = await import('./tool-contract-store.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });
beforeEach(() => { _clearToolContractsForTests(); });

const SCHEMA = { type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } } };

test('a contract survives the process — discovery is paid once per tool, not per session', () => {
  saveToolContract({ identifier: 'OUTLOOK_CREATE_DRAFT', schema: SCHEMA });
  const loaded = loadToolContract('OUTLOOK_CREATE_DRAFT');
  assert.ok(loaded, 'a saved contract must be readable by a fresh process');
  assert.deepEqual(loaded!.schema, SCHEMA);
});

test('identifiers from every tool family round-trip — this is not a Composio feature', () => {
  // The whole point is generality across thousands of tools: composio slugs,
  // CLI commands and native MCP names all pass through the same door.
  for (const id of ['OUTLOOK_CREATE_DRAFT', 'sf data query', 'dataforseo__labs_bulk_traffic', 'gh pr list --json number']) {
    saveToolContract({ identifier: id, schema: SCHEMA });
    assert.ok(loadToolContract(id), `${id} must round-trip`);
  }
});

test('a file name is safe and collision-free even for hostile identifiers', () => {
  const a = contractFileName('../../etc/passwd');
  const b = contractFileName('..%2F..%2Fetc%2Fpasswd');
  assert.doesNotMatch(a, /[/\\]/, 'no path separators may survive into a file name');
  assert.notEqual(a, b, 'distinct identifiers must not collide after sanitising');
});

test('the fingerprint is key-order independent, so a re-serialised schema is not drift', () => {
  const one = fingerprintSchema({ a: 1, b: { c: 2, d: 3 } });
  const two = fingerprintSchema({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(one, two, 'identical contracts must agree or we discard good contracts as drift');
  assert.notEqual(one, fingerprintSchema({ a: 1, b: { c: 2, d: 4 } }), 'a real change must move it');
});

test('an example records SHAPE, never content — this is a cache, not a copy of the mailbox', () => {
  const redacted = redactExample({
    to: 'christian@inmanandstadler.com',
    subject: 'Your Q3 traffic drop',
    body: 'Hi Christian, I noticed...',
    isDraft: true,
    importance: 2,
    cc: ['someone@example.com'],
    nested: { token: 'secret-value' },
  });
  const serialised = JSON.stringify(redacted);
  assert.doesNotMatch(serialised, /christian|inmanandstadler|Q3 traffic|Hi Christian|secret-value/i,
    'no recipient, subject, body or secret may be persisted');
  assert.ok('to' in redacted!, 'the KEYS are the useful part — they are the call shape');
  assert.equal(redacted!.isDraft, true, 'booleans are shape, not content');
  assert.equal(redacted!.importance, '<number>', 'numeric ids/timestamps/amounts are content; only their type survives');
});

test('a working example survives a schema refresh — losing it re-opens the failure it prevents', () => {
  saveToolContract({ identifier: 'X_TOOL', schema: SCHEMA, exampleArgs: { message_id: 'abc', isDraft: true } });
  saveToolContract({ identifier: 'X_TOOL', schema: { ...SCHEMA, title: 'v2' } });
  const loaded = loadToolContract('X_TOOL');
  assert.ok(loaded?.exampleArgs, 'a refreshed schema must not discard the known-good call shape');
  assert.equal(loaded!.exampleArgs!.isDraft, true);
});

test('business/example writes never mint or renew provider schema authority', () => {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  saveToolContract({
    identifier: 'AUTHORITY_TOOL',
    schema: SCHEMA,
    providerObservedAt: observedAt,
  });
  saveToolContractExample({ identifier: 'AUTHORITY_TOOL', exampleArgs: { message_id: 'private-id' } });
  assert.equal(
    loadToolContract('AUTHORITY_TOOL')?.providerObservedAt,
    observedAt,
    'same-schema example capture must preserve the original observation time exactly',
  );
  assert.equal(
    loadToolContract('AUTHORITY_TOOL')?.providerObservedFingerprint,
    fingerprintSchema(SCHEMA),
    'the preserved observation stays bound to the exact schema fingerprint',
  );

  saveToolContract({
    identifier: 'AUTHORITY_TOOL',
    schema: { ...SCHEMA, title: 'business-fallback-shape' },
    exampleArgs: { message_id: 'private-id' },
  });
  assert.equal(
    loadToolContract('AUTHORITY_TOOL')?.providerObservedAt,
    observedAt,
    'a schema change without provider metadata cannot replace or downgrade prior authority',
  );
  assert.deepEqual(
    loadToolContract('AUTHORITY_TOOL')?.schema,
    SCHEMA,
    'the stale unproven schema itself is rejected, not merely its authority timestamp',
  );
});

test('a SUCCESSFUL call teaches the shape; a failed one teaches nothing', async () => {
  // The learning guards elsewhere decide whether a slug becomes the proven
  // answer for an INTENT — a much stricter question than "what does a valid
  // payload look like". Shape capture must not inherit those guards, or the
  // example is missing exactly when it would have helped.
  const { maybeAutoRememberComposioChoice } = await import('./composio-tools.js');
  await maybeAutoRememberComposioChoice(
    'OUTLOOK_CREATE_DRAFT',
    { to: 'christian@inmanandstadler.com', subject: 'Q3 traffic', isDraft: true },
    { successful: true, data: { id: 'draft-1' } },
    undefined,
  );
  const learned = loadToolContract('OUTLOOK_CREATE_DRAFT');
  assert.ok(learned?.exampleArgs, 'a success must leave a known-good call shape behind');
  assert.equal(learned?.providerObservedAt, undefined,
    'a business success without provider metadata must remain validation-only');
  assert.ok('to' in learned!.exampleArgs!, 'the keys are the recipe');
  assert.doesNotMatch(JSON.stringify(learned!.exampleArgs), /christian|Q3 traffic/i,
    'and still no content, on the path that runs against real mail');

  _clearToolContractsForTests();
  await maybeAutoRememberComposioChoice(
    'OUTLOOK_UPDATE_EMAIL',
    { message_id: 'x' },
    { successful: false, error: 'invalid arguments' },
    undefined,
  );
  assert.equal(loadToolContract('OUTLOOK_UPDATE_EMAIL'), null,
    'a failed call must never be recorded as the way to call something');
});

test('a corrupt or missing contract reads as no opinion, never as a throw', () => {
  assert.equal(loadToolContract('NEVER_SAVED'), null);
  assert.equal(loadToolContract(''), null);
  // Junk in must not be persisted at all.
  saveToolContract({ identifier: 'BAD', schema: 'not a schema' as unknown });
  assert.equal(loadToolContract('BAD'), null, 'a non-object schema must never become a contract');
});
