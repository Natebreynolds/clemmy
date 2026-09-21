/**
 * Settings contract: status, paste-key verify against /v1/systemone, disconnect.
 */

import { getSecretStore } from '../secrets/index.js';
import { jevEnabled, resolveTypesafeApiKey } from './client.js';
import { probeTypesafeApiKey, TYPESAFE_MODEL, TYPESAFE_SYSTEMONE_URL, type SystemOneFetch } from './system-one.js';

export interface JevStatus {
  configured: boolean;
  enabled: boolean;
  model: string;
  endpoint: string;
  keySource: 'vault' | 'env' | 'override' | 'missing';
  warning?: string;
}

export async function getJevStatus(): Promise<JevStatus> {
  const key = await resolveTypesafeApiKey();
  return {
    configured: Boolean(key),
    enabled: jevEnabled(),
    model: TYPESAFE_MODEL,
    endpoint: TYPESAFE_SYSTEMONE_URL,
    keySource: key?.source ?? 'missing',
  };
}

export async function connectJevKey(apiKey: string, fetchImpl?: SystemOneFetch): Promise<JevStatus> {
  const probe = await probeTypesafeApiKey(apiKey, fetchImpl);
  if (probe.result === 'invalid') {
    const error = new Error(probe.message ?? 'TypeSafe rejected this key.');
    (error as Error & { code: string }).code = 'invalid_key';
    throw error;
  }
  const store = await getSecretStore();
  await store.set('typesafe_api_key', apiKey.trim());
  const status = await getJevStatus();
  if (probe.result === 'unknown' && probe.message) status.warning = probe.message;
  return status;
}

export async function disconnectJevKey(): Promise<JevStatus> {
  const store = await getSecretStore();
  await store.delete('typesafe_api_key');
  const status = await getJevStatus();
  if (status.configured && status.keySource === 'env') {
    status.warning = 'Disconnect removed the saved key. Jev is still on because TYPESAFE_API_KEY is set in the environment. Remove that variable to turn Jev off.';
  }
  return status;
}
