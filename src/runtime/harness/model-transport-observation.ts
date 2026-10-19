import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent } from './eventlog.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { completedModelResponseBinding } from './model-response-binding.js';
import { modelCallPurpose, type ModelCallPurpose } from '../model-call-purpose.js';
import { modelUsageAttributionStorage, captureModelUsageProvenance, capturedModelUsageAttribution,
  standaloneModelAccountingJobFromContext, standaloneModelAccountingJobBinding,
  type StandaloneModelAccountingJob, type StandaloneModelAccountingJobBinding,
  type CapturedModelUsageProvenance, type ModelUsageAttributionContext } from '../usage-log.js';
import { associateOriginalReviewWireResponse, beginReviewWireTransform, captureReviewWireExpectation,
  finishReviewWireTransform, reviewWireInclusionForDispatch, unavailableReviewWireExpectation, type ClaudeSystemTextProjection,
  type ReviewWireExpectation, type ReviewWireInclusionObservation, type ReviewWireOwner,
  type ReviewWireTransform } from './review-input-observation.js';

export type ObservedModelTransport = 'raw_claude_messages' | 'typesafe_systemone';
export type ModelTransportRecorder = (data: Readonly<Record<string, unknown>>) => unknown;

interface ObservationOwner {
  sessionId: string; sourceUserSeq: number; runAttemptId?: string;
  accountingParent: boolean; usageJobId?: string;
}
export interface ModelTransportAttempt {
  readonly modelCallId: string;
  readonly physicalAttempt: number;
  readonly owner?: Readonly<ObservationOwner>;
  readonly accountingJob?: Readonly<StandaloneModelAccountingJobBinding>;
  readonly purpose: 'brain' | 'worker' | 'reviewer' | 'router' | 'writer' | 'memory' | 'unknown';
  readonly callPurpose?: ModelCallPurpose;
}
/** A nominal snapshot taken at the public model call, including an explicit
 * absent owner. A lazy stream must never borrow its later drainer's scope. */
export interface CapturedModelTransportOwner {
  readonly owner?: Readonly<ObservationOwner>;
  readonly accountingJob?: Readonly<StandaloneModelAccountingJobBinding>;
  readonly purpose: ModelTransportAttempt['purpose'];
}
const capturedOwners = new WeakMap<CapturedModelTransportOwner, { record?: ModelTransportRecorder; expectation: ReviewWireExpectation; usage?: CapturedModelUsageProvenance; framePromptComponents?: Record<string, number> }>();
const publicUsageOwner = new AsyncLocalStorage<CapturedModelTransportOwner>();
interface AttemptState {
  record: ModelTransportRecorder;
  dispatchIds: string[];
  terminal: boolean;
  journalFailed: boolean;
  expectation: ReviewWireExpectation;
  usage?: CapturedModelUsageProvenance;
  framePromptComponents?: Record<string, number>;
  wireInclusions: ReviewWireInclusionObservation[];
  producer?: ClaudeModelWireProducer;
  ambiguousProducer: boolean;
  localOutcome?: 'failed' | 'cancelled' | 'returned';
  localOriginal?: { response: object; providerResponseIdDigest: string };
  ambiguousLocalOriginal?: true;
}
export interface ClaudeModelWireProducer { readonly kind: 'claude_raw_aisdk_producer' }
const claudeProducers = new WeakSet<ClaudeModelWireProducer>();
/** Minted at the raw adapter's actual aisdk factory, never from provider JSON. */
export function createClaudeModelWireProducer(): ClaudeModelWireProducer {
  const producer = Object.freeze({ kind: 'claude_raw_aisdk_producer' as const });
  claudeProducers.add(producer); return producer;
}
export function declareActiveClaudeModelWireProducer(producer: ClaudeModelWireProducer): void {
  const scope = activeAttempt.getStore(); const state = scope && states.get(scope);
  if (!state || state.terminal) return;
  if (!claudeProducers.has(producer) || (state.producer && state.producer !== producer)) state.ambiguousProducer = true;
  else state.producer = producer;
}
function reviewWireOwner(scope: ModelTransportAttempt): ReviewWireOwner | undefined {
  return !scope.accountingJob && scope.owner ? { sessionId: scope.owner.sessionId, sourceUserSeq: scope.owner.sourceUserSeq,
    attemptId: scope.owner.runAttemptId, modelCallId: scope.modelCallId, physicalAttempt: scope.physicalAttempt } : undefined;
}
export function beginActiveClaudeReviewWireTransform(body: Record<string, unknown>): ReviewWireTransform | undefined {
  try {
    const scope = activeAttempt.getStore(); const state = scope && states.get(scope); const owner = scope && reviewWireOwner(scope);
    return state?.producer && !state.terminal && !state.ambiguousProducer && owner
      ? beginReviewWireTransform(state.expectation, owner, body) : undefined;
  } catch { return undefined; }
}
export function finishActiveClaudeReviewWireTransform(transform: ReviewWireTransform | undefined,
  body: Record<string, unknown>, projection: ClaudeSystemTextProjection | undefined, identity: string): void {
  if (transform) try { finishReviewWireTransform(transform, body, projection, identity); } catch { /* diagnostic only */ }
}
const states = new WeakMap<ModelTransportAttempt, AttemptState>();
const activeAttempt = new AsyncLocalStorage<ModelTransportAttempt>();
const overrideRecorder = new AsyncLocalStorage<ModelTransportRecorder>();
const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);

interface WirePart { readonly sha256: string; readonly bytes: number }
export interface ModelWireRequestSnapshot {
  readonly serialized: Readonly<WirePart>;
  readonly components: Readonly<Partial<Record<'system' | 'messages' | 'tools' | 'toolSchemas' | 'output_config', Readonly<WirePart>>>>;
}
const wireSnapshots = new WeakSet<ModelWireRequestSnapshot>();
const wirePart = (text: string): Readonly<WirePart> => Object.freeze({
  sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8'),
});

/** Final serialized request hashes only. This does not attest that any rubric
 * or guide was included; that requires its own exact nominal component join. */
export function modelWireRequestSnapshot(serialized: unknown): ModelWireRequestSnapshot | undefined {
  try {
    if (typeof serialized !== 'string') return undefined;
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const body = parsed as Record<string, unknown>;
    const components: ModelWireRequestSnapshot['components'] = {};
    const mutable = components as Record<string, Readonly<WirePart>>;
    for (const key of ['system', 'messages', 'tools', 'output_config'] as const) {
      if (Object.hasOwn(body, key)) mutable[key] = wirePart(JSON.stringify(body[key]));
    }
    if (Array.isArray(body.tools)) mutable.toolSchemas = wirePart(JSON.stringify(body.tools.map(tool =>
      tool && typeof tool === 'object' && !Array.isArray(tool) ? (tool as Record<string, unknown>).input_schema ?? null : null)));
    const snapshot = Object.freeze({ serialized: wirePart(serialized), components: Object.freeze(components) });
    wireSnapshots.add(snapshot);
    return snapshot;
  } catch { return undefined; }
}

/** Avoid hashing detached/unobserved traffic. Their inventory remains unknown. */
export function activeModelWireRequestSnapshot(serialized: unknown): ModelWireRequestSnapshot | undefined {
  const scope = activeAttempt.getStore();
  return scope?.owner || scope?.accountingJob ? modelWireRequestSnapshot(serialized) : undefined;
}

/** Test/request-local sink only; concurrent requests never share mutable sinks. */
export function withModelTransportRecorder<T>(record: ModelTransportRecorder, work: () => T): T {
  return overrideRecorder.run(record, work);
}

function snapshotOwner(): Readonly<ObservationOwner> | undefined {
  const current = modelUsageAttributionStorage.getStore();
  if (standaloneModelAccountingJobFromContext(current)) return undefined;
  // Select a whole existing accounting tuple. A detached memory job may carry
  // its parent, but its own attempt must never be spliced into that tuple.
  const value = current && identity(current.sessionId) && current.sessionId !== 'unknown'
    && Number.isSafeInteger(current.sourceUserSeq) && current.sourceUserSeq > 0
    ? current : current?.usageParentTurn;
  if (!value || !identity(value.sessionId) || value.sessionId === 'unknown'
    || !Number.isSafeInteger(value.sourceUserSeq) || value.sourceUserSeq <= 0) return undefined;
  return Object.freeze({ sessionId: value.sessionId, sourceUserSeq: value.sourceUserSeq,
    accountingParent: value !== current,
    ...(identity(current?.usageJobId) ? { usageJobId: current.usageJobId } : {}),
    ...(identity(value.attemptId) ? { runAttemptId: value.attemptId } : {}) });
}

function emit(scope: ModelTransportAttempt, fields: Record<string, unknown>): void {
  const state = states.get(scope);
  if (!state || (!scope.owner && !scope.accountingJob)) return;
  try {
    const data = Object.freeze({ ...fields, version: 1,
    ...(scope.accountingJob ? { ownerKind: 'accounting_job', ...scope.accountingJob } : {
      sourceUserSeq: scope.owner!.sourceUserSeq, logicalTurnId: `turn:${scope.owner!.sourceUserSeq}`,
      ownerKind: scope.owner!.accountingParent ? 'accounting_parent' : 'accepted_source_scope',
      ...(scope.owner!.usageJobId ? { usageJobId: scope.owner!.usageJobId } : {}),
      ...(scope.owner!.runAttemptId ? { runAttemptId: scope.owner!.runAttemptId } : {}),
    }), modelCallId: scope.modelCallId,
    physicalAttempt: scope.physicalAttempt, purpose: scope.purpose,
    ...(scope.callPurpose ? { callPurpose: scope.callPurpose } : {}),
    at: Date.now(), clock: 'host_epoch_ms', journalFailed: state.journalFailed });
    const returned = state.record(data);
    if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(returned).catch(() => { state.journalFailed = true; });
    }
  } catch { state.journalFailed = true; /* diagnostics never change dispatch */ }
}

export function captureModelTransportOwner(): CapturedModelTransportOwner {
  const current = modelUsageAttributionStorage.getStore();
  const role = current?.role;
  const purpose = role && ['brain', 'worker', 'reviewer', 'router', 'writer', 'memory'].includes(role) ? role : 'unknown';
  const owner = snapshotOwner();
  const job = standaloneModelAccountingJobFromContext(current);
  const accountingJob = job && standaloneModelAccountingJobBinding(job);
  const captured = Object.freeze({ ...(owner ? { owner } : {}), ...(accountingJob ? { accountingJob } : {}), purpose }) as CapturedModelTransportOwner;
  capturedOwners.set(captured, { record: overrideRecorder.getStore(),
    expectation: job ? unavailableReviewWireExpectation() : captureReviewWireExpectation(),
    ...(job ? { usage: captureModelUsageProvenance() } : {}) });
  return captured;
}

/** Failed diagnostic capture is explicitly unowned, never a request to adopt
 * a later caller's ALS. This uses the same nominal token and original sink. */
export function captureUnavailableModelTransportOwner(): CapturedModelTransportOwner {
  const captured = Object.freeze({ purpose: 'unknown' as const });
  capturedOwners.set(captured, { record: overrideRecorder.getStore(), expectation: unavailableReviewWireExpectation() });
  return captured;
}

/** BYO public-entry accounting only. Snapshot before its outer lazy assertion;
 * never run provider work under copied harness or usage attribution authority.
 * Other providers' ordinary owner capture does not perform this usage capture. */
export function captureModelTransportUsageOwner(fallback?: ModelUsageAttributionContext): CapturedModelTransportOwner {
  const usage = modelUsageAttributionStorage.getStore() === undefined && fallback
    ? modelUsageAttributionStorage.run(fallback, captureModelUsageProvenance) : captureModelUsageProvenance();
  const captured = modelUsageAttributionStorage.run(capturedModelUsageAttribution(usage)
    ?? { sessionId: 'unknown', sourceUserSeq: 0 }, captureModelTransportOwner);
  capturedOwners.get(captured)!.usage = usage;
  const owner = captured.owner;
  if (owner && fallback && owner.sessionId === fallback.sessionId && owner.sourceUserSeq === fallback.sourceUserSeq
    && owner.runAttemptId === fallback.attemptId && fallback.promptComponents) {
    capturedOwners.get(captured)!.framePromptComponents = fallback.promptComponents;
  }
  return captured;
}

export function withPublicModelTransportUsageOwner<T>(owner: CapturedModelTransportOwner, work: () => T): T {
  return publicUsageOwner.run(owner, work);
}

/** An adapter attempt is not a wire request. Capture its owner before any
 * transport work; actual fetches mint their own IDs under this immutable scope. */
export function createModelTransportAttempt(modelCallId: string, physicalAttempt: number,
  captured: CapturedModelTransportOwner = captureModelTransportOwner(),
  requestPurpose?: ModelCallPurpose): ModelTransportAttempt {
  const nominal = capturedOwners.has(captured);
  const purpose = nominal ? captured.purpose : 'unknown';
  const owner = nominal ? captured.owner : undefined;
  const accountingJob = nominal ? captured.accountingJob : undefined;
  // A stage is advisory metadata. It cannot supply an absent nominal owner,
  // and a later async drainer cannot rename an already-created request.
  const callPurpose = modelCallPurpose(requestPurpose);
  const scope = Object.freeze({ modelCallId, physicalAttempt, ...(owner ? { owner } : {}),
    ...(accountingJob ? { accountingJob } : {}), purpose,
    ...(callPurpose ? { callPurpose } : {}) }) as ModelTransportAttempt;
  const capturedState = nominal ? capturedOwners.get(captured) : undefined;
  const record = capturedState?.record ?? ((data: Readonly<Record<string, unknown>>) => {
    if (accountingJob) recordOperationalEvent({ source: 'model', type: 'model_accounting_observed',
      actor: 'model-transport-observation', modelCallId, payload: data });
    else appendEvent({ sessionId: owner!.sessionId, turn: 0, role: 'system', type: 'model_transport_observed', data });
  });
  if (identity(modelCallId) && Number.isSafeInteger(physicalAttempt) && physicalAttempt > 0) {
    states.set(scope, { record, dispatchIds: [], terminal: false, journalFailed: false,
      expectation: capturedState?.expectation ?? unavailableReviewWireExpectation(), usage: capturedState?.usage,
      framePromptComponents: capturedState?.framePromptComponents,
      wireInclusions: [], ambiguousProducer: false });
    // Creation is a local declaration, not proof that an SDK or fetch ran.
    emit(scope, { phase: 'adapter_attempt_created', resultScope: 'local_adapter_attempt', dispatchIds: [] });
  }
  return scope;
}

export interface CapturedModelTransportUsage {
  readonly attempt?: ModelTransportAttempt;
  readonly callerProvenance: CapturedModelUsageProvenance;
  readonly owner?: Readonly<ObservationOwner>;
  readonly framePromptComponents?: Record<string, number>;
}
function usageMatchesAttempt(scope: ModelTransportAttempt, usage: CapturedModelUsageProvenance): boolean {
  const current = capturedModelUsageAttribution(usage);
  if (scope.accountingJob) {
    const token = standaloneModelAccountingJobFromContext(current);
    const binding = token && standaloneModelAccountingJobBinding(token);
    return !!binding && binding.usageJobId === scope.accountingJob.usageJobId
      && binding.operation === scope.accountingJob.operation && binding.operationId === scope.accountingJob.operationId
      && binding.revisionDigest === scope.accountingJob.revisionDigest && !scope.owner
      && scope.purpose === (current?.role ?? 'unknown');
  }
  const value = current && identity(current.sessionId) && current.sessionId !== 'unknown'
    && Number.isSafeInteger(current.sourceUserSeq) && current.sourceUserSeq > 0 ? current : current?.usageParentTurn;
  const owner = scope.owner;
  // A background job outside any turn (a scheduled memory job) has no turn
  // tuple: its attempt has no owner and the usage it captured at entry names
  // only the job. That entry capture is its own accounting, never a later
  // drainer's.
  if (!owner && current && !value && identity(current.usageJobId)) {
    return scope.purpose === (current.role ?? 'unknown');
  }
  return !!owner && !!value && owner.sessionId === value.sessionId
    && owner.sourceUserSeq === value.sourceUserSeq && owner.runAttemptId === value.attemptId
    && owner.accountingParent === (value !== current) && owner.usageJobId === current?.usageJobId
    && scope.purpose === (current?.role ?? 'unknown');
}
function emptyUsage(): CapturedModelUsageProvenance {
  return modelUsageAttributionStorage.run({ sessionId: 'unknown', sourceUserSeq: 0 }, captureModelUsageProvenance);
}
/** Absent is legacy. Present unsupported/retired metadata must not become
 * permission to borrow the later drainer's accounting namespace. */
export function captureActiveModelTransportUsage(): CapturedModelTransportUsage | undefined {
  const scope = activeAttempt.getStore();
  if (scope) {
    const state = states.get(scope);
    if (!state?.usage || !usageMatchesAttempt(scope, state.usage)) {
      return Object.freeze({ attempt: scope, callerProvenance: emptyUsage() });
    }
    return Object.freeze({ attempt: scope, callerProvenance: state.usage, owner: scope.owner,
      framePromptComponents: state.framePromptComponents });
  }
  const captured = publicUsageOwner.getStore();
  if (!captured) return undefined;
  const state = capturedOwners.get(captured);
  return Object.freeze({ callerProvenance: state?.usage ?? emptyUsage(), ...(state ? {
    owner: captured.owner, framePromptComponents: state.framePromptComponents } : {}) });
}
/** Only the same live nominal attempt can provide the invocation UUID. Usage
 * still records with its captured tuple when the UUID cannot be certified. */
export function capturedModelTransportUsageCallId(scope: ModelTransportAttempt | undefined,
  usage: CapturedModelUsageProvenance): string | undefined {
  const state = scope && states.get(scope);
  return scope && (scope.purpose !== 'unknown' || scope.accountingJob !== undefined) && state && !state.terminal && state.localOutcome === undefined
    && !state.journalFailed && state.usage === usage
    && usageMatchesAttempt(scope, usage) ? scope.modelCallId : undefined;
}

/** Local invocation/receipt links only. Missing observations never prove no
 * model ran, and a returned operation does not certify provider usage. */
export function recordStandaloneModelAccountingJobObservation(job: StandaloneModelAccountingJob, input: {
  phase: 'job_started' | 'job_finished' | 'operation_receipt';
  outcome?: 'returned' | 'failed'; receiptDigest?: string;
}): void {
  const binding = standaloneModelAccountingJobBinding(job);
  if (!binding) return;
  try {
    recordOperationalEvent({ source: 'model', type: 'model_accounting_observed', actor: binding.operation === 'meeting_opportunity' ? 'meeting' : 'noticing', payload: {
      version: 1, ownerKind: 'accounting_job', ...binding, phase: input.phase,
      ...(input.outcome ? { outcome: input.outcome, usage: 'unknown' } : {}),
      ...(input.receiptDigest && /^[a-f0-9]{64}$/.test(input.receiptDigest) ? { receiptDigest: input.receiptDigest } : {}),
      at: Date.now(), clock: 'host_epoch_ms',
    } });
  } catch { /* Accounting never changes the operation's result. */ }
}

export function withModelTransportAttempt<T>(scope: ModelTransportAttempt, work: () => T): T {
  return activeAttempt.run(scope, work);
}

/** Generator creation does not retain ALS. Bind every next/return/throw to the
 * same captured attempt without buffering, changing yields or retry policy. */
export function modelTransportAttemptStream<T>(scope: ModelTransportAttempt, iterable: AsyncIterable<T>): AsyncIterable<T> {
  return { [Symbol.asyncIterator]() {
    const iterator = withModelTransportAttempt(scope, () => iterable[Symbol.asyncIterator]());
    return {
      next: (...args: [] | [unknown]) => withModelTransportAttempt(scope, () => iterator.next(...args as [])),
      ...(iterator.return ? { return: (value?: unknown) => withModelTransportAttempt(scope, () => iterator.return!(value as never)) } : {}),
      ...(iterator.throw ? { throw: (error?: unknown) => withModelTransportAttempt(scope, () => iterator.throw!(error)) } : {}),
    };
  } };
}

/** Observe only the existing fetch and its headers/failure. Never inspect or
 * consume response bodies, URLs, headers, credentials, prompts or raw errors. */
export async function observeModelTransportFetch<T extends { status: number; ok: boolean }>(
  transport: ObservedModelTransport, requestedModel: unknown, work: () => Promise<T>,
  retryReason?: 'cache_ttl_rejected',
  wireRequest?: ModelWireRequestSnapshot,
  reviewWire?: { transform?: ReviewWireTransform; serialized: unknown },
): Promise<T> {
  const scope = activeAttempt.getStore();
  const state = scope && states.get(scope);
  if (!scope || !state) return work();
  const dispatchId = randomUUID();
  const ordinal = state.dispatchIds.push(dispatchId);
  const started = Date.now();
  let wireInputInclusion: ReviewWireInclusionObservation | undefined;
  if (reviewWire && transport === 'raw_claude_messages') try {
    const owner = reviewWireOwner(scope);
    if (owner) wireInputInclusion = reviewWireInclusionForDispatch(state.expectation,
      state.producer && !state.ambiguousProducer && !state.terminal ? reviewWire.transform : undefined,
      owner, dispatchId, ordinal, reviewWire.serialized);
    if (wireInputInclusion) state.wireInclusions.push(wireInputInclusion);
  } catch { state.journalFailed = true; }
  emit(scope, { phase: 'dispatch_started', transport, dispatchId, wireSubattempt: ordinal,
    ...(wireInputInclusion ? { wireInputInclusion } : {}),
    ...(wireRequest && wireSnapshots.has(wireRequest) ? { wireRequest } : {}),
    ...(identity(requestedModel) ? { requestedModel } : {}), ...(retryReason ? { retryReason } : {}),
    late: state.terminal });
  try {
    const result = await work();
    try {
      emit(scope, { phase: 'headers_received', transport, dispatchId, wireSubattempt: ordinal,
        status: result.status, ok: result.ok, durationMs: Math.max(0, Date.now() - started),
        modelCompletion: 'unproved', late: state.terminal });
    } catch { state.journalFailed = true; }
    return result;
  } catch (error) {
    emit(scope, { phase: 'dispatch_failed', transport, dispatchId, wireSubattempt: ordinal,
      durationMs: Math.max(0, Date.now() - started), usage: 'unknown', late: state.terminal });
    throw error;
  }
}

/** Called only after the original provider result acquired the private
 * completed-response binding, before any Runner aggregate/metadata clone. */
export function observeCompletedTransportModelResponse(scope: ModelTransportAttempt, response: unknown): void {
  const binding = completedModelResponseBinding(response);
  if (!binding || binding.modelCallId !== scope.modelCallId || binding.physicalAttempt !== scope.physicalAttempt) return;
  const state = states.get(scope);
  if (state && state.localOutcome === undefined && response && typeof response === 'object') {
    if (state.localOriginal && (state.localOriginal.response !== response
      || state.localOriginal.providerResponseIdDigest !== binding.providerResponseIdDigest)) state.ambiguousLocalOriginal = true;
    else state.localOriginal = { response, providerResponseIdDigest: binding.providerResponseIdDigest };
  }
  if (!state || state.terminal || state.dispatchIds.length === 0) return;
  const owner = reviewWireOwner(scope);
  if (owner && state.wireInclusions.length) try {
    associateOriginalReviewWireResponse(state.expectation, response, owner, state.dispatchIds, state.wireInclusions);
  } catch { state.journalFailed = true; }
  state.terminal = true;
  emit(scope, { phase: 'model_result_completed', resultScope: 'original_sdk_response',
    hostResultReceiptId: randomUUID(),
    dispatchIds: [...state.dispatchIds], providerResponseIdDigest: binding.providerResponseIdDigest,
    ...(state.wireInclusions.length ? { reviewWireInclusionReceipts: state.wireInclusions.map(record => record.receiptId) } : {}),
    rawHttpBodyEof: 'not_observed', wireUsageCoverage: 'unproved' });
}

/** Jev owns its parsed result. This local retirement does not declare remote
 * settlement, nor make missing/failed usage zero or headers a completion. */
export function finishModelTransportAttempt(scope: ModelTransportAttempt, outcome: 'failed' | 'cancelled' | 'returned',
  parsedResult?: { providerReportedModel?: string; usageKnown: boolean }): void {
  const state = states.get(scope);
  if (state && state.localOutcome === undefined) {
    // Original response observation can precede empty-response failure or
    // cancellation. Only this existing finish boundary supplies local outcome.
    const binding = state.localOriginal && !state.ambiguousLocalOriginal
      ? completedModelResponseBinding(state.localOriginal.response) : undefined;
    const original = binding && binding.modelCallId === scope.modelCallId && binding.physicalAttempt === scope.physicalAttempt
      && binding.providerResponseIdDigest === state.localOriginal?.providerResponseIdDigest ? binding : undefined;
    const parsed = parsedResult && outcome === 'returned' ? parsedResult : undefined;
    state.localOutcome = outcome;
    emit(scope, { phase: 'adapter_attempt_finished', outcome,
      resultScope: original ? 'original_sdk_response' : parsed ? 'owned_systemone_parser' : 'local_retirement',
      dispatchIds: [...state.dispatchIds], usage: parsed?.usageKnown ? 'reported' : 'unknown',
      ...(original ? { providerResponseIdDigest: original.providerResponseIdDigest } : {}),
      ...(identity(parsed?.providerReportedModel) ? { providerReportedModel: parsed.providerReportedModel } : {}),
      remoteSettlement: parsed ? 'parsed_response' : 'unknown' });
  }
  if (!state || state.terminal || state.dispatchIds.length === 0) return;
  state.terminal = true;
  emit(scope, { phase: parsedResult && outcome === 'returned' ? 'model_result_completed' : 'model_attempt_retired',
    hostResultReceiptId: randomUUID(),
    resultScope: parsedResult ? 'owned_systemone_parser' : 'local_retirement', outcome,
    dispatchIds: [...state.dispatchIds], usage: parsedResult?.usageKnown ? 'reported' : 'unknown',
    ...(identity(parsedResult?.providerReportedModel) ? { providerReportedModel: parsedResult.providerReportedModel } : {}),
    remoteSettlement: parsedResult && outcome === 'returned' ? 'parsed_response' : 'unknown',
    wireUsageCoverage: 'unproved' });
}
