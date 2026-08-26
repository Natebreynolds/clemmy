import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithToolAbortSignal } from '../../runtime/tool-abort-context.js';
import {
  COMPOSIO_AUTH_CONFIGS_URL,
  ComposioNeedsAuthConfigError,
  ComposioDispatchUncertainError,
  ComposioPreDispatchError,
  __test__,
  filterSuppressedConnectedToolkits,
  getPreferredUserId,
  listConnectedToolkits,
  listSuppressedConnectedToolkitViews,
  pickToolkitConnection,
  selectToolkitConnection,
  dispatchUserIdFor,
  resolveToolkitConnectionId,
  clearConnectedToolkitsCache,
  loneToolkitConnection,
  composioAutoFallbackAllowed,
  composioCliErrorProvesNoDispatch,
  executeComposioTool,
  executePreparedComposioTool,
  peekConnectedToolkits,
  peekCurrentConnectedToolkits,
  prepareComposioOneShotDispatch,
  prepareInAppToolkitConnection,
  resetComposioClient,
  selectToolkitCredentialValues,
  toComposioDashboardConnection,
  type ConnectedToolkit,
} from './client.js';

test('prepared SDK dispatch is one exact no-retry POST with no core schema/modifier/reconnect path', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousUserId = process.env.COMPOSIO_USER_ID;
  process.env.COMPOSIO_BACKEND = 'sdk';
  process.env.COMPOSIO_USER_ID = 'fallback-must-not-win';
  __test__.setComposioApiKeyOverride('prepared-one-shot-key');
  __test__.setConnectedAccountsLoader(async () => [{
    id: 'ca_exact',
    toolkit: { slug: 'outlook' },
    status: 'ACTIVE',
    user_id: 'provider-owner-exact',
  }]);
  await listConnectedToolkits({ requireFresh: true });

  let coreExecuteCalls = 0;
  let rawExecuteCalls = 0;
  const withOptions: unknown[] = [];
  let capturedBody: Record<string, unknown> | undefined;
  let capturedRequestOptions: { signal?: AbortSignal } | undefined;
  const rawNoRetry = {
    tools: {
      execute: async (
        _slug: string,
        body: Record<string, unknown>,
        requestOptions?: { signal?: AbortSignal },
      ) => {
        rawExecuteCalls += 1;
        capturedBody = body;
        capturedRequestOptions = requestOptions;
        return {
          data: { id: 'draft-1' },
          error: null,
          successful: true,
          log_id: 'log-exact',
          session_info: { source: 'raw' },
        };
      },
    },
  };
  __test__.setComposioClient({
    getClient: () => ({
      withOptions: (options: unknown) => {
        withOptions.push(options);
        return rawNoRetry;
      },
    }),
    tools: {
      execute: async () => {
        coreExecuteCalls += 1;
        throw new Error('core execute must not run');
      },
    },
  });
  try {
    const prepared = prepareComposioOneShotDispatch({
      toolSlug: 'OUTLOOK_CREATE_DRAFT',
      args: { subject: 'bounded' },
      connectedAccountId: 'ca_exact',
      providerOperationVersion: '20260824_01',
    });
    const controller = new AbortController();
    const result = await runWithToolAbortSignal(
      controller.signal,
      () => executePreparedComposioTool(prepared),
    );
    assert.equal(rawExecuteCalls, 1, 'one business POST');
    assert.equal(coreExecuteCalls, 0, 'no core schema GET, file modifiers, or fallback execute');
    assert.deepEqual(withOptions, [{ maxRetries: 0 }], 'transport retries are disabled');
    assert.deepEqual(capturedBody, {
      arguments: { subject: 'bounded' },
      user_id: 'provider-owner-exact',
      version: '20260824_01',
      connected_account_id: 'ca_exact',
    });
    assert.equal(capturedRequestOptions?.signal, controller.signal, 'the raw request owns the host abort signal');
    assert.deepEqual(result, {
      data: { id: 'draft-1' },
      error: null,
      successful: true,
      logId: 'log-exact',
      sessionInfo: { source: 'raw' },
    });
    await assert.rejects(
      executePreparedComposioTool(prepared),
      (error: unknown) => error instanceof ComposioPreDispatchError,
      'the opaque preparation is exactly one-shot',
    );
    assert.equal(rawExecuteCalls, 1, 'reuse never crosses');
  } finally {
    __test__.setConnectedAccountsLoader(null);
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    if (previousUserId === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = previousUserId;
  }
});

test('prepared SDK dispatch refuses missing current account/version before the raw body', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'sdk';
  __test__.setComposioApiKeyOverride('prepared-zero-crossing-key');
  let rawCalls = 0;
  __test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: { execute: async () => { rawCalls += 1; return {}; } },
      }),
    }),
  });
  try {
    clearConnectedToolkitsCache();
    assert.throws(
      () => prepareComposioOneShotDispatch({
        toolSlug: 'OUTLOOK_CREATE_DRAFT',
        args: {},
        connectedAccountId: 'ca_absent',
        providerOperationVersion: '20260824_01',
      }),
      (error: unknown) => error instanceof ComposioPreDispatchError,
    );
    assert.throws(
      () => prepareComposioOneShotDispatch({
        toolSlug: 'NOAUTH_SEARCH',
        args: {},
      }),
      (error: unknown) => error instanceof ComposioPreDispatchError,
    );
    assert.equal(rawCalls, 0);
  } finally {
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('prepared business dispatch refuses CLI-only before spawning a CLI or provider body', () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'composio-prepared-cli-refusal-'));
  const marker = path.join(tmp, 'cli-entered');
  const shim = path.join(tmp, 'composio-cli-must-not-run.mjs');
  writeFileSync(shim, [
    `import { writeFileSync } from 'node:fs';`,
    `writeFileSync(${JSON.stringify(marker)}, 'entered');`,
    `process.exitCode = 2;`,
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  process.env.COMPOSIO_BACKEND = 'cli';
  process.env.COMPOSIO_CLI_PATH = shim;
  __test__.setComposioApiKeyOverride('');
  try {
    assert.throws(
      () => prepareComposioOneShotDispatch({
        toolSlug: 'COMPOSIO_LIST_TOOLS',
        args: { query: 'calendar' },
        providerOperationVersion: '20260825_01',
      }),
      (error: unknown) => error instanceof ComposioPreDispatchError
        && /CLI cannot prove one provider request/.test(error.message),
    );
    assert.equal(existsSync(marker), false, 'prepared refusal never even spawns the CLI utility');
  } finally {
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

function createAuthenticatedFailingComposioCli(
  tmp: string,
  failure: string,
): { shim: string; executeMarker: string } {
  const shim = path.join(tmp, 'composio-authenticated-failing.mjs');
  const executeMarker = path.join(tmp, 'execute-called');
  writeFileSync(shim, [
    `import { appendFileSync } from 'node:fs';`,
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === '--version') console.log('composio-proof 1.0.0');`,
    `else if (argv[0] === 'whoami') console.log('authenticated-proof-user');`,
    `else if (argv[0] === 'execute') {`,
    `  appendFileSync(${JSON.stringify(executeMarker)}, JSON.stringify(argv) + '\\n');`,
    `  console.error(${JSON.stringify(failure)});`,
    `  process.exitCode = 2;`,
    `} else process.exitCode = 2;`,
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  return { shim, executeMarker };
}

test('AUTO with an SDK key never touches an authenticated CLI shim for an unpinned write', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-auto-sdk-'));
  const shim = path.join(tmp, 'composio-authenticated.mjs');
  const log = path.join(tmp, 'cli-invocations.jsonl');
  writeFileSync(shim, [
    `import { appendFileSync } from 'node:fs';`,
    `const argv = process.argv.slice(2);`,
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');`,
    `if (argv[0] === '--version') console.log('composio-proof 1.0.0');`,
    `else if (argv[0] === 'whoami') console.log('authenticated-proof-user');`,
    `else if (argv[0] === 'execute') console.log(JSON.stringify({ successful: true, lane: 'cli' }));`,
    `else process.exitCode = 2;`,
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);

  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousApiKey = process.env.COMPOSIO_API_KEY;
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;
  process.env.COMPOSIO_BACKEND = 'auto';
  process.env.COMPOSIO_API_KEY = 'isolated-sdk-proof-key';
  process.env.COMPOSIO_CLI_PATH = shim;
  __test__.setConnectedAccountsLoader(async () => []);
  let sdkDispatches = 0;
  __test__.setComposioClient({
    tools: {
      execute: async (slug: string, body: Record<string, unknown>) => {
        sdkDispatches += 1;
        return { successful: true, lane: 'sdk', slug, body };
      },
    },
  });
  try {
    const out = await executeComposioTool('PROOF_CREATE_RECORD', { fields: { Name: 'SDK lane proof' } });
    assert.equal((out as { lane?: unknown }).lane, 'sdk');
    assert.equal(sdkDispatches, 1, 'AUTO+key dispatches exactly once through the SDK');
    assert.equal(existsSync(log), false, 'CLI status and execute were both untouched');
  } finally {
    __test__.setConnectedAccountsLoader(null);
    resetComposioClient();
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    if (previousApiKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousApiKey;
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AUTO preserves the original CLI read failure when no SDK key/client is available', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-auto-cli-truth-'));
  const failure = 'retained CLI validation failure: field force_refresh is unsupported';
  const { shim, executeMarker } = createAuthenticatedFailingComposioCli(tmp, failure);
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;

  process.env.COMPOSIO_BACKEND = 'auto';
  process.env.COMPOSIO_CLI_PATH = shim;
  resetComposioClient();
  __test__.setComposioApiKeyOverride('');
  try {
    await assert.rejects(
      executeComposioTool('OUTLOOK_LIST_MESSAGES', { force_refresh: true }),
      (error: unknown) => {
        assert.equal((error as Error).name, 'ComposioCliError');
        assert.match((error as Error).message, new RegExp(failure));
        assert.doesNotMatch((error as Error).message, /COMPOSIO_API_KEY is not configured/);
        return true;
      },
    );
    assert.equal(existsSync(executeMarker), true, 'the authenticated CLI read was actually attempted');
  } finally {
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AUTO still falls back from a failed CLI read when an SDK client is available', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-auto-sdk-fallback-'));
  const { shim, executeMarker } = createAuthenticatedFailingComposioCli(
    tmp,
    'CLI read failed before the SDK fallback proof',
  );
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;

  process.env.COMPOSIO_BACKEND = 'auto';
  process.env.COMPOSIO_CLI_PATH = shim;
  resetComposioClient();
  __test__.setComposioApiKeyOverride('');
  __test__.setConnectedAccountsLoader(async () => []);
  let sdkDispatches = 0;
  __test__.setComposioClient({
    tools: {
      execute: async () => {
        sdkDispatches += 1;
        return { successful: true, lane: 'sdk-fallback' };
      },
    },
  });
  try {
    const out = await executeComposioTool('OUTLOOK_LIST_MESSAGES', { folder: 'inbox' });
    assert.equal((out as { lane?: unknown }).lane, 'sdk-fallback');
    assert.equal(existsSync(executeMarker), true, 'the CLI read failed before fallback');
    assert.equal(sdkDispatches, 1, 'the available SDK performed exactly one fallback read');
  } finally {
    __test__.setConnectedAccountsLoader(null);
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AUTO fallback never replays an ambiguous CLI mutation through the SDK', () => {
  const timeout = new Error('socket timeout after request dispatch');
  assert.equal(composioAutoFallbackAllowed('GOOGLEDOCS_CREATE_DOCUMENT', timeout), false);
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_SEND_EMAIL', new Error('503 Service unavailable')), false);
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_LIST_MESSAGES', timeout), true, 'reads remain retry/fallback safe');
  assert.equal(
    composioAutoFallbackAllowed(
      'GOOGLEDOCS_CREATE_DOCUMENT',
      new ComposioPreDispatchError('cli-unavailable', 'CLI preflight found no executable'),
    ),
    true,
    'a nominal local preflight failure may fall back',
  );
  assert.equal(
    composioAutoFallbackAllowed(
      'GOOGLEDOCS_CREATE_DOCUMENT',
      Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
    ),
    false,
    'an untyped launch-looking error after invocation is not replay provenance',
  );
  assert.equal(composioCliErrorProvesNoDispatch(new Error('ECONNRESET')), false);
  assert.equal(
    composioCliErrorProvesNoDispatch(
      new ComposioPreDispatchError('sdk-unavailable', 'COMPOSIO_API_KEY is not configured.'),
    ),
    true,
  );
  assert.equal(
    composioCliErrorProvesNoDispatch(
      new Error('[provider-dispatch:not-started:cli-auth] no CLI login was detected'),
    ),
    false,
    'marker prose is forgeable provider output, not local provenance',
  );
  assert.match(new ComposioDispatchUncertainError('GOOGLEDOCS_CREATE_DOCUMENT', timeout).message, /Verify the remote state/);
});

test('composioCliErrorProvesNoDispatch: provider text and status-like errors never prove no-dispatch', () => {
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
  // Even launch/version-looking prose is untrusted after invocation. The local
  // preflight wraps genuine zero-dispatch conditions in ComposioPreDispatchError.
  assert.equal(composioCliErrorProvesNoDispatch(new Error('Composio CLI is not installed. Install it or switch the backend to AUTO/SDK.')), false);
  assert.equal(composioCliErrorProvesNoDispatch(Object.assign(new Error('spawn composio ENOENT'), { code: 'ENOENT' })), false);
  assert.equal(composioCliErrorProvesNoDispatch(new Error('unsupported CLI version')), false);
  assert.equal(composioCliErrorProvesNoDispatch(new Error('Unable to retrieve tool; version not found')), false);
});

test('composioAutoFallbackAllowed: a post-dispatch CLI auth error on a mutation no longer authorizes SDK replay', () => {
  // The receipt-ledger double-write class: a CLI mutation that crossed the
  // boundary and failed with auth-shaped text must NOT fall back to the SDK.
  assert.equal(
    composioAutoFallbackAllowed('OUTLOOK_SEND_EMAIL', new Error('Composio CLI execute failed for OUTLOOK_SEND_EMAIL: 401 not authenticated')),
    false,
  );
  // Reads still fall back (idempotent), and only a nominal local preflight
  // failure may authorize mutation fallback.
  assert.equal(composioAutoFallbackAllowed('OUTLOOK_LIST_MESSAGES', new Error('401 not authenticated')), true, 'reads stay fallback-safe');
  assert.equal(
    composioAutoFallbackAllowed(
      'OUTLOOK_SEND_EMAIL',
      new ComposioPreDispatchError('cli-auth', 'no CLI login was detected'),
    ),
    true,
    'typed local pre-dispatch failure may still fall back',
  );
  assert.equal(
    composioAutoFallbackAllowed(
      'OUTLOOK_SEND_EMAIL',
      new Error('[provider-dispatch:not-started:cli-auth] no CLI login was detected'),
    ),
    false,
    'returned marker text may not authorize replay',
  );
});

test('selectAuthConfigIdForToolkit handles current auth config response shapes', () => {
  const items = [
    { id: 'ac_gmail', toolkit: { slug: 'gmail' } },
    { nanoid: 'ac_outlook', toolkit_slug: 'outlook' },
    { authConfigId: 'ac_slack', toolkitSlug: 'slack' },
    { auth_config: { id: 'ac_drive', toolkit_slug: 'googledrive' } },
    { id: 'ac_dual_oauth', toolkit: { slug: 'dual' }, auth_scheme: 'OAUTH2' },
    { id: 'ac_dual_key', toolkit: { slug: 'dual' }, auth_scheme: 'API_KEY' },
  ];

  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'outlook'), 'ac_outlook');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'slack'), 'ac_slack');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'googledrive'), 'ac_drive');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'dual', 'API_KEY'), 'ac_dual_key');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'dual', 'OAUTH2'), 'ac_dual_oauth');
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'dual', 'BASIC'), null);
  assert.equal(__test__.selectAuthConfigIdForToolkit(items, 'missing'), null);
  assert.equal(__test__.authConfigId({ auth_config: { nanoid: 'ac_nested' } }), 'ac_nested');
  assert.equal(__test__.authConfigAuthScheme({ authConfig: 'ignored', auth_scheme: 'BASIC' }), 'BASIC');
});

test('Composio auth-config fallback URL uses the current dashboard path', () => {
  assert.equal(COMPOSIO_AUTH_CONFIGS_URL, 'https://dashboard.composio.dev/~/project/auth-configs');
});

test('in-app connection returns native credential fields without opening Composio', async () => {
  let authorizeCalls = 0;
  const result = await prepareInAppToolkitConnection('firecrawl', {
    getSetupMeta: async () => ({
      name: 'Firecrawl',
      description: null,
      appUrl: null,
      authHintUrl: null,
      authGuideUrl: null,
      authScheme: 'API_KEY',
      fields: [
        { name: 'full', label: 'Base URL', description: null, default: 'https://api.firecrawl.dev/v1', isSecret: false, required: true },
        { name: 'generic_api_key', label: 'API Key', description: null, default: null, isSecret: true, required: true },
      ],
    }),
    authorize: async () => { authorizeCalls += 1; return { redirectUrl: 'https://should-not-open.test', connectionId: '' }; },
    setupOAuth: async () => ({ ok: true, authConfigId: 'unused' }),
  });

  assert.equal(result.kind, 'credentials');
  assert.equal(result.setup.fields[0].name, 'full');
  assert.equal(authorizeCalls, 0, 'non-OAuth credentials stay inside Clementine');
});

test('native credential selection preserves exact live field names, fills defaults, and drops extras', () => {
  const selected = selectToolkitCredentialValues({
    name: 'Firecrawl',
    description: null,
    appUrl: null,
    authHintUrl: null,
    authGuideUrl: null,
    authScheme: 'API_KEY',
    fields: [
      { name: 'full', label: 'Base URL', description: null, default: 'https://api.firecrawl.dev/v1', isSecret: false, required: true },
      { name: 'generic_api_key', label: 'API Key', description: null, default: null, isSecret: true, required: true },
    ],
  }, {
    generic_api_key: '  fc-secret  ',
    attacker_supplied: 'must-not-cross',
  });

  assert.deepEqual(selected, {
    credentials: {
      full: 'https://api.firecrawl.dev/v1',
      generic_api_key: 'fc-secret',
    },
    missing: [],
  });
});

test('native credential selection reports missing fields by their human labels', () => {
  const selected = selectToolkitCredentialValues({
    name: 'DataForSEO',
    description: null,
    appUrl: null,
    authHintUrl: null,
    authGuideUrl: null,
    authScheme: 'BASIC',
    fields: [
      { name: 'username', label: 'API Login', description: null, default: null, isSecret: false, required: true },
      { name: 'password', label: 'API Password', description: null, default: null, isSecret: true, required: true },
    ],
  }, { username: 'user@example.com' });
  assert.deepEqual(selected.missing, ['API Password']);
});

test('in-app OAuth provisions missing managed auth then retries once', async () => {
  let authorizeCalls = 0;
  let setupCalls = 0;
  const result = await prepareInAppToolkitConnection('github', {
    getSetupMeta: async () => ({
      name: 'GitHub',
      description: null,
      appUrl: null,
      authHintUrl: null,
      authGuideUrl: null,
      authScheme: 'OAUTH2',
      fields: [],
    }),
    authorize: async (slug) => {
      authorizeCalls += 1;
      if (authorizeCalls === 1) throw new ComposioNeedsAuthConfigError(slug, 'missing');
      return { redirectUrl: 'https://connect.example.test/github', connectionId: 'ca_new' };
    },
    setupOAuth: async () => { setupCalls += 1; return { ok: true, authConfigId: 'ac_github' }; },
  });

  assert.equal(result.kind, 'authorization');
  assert.equal(result.redirectUrl, 'https://connect.example.test/github');
  assert.equal(authorizeCalls, 2);
  assert.equal(setupCalls, 1);
});

test('in-app OAuth with an existing config does not create another', async () => {
  let setupCalls = 0;
  const result = await prepareInAppToolkitConnection('notion', {
    getSetupMeta: async () => ({
      name: 'Notion',
      description: null,
      appUrl: null,
      authHintUrl: null,
      authGuideUrl: null,
      authScheme: 'OAUTH2',
      fields: [],
    }),
    authorize: async () => ({ redirectUrl: 'https://connect.example.test/notion', connectionId: 'ca_notion' }),
    setupOAuth: async () => { setupCalls += 1; return { ok: true, authConfigId: 'unused' }; },
  });

  assert.equal(result.kind, 'authorization');
  assert.equal(setupCalls, 0);
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

test('loneToolkitConnection: pins the single connection for a toolkit (never bare-dispatch when one exists), but never guesses among ambiguous', () => {
  const conns: ConnectedToolkit[] = [
    { slug: 'apify', connectionId: 'ca_apify', status: 'ACTIVE', ownerUserId: 'pg-test' },
    { slug: 'firecrawl', connectionId: 'ca_fc', status: 'EXPIRED', ownerUserId: 'pg-test' },
    { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE', accountEmail: 'a@x.com' },
    { slug: 'outlook', connectionId: 'ca_b', status: 'ACTIVE', accountEmail: 'b@x.com' },
  ];
  // Single connection → pin it, regardless of status (a stale pin yields a precise
  // reconnect error; a bare dispatch yields an opaque AuthSchemeNotFound).
  assert.equal(loneToolkitConnection('APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', conns), 'ca_apify');
  assert.equal(loneToolkitConnection('FIRECRAWL_SEARCH', conns), 'ca_fc');
  // Two distinct connections for the toolkit → do NOT guess (must ASK).
  assert.equal(loneToolkitConnection('OUTLOOK_SEND_EMAIL', conns), undefined);
  // No connection for the toolkit → undefined (falls through to a legible bare fail).
  assert.equal(loneToolkitConnection('GMAIL_LIST_EMAILS', conns), undefined);
  // A bare toolkit prefix must not cross-match (google !== googledrive).
  assert.equal(loneToolkitConnection('GOOGLEDRIVE_DOWNLOAD_FILE', [
    { slug: 'google', connectionId: 'ca_g', status: 'ACTIVE' },
  ]), undefined);
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

test('ROOT CAUSE: a transient refresh failure serves last-good (never empties a healthy lane → no false AuthSchemeNotFound under fan-out load)', async () => {
  const prev = process.env.COMPOSIO_USER_ID;
  process.env.COMPOSIO_USER_ID = 'user-main'; // dispatch entity owns NOTHING (the prod shape)
  let mode: 'ok' | 'throw' = 'ok';
  __test__.setConnectedAccountsLoader(async () => {
    if (mode === 'throw') throw new Error('429 Too Many Requests — snapshot throttled under a wide fan-out');
    // Apify connection is live but owned by a DIFFERENT entity (pg-test), exactly as in prod.
    return [account('ca_apify', 'apify', 'pg-test-owner')];
  });
  try {
    // 1) Warm the last-good snapshot.
    assert.deepEqual(
      (await listConnectedToolkits({ requireFresh: true })).map((c) => c.connectionId),
      ['ca_apify'],
    );
    // 2) Fan-out reality: the self-heal invalidates the cache, then the refetch throttles.
    clearConnectedToolkitsCache();
    mode = 'throw';
    const underLoad = await listConnectedToolkits({ requireFresh: true });
    assert.deepEqual(underLoad.map((c) => c.connectionId), ['ca_apify'],
      'serves last-good instead of [] on a throttled refresh');
    // 3) The payoff: resolution still finds the connection → dispatch stays owner-paired,
    //    NOT a bare dispatch under user-main that would false-fail AuthSchemeNotFound.
    const resolved = await resolveToolkitConnectionId('APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
    assert.equal(resolved, 'ca_apify', 'resolution survives the transient failure');
  } finally {
    __test__.setConnectedAccountsLoader(null);
    if (prev === undefined) delete process.env.COMPOSIO_USER_ID;
    else process.env.COMPOSIO_USER_ID = prev;
  }
});

test('raw + SDK share one absolute deadline; timeout preserves last-good and a late SDK result cannot publish', async (t) => {
  __test__.setConnectedAccountsLoader(async () => [
    account('ca_deadline_good', 'outlook', 'owner-deadline-good'),
  ]);
  assert.deepEqual(
    (await listConnectedToolkits({ requireFresh: true })).map((row) => row.connectionId),
    ['ca_deadline_good'],
  );

  let sdkCalls = 0;
  let resolveSdk!: (value: unknown) => void;
  const lateSdk = new Promise<unknown>((resolve) => { resolveSdk = resolve; });
  let rawSignal: AbortSignal | undefined;
  let completed = false;
  __test__.setComposioApiKeyOverride('account-deadline-fixture-key');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  __test__.setConnectedAccountsListTransports({
    rawList: ({ signal }) => {
      rawSignal = signal;
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: false,
          status: 503,
          json: async () => ({ items: [] }),
        }), 10_000);
      });
    },
    sdkList: () => {
      sdkCalls += 1;
      return lateSdk;
    },
  });

  const flushMicrotasks = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  try {
    const refresh = listConnectedToolkits({ requireFresh: true });
    void refresh.then(
      () => { completed = true; },
      () => { completed = true; },
    );

    t.mock.timers.tick(9_999);
    await flushMicrotasks();
    assert.equal(completed, false, 'raw leg remains inside the one phase deadline');
    assert.equal(sdkCalls, 0);

    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(sdkCalls, 1, 'raw failure falls through to SDK with only the remaining time');
    assert.equal(completed, false);

    t.mock.timers.tick(4_999);
    await flushMicrotasks();
    assert.equal(completed, false, 'SDK does not receive a fresh 15 second window');

    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.deepEqual(
      (await refresh).map((row) => row.connectionId),
      ['ca_deadline_good'],
      'the phase timeout serves the seeded last-good snapshot',
    );
    assert.equal(rawSignal?.aborted, true, 'the absolute phase deadline aborts the raw transport owner');
    assert.equal(peekCurrentConnectedToolkits(), null,
      'a timeout never mints a fresh execution-preparation observation');
    assert.deepEqual(peekConnectedToolkits().map((row) => row.connectionId), ['ca_deadline_good']);

    resolveSdk({
      items: [account('ca_deadline_late', 'outlook', 'owner-deadline-late')],
    });
    await flushMicrotasks();
    assert.equal(peekCurrentConnectedToolkits(), null,
      'the abandoned SDK completion cannot publish current authority');
    assert.deepEqual(
      peekConnectedToolkits().map((row) => row.connectionId),
      ['ca_deadline_good'],
      'the abandoned SDK completion cannot overwrite last-good',
    );
    assert.equal(
      dispatchUserIdFor('ca_deadline_late', [], 'fallback-after-late-sdk'),
      'fallback-after-late-sdk',
      'the abandoned SDK completion cannot record connection-owner authority',
    );
  } finally {
    resolveSdk({ items: [] });
    await flushMicrotasks();
    __test__.setConnectedAccountsListTransports(null);
    __test__.setComposioApiKeyOverride(null);
    t.mock.timers.reset();
    resetComposioClient();
  }
});

test('a successful provider 200 with an actual empty items array authoritatively clears last-good', async () => {
  __test__.setConnectedAccountsLoader(async () => [
    account('ca_before_provider_empty', 'outlook', 'owner-before-provider-empty'),
  ]);
  assert.deepEqual(
    (await listConnectedToolkits({ requireFresh: true })).map((row) => row.connectionId),
    ['ca_before_provider_empty'],
  );

  let rawCalls = 0;
  let sdkCalls = 0;
  __test__.setComposioApiKeyOverride('account-empty-fixture-key');
  __test__.setConnectedAccountsListTransports({
    rawList: async () => {
      rawCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      };
    },
    sdkList: () => {
      sdkCalls += 1;
      return Promise.resolve({ items: [account('ca_sdk_must_not_run', 'outlook', 'owner-sdk')] });
    },
  });
  try {
    assert.deepEqual(await listConnectedToolkits({ requireFresh: true }), []);
    assert.equal(rawCalls, 1);
    assert.equal(sdkCalls, 0, 'an authoritative raw response never falls through to SDK');
    assert.deepEqual(peekConnectedToolkits(), [], 'the authoritative empty replaces last-good');
    assert.deepEqual(peekCurrentConnectedToolkits(), [], 'the empty provider observation is current');
  } finally {
    __test__.setConnectedAccountsListTransports(null);
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
  }
});

test('selectToolkitConnection: 3 re-auths of ONE mailbox collapse → freshest ACTIVE (the reported bug)', () => {
  const conn = (connectionId: string, status: string, createdAt: string): ConnectedToolkit =>
    ({ slug: 'outlook', connectionId, status, accountEmail: 'alex@corp.example', createdAt });
  const out = selectToolkitConnection('OUTLOOK_LIST_MESSAGES', [
    conn('ca_old', 'ACTIVE', '2026-07-01T00:00:00Z'),
    conn('ca_mid', 'ACTIVE', '2026-07-05T00:00:00Z'),
    conn('ca_new', 'ACTIVE', '2026-07-10T00:00:00Z'),
  ]);
  assert.deepEqual(out, { kind: 'resolved', connectionId: 'ca_new', identity: 'alex@corp.example' });
});

test('selectToolkitConnection: active-tier beats createdAt (a fresh INITIATED re-auth cannot hijack a working ACTIVE)', () => {
  const out = selectToolkitConnection('OUTLOOK_LIST_MESSAGES', [
    { slug: 'outlook', connectionId: 'ca_active', status: 'ACTIVE', accountEmail: 'a@site.example', createdAt: '2026-07-01T00:00:00Z' },
    { slug: 'outlook', connectionId: 'ca_initiated', status: 'INITIATED', accountEmail: 'a@site.example', createdAt: '2026-07-10T00:00:00Z' },
  ]);
  assert.equal(out.kind === 'resolved' && out.connectionId, 'ca_active');
});

test('selectToolkitConnection: two DISTINCT mailboxes with no hint → ambiguous (ASK), never a silent pick', () => {
  const out = selectToolkitConnection('OUTLOOK_SEND_EMAIL', [
    { slug: 'outlook', connectionId: 'ca_work', status: 'ACTIVE', accountEmail: 'work@site.example' },
    { slug: 'outlook', connectionId: 'ca_home', status: 'ACTIVE', accountEmail: 'home@personal.example' },
  ]);
  assert.equal(out.kind, 'ambiguous');
  assert.equal(out.kind === 'ambiguous' && out.candidates.length, 2);
});

test('selectToolkitConnection: identity hint routes to the matching mailbox; a miss is identity-absent (ASK)', () => {
  const conns: ConnectedToolkit[] = [
    { slug: 'outlook', connectionId: 'ca_work', status: 'ACTIVE', accountEmail: 'work@site.example' },
    { slug: 'outlook', connectionId: 'ca_home', status: 'ACTIVE', accountEmail: 'home@personal.example' },
  ];
  assert.deepEqual(
    selectToolkitConnection('OUTLOOK_SEND_EMAIL', conns, 'HOME@personal.example'),
    { kind: 'resolved', connectionId: 'ca_home', identity: 'home@personal.example' },
  );
  const miss = selectToolkitConnection('OUTLOOK_SEND_EMAIL', conns, 'gone@archive.example');
  assert.equal(miss.kind, 'identity-absent');
  assert.equal(miss.kind === 'identity-absent' && miss.want, 'gone@archive.example');
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
    { slug: 'outlook', connectionId: 'ca_x', status: 'EXPIRED', accountEmail: 'a@site.example' },
    { slug: 'outlook', connectionId: 'ca_y', status: 'REVOKED', accountEmail: 'a@site.example' },
  ]);
  assert.deepEqual(out, { kind: 'defer' });
});

test('selectToolkitConnection: canonical matcher — underscore toolkit slugs match, bare prefixes do not', () => {
  const oneDrive = selectToolkitConnection('ONE_DRIVE_UPLOAD_FILE', [
    { slug: 'one_drive', connectionId: 'ca_od', status: 'ACTIVE', accountEmail: 'a@site.example' },
  ]);
  assert.equal(oneDrive.kind === 'resolved' && oneDrive.connectionId, 'ca_od');
  // A bare `google` connection must NOT match a GOOGLEDRIVE_* tool.
  const noMatch = selectToolkitConnection('GOOGLEDRIVE_DOWNLOAD_FILE', [
    { slug: 'google', connectionId: 'ca_g', status: 'ACTIVE', accountEmail: 'a@site.example' },
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

// A post-failure auth probe only establishes the lane's current health. It
// cannot prove whether the earlier mutation committed before its response was
// lost, so neither 401 prose nor a marker may authorize replay.
test('composioAutoFallbackAllowed requires nominal local provenance for mutations', async () => {
  const { composioAutoFallbackAllowed } = await import('./client.js');
  assert.equal(
    composioAutoFallbackAllowed('SLACK_SEND_MESSAGE', new Error('HTTP 401 Unauthorized')),
    false,
    'bare 401 text never proves no-dispatch',
  );
  assert.equal(
    composioAutoFallbackAllowed('SLACK_SEND_MESSAGE', new Error('[provider-dispatch:not-started:cli-auth] no CLI login')),
    false,
    'provider-returned marker text is not replay provenance',
  );
  assert.equal(
    composioAutoFallbackAllowed(
      'SLACK_SEND_MESSAGE',
      new ComposioPreDispatchError('cli-auth', 'local status probe ran before invocation'),
    ),
    true,
    'a locally constructed pre-dispatch condition remains replay-safe',
  );
});

test('a benched CLI lane reports unauthenticated so AUTO routes SDK-first until recovery', async () => {
  const { benchComposioCliAuth, _resetComposioCliBenchForTests, getComposioCliStatus } = await import('./cli.js');
  try {
    benchComposioCliAuth();
    const status = await getComposioCliStatus();
    assert.equal(status.authenticated, false, 'benched lane never claims authenticated');
    assert.match(status.authMessage ?? '', /proven auth-dead/, 'the bench explains itself');
  } finally {
    _resetComposioCliBenchForTests();
  }
});

test("SDK ComposioToolNotFoundError is nominal proof of ZERO dispatch — a wrong slug never parks a turn as uncertain (live 2026-07-31)", async () => {
  const { ComposioToolNotFoundError } = await import('@composio/core');
  // The SDK throws this class at exactly ONE site: the tool-definition GET
  // inside execute, BEFORE any execution request is constructed. The wrong
  // GOOGLESHEETS slug tonight took this path and got misfiled as ambiguous,
  // cascading into the artifact jail ("the sheet died mid-flight" — it never
  // dispatched at all).
  const sdkErr = new ComposioToolNotFoundError('Unable to retrieve tool with slug GOOGLESHEETS_CREATE_GOOGLE_SHEET');
  const wrapped = new ComposioPreDispatchError(
    'tool-not-found',
    'Tool slug "GOOGLESHEETS_CREATE_GOOGLE_SHEET" does not exist in the Composio catalog — the provider never received any request.',
    sdkErr,
  );
  assert.equal(composioCliErrorProvesNoDispatch(wrapped), true, 'the wrapped resolver miss is replay-safe proof');
  assert.match(wrapped.message, /never received any request/i, 'the message teaches the truth');
  // TEXT alone (a provider could echo it post-commit) still proves nothing —
  // the long-standing nominal rule is intact.
  assert.equal(composioCliErrorProvesNoDispatch(new Error('Unable to retrieve tool with slug X — Tool not found')), false);
});
