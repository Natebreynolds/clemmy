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
const { rememberAccountAlias, resolveAccountAlias } = await import('../memory/account-alias-store.js');
const { recordIdentityProbe } = await import('../integrations/composio/identity-cache.js');

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
