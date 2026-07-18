import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSIO_AUTH_CONFIGS_URL,
  ComposioDispatchUncertainError,
  __test__,
  filterSuppressedConnectedToolkits,
  getPreferredUserId,
  listConnectedToolkits,
  listSuppressedConnectedToolkitViews,
  pickToolkitConnection,
  selectToolkitConnection,
  dispatchUserIdFor,
  composioAutoFallbackAllowed,
  composioCliErrorProvesNoDispatch,
  toComposioDashboardConnection,
  type ConnectedToolkit,
} from './client.js';

test('AUTO fallback never replays an ambiguous CLI mutation through the SDK', () => {
  const timeout = new Error('socket timeout after request dispatch');
  assert.equal(composioAutoFallbackAllowed('GOOGLEDOCS_CREATE_DOCUMENT', timeout), false);
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_SEND_EMAIL', new Error('503 Service unavailable')), false);
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_LIST_MESSAGES', timeout), true, 'reads remain retry/fallback safe');
  assert.equal(composioAutoFallbackAllowed('GOOGLEDOCS_CREATE_DOCUMENT', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })), true, 'proven pre-dispatch CLI failures may fall back');
  assert.equal(composioCliErrorProvesNoDispatch(new Error('ECONNRESET')), false);
  // Genuine pre-dispatch throws now prove no-dispatch STRUCTURALLY via the
  // not-started marker (the executeComposioTool gates emit these verbatim).
  assert.equal(composioCliErrorProvesNoDispatch(new Error('[provider-dispatch:not-started:no-api-key] COMPOSIO_API_KEY is not configured.')), true);
  assert.equal(composioCliErrorProvesNoDispatch(new Error('[provider-dispatch:not-started:cli-auth] Composio CLI is installed, but no CLI login was detected. Run composio login or switch the backend to AUTO/SDK.')), true, 'pre-dispatch CLI-auth gate carries the marker');
  assert.match(new ComposioDispatchUncertainError('GOOGLEDOCS_CREATE_DOCUMENT', timeout).message, /Verify the remote state/);
});

test('composioCliErrorProvesNoDispatch: bare auth/key text is NOT proof of no-dispatch (post-dispatch false-positive guard)', () => {
  // A non-zero CLI exit AFTER dispatch that carries the provider's response body
  // (or a downstream sub-call failing on auth once the mutation already
  // committed): the flattened ~8KB error mentions auth, but the write may have
  // landed. Without the not-started marker this MUST stay ambiguous — proving
  // no-dispatch here would authorize an auto-fallback replay that double-writes.
  assert.equal(
    composioCliErrorProvesNoDispatch(new Error('Composio CLI execute failed for OUTLOOK_SEND_EMAIL: 401 authentication required')),
    false,
    'provider auth error in a post-dispatch CLI exit is not proof of no-dispatch',
  );
  assert.equal(composioCliErrorProvesNoDispatch(new Error('not logged in')), false);
  assert.equal(composioCliErrorProvesNoDispatch(new Error('not authenticated')), false);
  // Composio's OWN wrapper thrown AFTER runComposioCli already dispatched — the
  // "run composio login" phrase must no longer prove no-dispatch.
  assert.equal(
    composioCliErrorProvesNoDispatch(new Error('Composio CLI execute produced no output for OUTLOOK_SEND_EMAIL; run composio login or use the SDK backend.')),
    false,
    'post-dispatch no-output wrapper mentioning "run composio login" is ambiguous',
  );
  // Bare API-key prose nested in a post-dispatch error body is likewise not proof.
  assert.equal(
    composioCliErrorProvesNoDispatch(Object.assign(new Error('Composio CLI execute failed for GOOGLEDOCS_CREATE_DOCUMENT'), { stderr: 'upstream: API key required for the referenced datasource' })),
    false,
    'API-key phrase in provider stderr after dispatch is ambiguous',
  );
  // Hard process-launch failures still prove no-dispatch (the binary never ran).
  assert.equal(composioCliErrorProvesNoDispatch(new Error('Composio CLI is not installed. Install it or switch the backend to AUTO/SDK.')), true);
  assert.equal(composioCliErrorProvesNoDispatch(Object.assign(new Error('spawn composio ENOENT'), { code: 'ENOENT' })), true);
});

test('composioAutoFallbackAllowed: a post-dispatch CLI auth error on a mutation no longer authorizes SDK replay', () => {
  // The receipt-ledger double-write class: a CLI mutation that crossed the
  // boundary and failed with auth-shaped text must NOT fall back to the SDK.
  assert.equal(
    composioAutoFallbackAllowed('OUTLOOK_SEND_EMAIL', new Error('Composio CLI execute failed for OUTLOOK_SEND_EMAIL: 401 not authenticated')),
    false,
  );
  // Reads still fall back (idempotent), and a marked pre-dispatch failure still may.
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_LIST_MESSAGES', new Error('401 not authenticated')), true, 'reads stay fallback-safe');
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_SEND_EMAIL', new Error('[provider-dispatch:not-started:cli-auth] no CLI login was detected')), true, 'marked pre-dispatch failure may still fall back');
});

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
  // getPreferredUserId is now PURE: configuredUserId() (COMPOSIO_USER_ID) else a
  // machine-derived id — it no longer reads the account list. Set the env
  // explicitly so this asserts the configured path deterministically (deleting
  // it made the result depend on the dev's ~/.clementine-next/.env, which passed
  // locally off a leftover but returned the derived id on a clean CI checkout).
  process.env.COMPOSIO_USER_ID = 'user-main';
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

test('dispatchUserIdFor: a pinned connection dispatches under the entity that OWNS it, never the env fallback', () => {
  const conns: ConnectedToolkit[] = [
    { slug: 'outlook', connectionId: 'ca_dash', status: 'ACTIVE', ownerUserId: 'pg-test-dashboard-entity' },
    { slug: 'outlook', connectionId: 'ca_clem', status: 'ACTIVE', ownerUserId: 'clementine-machine' },
    { slug: 'gmail', connectionId: 'ca_no_owner', status: 'ACTIVE' }, // SDK-fallback listing: owner unknown
  ];
  // Composio validates userId ↔ connectedAccountId; the owner must win over a
  // stale COMPOSIO_USER_ID (the 2026-07-11 entity-mismatch class).
  assert.equal(dispatchUserIdFor('ca_dash', conns, 'user-main'), 'pg-test-dashboard-entity');
  assert.equal(dispatchUserIdFor('ca_clem', conns, 'user-main'), 'clementine-machine');
  // Owner unknown (SDK fallback) or nothing pinned → the fallback entity.
  assert.equal(dispatchUserIdFor('ca_no_owner', conns, 'user-main'), 'user-main');
  assert.equal(dispatchUserIdFor(undefined, conns, 'user-main'), 'user-main');
  assert.equal(dispatchUserIdFor('ca_unknown', conns, 'fallback'), 'fallback');
});

test('refreshConnectedToolkits maps the raw-v3 user_id to ownerUserId', async () => {
  __test__.setConnectedAccountsLoader(async () => [
    { id: 'ca_owned', toolkit: { slug: 'outlook' }, status: 'ACTIVE', user_id: 'pg-test-owner' },
  ]);
  const conns = await listConnectedToolkits();
  assert.equal(conns.find((c) => c.connectionId === 'ca_owned')?.ownerUserId, 'pg-test-owner');
  __test__.setConnectedAccountsLoader(null);
});

test('selectToolkitConnection: 3 re-auths of ONE mailbox collapse → freshest ACTIVE (the reported bug)', () => {
  const conn = (connectionId: string, status: string, createdAt: string): ConnectedToolkit =>
    ({ slug: 'outlook', connectionId, status, accountEmail: 'nathan@scorpion.co', createdAt });
  const out = selectToolkitConnection('OUTLOOK_LIST_MESSAGES', [
    conn('ca_old', 'ACTIVE', '2026-07-01T00:00:00Z'),
    conn('ca_mid', 'ACTIVE', '2026-07-05T00:00:00Z'),
    conn('ca_new', 'ACTIVE', '2026-07-10T00:00:00Z'),
  ]);
  assert.deepEqual(out, { kind: 'resolved', connectionId: 'ca_new', identity: 'nathan@scorpion.co' });
});

test('selectToolkitConnection: active-tier beats createdAt (a fresh INITIATED re-auth cannot hijack a working ACTIVE)', () => {
  const out = selectToolkitConnection('OUTLOOK_LIST_MESSAGES', [
    { slug: 'outlook', connectionId: 'ca_active', status: 'ACTIVE', accountEmail: 'a@x.com', createdAt: '2026-07-01T00:00:00Z' },
    { slug: 'outlook', connectionId: 'ca_initiated', status: 'INITIATED', accountEmail: 'a@x.com', createdAt: '2026-07-10T00:00:00Z' },
  ]);
  assert.equal(out.kind === 'resolved' && out.connectionId, 'ca_active');
});

test('selectToolkitConnection: two DISTINCT mailboxes with no hint → ambiguous (ASK), never a silent pick', () => {
  const out = selectToolkitConnection('OUTLOOK_SEND_EMAIL', [
    { slug: 'outlook', connectionId: 'ca_work', status: 'ACTIVE', accountEmail: 'work@x.com' },
    { slug: 'outlook', connectionId: 'ca_home', status: 'ACTIVE', accountEmail: 'home@y.com' },
  ]);
  assert.equal(out.kind, 'ambiguous');
  assert.equal(out.kind === 'ambiguous' && out.candidates.length, 2);
});

test('selectToolkitConnection: identity hint routes to the matching mailbox; a miss is identity-absent (ASK)', () => {
  const conns: ConnectedToolkit[] = [
    { slug: 'outlook', connectionId: 'ca_work', status: 'ACTIVE', accountEmail: 'work@x.com' },
    { slug: 'outlook', connectionId: 'ca_home', status: 'ACTIVE', accountEmail: 'home@y.com' },
  ];
  assert.deepEqual(
    selectToolkitConnection('OUTLOOK_SEND_EMAIL', conns, 'HOME@y.com'),
    { kind: 'resolved', connectionId: 'ca_home', identity: 'home@y.com' },
  );
  const miss = selectToolkitConnection('OUTLOOK_SEND_EMAIL', conns, 'gone@z.com');
  assert.equal(miss.kind, 'identity-absent');
  assert.equal(miss.kind === 'identity-absent' && miss.want, 'gone@z.com');
});

test('selectToolkitConnection: unknown-identity connections are NEVER merged → ambiguous', () => {
  const out = selectToolkitConnection('OUTLOOK_SEND_EMAIL', [
    { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE' },
    { slug: 'outlook', connectionId: 'ca_b', status: 'ACTIVE' },
  ]);
  assert.equal(out.kind, 'ambiguous');
});

test('selectToolkitConnection: all matched connections inactive → defer', () => {
  const out = selectToolkitConnection('OUTLOOK_LIST_MESSAGES', [
    { slug: 'outlook', connectionId: 'ca_x', status: 'EXPIRED', accountEmail: 'a@x.com' },
    { slug: 'outlook', connectionId: 'ca_y', status: 'REVOKED', accountEmail: 'a@x.com' },
  ]);
  assert.deepEqual(out, { kind: 'defer' });
});

test('selectToolkitConnection: canonical matcher — underscore toolkit slugs match, bare prefixes do not', () => {
  const oneDrive = selectToolkitConnection('ONE_DRIVE_UPLOAD_FILE', [
    { slug: 'one_drive', connectionId: 'ca_od', status: 'ACTIVE', accountEmail: 'a@x.com' },
  ]);
  assert.equal(oneDrive.kind === 'resolved' && oneDrive.connectionId, 'ca_od');
  // A bare `google` connection must NOT match a GOOGLEDRIVE_* tool.
  const noMatch = selectToolkitConnection('GOOGLEDRIVE_DOWNLOAD_FILE', [
    { slug: 'google', connectionId: 'ca_g', status: 'ACTIVE', accountEmail: 'a@x.com' },
  ]);
  assert.deepEqual(noMatch, { kind: 'defer' });
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

test('dashboard connection state never presents a suppressed ACTIVE account as healthy', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const connection = { slug: 'outlook', connectionId: 'ca_legacy', status: 'ACTIVE' };
  const suppression = {
    suppressedConnections: {
      ca_legacy: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-07-17T12:00:00Z',
        lastErrorAt: '2026-07-10T11:59:00Z',
        failures: 1,
      },
    },
  };

  const stale = toComposioDashboardConnection(connection, suppression, now);
  assert.equal(stale.providerStatus, 'ACTIVE');
  assert.equal(stale.status, 'NEEDS_RECONNECT');
  assert.equal(stale.usable, false);
  assert.equal(stale.needsReconnect, true);
  assert.equal(stale.suppressionReason, 'entity-mismatch');

  const healthy = toComposioDashboardConnection(
    { ...connection, connectionId: 'ca_current' },
    suppression,
    now,
  );
  assert.equal(healthy.status, 'ACTIVE');
  assert.equal(healthy.usable, true);
  assert.equal(healthy.needsReconnect, false);
});
