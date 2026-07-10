import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSIO_AUTH_CONFIGS_URL,
  __test__,
  filterSuppressedConnectedToolkits,
  getPreferredUserId,
  listConnectedToolkits,
  listSuppressedConnectedToolkitViews,
  pickToolkitConnection,
} from './client.js';

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

function account(id: string, slug: string, userId: string, status = 'ACTIVE') {
  return { id, toolkit: { slug }, user_id: userId, status };
}

test('connected-account snapshot feeds preferred user and connection routing with one fetch', async () => {
  const prev = process.env.COMPOSIO_USER_ID;
  delete process.env.COMPOSIO_USER_ID;
  let calls = 0;
  __test__.setConnectedAccountsLoader(async () => {
    calls += 1;
    return [
      account('ca_outlook', 'outlook', 'user-main'),
      account('ca_drive', 'googledrive', 'user-main'),
      account('ca_old', 'gmail', 'user-old', 'EXPIRED'),
    ];
  });
  try {
    assert.equal(await getPreferredUserId({ requireFresh: true }), 'user-main');
    assert.deepEqual((await listConnectedToolkits({ requireFresh: true })).map((row) => row.connectionId), [
      'ca_outlook',
      'ca_drive',
      'ca_old',
    ]);
    assert.equal(calls, 1, 'preferred user and connection routing share one snapshot');
  } finally {
    __test__.setConnectedAccountsLoader(null);
    if (prev === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = prev;
  }
});

test('cache invalidation rejects a late old-account refresh and preserves the new generation', async () => {
  let resolveOld!: (items: Array<Record<string, unknown>>) => void;
  const oldItems = new Promise<Array<Record<string, unknown>>>((resolve) => { resolveOld = resolve; });
  __test__.setConnectedAccountsLoader(() => oldItems);
  const oldRefresh = listConnectedToolkits({ requireFresh: true });

  __test__.setConnectedAccountsLoader(async () => [account('ca_new', 'outlook', 'user-new')]);
  try {
    assert.deepEqual((await listConnectedToolkits({ requireFresh: true })).map((row) => row.connectionId), ['ca_new']);
    resolveOld([account('ca_old', 'outlook', 'user-old')]);
    await assert.rejects(oldRefresh, /account state changed during refresh/i);
    assert.deepEqual((await listConnectedToolkits({ requireFresh: true })).map((row) => row.connectionId), ['ca_new']);
  } finally {
    __test__.setConnectedAccountsLoader(null);
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

test('filterSuppressedConnectedToolkits hides active-looking stale accounts before model discovery', () => {
  const c = (slug: string, connectionId: string, status: string) => ({ slug, connectionId, status });
  const now = Date.parse('2026-07-02T16:30:00Z');
  const connections = [
    c('outlook', 'ca_good', 'ACTIVE'),
    c('outlook', 'ca_stale', 'ACTIVE'),
    c('outlook', 'ca_expired_suppression', 'ACTIVE'),
  ];
  const state = {
    suppressedConnections: {
      ca_stale: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-07-03T16:30:00Z',
        lastErrorAt: '2026-07-02T16:29:00Z',
        failures: 1,
      },
      ca_expired_suppression: {
        reason: 'expired',
        suppressUntil: '2026-07-02T15:30:00Z',
        lastErrorAt: '2026-07-02T14:29:00Z',
        failures: 1,
      },
    },
  };

  assert.deepEqual(
    filterSuppressedConnectedToolkits(connections, state, now).map((connection) => connection.connectionId),
    ['ca_good', 'ca_expired_suppression'],
  );
  assert.deepEqual(
    listSuppressedConnectedToolkitViews(connections, state, now).map((connection) => ({
      connectionId: connection.connectionId,
      reason: connection.suppression.reason,
    })),
    [{ connectionId: 'ca_stale', reason: 'entity-mismatch' }],
  );
  assert.equal(
    pickToolkitConnection('OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', filterSuppressedConnectedToolkits(connections, state, now)),
    undefined,
    'two usable Outlook accounts remain ambiguous; the stale account is not considered',
  );
});
