/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/runtime-config-snapshot.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runtime-config-snapshot-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
delete process.env.OPENAI_API_KEY;

const config = await import('../config.js');
const { FileSecretBackend } = await import('./secrets/file-store.js');
const { rotateAuthoritySealKey } = await import('./harness/authority-argument-seal.js');
const { removeEnvKey, updateEnvKey } = await import('../tools/shared.js');

const ENV_PATH = path.join(TEST_HOME, '.env');
const VAULT_PATH = path.join(TEST_HOME, 'state', 'secrets-vault.json');
const SNAPSHOT_ENV_KEY = 'CLEMMY_RUNTIME_CONFIG_SNAPSHOT_TEST';

function writeExternalVault(entries: Record<string, string>): void {
  mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
  writeFileSync(VAULT_PATH, `${JSON.stringify({ version: 'v1', entries }, null, 2)}\n`, 'utf8');
}

after(() => {
  config._setRuntimeConfigCaptureObserverForTest(null);
  delete process.env[SNAPSHOT_ENV_KEY];
  delete process.env.OPENAI_API_KEY;
  delete process.env.CLEMMY_TEST_ISOLATED_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('one request captures env and vault once, nested scopes reuse it, and the next request is fresh', async () => {
  delete process.env[SNAPSHOT_ENV_KEY];
  writeFileSync(ENV_PATH, `${SNAPSHOT_ENV_KEY}=request-one\n`, 'utf8');
  writeExternalVault({ openai_api_key: 'sk-request-one' });

  const captures: Array<'environment' | 'secret_vault'> = [];
  config._setRuntimeConfigCaptureObserverForTest((kind) => captures.push(kind));
  try {
    await config.withRuntimeConfigSnapshot(async () => {
      assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'request-one');
      assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'request-one');
      assert.equal(config.getOpenAiApiKey(), 'sk-request-one');
      assert.equal(config.getOpenAiApiKey(), 'sk-request-one');

      await config.withRuntimeConfigSnapshot(async () => {
        assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'request-one');
        assert.equal(config.getOpenAiApiKey(), 'sk-request-one');
      });

      // Unowned external edits do not split one accepted request's view.
      writeFileSync(ENV_PATH, `${SNAPSHOT_ENV_KEY}=request-two\n`, 'utf8');
      writeExternalVault({ openai_api_key: 'sk-request-two' });
      assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'request-one');
      assert.equal(config.getOpenAiApiKey(), 'sk-request-one');
    });
    assert.deepEqual(captures, ['environment', 'secret_vault']);

    await config.withRuntimeConfigSnapshot(async () => {
      assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'request-two');
      assert.equal(config.getOpenAiApiKey(), 'sk-request-two');
    });
    assert.deepEqual(captures, [
      'environment', 'secret_vault',
      'environment', 'secret_vault',
    ]);
  } finally {
    config._setRuntimeConfigCaptureObserverForTest(null);
  }

  // Outside a request scope, the historical dynamic-read contract remains.
  writeFileSync(ENV_PATH, `${SNAPSHOT_ENV_KEY}=outside-one\n`, 'utf8');
  writeExternalVault({ openai_api_key: 'sk-outside-one' });
  assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'outside-one');
  assert.equal(config.getOpenAiApiKey(), 'sk-outside-one');
  writeFileSync(ENV_PATH, `${SNAPSHOT_ENV_KEY}=outside-two\n`, 'utf8');
  writeExternalVault({ openai_api_key: 'sk-outside-two' });
  assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY), 'outside-two');
  assert.equal(config.getOpenAiApiKey(), 'sk-outside-two');
});

test('owned env update and delete are visible inside the same request', async () => {
  removeEnvKey(SNAPSHOT_ENV_KEY);
  await config.withRuntimeConfigSnapshot(async () => {
    assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY, 'default'), 'default');

    updateEnvKey(SNAPSHOT_ENV_KEY, 'same-request');
    assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY, 'default'), 'same-request',
      'live process.env precedence exposes an owned update immediately');

    removeEnvKey(SNAPSHOT_ENV_KEY);
    assert.equal(config.getRuntimeEnv(SNAPSHOT_ENV_KEY, 'default'), 'default',
      'the durable file delete invalidates the captured fallback before process.env is read again');
  });
});

test('file-vault set, delete, and authority-key rotation invalidate the same request snapshot', async () => {
  const backend = new FileSecretBackend();
  await backend.delete('openai_api_key');
  const vaultCaptures: string[] = [];
  config._setRuntimeConfigCaptureObserverForTest((kind) => {
    if (kind === 'secret_vault') vaultCaptures.push(kind);
  });
  try {
    await config.withRuntimeConfigSnapshot(async () => {
      assert.equal(config.getOpenAiApiKey(), '');
      assert.equal(vaultCaptures.length, 1, 'request entry parses the vault once');

      await backend.set('openai_api_key', 'sk-same-request');
      assert.equal(config.getOpenAiApiKey(), 'sk-same-request');
      assert.equal(vaultCaptures.length, 2, 'set invalidates and reparses on the next read');

      await backend.delete('openai_api_key');
      assert.equal(config.getOpenAiApiKey(), '');
      assert.equal(vaultCaptures.length, 3, 'delete invalidates and reparses on the next read');

      await backend.set('openai_api_key', 'sk-survives-rotation');
      assert.equal(config.getOpenAiApiKey(), 'sk-survives-rotation');
      assert.equal(vaultCaptures.length, 4);

      rotateAuthoritySealKey('a'.repeat(64));
      assert.equal(config.getOpenAiApiKey(), 'sk-survives-rotation');
      assert.equal(vaultCaptures.length, 5,
        'the direct authority-key writer invalidates the shared parsed vault in this request');
    });
  } finally {
    config._setRuntimeConfigCaptureObserverForTest(null);
    await backend.delete('openai_api_key');
  }
});
