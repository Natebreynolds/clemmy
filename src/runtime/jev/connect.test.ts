import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = path.join(os.tmpdir(), `clemmy-jev-connect-${process.pid}`);
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
delete process.env.TYPESAFE_API_KEY;

const { __resetSecretStoreForTests } = await import('../secrets/composite-store.js');
const { connectJevKey, disconnectJevKey, getJevStatus } = await import('./connect.js');
const { TYPESAFE_SYSTEMONE_URL } = await import('./system-one.js');
const { _setTypesafeKeyForTests } = await import('./client.js');

after(() => {
  _setTypesafeKeyForTests(undefined);
  rmSync(HOME, { recursive: true, force: true });
});

test('getJevStatus is disconnected without a key', async () => {
  __resetSecretStoreForTests();
  _setTypesafeKeyForTests(null);
  const status = await getJevStatus();
  assert.equal(status.configured, false);
  assert.equal(status.keySource, 'missing');
  assert.equal(status.endpoint, TYPESAFE_SYSTEMONE_URL);
  assert.match(status.endpoint, /\/v1\/systemone$/);
  assert.doesNotMatch(status.endpoint, /chat\/completions/);
});

test('connectJevKey verifies against /v1/systemone then reports connected; disconnect clears it', async () => {
  __resetSecretStoreForTests();
  _setTypesafeKeyForTests(undefined);
  let posted = '';
  const status = await connectJevKey('ts_live_key', async (url, init) => {
    posted = url;
    assert.equal(init.method, 'POST');
    assert.match(init.headers.authorization, /^Bearer ts_live_key$/);
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: { alive: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 8, output_tokens: 1 },
      }),
    };
  });
  assert.equal(posted, TYPESAFE_SYSTEMONE_URL);
  assert.equal(status.configured, true);
  assert.equal(status.keySource, 'vault');

  const gone = await disconnectJevKey();
  assert.equal(gone.configured, false);
  assert.equal(gone.keySource, 'missing');
});

test('env-only key reports keySource env and disconnect names the leftover variable', async () => {
  __resetSecretStoreForTests();
  _setTypesafeKeyForTests(undefined);
  process.env.TYPESAFE_API_KEY = 'ts_env_only';
  try {
    const status = await getJevStatus();
    assert.equal(status.configured, true);
    assert.equal(status.keySource, 'env');
    const after = await disconnectJevKey();
    assert.equal(after.configured, true);
    assert.equal(after.keySource, 'env');
    assert.match(after.warning ?? '', /TYPESAFE_API_KEY/);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test('connectJevKey refuses an unauthorized key and does not store it', async () => {
  __resetSecretStoreForTests();
  _setTypesafeKeyForTests(undefined);
  await assert.rejects(
    () => connectJevKey('ts_bad', async () => ({
      status: 401,
      ok: false,
      text: async () => '{"error":"unauthorized"}',
    })),
    /rejected this key/,
  );
  const status = await getJevStatus();
  assert.equal(status.configured, false);
});
