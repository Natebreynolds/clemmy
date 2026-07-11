/**
 * Run: npx tsx --test src/integrations/composio/client-user-routing.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-user-routing-'));
const previousHome = process.env.CLEMENTINE_HOME;
const previousUserId = process.env.COMPOSIO_USER_ID;
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_USER_ID = 'default';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'Machine A / 01\n', 'utf-8');
writeFileSync(path.join(TMP_HOME, '.env'), 'COMPOSIO_USER_ID=default\nKEEP_ME=yes\n', 'utf-8');

const {
  __test__,
  getPreferredUserId,
  isComposioReconnectRequiredError,
} = await import('./client.js');
const { BASE_DIR } = await import('../../config.js');

test.after(() => {
  __test__.setConnectedAccountsLoader(null);
  if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = previousHome;
  if (previousUserId === undefined) delete process.env.COMPOSIO_USER_ID;
  else process.env.COMPOSIO_USER_ID = previousUserId;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('getPreferredUserId: COMPOSIO_USER_ID=default derives a stable non-default machine user, persists it, NEVER probes the network', () => {
  assert.equal(BASE_DIR, TMP_HOME, 'this persistence test is isolated from the real Clementine home');
  // getPreferredUserId is a pure local resolve now — the old auto-detect read
  // user_id off the account list, which the SDK strips (so it was dead). It must
  // therefore never touch the connected-account loader.
  __test__.setConnectedAccountsLoader(async () => {
    throw new Error('getPreferredUserId must NOT probe the network');
  });

  const userId = getPreferredUserId();
  assert.equal(userId, 'clementine-machine-a-01');
  assert.notEqual(userId, 'default');
  assert.equal(process.env.COMPOSIO_USER_ID, userId);

  const persisted = readFileSync(path.join(TMP_HOME, '.env'), 'utf-8');
  assert.match(persisted, /^COMPOSIO_USER_ID=clementine-machine-a-01$/m);
  assert.match(persisted, /^KEEP_ME=yes$/m, 'unrelated env values survive persistence');

  // Stable + still no network on the second call (now configured, short-circuits).
  assert.equal(getPreferredUserId(), userId);
});

// NOTE: the former "legacy API user ids still win" test was DELETED — it mocked a
// `user_id` field the @composio/core SDK strips from connectedAccounts.list(), so
// it was false-green: it exercised an auto-detect path that can never fire in
// production. The mailbox is now decided by the identity-resolved connectedAccountId
// (see selectToolkitConnection), not a `user_id` probe.

test('connection mismatch classifier recognizes current Composio errors without broad 4xx matching', () => {
  assert.equal(isComposioReconnectRequiredError(
    new Error('ConnectedAccountEntityIdMismatch: connected account user ID does not match the provided user ID'),
  ), true);
  assert.equal(isComposioReconnectRequiredError({
    cause: { error: { code: 1810, message: 'ToolRouterV2_NoActiveConnection' } },
  }), true);
  assert.equal(isComposioReconnectRequiredError(new Error('400 missing required field title')), false);
});
