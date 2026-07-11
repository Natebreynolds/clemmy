/**
 * Run: npx tsx --test apps/console-web/src/lib/connect.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeConnectionId,
  connectedToolkits,
  reconnectComposio,
  reconnectConnectionId,
  toolkitStatus,
  type ComposioToolkit,
} from './connect';

test('suppressed ACTIVE connection renders as reconnect, never connected', () => {
  const outlook: ComposioToolkit = {
    slug: 'outlook',
    displayName: 'Outlook',
    connections: [{
      id: 'ca_legacy',
      status: 'NEEDS_RECONNECT',
      providerStatus: 'ACTIVE',
      usable: false,
      needsReconnect: true,
      suppressionReason: 'entity-mismatch',
    }],
  };

  assert.equal(toolkitStatus(outlook), 'reconnect');
  assert.equal(reconnectConnectionId(outlook), 'ca_legacy');
  assert.equal(connectedToolkits({ toolkits: [outlook] })[0], outlook);
});

test('one usable account keeps a toolkit healthy and stale account never wins active routing', () => {
  const gmail: ComposioToolkit = {
    slug: 'gmail',
    connections: [
      { id: 'ca_stale', status: 'NEEDS_RECONNECT', providerStatus: 'ACTIVE', usable: false, needsReconnect: true },
      { id: 'ca_current', status: 'ACTIVE', providerStatus: 'ACTIVE', usable: true, needsReconnect: false },
    ],
  };

  assert.equal(toolkitStatus(gmail), 'active');
  assert.equal(activeConnectionId(gmail), 'ca_current');
  assert.equal(reconnectConnectionId(gmail), 'ca_stale');
});

test('legacy snapshots with only ACTIVE status remain compatible', () => {
  const slack: ComposioToolkit = { slug: 'slack', connections: [{ id: 'ca_slack', status: 'ACTIVE' }] };
  assert.equal(toolkitStatus(slack), 'active');
  assert.equal(activeConnectionId(slack), 'ca_slack');
});

test('reconnect removes the stale account before starting authorization', async () => {
  const calls: string[] = [];
  const result = await reconnectComposio('outlook', 'ca_legacy', {
    disconnect: async (slug, id) => { calls.push(`disconnect:${slug}:${id}`); return { ok: true }; },
    authorize: async (slug) => { calls.push(`authorize:${slug}`); return { redirectUrl: 'https://connect.example.test' }; },
  });

  assert.deepEqual(calls, ['disconnect:outlook:ca_legacy', 'authorize:outlook']);
  assert.equal(result.staleRemoved, true);
  assert.equal(result.redirectUrl, 'https://connect.example.test');
});

test('reconnect still authorizes when Composio refuses legacy-record deletion', async () => {
  const calls: string[] = [];
  const result = await reconnectComposio('gmail', 'ca_foreign_entity', {
    disconnect: async () => { calls.push('disconnect'); throw new Error('entity mismatch'); },
    authorize: async () => { calls.push('authorize'); return { url: 'https://connect.example.test/gmail' }; },
  });

  assert.deepEqual(calls, ['disconnect', 'authorize']);
  assert.equal(result.staleRemoved, false);
  assert.equal(result.url, 'https://connect.example.test/gmail');
});
