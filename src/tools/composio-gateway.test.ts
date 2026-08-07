/**
 * Run: npx tsx --test src/tools/composio-gateway.test.ts
 *
 * Boundary tests for the composio dispatch GATEWAY — the single front door for
 * chat, workflow exact-call, Space, batch, and background dispatch. Locks the
 * invariants from the 2026-07-11 convergence review:
 *   - owner routing: recalled mailbox identity routes to its live connection
 *   - ambiguity → TYPED block, ZERO CLI/SDK dispatch (reads included)
 *   - identity-absent (remembered mailbox gone) → typed block, never a guess
 *   - every block is ledgered (guardrail_tripped: composio_gateway)
 *   - reconnect breaker is NARROW: only fires when the snapshot confirms zero
 *     usable connections; a visible reconnect disarms it without TTL
 *   - CLI/SDK selection: a pinned owner can never dispatch via the CLI
 *     (the CLI cannot target a specific connected account)
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-gateway-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'gateway-test-machine\n');
// No API key: any dispatch that reached the client would throw
// "COMPOSIO_API_KEY is not configured" — so a clean typed block RETURNING
// (not throwing) is itself proof of zero dispatch.
delete process.env.COMPOSIO_API_KEY;
// Resolver tests exercise SDK account-routing semantics unless a test
// explicitly switches to the CLI-only lane.
process.env.COMPOSIO_BACKEND = 'sdk';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  __test__,
  bustComposioDashboardCaches,
  resetComposioClient,
} = await import('../integrations/composio/client.js');
const {
  resolveComposioDispatch,
  dispatchComposioTool,
  composioDispatchLaneAvailable,
  composioCliCanResolveUnlistedConnectedAccount,
  __gatewayTest__,
} = await import('./composio-tools.js');
const { deleteToolChoice, rememberToolChoice } = await import('../memory/tool-choice-store.js');
const { createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { rememberAccountAlias, resolveAccountAlias } = await import('../memory/account-alias-store.js');
const { recordIdentityProbe } = await import('../integrations/composio/identity-cache.js');
const {
  grantComposioCliDefaultAccountAuthority,
  revokeComposioCliDefaultAccountAuthority,
} = await import('../integrations/composio/cli-default-account-authority.js');

type LoaderItem = Record<string, unknown>;
function account(id: string, toolkit: string, email?: string, status = 'ACTIVE'): LoaderItem {
  return {
    id,
    toolkit: { slug: toolkit },
    status,
    // extractAccountIdentity reads data.user_info.email (among other shapes).
    ...(email ? { data: { user_info: { email } } } : {}),
  };
}

function setAccounts(items: LoaderItem[]): void {
  // setConnectedAccountsLoader invalidates the snapshot, so the next
  // listUsableConnectedToolkits() fetches through this loader.
  __test__.setConnectedAccountsLoader(async () => items);
}

test('ambiguity → typed block with candidates, ZERO dispatch (reads included)', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  // A READ (not a send): the gateway still blocks — reading the wrong mailbox
  // produces confidently-wrong answers. Returning (not throwing) proves the
  // client was never reached (no API key would have thrown).
  const out = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', {}, undefined, {});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'ambiguous-account');
    assert.equal(out.candidates?.length, 2);
    assert.match(out.message, /NEEDS-YOUR-CHOICE/);
    assert.match(out.message, /connected_account_id/, 'ASK teaches the pin-and-retry path');
  }
  // Same through the one-shot wrapper (the Space/workflow path) — typed block, no throw.
  const wrapped = await dispatchComposioTool('OUTLOOK_LIST_MESSAGES', {}, {});
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) assert.equal(wrapped.reason, 'ambiguous-account');
});

test('owner routing: a recalled mailbox identity resolves the ambiguity to its live connection', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  rememberToolChoice({
    intent: 'list unread inbox messages',
    choice: { kind: 'composio', identifier: 'OUTLOOK_LIST_MESSAGES', accountIdentity: 'home@personal.example' },
  });
  const out = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', {}, undefined, {});
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.connectionId, 'ca_home');
    assert.equal(out.identity, 'home@personal.example');
    assert.ok(out.notes.some((n) => n.includes('home@personal.example')), 'route note names the remembered mailbox');
  }
});

test('identity-absent: the remembered mailbox is no longer connected → typed block, never a fallback guess', async () => {
  setAccounts([
    account('ca_other', 'gmail', 'other@archive.example'),
    account('ca_second', 'gmail', 'second@archive.example'),
  ]);
  rememberToolChoice({
    intent: 'send the weekly gmail digest',
    choice: { kind: 'composio', identifier: 'GMAIL_SEND_EMAIL', accountIdentity: 'gone@archive.example' },
  });
  const out = await resolveComposioDispatch('GMAIL_SEND_EMAIL', {}, undefined, {});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'identity-absent');
    assert.match(out.message, /gone@archive\.example/);
  }
});

test('single distinct mailbox (duplicate re-auths) resolves to the freshest ACTIVE — no block', async () => {
  setAccounts([
    { ...account('ca_old', 'airtable', 'me@site.example'), createdAt: '2026-07-01T00:00:00Z' },
    { ...account('ca_new', 'airtable', 'me@site.example'), createdAt: '2026-07-10T00:00:00Z' },
  ]);
  const out = await resolveComposioDispatch('AIRTABLE_LIST_RECORDS', {}, undefined, {});
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.connectionId, 'ca_new');
});

test('blocked ledger semantics: every gateway block emits guardrail_tripped(composio_gateway) with the reason', async () => {
  setAccounts([
    account('ca_a', 'slack', 'a@site.example'),
    account('ca_b', 'slack', 'b@personal.example'),
  ]);
  const sess = createSession({ kind: 'chat' });
  const out = await resolveComposioDispatch('SLACK_SEND_MESSAGE', {}, undefined, { sessionId: sess.id });
  assert.equal(out.ok, false);
  const events = listEvents(sess.id, { types: ['guardrail_tripped'] });
  const gw = events.filter((e) => {
    const d = (e as { data?: unknown }).data as Record<string, unknown> | undefined
      ?? JSON.parse((e as unknown as { data_json?: string }).data_json ?? '{}');
    return d?.guardrail === 'composio_gateway' && d?.reason === 'ambiguous-account';
  });
  assert.equal(gw.length, 1, 'exactly one ledgered gateway block');
});

test('breaker is NARROW: fires only when the snapshot confirms zero usable connections; a reconnect disarms it', async () => {
  const sid = 'sess-gw-breaker';
  // Trip the breaker for a toolkit with NO connections.
  setAccounts([]);
  __gatewayTest__.recordReconnectBreaker(sid, 'NOTION_SEARCH_PAGES');
  const dead = await resolveComposioDispatch('NOTION_SEARCH_PAGES', {}, undefined, { sessionId: sid });
  assert.equal(dead.ok, false);
  if (!dead.ok) assert.equal(dead.reason, 'not-connected');
  // The user reconnects (a usable connection appears): the SAME tripped breaker
  // must NOT block — the narrow condition (zero usable) no longer holds.
  setAccounts([account('ca_notion', 'notion', 'n@site.example')]);
  const alive = await resolveComposioDispatch('NOTION_SEARCH_PAGES', {}, undefined, { sessionId: sid });
  assert.equal(alive.ok, true, 'a visible reconnect disarms the breaker without waiting for TTL');
  __gatewayTest__.clearReconnectBreaker(sid, 'NOTION_SEARCH_PAGES');
});

test('multiword toolkit semantics keep OneDrive distinct in breaker, ask, and guardrail evidence', async () => {
  const sid = createSession({ kind: 'chat' }).id;
  __gatewayTest__.recordReconnectBreaker(sid, 'ONE_DRIVE_LIST_FILES');
  assert.equal(__gatewayTest__.reconnectBreakerTripped(sid, 'ONE_DRIVE_UPLOAD_FILE'), true);
  assert.equal(
    __gatewayTest__.reconnectBreakerTripped(sid, 'ONE_NOTE_LIST_PAGES'),
    false,
    'one_drive and one_note cannot collide under a generic "one" key',
  );
  __gatewayTest__.clearReconnectBreaker(sid, 'ONE_DRIVE_LIST_FILES');

  setAccounts([
    account('ca_one_drive_work', 'one_drive', 'work@drive.example'),
    account('ca_one_drive_home', 'one_drive', 'home@drive.example'),
  ]);
  const out = await resolveComposioDispatch(
    'ONE_DRIVE_LIST_FILES',
    {},
    undefined,
    { sessionId: sid },
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'ambiguous-account');
    assert.equal(out.toolkit, 'one_drive');
    assert.match(out.message, /NEEDS-YOUR-CHOICE \(one_drive\)/);
  }
  const [event] = listEvents(sid, { types: ['guardrail_tripped'] });
  assert.equal(event?.data.toolkit, 'one_drive');
});

test('an SDK-managed toolkit with zero usable connections blocks before its first dispatch', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'sdk';
  setAccounts([]);
  try {
    const out = await resolveComposioDispatch('GOOGLESHEETS_BATCH_UPDATE', {}, undefined, {});
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.reason, 'not-connected');
      assert.match(out.message, /No provider dispatch was started/);
    }
  } finally {
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('dispatch-lane availability distinguishes SDK, CLI, and AUTO auth without guessing', () => {
  const deadCli = { installed: true, authenticated: false, authStatus: 'error' as const };
  const liveCli = { installed: true, authenticated: true, authStatus: 'ok' as const };
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'sdk', apiKeyPresent: false, cli: liveCli }), false);
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'sdk', apiKeyPresent: true, cli: deadCli }), true);
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'cli', apiKeyPresent: true, cli: deadCli }), false);
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'cli', apiKeyPresent: false, cli: liveCli }), true);
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'auto', apiKeyPresent: false, cli: deadCli }), false);
  assert.equal(composioDispatchLaneAvailable({ executionBackend: 'auto', apiKeyPresent: true, cli: deadCli }), true);
});

test('an empty SDK snapshot makes provider-default resolution eligible only on a positively authenticated CLI lane', () => {
  const deadCli = { installed: true, authenticated: false, authStatus: 'error' as const };
  const unknownCli = { installed: true, authenticated: false, authStatus: 'unknown' as const };
  const liveCli = { installed: true, authenticated: true, authStatus: 'ok' as const };

  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'auto',
      apiKeyPresent: false,
      cli: liveCli,
    }),
    true,
    'AUTO without an SDK key is eligible for CLI provider-default resolution',
  );
  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'cli',
      apiKeyPresent: true,
      cli: liveCli,
    }),
    true,
    'an explicit CLI backend remains provider-default eligible even when an unused SDK key exists',
  );
  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'auto',
      apiKeyPresent: true,
      cli: liveCli,
    }),
    false,
    'AUTO with an SDK key treats the SDK account snapshot as authoritative',
  );
  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'sdk',
      apiKeyPresent: false,
      cli: liveCli,
    }),
    false,
  );
  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'cli',
      apiKeyPresent: false,
      cli: deadCli,
    }),
    false,
  );
  assert.equal(
    composioCliCanResolveUnlistedConnectedAccount({
      executionBackend: 'cli',
      apiKeyPresent: false,
      cli: unknownCli,
    }),
    false,
    'unknown auth may probe no-auth tools but cannot authorize account-bearing writes',
  );
});

test('CLI-only reads remain lightweight, writes require durable default-account authority, and account selectors fail closed', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  setAccounts([]);
  __gatewayTest__.setRuntimeStatusLoader(async () => ({
    enabled: true,
    apiKeyPresent: false,
    userId: 'cli-only-test-user',
    executionBackend: 'cli',
    cli: {
      installed: true,
      path: '/test/composio',
      version: 'test',
      authenticated: true,
      authStatus: 'ok',
      authMessage: 'cli-only-test-user',
    },
  }));
  try {
    const knownRead = await resolveComposioDispatch('AIRTABLE_LIST_RECORDS', {}, undefined, {});
    const unknownRead = await resolveComposioDispatch('NEWCRM_LIST_RECORDS', {}, undefined, {});
    const unknownWrite = await resolveComposioDispatch(
      'NEWCRM_CREATE_RECORD',
      { fields: { Name: 'Proof' } },
      undefined,
      {},
    );
    for (const out of [knownRead, unknownRead]) {
      assert.equal(out.ok, true, 'an authenticated CLI default remains a usable lightweight read lane');
      if (out.ok) {
        assert.equal(out.connectionId, undefined);
        assert.ok(out.notes.some((note) => /read through the authenticated Composio CLI/i.test(note)));
      }
    }
    assert.equal(unknownWrite.ok, false, 'CLI whoami alone cannot establish write authority');
    if (!unknownWrite.ok) {
      assert.equal(unknownWrite.reason, 'ambiguous-account');
      assert.match(unknownWrite.message, /authorize.*CLI default in Connect/i);
      assert.match(unknownWrite.message, /Reads remain available/i);
      assert.match(unknownWrite.message, /No provider dispatch was started/i);
    }

    const explicitlyPinnedWrite = await resolveComposioDispatch(
      'NOTION_CREATE_PAGE',
      { parent_id: 'page-proof', title: 'Proof' },
      'ca_cli_explicit',
      {},
    );
    assert.equal(explicitlyPinnedWrite.ok, false, 'CLI execute cannot honor an explicit connected account pin');
    if (!explicitlyPinnedWrite.ok) {
      assert.match(explicitlyPinnedWrite.message, /cannot honor connected_account_id/i);
      assert.match(explicitlyPinnedWrite.message, /COMPOSIO_BACKEND=sdk/i);
      assert.match(explicitlyPinnedWrite.message, /No provider dispatch was started/i);
    }

    // Even a lone row in an SDK inventory does not make it routable by the CLI.
    // Without deliberate default-account authority, it remains a typed block.
    setAccounts([account('ca_cli_single', 'airtable', 'only@example.test')]);
    const singleAccountWrite = await resolveComposioDispatch(
      'AIRTABLE_CREATE_RECORD',
      { base_id: 'app-proof', table_id: 'tbl-proof', fields: { Name: 'Proof' } },
      undefined,
      {},
    );
    assert.equal(singleAccountWrite.ok, false, 'a single SDK inventory owner is not CLI routing authority');
    if (!singleAccountWrite.ok) {
      assert.match(singleAccountWrite.message, /authorize.*CLI default in Connect/i);
      assert.match(singleAccountWrite.message, /No provider dispatch was started/i);
    }
  } finally {
    __gatewayTest__.setRuntimeStatusLoader(null);
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('CLI account-specific blocks name preferred/remembered identity and a concrete recovery', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  setAccounts([]);
  __gatewayTest__.setRuntimeStatusLoader(async () => ({
    enabled: true,
    apiKeyPresent: false,
    userId: 'cli-account-copy-user',
    executionBackend: 'cli',
    cli: {
      installed: true,
      path: '/test/composio',
      version: 'test',
      authenticated: true,
      authStatus: 'ok',
      authMessage: 'cli-account-copy-user',
    },
  }));
  try {
    const preferred = await resolveComposioDispatch(
      'ONE_DRIVE_LIST_FILES',
      {},
      undefined,
      { preferredIdentity: 'finance@drive.example' },
    );
    assert.equal(preferred.ok, false);
    if (!preferred.ok) {
      assert.match(preferred.message, /finance@drive\.example/);
      assert.match(preferred.message, /preferred/i);
      assert.match(preferred.message, /clear|retry without/i);
      assert.match(preferred.message, /COMPOSIO_BACKEND=sdk/i);
    }

    const rememberedIntent = 'list files from remembered one drive';
    rememberToolChoice({
      intent: rememberedIntent,
      choice: {
        kind: 'composio',
        identifier: 'ONE_DRIVE_LIST_FILES',
        accountIdentity: 'archive@drive.example',
      },
    });
    const remembered = await resolveComposioDispatch(
      'ONE_DRIVE_LIST_FILES',
      {},
      undefined,
      {},
    );
    assert.equal(remembered.ok, false);
    if (!remembered.ok) {
      assert.match(remembered.message, /archive@drive\.example/);
      assert.match(remembered.message, /remembered/i);
      assert.match(remembered.message, /tool_choice_forget|Tool Memory/i);
    }
  } finally {
    deleteToolChoice('list files from remembered one drive');
    __gatewayTest__.setRuntimeStatusLoader(null);
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('CLI default-account authority uses the longest known toolkit prefix and preserves generic discovery', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'one_drive',
    label: 'isolated-one-drive',
    grantedBy: 'test',
  });
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'newcrm',
    label: 'isolated-generic',
    grantedBy: 'test',
  });
  setAccounts([]);
  __gatewayTest__.setRuntimeStatusLoader(async () => ({
    enabled: true,
    apiKeyPresent: false,
    userId: 'cli-prefix-test-user',
    executionBackend: 'cli',
    cli: {
      installed: true,
      path: '/test/composio',
      version: 'test',
      authenticated: true,
      authStatus: 'ok',
      authMessage: 'cli-prefix-test-user',
    },
  }));
  try {
    const oneDrive = await resolveComposioDispatch(
      'ONE_DRIVE_CREATE_FOLDER',
      { name: 'Proof folder' },
      undefined,
      {},
    );
    assert.equal(oneDrive.ok, true, 'ONE_DRIVE_* resolves authority as one_drive, not one');
    if (oneDrive.ok) {
      assert.ok(oneDrive.notes.some((note) => /scoped specifically to one_drive/i.test(note)));
    }

    const generic = await resolveComposioDispatch(
      'NEWCRM_CREATE_RECORD',
      { fields: { Name: 'Proof' } },
      undefined,
      {},
    );
    assert.equal(generic.ok, true, 'unknown single-token toolkit discovery keeps its generic fallback');
    if (generic.ok) {
      assert.ok(generic.notes.some((note) => /scoped specifically to newcrm/i.test(note)));
    }
  } finally {
    __gatewayTest__.setRuntimeStatusLoader(null);
    await revokeComposioCliDefaultAccountAuthority('one_drive');
    await revokeComposioCliDefaultAccountAuthority('newcrm');
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('operator-authorized CLI default dispatches end-to-end with no false connected-account pin', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;
  const shimPath = path.join(TMP_HOME, 'composio-gateway-cli-proof.mjs');
  const shimLog = path.join(TMP_HOME, 'composio-gateway-cli-proof.jsonl');
  writeFileSync(shimPath, [
    `import { appendFileSync } from 'node:fs';`,
    `const argv = process.argv.slice(2);`,
    `appendFileSync(process.env.CLEMMY_COMPOSIO_SHIM_LOG, JSON.stringify(argv) + '\\n');`,
    `if (argv[0] === '--version') console.log('composio-proof 1.0.0');`,
    `else if (argv[0] === 'whoami') console.log('isolated-proof-operator');`,
    `else if (argv[0] === 'execute') console.log(JSON.stringify({ successful: true, data: { slug: argv[1], arguments: JSON.parse(argv[3] ?? '{}') } }));`,
    `else { console.error('unsupported command'); process.exitCode = 2; }`,
    '',
  ].join('\n'));
  chmodSync(shimPath, 0o755);
  process.env.COMPOSIO_BACKEND = 'cli';
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'proof',
    label: 'isolated-proof',
    grantedBy: 'test',
  });
  process.env.COMPOSIO_CLI_PATH = shimPath;
  process.env.CLEMMY_COMPOSIO_SHIM_LOG = shimLog;
  delete process.env.COMPOSIO_API_KEY;
  setAccounts([]);
  __gatewayTest__.setRuntimeStatusLoader(null);
  resetComposioClient();
  bustComposioDashboardCaches();
  try {
    const out = await dispatchComposioTool(
      'PROOF_CREATE_RECORD',
      { fields: { Name: 'End-to-end CLI proof' } },
      {},
    );
    assert.equal(out.ok, true, 'the gateway must reach the real CLI client path, not stop at resolver-only ok:true');
    if (out.ok) {
      assert.equal(out.connectionId, undefined, 'CLI execute has no account selector; never claim a routed SDK owner');
      assert.deepEqual(out.result, {
        successful: true,
        data: {
          slug: 'PROOF_CREATE_RECORD',
          arguments: { fields: { Name: 'End-to-end CLI proof' } },
        },
      });
    }
    const invocations = readFileSync(shimLog, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const executes = invocations.filter((argv) => argv[0] === 'execute');
    assert.equal(executes.length, 1, 'exactly one provider dispatch');
    assert.deepEqual(executes[0]?.slice(0, 3), [
      'execute',
      'PROOF_CREATE_RECORD',
      '-d',
    ]);
    assert.ok(!JSON.stringify(executes[0]).includes('connected_account_id'));
    assert.ok(!JSON.stringify(executes[0]).includes('ca_'));
  } finally {
    __gatewayTest__.setRuntimeStatusLoader(null);
    delete process.env.CLEMMY_COMPOSIO_SHIM_LOG;
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    await revokeComposioCliDefaultAccountAuthority('proof');
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    resetComposioClient();
    bustComposioDashboardCaches();
  }
});

test('AUTO with an SDK key keeps normal account-addressable routing unchanged', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  const previousApiKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_BACKEND = 'auto';
  process.env.COMPOSIO_API_KEY = 'proof-sdk-key';
  setAccounts([account('ca_sdk_airtable', 'airtable', 'sdk-owner@example.test')]);
  try {
    const out = await resolveComposioDispatch(
      'AIRTABLE_CREATE_RECORD',
      { base_id: 'app-proof', table_id: 'tbl-proof', fields: { Name: 'SDK proof' } },
      undefined,
      {},
    );
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.connectionId, 'ca_sdk_airtable');
  } finally {
    if (previousApiKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previousApiKey;
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
    // Restoring the ENV is not enough: the SDK client is a module singleton, so
    // anything that touched getComposio() while this key was set would keep a
    // live client for every LATER keyless test (which then takes the SDK path
    // instead of proving "not configured"). Drop it with the key.
    resetComposioClient();
  }
});

test('named accounts: "remember this as acme" binds pin→name; alias alone then resolves with no ask', async () => {
  setAccounts([
    account('ca_acme', 'outlook', 'alex.chen@corp.example'),
    account('ca_personal', 'outlook', 'alex.chen@personal.example'),
  ]);
  // The remember gesture: pinned connection + account_alias meta-arg.
  const saved = await resolveComposioDispatch(
    'OUTLOOK_LIST_MESSAGES',
    { account_alias: 'acme' },
    'ca_acme',
    {},
  );
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(saved.connectionId, 'ca_acme');
    assert.ok(saved.notes.some((n) => n.includes('"acme"')), 'confirms the name was saved');
    assert.ok(!('account_alias' in saved.args), 'meta-arg never reaches the provider');
  }
  assert.equal(resolveAccountAlias('acme', 'outlook')?.email, 'alex.chen@corp.example');

  // The use gesture: alias alone — resolves through the store, zero ambiguity ask.
  const used = await resolveComposioDispatch(
    'OUTLOOK_LIST_MESSAGES',
    { account_alias: 'acme' },
    undefined,
    {},
  );
  assert.equal(used.ok, true);
  if (used.ok) {
    assert.equal(used.connectionId, 'ca_acme');
    assert.equal(used.identity, 'alex.chen@corp.example');
  }
  // Fuzzy phrasing still lands ("my acme email").
  const fuzzy = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', { account_alias: 'my acme email' }, undefined, {});
  assert.equal(fuzzy.ok, true);
  if (fuzzy.ok) assert.equal(fuzzy.connectionId, 'ca_acme');
});

test('named accounts survive re-auth: the alias re-attaches by EMAIL to the new connection id', async () => {
  rememberAccountAlias({ toolkit: 'gmail', label: 'newsletter', email: 'news@brand.example', connectionId: 'ca_old_rotated' });
  // Re-auth minted a NEW connection id for the same mailbox; old id is gone.
  setAccounts([
    account('ca_new_id', 'gmail', 'news@brand.example'),
    account('ca_other2', 'gmail', 'me@brand.example'),
  ]);
  const out = await resolveComposioDispatch('GMAIL_FETCH_EMAILS', { account_alias: 'newsletter' }, undefined, {});
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.connectionId, 'ca_new_id', 'alias followed the mailbox, not the rotated ca_ id');
});

test('identity enrichment: cached probe results merge no-email duplicates so the ask disappears', async () => {
  // Two re-auths of ONE mailbox whose listing exposes NO email (the Microsoft
  // case) — unmergeable → would ask. A prior profile probe cached their real
  // mailbox; resolution must now merge them and pick the freshest, no ask.
  recordIdentityProbe('ca_ms_old', 'alex.chen@corp.example');
  recordIdentityProbe('ca_ms_new', 'alex.chen@corp.example');
  setAccounts([
    { ...account('ca_ms_old', 'outlook'), createdAt: '2026-07-01T00:00:00Z' },
    { ...account('ca_ms_new', 'outlook'), createdAt: '2026-07-10T00:00:00Z' },
  ]);
  // A slug with NO per-intent recall in this suite — isolates the enrichment merge.
  const out = await resolveComposioDispatch('OUTLOOK_LIST_MAIL_FOLDERS', {}, undefined, {});
  assert.equal(out.ok, true, 'no ask — enriched identities merged the duplicates');
  if (out.ok) assert.equal(out.connectionId, 'ca_ms_new');
});

test('the ambiguous ASK teaches the naming gesture and shows saved names', async () => {
  rememberAccountAlias({ toolkit: 'slack', label: 'work', email: 'ops@corp.example', connectionId: 'ca_slack_work' });
  setAccounts([
    account('ca_slack_work', 'slack', 'ops@corp.example'),
    account('ca_slack_side', 'slack', 'side@indie.example'),
  ]);
  const out = await resolveComposioDispatch('SLACK_SEND_MESSAGE', {}, undefined, {});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.message, /"work"/, 'saved name shown on its candidate');
    assert.match(out.message, /account_alias/, 'teaches the remember gesture');
  }
});

test('send safety net: an irreversible SEND to a multi-account toolkit never resolves to ok with no owner (findings 2,10)', async () => {
  setAccounts([
    account('ca_a', 'outlook', 'a@site.example'),
    account('ca_b', 'outlook', 'b@personal.example'),
  ]);
  // Two distinct mailboxes, no pin/name/hint, override flag set — a send must be
  // blocked (asked), NEVER dispatched to Composio's default entity.
  const out = await resolveComposioDispatch('OUTLOOK_SEND_EMAIL', { sender_override_confirmed: true, to_email: 'x@archive.example', subject: 's', body: 'b' }, undefined, {});
  assert.equal(out.ok, false, 'send with unresolved owner + multiple accounts must block');
  if (!out.ok) assert.equal(out.reason, 'ambiguous-account');
  // Never returns ok:true with connectionId undefined (the wrong-account send).
  if (out.ok) assert.notEqual(out.connectionId, undefined);
});

test('recipient normalization is CENTRAL: a single-send Outlook email maps `to`->`to_email` on the dispatch path (2026-07-20 misroute fix)', async () => {
  // The live incident: the model passed the natural `to`, but only the BATCH lane
  // mapped it onto the provider-required `to_email`. The single-send lane skipped
  // that, so Graph got no recognized recipient and delivered to the sender's own
  // mailbox ("sent 0 of 20, misrouting every recipient as your own address"). The
  // fix centralizes the alias in resolveComposioDispatch — every lane, one step.
  setAccounts([account('ca_solo', 'outlook', 'me@work.example')]);
  const out = await resolveComposioDispatch('OUTLOOK_SEND_EMAIL', { to: 'client@firm.example', subject: 's', body: 'b' }, undefined, {});
  assert.equal(out.ok, true, 'a single-account send resolves');
  if (out.ok) {
    assert.equal(out.args.to_email, 'client@firm.example', '`to` is mapped onto `to_email` so Graph does NOT fall back to the sender mailbox');
    assert.ok(!('to' in out.args), 'the raw `to` alias is consumed once mapped');
  }
});

test('validate-the-write is EFFECT-anchored (not tool-specific): a target-less send is BLOCKED, never dispatched', async () => {
  // The validation keys off "is this an irreversible send with no resolvable
  // target?" — general across every tool, NOT "is this Outlook?". With no target
  // there is nothing to validate and the provider would misroute to self, so the
  // gateway asks for a recipient instead of firing blind.
  setAccounts([account('ca_solo', 'outlook', 'me@work.example')]);
  const outlook = await resolveComposioDispatch('OUTLOOK_SEND_EMAIL', { subject: 's', body: 'b' }, undefined, {});
  assert.equal(outlook.ok, false, 'a target-less Outlook send must not dispatch');
  if (!outlook.ok) {
    assert.equal(outlook.reason, 'invalid-args');
    assert.match(outlook.message, /recipient|target/i);
  }
  // SAME logic, a NON-email tool — proves no Outlook/email special-casing: a Slack
  // send with no `channel` (its target) is blocked by the same effect-anchored rule.
  setAccounts([account('ca_slack', 'slack', 'me@work.example')]);
  const slack = await resolveComposioDispatch('SLACK_SEND_MESSAGE', { text: 'hi team' }, undefined, {});
  assert.equal(slack.ok, false, 'a target-less Slack send is blocked by the same rule (channel is its target)');
  if (!slack.ok) assert.match(slack.message, /recipient|target/i);
});

test('validate-the-write does NOT block a legitimate send that HAS a target (no false positive)', async () => {
  // A send whose target field is present (channel, to, recipient_email, …) passes.
  setAccounts([account('ca_slack', 'slack', 'me@work.example')]);
  const out = await resolveComposioDispatch('SLACK_SEND_MESSAGE', { channel: 'C0123', text: 'hi team' }, undefined, {});
  assert.equal(out.ok, true, 'a send WITH a target dispatches — the rule is target-presence, not a taxonomy wall');
});

test('account-scoped social publishes use the positively resolved owner without synthetic destination fields', async () => {
  const cases: Array<{
    slug: string;
    toolkit: string;
    args: Record<string, unknown>;
  }> = [
    {
      slug: 'INSTAGRAM_CREATE_POST',
      toolkit: 'instagram',
      args: { caption: 'Launch day', image_url: 'https://assets.example/launch.png' },
    },
    {
      slug: 'LINKEDIN_CREATE_POST',
      toolkit: 'linkedin',
      args: { commentary: 'Launch day', visibility: 'PUBLIC' },
    },
    {
      slug: 'LINKEDIN_POST_UPDATE',
      toolkit: 'linkedin',
      args: { commentary: 'Launch update' },
    },
    {
      slug: 'TWITTER_CREATE_TWEET',
      toolkit: 'twitter',
      args: { text: 'Launch day' },
    },
    {
      slug: 'TWITTER_POST',
      toolkit: 'twitter',
      args: { text: 'Launch update' },
    },
  ];
  for (const entry of cases) {
    const connectionId = `ca_${entry.toolkit}_publisher`;
    setAccounts([account(connectionId, entry.toolkit, `publisher@${entry.toolkit}.example`)]);
    const out = await resolveComposioDispatch(entry.slug, entry.args, undefined, {});
    assert.equal(out.ok, true, `${entry.slug} should address the resolved social account itself`);
    if (out.ok) {
      assert.equal(out.connectionId, connectionId);
      for (const invented of ['target', 'destination', 'channel', 'channel_id', 'recipient']) {
        assert.ok(!(invented in out.args), `${entry.slug} must not invent provider field ${invented}`);
      }
    }
  }
});

test('social account destination is fail-closed on ambiguity, while directed email/chat/DM still require targets', async () => {
  setAccounts([
    account('ca_instagram_brand', 'instagram', 'brand@instagram.example'),
    account('ca_instagram_personal', 'instagram', 'personal@instagram.example'),
  ]);
  const ambiguousBroadcast = await resolveComposioDispatch(
    'INSTAGRAM_CREATE_POST',
    { caption: 'Launch day', image_url: 'https://assets.example/launch.png' },
    undefined,
    {},
  );
  assert.equal(ambiguousBroadcast.ok, false, 'a social publish cannot guess between multiple account destinations');
  if (!ambiguousBroadcast.ok) assert.equal(ambiguousBroadcast.reason, 'ambiguous-account');

  const directed: Array<{ slug: string; toolkit: string; args: Record<string, unknown> }> = [
    { slug: 'OUTLOOK_SEND_EMAIL', toolkit: 'outlook', args: { subject: 'Hello', body: 'No recipient' } },
    { slug: 'SLACK_SEND_MESSAGE', toolkit: 'slack', args: { text: 'No channel' } },
    { slug: 'TWITTER_SEND_DM', toolkit: 'twitter', args: { text: 'No DM recipient' } },
  ];
  for (const entry of directed) {
    setAccounts([account(`ca_${entry.toolkit}_directed`, entry.toolkit, `owner@${entry.toolkit}.example`)]);
    const out = await resolveComposioDispatch(entry.slug, entry.args, undefined, {});
    assert.equal(out.ok, false, `${entry.slug} remains directed and must carry a recipient/channel`);
    if (!out.ok) {
      assert.equal(out.reason, 'invalid-args');
      assert.match(out.message, /recipient|target/i);
    }
  }
});

test('operator-authorized CLI default is a valid account destination for a social broadcast', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'instagram',
    label: 'isolated-proof',
    grantedBy: 'test',
  });
  setAccounts([]);
  __gatewayTest__.setRuntimeStatusLoader(async () => ({
    enabled: true,
    apiKeyPresent: false,
    userId: 'cli-social-test-user',
    executionBackend: 'cli',
    cli: {
      installed: true,
      path: '/test/composio',
      version: 'test',
      authenticated: true,
      authStatus: 'ok',
      authMessage: 'cli-social-test-user',
    },
  }));
  try {
    const out = await resolveComposioDispatch(
      'INSTAGRAM_CREATE_POST',
      { caption: 'Launch day', image_url: 'https://assets.example/launch.png' },
      undefined,
      {},
    );
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.connectionId, undefined, 'CLI default is deliberate but not falsely represented as a targetable connection');
      assert.ok(out.notes.some((note) => /operator authority scoped specifically to instagram/i.test(note)));
    }

    const otherRead = await resolveComposioDispatch('GMAIL_LIST_MESSAGES', {}, undefined, {});
    assert.equal(otherRead.ok, true, 'another toolkit read remains usable without inheriting write authority');
    if (otherRead.ok) {
      assert.ok(otherRead.notes.some((note) => /read through the authenticated Composio CLI/i.test(note)));
      assert.ok(otherRead.notes.every((note) => !/operator authority/i.test(note)));
    }

    const otherWrite = await resolveComposioDispatch(
      'NOTION_CREATE_PAGE',
      { parent_id: 'page-proof', title: 'Proof' },
      undefined,
      {},
    );
    assert.equal(otherWrite.ok, false, 'another toolkit write must not inherit Instagram authority');
    if (!otherWrite.ok) {
      assert.equal(otherWrite.reason, 'ambiguous-account');
      assert.match(otherWrite.message, /authorize.*CLI default in Connect/i);
      assert.match(otherWrite.message, /No provider dispatch was started/i);
    }
  } finally {
    __gatewayTest__.setRuntimeStatusLoader(null);
    await revokeComposioCliDefaultAccountAuthority('instagram');
    if (previousBackend === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = previousBackend;
  }
});

test('identity enrichment does NOT permanently blind a mailbox on a transient probe failure (finding 13)', async () => {
  setAccounts([
    account('ca_ms1', 'outlook'), // no email in listing
    account('ca_ms2', 'outlook'),
  ]);
  // No COMPOSIO_API_KEY in tests → the enrichment profile probe THROWS (transient
  // class). The gateway must NOT cache a negative identity for these connections
  // (which would permanently exclude them from future probes); it must still
  // block ambiguously rather than silently merging or resolving.
  const blockReasons = ['ambiguous-account', 'identity-absent'];
  const first = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', {}, undefined, {});
  assert.equal(first.ok, false, 'must block — never silently merge/resolve two unidentified accounts');
  if (!first.ok) assert.ok(blockReasons.includes(first.reason), `blocked (${first.reason})`);
  // A second call still sees two candidates (not blinded to zero/one) — proving
  // the transient failure did not poison the durable cache.
  const second = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', {}, undefined, {});
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.candidates?.length, 2, 'both connections still resolvable — not permanently negative-cached');
});

test('CLI/SDK selection boundary: a pinned owner is NEVER dispatched via the CLI', async () => {
  // With backend forced to 'cli' and NO CLI installed:
  //   - an UNPINNED dispatch takes the CLI branch → "CLI is not installed" error
  //   - a PINNED dispatch must skip the CLI (it cannot target an account) and
  //     reach the SDK path → "COMPOSIO_API_KEY is not configured" error.
  // The two DIFFERENT errors prove the selection boundary.
  const prev = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  try {
    const { executeComposioTool } = await import('../integrations/composio/client.js');
    await assert.rejects(
      () => executeComposioTool('OUTLOOK_LIST_MESSAGES', {}, 'ca_pinned_123'),
      /COMPOSIO_API_KEY is not configured/,
      'pinned → SDK path (CLI skipped)',
    );
  } finally {
    if (prev === undefined) delete process.env.COMPOSIO_BACKEND;
    else process.env.COMPOSIO_BACKEND = prev;
  }
});

// ─── Run-scoped account stickiness (ask AT MOST ONCE per run) ───
// Live 2026-08-06: with two Outlook accounts connected, EVERY call of a
// 10-draft run re-asked "which account?" — 81 tool calls, 43% harness
// refusals, 0 drafts created. One answered choice must hold for the run.
const { harnessRunContextStorage, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
const stickyCtx = () => ({ sessionId: `sess-sticky-${Math.random().toString(36).slice(2)}`, counter: new ToolCallsCounter(50) });

test('ask-once: an explicit account pin answers the question for the REST of the run', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  await harnessRunContextStorage.run(stickyCtx(), async () => {
    // First call without a pin: ambiguous → asks (unchanged behavior).
    const asked = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'a' }, undefined, {});
    assert.equal(asked.ok, false);
    if (!asked.ok) assert.equal(asked.reason, 'ambiguous-account');
    // The user answers; the model retries with the pin.
    const pinnedCall = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'a' }, 'ca_work', {});
    assert.equal(pinnedCall.ok, true);
    // Every LATER unpinned call in the run reuses that answer — zero re-asks.
    for (const subject of ['b', 'c', 'd']) {
      const reused = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject }, undefined, {});
      assert.equal(reused.ok, true, `draft "${subject}" must not re-ask`);
      if (reused.ok) {
        assert.equal(reused.connectionId, 'ca_work');
        assert.ok(
          reused.notes.some((n) => /already chosen for outlook in this run/i.test(n)),
          'route note says the run choice was reused',
        );
      }
    }
    // A DIFFERENT toolkit in the same run still resolves on its own terms.
    setAccounts([
      account('ca_g1', 'gmail', 'one@g.example'),
      account('ca_g2', 'gmail', 'two@g.example'),
    ]);
    const otherToolkit = await resolveComposioDispatch('GMAIL_SEND_EMAIL', {}, undefined, {});
    assert.equal(otherToolkit.ok, false, 'outlook stickiness never leaks into gmail');
  });
});

test('never guess between proven alternatives: two accounts used in ONE run re-arms the ask', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  await harnessRunContextStorage.run(stickyCtx(), async () => {
    const first = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'a' }, 'ca_work', {});
    assert.equal(first.ok, true);
    // Explicit user choice ALWAYS wins — a later pin to the other account is honored.
    const second = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'b' }, 'ca_home', {});
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.connectionId, 'ca_home');
    // Now BOTH accounts are proven in this run: an unpinned call must ASK, not guess.
    const ambiguous = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'c' }, undefined, {});
    assert.equal(ambiguous.ok, false, 'two used accounts → the gateway refuses to pick one');
    if (!ambiguous.ok) assert.equal(ambiguous.reason, 'ambiguous-account');
  });
});

test('stickiness is RUN-scoped: a new run context starts with the question open', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  await harnessRunContextStorage.run(stickyCtx(), async () => {
    const pinnedCall = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'a' }, 'ca_work', {});
    assert.equal(pinnedCall.ok, true);
  });
  // Fresh run → the memo died with the old run; no context at all → also asks.
  await harnessRunContextStorage.run(stickyCtx(), async () => {
    const asked = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'b' }, undefined, {});
    assert.equal(asked.ok, false);
    if (!asked.ok) assert.equal(asked.reason, 'ambiguous-account');
  });
  const noCtx = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'c' }, undefined, {});
  assert.equal(noCtx.ok, false, 'outside any run context the gateway behaves exactly as before');
});

test('a disconnected sticky account falls back to the ask — never a stale route', async () => {
  setAccounts([
    account('ca_work', 'outlook', 'work@site.example'),
    account('ca_home', 'outlook', 'home@personal.example'),
  ]);
  await harnessRunContextStorage.run(stickyCtx(), async () => {
    const pinnedCall = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'a' }, 'ca_work', {});
    assert.equal(pinnedCall.ok, true);
    // The chosen connection disappears mid-run (revoked/disconnected)…
    setAccounts([
      account('ca_home', 'outlook', 'home@personal.example'),
      account('ca_new', 'outlook', 'new@site.example'),
    ]);
    // …so reuse must NOT route to the dead id; normal resolution runs instead.
    const out = await resolveComposioDispatch('OUTLOOK_CREATE_DRAFT', { subject: 'b' }, undefined, {});
    if (out.ok) {
      assert.notEqual(out.connectionId, 'ca_work', 'a dead connection is never reused');
    } else {
      assert.equal(out.reason, 'ambiguous-account');
    }
  });
});
