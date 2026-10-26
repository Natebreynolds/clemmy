/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/pending-action-account-pin.test.ts
 *
 * An approved SDK write runs only on the exact account its card binds, so a
 * staged write that names no account must not reach a card it can never run.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-pending-account-pin-'));
process.env.CLEMENTINE_HOME = home;
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const client = await import('../integrations/composio/client.js');
const { admitPendingActionCall } = await import('./pending-action-admission.js');
after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => client._setConnectedToolkitsSnapshotForTests(null));

const deleteEvent = {
  tool_slug: 'OUTLOOK_DELETE_CALENDAR_EVENT',
  arguments: JSON.stringify({ event_id: 'evt-fixture', user_id: 'me' }),
  connected_account_id: null,
};
const account = (connectionId: string, accountEmail: string, status = 'ACTIVE') => (
  { slug: 'outlook', connectionId, status, accountEmail }
);

test('one connected account for the app is pinned into the staged write', () => {
  client._setConnectedToolkitsSnapshotForTests([account('ca_only', 'owner@example.test')] as never);
  const admitted = admitPendingActionCall('composio_execute_tool', deleteEvent, { approvalIntent: 'request_now' });
  assert.equal((admitted.payload as Record<string, unknown>).connected_account_id, 'ca_only');
});

test('several connected accounts refuse the unnamed write before a card, naming them', () => {
  client._setConnectedToolkitsSnapshotForTests([
    account('ca_work', 'owner@work.test'),
    account('ca_home', 'owner@home.test'),
    account('ca_gone', 'old@example.test', 'EXPIRED'),
  ] as never);
  assert.throws(
    () => admitPendingActionCall('composio_execute_tool', deleteEvent, { approvalIntent: 'request_now' }),
    (error: Error) => /ca_work \(owner@work\.test\), ca_home \(owner@home\.test\)/.test(error.message)
      && !/ca_gone/.test(error.message)
      && /No approval card or provider dispatch was created/.test(error.message),
  );
});

test('a named account, a queue-only stage, or an unobserved registry is admitted as before', () => {
  client._setConnectedToolkitsSnapshotForTests([account('ca_work', 'a@x.test'), account('ca_home', 'b@x.test')] as never);
  const named = admitPendingActionCall('composio_execute_tool', { ...deleteEvent, connected_account_id: 'ca_home' }, { approvalIntent: 'request_now' });
  assert.equal((named.payload as Record<string, unknown>).connected_account_id, 'ca_home');
  const queued = admitPendingActionCall('composio_execute_tool', deleteEvent, { approvalIntent: 'queue_only' });
  assert.equal((queued.payload as Record<string, unknown>).connected_account_id, null);
  client._setConnectedToolkitsSnapshotForTests(null);
  const unobserved = admitPendingActionCall('composio_execute_tool', deleteEvent, { approvalIntent: 'request_now' });
  assert.equal((unobserved.payload as Record<string, unknown>).connected_account_id, null);
});
