/**
 * Live System One client: vault key, kill-switch, usage recording, fail-open.
 */

import { getRuntimeEnv } from '../../config.js';
import { getSecretStore } from '../secrets/index.js';
import { recordModelUsage } from '../usage-log.js';
import { JEV_ACCOUNT_ID, noteCreditAnswered, noteCreditRefused } from '../provider-credit.js';
import { isProviderCreditRefusal } from '../../shared/provider-capacity.js';
import {
  TYPESAFE_MODEL,
  TYPESAFE_SYSTEMONE_URL,
  buildSystemOneRequest,
  postSystemOne,
  type SystemOneFetch,
  type SystemOneQuestions,
  type SystemOneResult,
} from './system-one.js';

export { TYPESAFE_MODEL, TYPESAFE_SYSTEMONE_URL };

/** Credit state for the account from one System One answer. */
export function noteJevCreditOutcome(result: SystemOneResult): void {
  if (result.ok) { noteCreditAnswered(JEV_ACCOUNT_ID); return; }
  if (result.reason !== 'http_error' && result.reason !== 'unauthorized') return;
  if (isProviderCreditRefusal(result.status, result.body ?? '')) {
    noteCreditRefused(JEV_ACCOUNT_ID, { status: result.status, detail: result.body });
  }
}

let keyOverride: string | null | undefined;
let fetchOverride: SystemOneFetch | undefined;

export function _setTypesafeKeyForTests(value: string | null | undefined): void {
  keyOverride = value;
}

export function _setSystemOneFetchForTests(value: SystemOneFetch | undefined): void {
  fetchOverride = value;
}

export function jevEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_JEV', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

export async function resolveTypesafeApiKey(): Promise<{ value: string; source: 'override' | 'vault' | 'env' } | null> {
  if (keyOverride !== undefined) {
    const trimmed = (keyOverride ?? '').trim();
    return trimmed ? { value: trimmed, source: 'override' } : null;
  }
  try {
    const stored = await (await getSecretStore()).get('typesafe_api_key');
    const value = stored.value?.trim();
    if (value) {
      return { value, source: stored.source === 'env' ? 'env' : 'vault' };
    }
  } catch { /* vault unread is fail-open */ }
  const fromEnv = (getRuntimeEnv('TYPESAFE_API_KEY', '') ?? '').trim();
  return fromEnv ? { value: fromEnv, source: 'env' } : null;
}

export async function evaluateSystemOne(input: {
  state: unknown;
  questions: SystemOneQuestions;
  timeoutMs?: number;
  sessionId?: string;
  channel?: string;
}): Promise<SystemOneResult> {
  if (!jevEnabled()) return { ok: false, reason: 'disabled' };
  const key = await resolveTypesafeApiKey();
  if (!key) return { ok: false, reason: 'missing_key' };
  const started = Date.now();
  const result = await postSystemOne({
    apiKey: key.value,
    request: buildSystemOneRequest(input.state, input.questions),
    timeoutMs: input.timeoutMs,
    fetchImpl: fetchOverride,
  });
  const durationMs = Date.now() - started;
  noteJevCreditOutcome(result);
  try {
    recordModelUsage({
      sessionId: input.sessionId?.trim() || 'jev',
      channel: input.channel ?? 'jev',
      role: 'router',
      account: JEV_ACCOUNT_ID,
      model: result.ok ? result.model : TYPESAFE_MODEL,
      cacheDialect: 'none',
      inputTokens: result.ok ? result.usage.input_tokens : 0,
      outputTokens: result.ok ? result.usage.output_tokens : 0,
      durationMs,
      ok: result.ok,
      ...(result.ok ? {} : { failReason: result.reason }),
    });
  } catch { /* usage must never break the decision path */ }
  return result;
}

export async function typesafeKeyIsConfigured(): Promise<boolean> {
  return Boolean(await resolveTypesafeApiKey());
}

export async function forgetTypesafeApiKey(): Promise<void> {
  const store = await getSecretStore();
  await store.delete('typesafe_api_key');
}
