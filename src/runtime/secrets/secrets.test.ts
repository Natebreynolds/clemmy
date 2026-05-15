/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-secrets npx tsx --test src/runtime/secrets/secrets.test.ts
 *
 * Tests the env + file + composite backends. Keychain backend is
 * exercised in the integration suite (lives behind Electron packaging,
 * not bundled in the default daemon test path).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-secrets';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { EnvSecretBackend } = await import('./env-store.js');
const { FileSecretBackend } = await import('./file-store.js');
const { CompositeSecretStore, __resetSecretStoreForTests } = await import('./composite-store.js');
const { listSecretDescriptors, getSecretDescriptor, KEYCHAIN_SERVICE } = await import('./registry.js');

const VAULT = path.join(TEST_HOME, 'state', 'secrets-vault.json');
const META  = path.join(TEST_HOME, 'state', 'secrets-meta.json');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(VAULT, { force: true });
  rmSync(META, { force: true });
  __resetSecretStoreForTests();
  // Clean up any test env vars we may have set in a prior test.
  delete process.env.OPENAI_API_KEY;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.COMPOSIO_API_KEY;
});

// ─── Registry ────────────────────────────────────────────────────

test('registry: every descriptor has a stable name + description', () => {
  const all = listSecretDescriptors();
  assert.ok(all.length >= 5, 'expected at least 5 known credentials');
  for (const d of all) {
    assert.ok(d.name, 'name required');
    assert.ok(d.description, 'description required');
    // envVarName is optional (codex_oauth has no env var)
  }
});

test('registry: getSecretDescriptor throws on unknown name', () => {
  assert.throws(() => getSecretDescriptor('does_not_exist' as never));
});

test('registry: KEYCHAIN_SERVICE is the stable v1 name (NEVER change)', () => {
  assert.equal(KEYCHAIN_SERVICE, 'com.clemmy.desktop.v1');
});

// ─── Env backend ─────────────────────────────────────────────────

test('env backend: reads from process.env', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-env';
  const env = new EnvSecretBackend();
  const value = await env.get('openai_api_key');
  assert.equal(value, 'sk-test-env');
});

test('env backend: returns undefined when env var unset', async () => {
  const env = new EnvSecretBackend();
  const value = await env.get('openai_api_key');
  assert.equal(value, undefined);
});

test('env backend: returns undefined for secrets with no env var (codex tokens)', async () => {
  const env = new EnvSecretBackend();
  assert.equal(await env.get('codex_oauth_access_token'), undefined);
});

test('env backend: set() throws (read-only)', async () => {
  const env = new EnvSecretBackend();
  await assert.rejects(env.set('openai_api_key', 'x'));
});

// ─── File backend ────────────────────────────────────────────────

test('file backend: set + get roundtrip', async () => {
  const file = new FileSecretBackend();
  await file.set('openai_api_key', 'sk-file-test');
  assert.equal(await file.get('openai_api_key'), 'sk-file-test');
});

test('file backend: get returns undefined when entry absent', async () => {
  const file = new FileSecretBackend();
  assert.equal(await file.get('openai_api_key'), undefined);
});

test('file backend: delete removes the entry', async () => {
  const file = new FileSecretBackend();
  await file.set('openai_api_key', 'sk-file-test');
  await file.delete('openai_api_key');
  assert.equal(await file.get('openai_api_key'), undefined);
});

test('file backend: delete removes the vault file when last entry goes', async () => {
  const file = new FileSecretBackend();
  await file.set('openai_api_key', 'sk-test');
  assert.ok(existsSync(VAULT), 'vault file exists after set');
  await file.delete('openai_api_key');
  assert.equal(existsSync(VAULT), false, 'vault file deleted when empty');
});

test('file backend: vault file has 0600 perms', async () => {
  const file = new FileSecretBackend();
  await file.set('openai_api_key', 'sk-perm');
  const { statSync } = await import('node:fs');
  const mode = statSync(VAULT).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('file backend: rejects corrupt vault JSON instead of silently overwriting', async () => {
  mkdirSync(path.dirname(VAULT), { recursive: true });
  writeFileSync(VAULT, '{not valid json');
  const file = new FileSecretBackend();
  await assert.rejects(file.get('openai_api_key'), /corrupt/);
});

test('file backend: reset wipes everything', async () => {
  const file = new FileSecretBackend();
  await file.set('openai_api_key', 'a');
  await file.set('discord_bot_token', 'b');
  FileSecretBackend.reset();
  assert.equal(existsSync(VAULT), false);
});

// ─── Composite store ─────────────────────────────────────────────

test('composite: empty state returns missing', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'missing');
  assert.equal(r.status, 'missing');
  assert.equal(r.value, undefined);
});

test('composite: env-only secret surfaces as env_only status', async () => {
  process.env.OPENAI_API_KEY = 'sk-from-env';
  const store = new CompositeSecretStore();
  await store.init();
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'env');
  assert.equal(r.status, 'env_only', 'env_only flags that migration to file/keychain is recommended');
  assert.equal(r.value, 'sk-from-env');
});

test('composite: set writes to file (when no keychain), readback verified', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  const setResult = await store.set('openai_api_key', 'sk-written');
  assert.equal(setResult.source, 'file');
  assert.equal(setResult.status, 'connected');
  // Confirm readback
  const getResult = await store.get('openai_api_key');
  assert.equal(getResult.value, 'sk-written');
  assert.equal(getResult.source, 'file');
});

test('composite: file beats env in read priority', async () => {
  process.env.OPENAI_API_KEY = 'sk-from-env';
  const store = new CompositeSecretStore();
  await store.init();
  await store.set('openai_api_key', 'sk-from-file');
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'file');
  assert.equal(r.value, 'sk-from-file');
});

test('composite: metadata file tracks source + lastSetAt without storing secret', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  await store.set('openai_api_key', 'sk-meta-test');

  assert.ok(existsSync(META));
  const meta = JSON.parse(readFileSync(META, 'utf-8'));
  assert.equal(meta.version, 'v1');
  assert.equal(meta.entries.openai_api_key.source, 'file');
  assert.equal(meta.entries.openai_api_key.status, 'connected');
  assert.ok(meta.entries.openai_api_key.lastSetAt);
  // CRITICAL: the actual value MUST NOT appear in the metadata file.
  const rawMetaFile = readFileSync(META, 'utf-8');
  assert.equal(rawMetaFile.includes('sk-meta-test'), false, 'metadata file MUST NOT contain the secret value');
});

test('composite: delete clears all writable backends', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  await store.set('openai_api_key', 'sk-to-delete');
  await store.delete('openai_api_key');
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'missing');
});

test('composite: delete DOES NOT touch .env values', async () => {
  process.env.OPENAI_API_KEY = 'sk-env-stays';
  const store = new CompositeSecretStore();
  await store.init();
  await store.set('openai_api_key', 'sk-file-temp');
  await store.delete('openai_api_key');
  // After delete, file is gone but env is still there.
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'env');
  assert.equal(r.value, 'sk-env-stays');
});

test('composite: migrate env → file is confirm-then-move', async () => {
  process.env.OPENAI_API_KEY = 'sk-env-to-file';
  const store = new CompositeSecretStore();
  await store.init();
  const result = await store.migrate('openai_api_key', 'env', 'file');
  assert.equal(result.source, 'file');
  assert.equal(result.status, 'connected');
  // Env value is left intact (we never edit user .env files).
  assert.equal(process.env.OPENAI_API_KEY, 'sk-env-to-file');
  // File backend now has it as the primary source.
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'file');
  assert.equal(r.value, 'sk-env-to-file');
});

test('composite: migrate of a missing secret returns status missing', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  const result = await store.migrate('discord_bot_token', 'env', 'file');
  assert.equal(result.status, 'missing');
});

test('composite: health() includes every known credential', async () => {
  const store = new CompositeSecretStore();
  await store.init();
  process.env.OPENAI_API_KEY = 'sk-health';
  const rows = await store.health();
  const names = rows.map((r) => r.name);
  for (const desc of listSecretDescriptors()) {
    assert.ok(names.includes(desc.name), `health missing ${desc.name}`);
  }
  const openai = rows.find((r) => r.name === 'openai_api_key');
  assert.equal(openai?.hasValue, true);
  assert.equal(openai?.envFallbackAvailable, true);
});

test('composite: resetAll wipes vault + meta but not env', async () => {
  process.env.OPENAI_API_KEY = 'sk-env-survives';
  const store = new CompositeSecretStore();
  await store.init();
  await store.set('discord_bot_token', 'dt-test');
  const report = await store.resetAll();
  assert.equal(report.fileVaultDeleted, true);
  assert.equal(report.metaDeleted, true);
  // env still readable
  const r = await store.get('openai_api_key');
  assert.equal(r.source, 'env');
  // file-stored discord is gone
  const r2 = await store.get('discord_bot_token');
  assert.equal(r2.value, undefined);
});

test('composite: readback failure during set is recorded as needs_repair', async () => {
  // Force the file backend to return wrong data on readback by mocking.
  const store = new CompositeSecretStore();
  await store.init();
  const fake = {
    name: 'keychain' as const,
    isAvailable: true,
    get: async () => 'wrong-value-from-readback',
    set: async () => { /* pretend success */ },
    delete: async () => {},
  };
  store.setKeychainBackend(fake as unknown as Parameters<typeof store.setKeychainBackend>[0]);
  const result = await store.set('openai_api_key', 'right-value');
  assert.equal(result.status, 'needs_repair');
});
