/**
 * Live System One client: vault key, kill-switch, usage recording, fail-open.
 */

import { getRuntimeEnv } from '../../config.js';
import { getSecretStore } from '../secrets/index.js';
import { recordModelUsage } from '../usage-log.js';
import { compactJevAnswers, recordJevDecision } from './decision-log.js';
import { createHash, randomUUID } from 'node:crypto';
import { modelUsageAttributionStorage, withOwnModelRequestAttribution, type ModelUsageAttributionContext } from '../usage-log.js';
import { activeModelWireRequestSnapshot, captureModelTransportOwner, captureUnavailableModelTransportOwner, createModelTransportAttempt, finishModelTransportAttempt, observeModelTransportFetch,
  withModelTransportAttempt, type ModelTransportAttempt } from '../harness/model-transport-observation.js';
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

export interface JevAssessmentOwner { sessionId: string; sourceUserSeq: number; attemptId: string }
export interface SystemOneOriginalWitness {
  readonly kind: 'systemone_original_result_witness';
}
export interface SystemOneWitnessMetadata {
  readonly owner: Readonly<JevAssessmentOwner>;
  readonly modelCallId: string;
  readonly physicalAttempt: number;
  readonly requestBodySha256: string;
  readonly questionnaireSha256: string;
  readonly originalResultSha256: string;
  readonly requestedModel: string;
  readonly providerReportedModel?: string;
  readonly providerResponseIdentity: 'unknown';
  readonly accountBackend: 'unknown';
}
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const originalResults = new WeakMap<object, {
  original: SystemOneResult; originalHash: string; returnedHash: string;
  metadata: SystemOneWitnessMetadata; signal?: AbortSignal;
}>();
const originalOwners = new WeakSet<object>();
const ambiguousOriginals = new WeakSet<object>();
const witnesses = new WeakMap<SystemOneOriginalWitness, object>();
const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);

/** Direct request ownership only. An accounting parent is not this reader. */
function directAssessmentOwner(): Readonly<JevAssessmentOwner> | undefined {
  const owner = modelUsageAttributionStorage.getStore();
  return owner && !owner.usageParentTurn && !owner.usageJobId && identity(owner.sessionId)
    && owner.sessionId !== 'unknown' && Number.isSafeInteger(owner.sourceUserSeq) && owner.sourceUserSeq > 0
    && identity(owner.attemptId)
    ? Object.freeze({ sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq, attemptId: owner.attemptId }) : undefined;
}

/** A public result clone or decision-log row can never produce this witness. */
export function systemOneOriginalWitnessFor(result: unknown, expected: {
  owner: JevAssessmentOwner; requestBodySha256: string; questionnaireSha256: string;
}): SystemOneOriginalWitness | undefined {
  try {
    if (!result || typeof result !== 'object') return undefined;
    const entry = originalResults.get(result);
    if (!entry || entry.signal?.aborted || ambiguousOriginals.has(entry.original)
      || directAssessmentOwner()?.sessionId !== expected.owner.sessionId
      || directAssessmentOwner()?.sourceUserSeq !== expected.owner.sourceUserSeq
      || directAssessmentOwner()?.attemptId !== expected.owner.attemptId
      || entry.metadata.owner.sessionId !== expected.owner.sessionId
      || entry.metadata.owner.sourceUserSeq !== expected.owner.sourceUserSeq
      || entry.metadata.owner.attemptId !== expected.owner.attemptId
      || entry.metadata.requestBodySha256 !== expected.requestBodySha256
      || entry.metadata.questionnaireSha256 !== expected.questionnaireSha256
      || digest(JSON.stringify(entry.original)) !== entry.originalHash
      || digest(JSON.stringify(result)) !== entry.returnedHash) return undefined;
    const witness = Object.freeze({ kind: 'systemone_original_result_witness' as const });
    witnesses.set(witness, result); return witness;
  } catch { return undefined; }
}

export function systemOneOriginalWitnessMetadata(witness: SystemOneOriginalWitness): SystemOneWitnessMetadata | undefined {
  try {
    const result = witnesses.get(witness); const entry = result && originalResults.get(result);
    const owner = directAssessmentOwner();
    return entry && owner && owner.sessionId === entry.metadata.owner.sessionId
      && owner.sourceUserSeq === entry.metadata.owner.sourceUserSeq && owner.attemptId === entry.metadata.owner.attemptId
      && !entry.signal?.aborted && !ambiguousOriginals.has(entry.original)
      && digest(JSON.stringify(entry.original)) === entry.originalHash
      && digest(JSON.stringify(result)) === entry.returnedHash ? entry.metadata : undefined;
  } catch { return undefined; }
}

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

/** Whether a Jev request would be attempted at all: Jev is enabled and a key
 *  is configured. It says nothing about whether Jev would answer in time. A
 *  caller that builds candidates only for Jev asks this first, so a user
 *  without Jev pays for neither the candidates nor the request. The key is
 *  read on each call, so connecting or disconnecting applies to the next one. */
export async function jevAvailable(): Promise<boolean> {
  if (!jevEnabled()) return false;
  return Boolean(await resolveTypesafeApiKey());
}

const unownedUsage = Object.freeze({ sessionId: 'unknown', sourceUserSeq: 0 });
/** Snapshot only known data fields. No accessors, coercion, or later ambient
 * owner may supply a missing tuple; an accounting parent stays a whole tuple. */
function captureUsageAttribution(): ModelUsageAttributionContext {
  try {
    const current = modelUsageAttributionStorage.getStore();
    if (!current) return unownedUsage;
    const data = (object: object, key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return undefined;
      if (!('value' in descriptor)) throw new Error('unavailable attribution');
      return descriptor.value;
    };
    const tuple = (object: object): { sessionId: string; sourceUserSeq: number; attemptId?: string } => {
      const sessionId = data(object, 'sessionId'), sourceUserSeq = data(object, 'sourceUserSeq');
      const attemptId = data(object, 'attemptId');
      if (typeof sessionId !== 'string' || typeof sourceUserSeq !== 'number'
        || (attemptId !== undefined && typeof attemptId !== 'string')) throw new Error('unavailable attribution');
      return Object.freeze({ sessionId, sourceUserSeq, ...(attemptId !== undefined ? { attemptId } : {}) });
    };
    const own = tuple(current), parent = data(current, 'usageParentTurn');
    if (parent !== undefined && (!parent || typeof parent !== 'object' || Array.isArray(parent)))
      return unownedUsage;
    const usageParentTurn = parent !== undefined ? tuple(parent as object) : undefined;
    const usageJobId = data(current, 'usageJobId'), role = data(current, 'role');
    const channel = data(current, 'channel'), ownRequest = data(current, 'ownRequest');
    if ((usageJobId !== undefined && typeof usageJobId !== 'string')
      || (role !== undefined && (typeof role !== 'string'
        || !['brain', 'worker', 'reviewer', 'router', 'writer', 'memory', 'quick'].includes(role)))
      || (channel !== undefined && typeof channel !== 'string')
      || (ownRequest !== undefined && typeof ownRequest !== 'boolean')) return unownedUsage;
    const components = data(current, 'promptComponents');
    let promptComponents: Record<string, number> | undefined;
    if (components !== undefined) {
      if (!components || typeof components !== 'object' || Array.isArray(components)) return unownedUsage;
      const copied: Record<string, number> = Object.create(null);
      for (const key of Object.keys(components)) {
        const value = data(components, key);
        if (typeof value !== 'number' || !Number.isFinite(value)) return unownedUsage;
        copied[key] = value;
      }
      promptComponents = Object.freeze(copied);
    }
    return Object.freeze({ ...own,
      ...(usageParentTurn ? { usageParentTurn } : {}),
      ...(usageJobId !== undefined ? { usageJobId } : {}),
      ...(role !== undefined ? { role: role as ModelUsageAttributionContext['role'] } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(ownRequest !== undefined ? { ownRequest } : {}),
      ...(promptComponents ? { promptComponents } : {}),
    });
  } catch { return unownedUsage; }
}

export async function evaluateSystemOne(input: {
  state: unknown;
  questions: SystemOneQuestions;
  timeoutMs?: number;
  sessionId?: string;
  channel?: string;
  /** Host facts worth keeping beside the answers, e.g. the candidate ids. */
  decisionContext?: Record<string, unknown>;
  /** Optional completion diagnostics only; never changes transport cancellation. */
  captureOriginalWitness?: boolean;
  assessmentSignal?: AbortSignal;
}): Promise<SystemOneResult & { decisionId?: string }> {
  // Capture the whole request-local tuple and sink before asynchronous key
  // resolution. Missing-key/disabled paths still create no adapter attempt.
  const usageAttribution = captureUsageAttribution();
  let transportOwner;
  try {
    transportOwner = modelUsageAttributionStorage.run(usageAttribution,
      () => withOwnModelRequestAttribution({ role: 'router' }, () => captureModelTransportOwner()));
  } catch { transportOwner = captureUnavailableModelTransportOwner(); }
  const capturedOwner = input.captureOriginalWitness && input.channel === 'jev-completion'
    ? directAssessmentOwner() : undefined;
  let expectedBody: string | undefined;
  let questionnaireSha256: string | undefined;
  try {
    if (capturedOwner) {
      expectedBody = JSON.stringify(buildSystemOneRequest(input.state, input.questions));
      questionnaireSha256 = digest(JSON.stringify(input.questions));
    }
  } catch { /* diagnostics never replace a request or error */ }
  if (!jevEnabled()) return { ok: false, reason: 'disabled' };
  const key = await resolveTypesafeApiKey();
  if (!key) return { ok: false, reason: 'missing_key' };
  const started = Date.now();
  let observation!: ModelTransportAttempt;
  let actualBodies = 0; let bodyMatched = false;
  let result: SystemOneResult;
  try {
    result = await withOwnModelRequestAttribution({ role: 'router', channel: input.channel ?? 'jev' }, () => {
      observation = createModelTransportAttempt(randomUUID(), 1, transportOwner);
      const fetchImpl = fetchOverride ?? (globalThis.fetch as unknown as SystemOneFetch);
      return withModelTransportAttempt(observation, () => postSystemOne({
      apiKey: key.value,
      request: buildSystemOneRequest(input.state, input.questions),
      timeoutMs: input.timeoutMs,
      fetchImpl: (url, init) => {
        try { actualBodies++; bodyMatched = actualBodies === 1 && expectedBody !== undefined && init.body === expectedBody; }
        catch { bodyMatched = false; }
        return observeModelTransportFetch('typesafe_systemone', TYPESAFE_MODEL,
          () => fetchImpl(url, init), undefined, activeModelWireRequestSnapshot(init.body));
      },
    }));
    });
  } catch (error) {
    if (observation) finishModelTransportAttempt(observation, 'failed');
    throw error; // Diagnostics must not replace or disclose the original error.
  }
  finishModelTransportAttempt(observation, result.ok ? 'returned' : result.reason === 'timeout' ? 'cancelled' : 'failed',
    result.ok ? { providerReportedModel: result.providerReportedModel,
      usageKnown: result.usage.input_tokens !== undefined && result.usage.output_tokens !== undefined } : undefined);
  const durationMs = Date.now() - started;
  noteJevCreditOutcome(result);
  try {
    modelUsageAttributionStorage.run(usageAttribution, () => recordModelUsage({
      sessionId: input.sessionId?.trim() || 'jev',
      channel: input.channel ?? 'jev',
      role: 'router',
      account: JEV_ACCOUNT_ID,
      model: result.ok ? result.model : TYPESAFE_MODEL,
      requestModel: TYPESAFE_MODEL,
      ...(observation.owner ? { trace: { modelCallId: observation.modelCallId } } : {}),
      ...(result.ok && result.providerReportedModel ? { providerReportedModel: result.providerReportedModel } : {}),
      // Numeric placeholders keep existing rollups compatible, but a missing
      // wire count is unknown usage even when the decision itself succeeded.
      cacheDialect: result.ok && result.usage.input_tokens !== undefined && result.usage.output_tokens !== undefined
        ? 'none' : 'unknown',
      inputTokens: result.ok ? result.usage.input_tokens ?? 0 : 0,
      outputTokens: result.ok ? result.usage.output_tokens ?? 0 : 0,
      durationMs,
      ok: result.ok,
      ...(result.ok ? {} : { failReason: result.reason }),
    }));
  } catch { /* usage must never break the decision path */ }
  const decisionId = recordJevDecision({
    lane: input.channel ?? 'jev',
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    requestedModel: TYPESAFE_MODEL,
    ...(result.ok && result.providerReportedModel ? { servedModel: result.providerReportedModel } : {}),
    ...(result.ok && result.usage.input_tokens !== undefined ? { inputTokens: result.usage.input_tokens } : {}),
    ok: result.ok,
    ...(result.ok ? { answers: compactJevAnswers(result.answers) } : { failReason: result.reason }),
    durationMs,
    ...(input.decisionContext ? { context: input.decisionContext } : {}),
  });
  const returned = { ...result, decisionId };
  try {
    const actualOwner = observation.owner;
    if (capturedOwner && expectedBody && questionnaireSha256 && result.ok && bodyMatched && actualBodies === 1
      && !input.assessmentSignal?.aborted && input.sessionId === capturedOwner.sessionId
      && actualOwner && !actualOwner.accountingParent && actualOwner.sessionId === capturedOwner.sessionId
      && actualOwner.sourceUserSeq === capturedOwner.sourceUserSeq && actualOwner.runAttemptId === capturedOwner.attemptId
      && JSON.stringify(buildSystemOneRequest(input.state, input.questions)) === expectedBody) {
      if (originalOwners.has(result)) ambiguousOriginals.add(result); else originalOwners.add(result);
      const originalHash = digest(JSON.stringify(result));
      originalResults.set(returned, { original: result, originalHash, returnedHash: digest(JSON.stringify(returned)),
        signal: input.assessmentSignal,
        metadata: Object.freeze({ owner: capturedOwner, modelCallId: observation.modelCallId,
          physicalAttempt: observation.physicalAttempt, requestBodySha256: digest(expectedBody), questionnaireSha256,
          originalResultSha256: originalHash, requestedModel: TYPESAFE_MODEL,
          ...(result.providerReportedModel ? { providerReportedModel: result.providerReportedModel } : {}),
          providerResponseIdentity: 'unknown', accountBackend: 'unknown' }) });
    }
  } catch { /* missing proof is not a failed model decision */ }
  return returned;
}

export async function typesafeKeyIsConfigured(): Promise<boolean> {
  return Boolean(await resolveTypesafeApiKey());
}

export async function forgetTypesafeApiKey(): Promise<void> {
  const store = await getSecretStore();
  await store.delete('typesafe_api_key');
}
