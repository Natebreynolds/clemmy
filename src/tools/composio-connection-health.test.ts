/**
 * Run: npx tsx --test src/tools/composio-connection-health.test.ts
 *
 * A broken connection has to outlive the turn that discovered it.
 *
 * Measured on the owner's machine 2026-08-01: the durable capability registry
 * held exactly ONE record — `claude_sdk_local_mcp_surface` — because the only
 * two callers of recordHarnessCapabilityHealth both watch the brain's own MCP
 * surface. No provider, connection, or account state had ever been written.
 *
 * That is the root of the demo failure class. A plan promised "read-only via
 * the Salesforce CLI" while the saved login was expired and died on it mid-run.
 * The reconnect-required error WAS detected and self-healed at the gateway, and
 * the breaker that recorded it was in-memory, per-session and TTL'd — so
 * nothing outside that turn learned. Every consumer of capability health was
 * querying an empty table and correctly reporting nothing wrong.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-conn-health-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { __gatewayTest__ } = await import('./composio-tools.js');
const {
  readHarnessCapabilityHealth,
  listHarnessCapabilityHealth,
  _resetHarnessCapabilityHealthForTest,
} = await import('../runtime/harness/capability-health.js');

beforeEach(() => { _resetHarnessCapabilityHealthForTest(); });

test('a reconnect-required failure is recorded against the PROVIDER, not the session', () => {
  __gatewayTest__.recordReconnectBreaker('sess-a', 'SALESFORCE_RUN_SOQL_QUERY');
  const record = readHarnessCapabilityHealth('salesforce');
  assert.ok(record, 'the provider must be in the durable registry at all');
  assert.equal(record.state, 'unavailable');
  assert.match(record.summary, /reconnect/i);
});

test('the record outlives the session that found it', () => {
  // The session breaker is per-session and TTL'd; the registry must not be.
  // A plan composed in a DIFFERENT conversation has to see this.
  __gatewayTest__.recordReconnectBreaker('sess-discoverer', 'AIRTABLE_LIST_RECORDS');
  assert.equal(readHarnessCapabilityHealth('airtable')?.state, 'unavailable');
  assert.ok(
    listHarnessCapabilityHealth({ includeHealthy: false }).some((r) => r.id === 'airtable'),
    'and it must be enumerable, which is how a proposal learns not to promise it',
  );
});

test('a failure with no session still records — a connection is broken for everything', () => {
  __gatewayTest__.recordReconnectBreaker(undefined, 'GOOGLESHEETS_VALUES_APPEND');
  assert.equal(readHarnessCapabilityHealth('googlesheets')?.state, 'unavailable');
});

test('a later success clears it, because a working call is the only proof of recovery', () => {
  __gatewayTest__.recordReconnectBreaker('sess-b', 'OUTLOOK_SEND_EMAIL');
  assert.equal(readHarnessCapabilityHealth('outlook')?.state, 'unavailable');
  __gatewayTest__.clearReconnectBreaker('sess-b', 'OUTLOOK_SEND_EMAIL');
  assert.equal(readHarnessCapabilityHealth('outlook')?.state, 'healthy');
});

test('only STATE CHANGES are written — the hot success path must not write a file per call', () => {
  // recordHarnessCapabilityHealth persists on every call and the success path
  // runs on every gateway hit. Writing unconditionally would put a file write
  // in the hot path; `count` proves we only write on transitions.
  __gatewayTest__.clearReconnectBreaker('sess-c', 'NOTION_QUERY_DATABASE');
  const first = readHarnessCapabilityHealth('notion');
  assert.equal(first?.state, 'healthy');
  for (let i = 0; i < 50; i += 1) __gatewayTest__.clearReconnectBreaker('sess-c', 'NOTION_QUERY_DATABASE');
  assert.equal(
    readHarnessCapabilityHealth('notion')?.count,
    first?.count,
    '50 further successes must not write 50 more records',
  );
});

test('the provider is derived from the slug, so a new provider needs no list entry', () => {
  __gatewayTest__.recordReconnectBreaker('sess-d', 'SOMENEWVENDOR_FETCH_THINGS');
  assert.equal(readHarnessCapabilityHealth('somenewvendor')?.state, 'unavailable');
});

process.on('exit', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
