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
  resetComposioClient,
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

test('current connected-account shape gets one stable non-default machine user and persists it', async () => {
  assert.equal(BASE_DIR, TMP_HOME, 'this persistence test is isolated from the real Clementine home');
  let calls = 0;
  __test__.setConnectedAccountsLoader(async () => {
    calls += 1;
    return [
      { id: 'ca_outlook', toolkit: { slug: 'outlook' }, status: 'ACTIVE' },
      { id: 'ca_drive', toolkit: { slug: 'googledrive' }, status: 'ACTIVE' },
    ];
  });

  const userId = await getPreferredUserId({ requireFresh: true });
  assert.equal(userId, 'clementine-machine-a-01');
  assert.notEqual(userId, 'default');
  assert.equal(process.env.COMPOSIO_USER_ID, userId);

  const persisted = readFileSync(path.join(TMP_HOME, '.env'), 'utf-8');
  assert.match(persisted, /^COMPOSIO_USER_ID=clementine-machine-a-01$/m);
  assert.match(persisted, /^KEEP_ME=yes$/m, 'unrelated env values survive persistence');

  __test__.setConnectedAccountsLoader(async () => {
    throw new Error('a persisted id must short-circuit before the network');
  });
  assert.equal(await getPreferredUserId({ requireFresh: true }), userId);
  assert.equal(calls, 1);
});

test('legacy API user ids still win and are persisted to skip later probes', async () => {
  delete process.env.COMPOSIO_USER_ID;
  writeFileSync(path.join(TMP_HOME, '.env'), 'KEEP_ME=yes\n', 'utf-8');
  resetComposioClient();
  __test__.setConnectedAccountsLoader(async () => [
    { id: 'ca_legacy', toolkit: { slug: 'outlook' }, user_id: 'legacy-user', status: 'ACTIVE' },
  ]);

  assert.equal(await getPreferredUserId({ requireFresh: true }), 'legacy-user');
  assert.match(readFileSync(path.join(TMP_HOME, '.env'), 'utf-8'), /^COMPOSIO_USER_ID=legacy-user$/m);

  __test__.setConnectedAccountsLoader(async () => {
    throw new Error('the persisted legacy id must short-circuit before the network');
  });
  assert.equal(await getPreferredUserId({ requireFresh: true }), 'legacy-user');

  assert.equal(__test__.preferredUserIdFromConnectedAccounts([
    { user_id: 'legacy-user', status: 'ACTIVE' },
    { userId: 'legacy-user', status: 'ACTIVE' },
    { user_id: 'old-user', status: 'EXPIRED' },
  ]), 'legacy-user');
  assert.equal(__test__.preferredUserIdFromConnectedAccounts([
    { id: 'ca_current', toolkit: { slug: 'outlook' }, status: 'ACTIVE' },
  ]), undefined);
});

test('connection mismatch classifier recognizes current Composio errors without broad 4xx matching', () => {
  assert.equal(isComposioReconnectRequiredError(
    new Error('ConnectedAccountEntityIdMismatch: connected account user ID does not match the provided user ID'),
  ), true);
  assert.equal(isComposioReconnectRequiredError({
    cause: { error: { code: 1810, message: 'ToolRouterV2_NoActiveConnection' } },
  }), true);
  assert.equal(isComposioReconnectRequiredError(new Error('400 missing required field title')), false);
});
