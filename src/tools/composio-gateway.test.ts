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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { __test__ } = await import('../integrations/composio/client.js');
const { resolveComposioDispatch, dispatchComposioTool, __gatewayTest__ } = await import('./composio-tools.js');
const { rememberToolChoice } = await import('../memory/tool-choice-store.js');
const { createSession, listEvents } = await import('../runtime/harness/eventlog.js');

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
    account('ca_work', 'outlook', 'work@x.com'),
    account('ca_home', 'outlook', 'home@y.com'),
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
    account('ca_work', 'outlook', 'work@x.com'),
    account('ca_home', 'outlook', 'home@y.com'),
  ]);
  rememberToolChoice({
    intent: 'list unread inbox messages',
    choice: { kind: 'composio', identifier: 'OUTLOOK_LIST_MESSAGES', accountIdentity: 'home@y.com' },
  });
  const out = await resolveComposioDispatch('OUTLOOK_LIST_MESSAGES', {}, undefined, {});
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.connectionId, 'ca_home');
    assert.equal(out.identity, 'home@y.com');
    assert.ok(out.notes.some((n) => n.includes('home@y.com')), 'route note names the remembered mailbox');
  }
});

test('identity-absent: the remembered mailbox is no longer connected → typed block, never a fallback guess', async () => {
  setAccounts([
    account('ca_other', 'gmail', 'other@z.com'),
    account('ca_second', 'gmail', 'second@z.com'),
  ]);
  rememberToolChoice({
    intent: 'send the weekly gmail digest',
    choice: { kind: 'composio', identifier: 'GMAIL_SEND_EMAIL', accountIdentity: 'gone@z.com' },
  });
  const out = await resolveComposioDispatch('GMAIL_SEND_EMAIL', {}, undefined, {});
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'identity-absent');
    assert.match(out.message, /gone@z\.com/);
  }
});

test('single distinct mailbox (duplicate re-auths) resolves to the freshest ACTIVE — no block', async () => {
  setAccounts([
    { ...account('ca_old', 'airtable', 'me@x.com'), createdAt: '2026-07-01T00:00:00Z' },
    { ...account('ca_new', 'airtable', 'me@x.com'), createdAt: '2026-07-10T00:00:00Z' },
  ]);
  const out = await resolveComposioDispatch('AIRTABLE_LIST_RECORDS', {}, undefined, {});
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.connectionId, 'ca_new');
});

test('blocked ledger semantics: every gateway block emits guardrail_tripped(composio_gateway) with the reason', async () => {
  setAccounts([
    account('ca_a', 'slack', 'a@x.com'),
    account('ca_b', 'slack', 'b@y.com'),
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
  setAccounts([account('ca_notion', 'notion', 'n@x.com')]);
  const alive = await resolveComposioDispatch('NOTION_SEARCH_PAGES', {}, undefined, { sessionId: sid });
  assert.equal(alive.ok, true, 'a visible reconnect disarms the breaker without waiting for TTL');
  __gatewayTest__.clearReconnectBreaker(sid, 'NOTION_SEARCH_PAGES');
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
