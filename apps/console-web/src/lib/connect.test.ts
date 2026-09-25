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
  staleConnectionStory,
  toolkitConnectKind,
  toolkitStatus,
  type ComposioToolkit,
} from './connect';

test('each app says what connecting will ask for before the click, in the same order Connect decides', () => {
  const kind = (t: Partial<ComposioToolkit>) => toolkitConnectKind({ slug: 'x', ...t });
  assert.equal(kind({ authMode: 'none' }), 'none');
  assert.equal(kind({ authMode: 'byo', authSchemes: ['NO_AUTH'] }), 'none');
  assert.equal(kind({ authMode: 'managed', authSchemes: ['OAUTH2'], managedAuthSchemes: ['OAUTH2'] }), 'sign_in');
  // No shared sign-in, but a key works: the key form, never a failed OAuth setup.
  assert.equal(kind({ authMode: 'byo', authSchemes: ['OAUTH2', 'API_KEY', 'S2S_OAUTH2'], managedAuthSchemes: [] }), 'key');
  // Only OAuth and nothing shared: the person's own developer app.
  assert.equal(kind({ authMode: 'byo', authSchemes: ['OAUTH2'], managedAuthSchemes: [] }), 'own_app');
  // Once their own app is set up, it is just a sign-in.
  assert.equal(kind({ authMode: 'byo', authSchemes: ['OAUTH2'], managedAuthSchemes: [], hasAuthConfig: true }), 'sign_in');
  // An older snapshot without schemes makes no promise.
  assert.equal(kind({ authMode: 'byo' }), 'unknown');
});

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

test('a stale connection tells what broke and when; healthy rows stay quiet (2026-08-04 dead-login-behind-green-light)', () => {
  const now = Date.parse('2026-08-04T20:00:00Z');
  assert.equal(
    staleConnectionStory({ needsReconnect: true, suppressionReason: 'expired', lastFailureAt: '2026-08-04T19:35:00Z' }, now),
    'Login expired — stopped working 25m ago. Reconnect to keep things running.',
  );
  assert.equal(
    staleConnectionStory({ needsReconnect: true, suppressionReason: 'entity-mismatch', lastFailureAt: '2026-08-02T20:00:00Z' }, now),
    'Connected under a different identity — stopped working 2d ago. Reconnect to keep things running.',
  );
  assert.equal(
    staleConnectionStory({ status: 'NEEDS_RECONNECT' }, now),
    'Login expired — reconnect to keep things running.',
    'a provider-flagged stale row still gets a story without suppression data',
  );
  assert.equal(staleConnectionStory({ usable: true, status: 'ACTIVE' }, now), null);
});
