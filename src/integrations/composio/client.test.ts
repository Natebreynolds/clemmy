import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPOSIO_AUTH_CONFIGS_URL, __test__, pickToolkitConnection } from './client.js';

test('selectAuthConfigIdForToolkit handles current auth config response shapes', () => {
  const items = [
    { id: 'ac_gmail', toolkit: { slug: 'gmail' } },
    { nanoid: 'ac_outlook', toolkit_slug: 'outlook' },
    { authConfigId: 'ac_slack', toolkitSlug: 'slack' },
    { auth_config: { id: 'ac_drive', toolkit_slug: 'googledrive' } },
  ];

  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'outlook'), 'ac_outlook');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'slack'), 'ac_slack');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'googledrive'), 'ac_drive');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'missing'), null);
  assert.equal(__test__.authConfigId({ auth_config: { nanoid: 'ac_nested' } }), 'ac_nested');
});

test('Composio auth-config fallback URL uses the current dashboard path', () => {
  assert.equal(COMPOSIO_AUTH_CONFIGS_URL, 'https://dashboard.composio.dev/~/project/auth-configs');
});

test('pickToolkitConnection: resolves the live connection only when unambiguous (no stale-id guessing)', () => {
  const c = (slug: string, connectionId: string, status: string) => ({ slug, connectionId, status });
  // One connection for the toolkit → deterministic pick.
  assert.equal(
    pickToolkitConnection('AIRTABLE_LIST_RECORDS', [c('airtable', 'ca_only', 'ACTIVE')]),
    'ca_only',
  );
  // The real incident: two airtable connections, one dead — pick the single ACTIVE, never the stale one.
  assert.equal(
    pickToolkitConnection('AIRTABLE_LIST_RECORDS', [
      c('airtable', 'ca_dead', 'EXPIRED'),
      c('airtable', 'ca_good', 'ACTIVE'),
      c('gmail', 'ca_gmail', 'ACTIVE'), // unrelated toolkit ignored
    ]),
    'ca_good',
  );
  // Genuinely ambiguous (two ACTIVE for the toolkit) → defer to composio's default.
  assert.equal(
    pickToolkitConnection('AIRTABLE_LIST_RECORDS', [
      c('airtable', 'ca_a', 'ACTIVE'),
      c('airtable', 'ca_b', 'ACTIVE'),
    ]),
    undefined,
  );
  // No connection for the toolkit → undefined (composio surfaces a clear no-connection error).
  assert.equal(pickToolkitConnection('AIRTABLE_LIST_RECORDS', [c('gmail', 'ca_gmail', 'ACTIVE')]), undefined);
});
