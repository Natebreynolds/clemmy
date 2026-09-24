/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/implementation-artifacts/transport-account-resolution.test.ts
 *
 * The attested transport confirms the account the caller NAMED among the
 * toolkit's connections. It must not require the toolkit to have exactly one
 * connection: with three Outlook accounts connected, every one of them was
 * unobservable (calendar watch, 2026-09-22).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-transport-account-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { resolveConnectedAccount } = await import('./transport-entry.js');

const rows = [
  { slug: 'outlook', connectionId: 'ca_one', status: 'ACTIVE', accountEmail: 'one@corp.example' },
  { slug: 'outlook', connectionId: 'ca_two', status: 'ACTIVE', accountEmail: 'two@corp.example' },
  { slug: 'outlook', connectionId: 'ca_three', status: 'ACTIVE' },
  { slug: 'gmail', connectionId: 'ca_gmail', status: 'ACTIVE' },
];
const client = { peekConnectedToolkits: () => rows };

test('a named account is confirmed when the toolkit has several connections', () => {
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_two' }), 'ca_two');
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_three' }), 'ca_three');
});

test('an account that is not a connection of that toolkit is refused, exactly', () => {
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_gmail' }), null);
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_missing' }), null);
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: '' }), null);
  assert.equal(resolveConnectedAccount({ peekConnectedToolkits: () => [] }, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_one' }), null);
});

test('an email identity only stands in when the row has no connection id', () => {
  assert.equal(resolveConnectedAccount(client, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'one@corp.example' }), null);
  const legacy = { peekConnectedToolkits: () => [{ slug: 'outlook', connectionId: '', status: 'ACTIVE', accountEmail: 'legacy@corp.example' }] };
  assert.equal(resolveConnectedAccount(legacy, { operationId: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'legacy@corp.example' }), 'legacy@corp.example');
});
