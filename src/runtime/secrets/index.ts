/**
 * Public SecretStore API. Other modules should import from this barrel,
 * not from the individual files.
 *
 * Usage:
 *   import { getSecretStore, getOpenAiApiKeyAsync } from '../runtime/secrets/index.js';
 *   const store = await getSecretStore();
 *   const result = await store.get('openai_api_key');
 *   if (result.value) { ...use it... }
 *
 * For a smooth migration off `getRuntimeEnv('OPENAI_API_KEY')`,
 * getOpenAiApiKeyAsync() returns the raw value via the SecretStore
 * read order (file → env → keychain). Synchronous getOpenAiApiKey()
 * stays in config.ts as the dev/CLI fallback that hits env directly.
 */
export * from './types.js';
export { CompositeSecretStore, getSecretStore, getSecretStoreSync, __resetSecretStoreForTests } from './composite-store.js';
export { listSecretDescriptors, getSecretDescriptor, KEYCHAIN_SERVICE } from './registry.js';
export { EnvSecretBackend } from './env-store.js';
export { FileSecretBackend } from './file-store.js';
export { KeychainSecretBackend, probeKeychain, resetKeychainProbe } from './keychain-store.js';

import { getSecretStore } from './composite-store.js';
import type { SecretName } from './types.js';

/** Convenience: read a known secret and return just the value (or undefined). */
export async function readSecret(name: SecretName): Promise<string | undefined> {
  const store = await getSecretStore();
  const result = await store.get(name);
  return result.value;
}

/** Convenience: write a known secret. Throws on backend failure. */
export async function writeSecret(name: SecretName, value: string): Promise<void> {
  const store = await getSecretStore();
  await store.set(name, value);
}

/** Convenience for the most common credential. */
export async function getOpenAiApiKeyAsync(): Promise<string | undefined> {
  return readSecret('openai_api_key');
}
