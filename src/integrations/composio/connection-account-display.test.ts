/** Strict verification and UI identity must share one provider snapshot. */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-account-display-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Provider network is forbidden in this fixture.'); };
const { __test__, revalidateSelectedComposioConnections, clearConnectedToolkitsCache } = await import('./client.js');
afterEach(() => __test__.setConnectedAccountsLoader(null));
after(() => { globalThis.fetch = originalFetch; rmSync(fixtureHome, { recursive: true, force: true }); });
const selection = [{ identifier: 'OUTLOOK_LIST_MESSAGES', connectionId: 'ca_selected' }];
const account = (id: string, email?: string, status = 'ACTIVE') => ({ id, toolkit: { slug: 'outlook' }, status,
  user_id: 'private-dispatch-entity', state: { email, access_token: 'fixture-secret', refresh_token: 'fixture-refresh' } });

test('one strict snapshot supplies only the selected account display fields', async () => {
  let calls = 0;
  __test__.setConnectedAccountsLoader(async () => {
    calls++;
    return [account('ca_other', 'other@example.test'), account('ca_selected', 'work@example.test')];
  });
  const result = await revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true });
  assert.deepEqual(result, { ok: true, accounts: [{ connectionId: 'ca_selected', toolkit: 'outlook', label: 'work@example.test' }] });
  assert.equal(calls, 1, 'showing account identity must not issue a second provider request');
  assert.deepEqual(await revalidateSelectedComposioConnections(selection), { ok: true }, 'ordinary authority checks retain their existing result shape');
});

test('missing labels remain unknown and inactive or mismatched accounts expose no verified display', async () => {
  __test__.setConnectedAccountsLoader(async () => [account('ca_selected')]);
  assert.deepEqual(await revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true }), {
    ok: true, accounts: [{ connectionId: 'ca_selected', toolkit: 'outlook', label: null }],
  });
  __test__.setConnectedAccountsLoader(async () => [account('ca_selected', 'work@example.test', 'EXPIRED')]);
  assert.deepEqual(await revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true }), {
    ok: false, identifier: selection[0].identifier, reason: 'inactive_or_suppressed',
  });
  __test__.setConnectedAccountsLoader(async () => [account('ca_other', 'other@example.test')]);
  assert.deepEqual(await revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true }), {
    ok: false, identifier: selection[0].identifier, reason: 'missing_or_changed',
  });
});

test('a failed refresh cannot return an old verified account label from the last-good cache', async () => {
  let unavailable = false;
  __test__.setConnectedAccountsLoader(async () => {
    if (unavailable) throw new Error('Fixture provider offline');
    return [account('ca_selected', 'old@example.test')];
  });
  assert.equal((await revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true })).ok, true);
  clearConnectedToolkitsCache();
  unavailable = true;
  await assert.rejects(revalidateSelectedComposioConnections(selection, { includeAccountDisplay: true }), /Fixture provider offline/);
});
