import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPOSIO_AUTH_CONFIGS_URL, __test__, getPreferredUserId, pickToolkitConnection } from './client.js';

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

test('getPreferredUserId honors a real explicit COMPOSIO_USER_ID (short-circuits before any network)', async () => {
  // Regression guard for the sentinel fix: a real id like pg-test-… must
  // still short-circuit and be returned verbatim — we only stopped the
  // literal "default" sentinel from masking auto-detection. (Hermetic: the
  // real-id branch returns before getComposio()/connected-accounts ever run;
  // we deliberately do NOT assert the "default" fallthrough here because that
  // path can reach the live SDK on a machine with a configured key.)
  const prev = process.env.COMPOSIO_USER_ID;
  try {
    process.env.COMPOSIO_USER_ID = 'pg-test-04a26016-regression';
    assert.equal(await getPreferredUserId(), 'pg-test-04a26016-regression');
  } finally {
    if (prev === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = prev;
  }
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
