import { createHash, randomUUID } from 'node:crypto';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { completedModelResponseBinding, type CompletedModelResponseBinding } from './model-response-binding.js';

/** Fixed vocabulary only: changing source text is hashed, never retained in a receipt. */
export type ReviewInputComponentName =
  | 'judge_rubric' | 'host_completion_guidance' | 'memory_review_guidance'
  | 'effective_objective' | 'candidate_response' | 'private_review_evidence'
  | 'coverage_ledger' | 'retained_skill_references' | 'standing_instructions'
  | 'memory_requirement_context' | 'evidence_tool_guidance' | 'evidence_reference_inventory'
  | 'coverage_followup' | 'verdict_restatement_instructions' | 'verdict_restatement_input';

export interface ReviewInputComponent {
  readonly name: ReviewInputComponentName;
  readonly startByte: number;
  readonly endByte: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** Transient assembly value. Its text is the existing model input, not diagnostic output. */
export interface ReviewInputComposition {
  readonly text: string;
  readonly components: readonly ReviewInputComponent[];
}
export type ReviewInputPart = string | { text: string; component: ReviewInputComponentName } | ReviewInputComposition;
const compositions = new WeakSet<object>();
const componentNames = new Set<string>([
  'judge_rubric', 'host_completion_guidance', 'memory_review_guidance', 'effective_objective',
  'candidate_response', 'private_review_evidence', 'coverage_ledger', 'retained_skill_references',
  'standing_instructions', 'memory_requirement_context', 'evidence_tool_guidance',
  'evidence_reference_inventory', 'coverage_followup', 'verdict_restatement_instructions', 'verdict_restatement_input',
]);
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Preserve join bytes and derive component positions at construction, never by parsing prose. */
export function composeReviewInput(parts: readonly ReviewInputPart[], separator: string): ReviewInputComposition {
  const components: ReviewInputComponent[] = [];
  const texts: string[] = [];
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (index) position += Buffer.byteLength(separator, 'utf8');
    const text = typeof part === 'string' ? part : part.text;
    texts.push(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (typeof part !== 'string' && 'component' in part) {
      if (!componentNames.has(part.component)) throw new Error('Unknown review input component');
      components.push(Object.freeze({ name: part.component, startByte: position,
        endByte: position + bytes, bytes, sha256: hash(text) }));
    } else if (typeof part !== 'string') {
      if (!compositions.has(part)) throw new Error('Unknown review input composition');
      components.push(...part.components.map(component => Object.freeze({ ...component,
        startByte: component.startByte + position, endByte: component.endByte + position })));
    }
    position += bytes;
  }
  const result = Object.freeze({ text: texts.join(separator), components: Object.freeze(components) });
  compositions.add(result);
  return result;
}

export type ReviewInputStage = 'completion' | 'confirmation' | 'coverage_followup' | 'verdict_restatement';
export interface ReviewInputOwner { sessionId: string; sourceUserSeq: number; attemptId?: string }
export interface ReviewInputSeed {
  readonly owner: ReviewInputOwner;
  readonly stage: ReviewInputStage;
  readonly objectiveDigest: string;
  readonly candidateDigest: string;
  readonly instructions: ReviewInputComposition;
  readonly prompt: ReviewInputComposition;
}
type UnqualifiedReason = 'owner_unavailable' | 'assembly_unavailable' | 'request_unavailable'
  | 'request_mismatch' | 'request_mutated' | 'response_unbound' | 'response_ambiguous'
  | 'response_mutated' | 'final_response_unproven' | 'cancelled_or_incomplete' | 'observation_unavailable';

export interface BoundReviewInputObservation {
  readonly version: 1;
  readonly scope: 'sdk_model_entry';
  readonly status: 'bound';
  readonly sessionId: string;
  readonly sourceUserSeq: number;
  readonly attemptId: string;
  readonly objectiveDigest: string;
  readonly candidateDigest: string;
  readonly reviewStage: ReviewInputStage;
  readonly reviewInvocationId: string;
  readonly requestOrdinal: number;
  readonly modelCallId: string;
  /** Resilience ordinal only; not a complete inventory of transport dispatches. */
  readonly physicalAttempt: number;
  readonly providerResponseIdDigest: string;
  readonly sdkRequestSha256: string;
  readonly sdkRequestBytes: number;
  readonly instructionsSha256: string;
  readonly inputSha256: string;
  readonly toolsSha256: string;
  readonly toolCount: number;
  readonly responseOutputSha256: string;
  readonly components: readonly (ReviewInputComponent & { readonly scope: 'instructions' | 'prompt' })[];
  readonly wireDispatchInventory: 'unknown';
  readonly accountBackendBilling: 'unknown';
}
export type ReviewInputObservation = BoundReviewInputObservation | {
  readonly version: 1; readonly scope: 'sdk_model_entry'; readonly status: 'unqualified'; readonly reason: UnqualifiedReason;
};
const observations = new WeakSet<object>();
const originalOwners = new WeakMap<object, object>();
const ambiguousOriginals = new WeakSet<object>();
const safeIdentity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
const safeDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Canonical content is transient. Only hashes/byte counts leave this function. */
function canonical(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 100) throw new Error('Unbounded review observation');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Unsupported review observation');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item, ancestors, depth + 1)).join(',') + ']';
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Unsupported review observation object');
    }
    return '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], ancestors, depth + 1)).join(',') + '}';
  } finally { ancestors.delete(value); }
}

function requestSnapshot(request: ModelRequest) {
  // No auth headers, tracing payloads, cancellation objects or arbitrary future fields.
  const selected = { systemInstructions: request.systemInstructions, input: request.input,
    modelSettings: request.modelSettings, tools: request.tools, handoffs: request.handoffs,
    outputType: request.outputType, previousResponseId: request.previousResponseId,
    conversationId: request.conversationId, prompt: request.prompt,
    overridePromptModel: request.overridePromptModel, toolsExplicitlyProvided: request.toolsExplicitlyProvided };
  const text = canonical(selected);
  return Object.freeze({ sdkRequestSha256: hash(text), sdkRequestBytes: Buffer.byteLength(text, 'utf8'),
    instructionsSha256: hash(request.systemInstructions ?? ''), inputSha256: hash(canonical(request.input)),
    toolsSha256: hash(canonical(request.tools)), toolCount: request.tools.length });
}

function hasInitialPrompt(input: ModelRequest['input'], prompt: string): boolean {
  if (typeof input === 'string') return input === prompt;
  const first = input[0] as { role?: unknown; content?: unknown } | undefined;
  // Exact structural SDK message, never substring/prefix matching or inferred prose.
  return first?.role === 'user' && first.content === prompt;
}

function finalResponseText(response: unknown): string | undefined {
  const output = (response as ModelResponse)?.output;
  if (!Array.isArray(output)) return undefined;
  const last = output.filter(item => item.type === 'message' && item.role === 'assistant').at(-1) as unknown as
    { status?: unknown; content?: unknown } | undefined;
  if (!last || last.status !== 'completed' || !Array.isArray(last.content)) return undefined;
  const texts = last.content.filter((part: unknown): part is { type: 'output_text'; text: string } =>
    Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'output_text'
      && typeof (part as { text?: unknown }).text === 'string'));
  // The text reviewer has one final text item. Other output shapes remain unknown.
  return texts.length === 1 && texts[0]?.type === 'output_text' ? texts[0].text : undefined;
}

interface Entry {
  ordinal: number;
  snapshot?: ReturnType<typeof requestSnapshot>;
  binding?: CompletedModelResponseBinding;
  responseOutputSha256?: string;
  reason?: UnqualifiedReason;
  settled: boolean;
}

/** Each reviewer attempt owns this collector. Cached/shared models keep no mutable callback. */
export function createReviewInputObservation(seed: ReviewInputSeed, options: {
  signal?: AbortSignal;
  /** Read the owning request-local scope; a supplied seed alone cannot attest ownership. */
  ownerAtEntry?: () => ReviewInputOwner | undefined;
  observe?: (record: ReviewInputObservation) => unknown;
} = {}): {
  wrap: (inner: Model) => Model;
  finish: (responses: readonly unknown[] | undefined, finalOutput: unknown) => ReviewInputObservation;
} {
  const token = {};
  const invocationId = randomUUID();
  const owner = Object.freeze({ ...seed.owner });
  const stage = seed.stage;
  const objectiveDigest = seed.objectiveDigest;
  const candidateDigest = seed.candidateDigest;
  const instructions = seed.instructions;
  const prompt = seed.prompt;
  const entries = new WeakMap<object, Entry>();
  let ordinal = 0;
  let ownerValid = false;
  let assemblyValid = false;
  try {
    ownerValid = safeIdentity(owner.sessionId) && Number.isSafeInteger(owner.sourceUserSeq) && owner.sourceUserSeq > 0
      && safeIdentity(owner.attemptId) && safeDigest(objectiveDigest) && safeDigest(candidateDigest);
    assemblyValid = compositions.has(instructions) && compositions.has(prompt);
  } catch { /* missing observation never affects review execution */ }
  const start = (request: ModelRequest): Entry => {
    const entry: Entry = { ordinal: ++ordinal, settled: false };
    try {
      if (!ownerValid) entry.reason = 'owner_unavailable';
      else if (!['completion', 'confirmation', 'coverage_followup', 'verdict_restatement'].includes(stage)) entry.reason = 'assembly_unavailable';
      else if (!assemblyValid) entry.reason = 'assembly_unavailable';
      else {
        const current = options.ownerAtEntry?.();
        if (!current || current.sessionId !== owner.sessionId || current.sourceUserSeq !== owner.sourceUserSeq
          || current.attemptId !== owner.attemptId) entry.reason = 'owner_unavailable';
        else {
          entry.snapshot = requestSnapshot(request);
          if (request.systemInstructions !== instructions.text || !hasInitialPrompt(request.input, prompt.text)) entry.reason = 'request_mismatch';
        }
      }
    } catch { entry.reason = 'request_unavailable'; }
    return entry;
  };
  const capture = (entry: Entry, request: ModelRequest, response: unknown): void => {
    try {
      if (!response || typeof response !== 'object') { entry.reason ??= 'response_unbound'; return; }
      if (originalOwners.has(response)) ambiguousOriginals.add(response);
      else originalOwners.set(response, token);
      if (ambiguousOriginals.has(response)) entry.reason = 'response_ambiguous';
      if (entry.snapshot && requestSnapshot(request).sdkRequestSha256 !== entry.snapshot.sdkRequestSha256) entry.reason = 'request_mutated';
      // Must occur on the ORIGINAL adapter return, before Runner retry aggregation.
      entry.binding = completedModelResponseBinding(response);
      if (!entry.binding) entry.reason ??= 'response_unbound';
      entry.responseOutputSha256 = hash(canonical((response as ModelResponse).output));
      entries.set(response, entry);
    } catch { entry.reason ??= 'observation_unavailable'; }
  };
  const wrap = (inner: Model): Model => ({
    async getResponse(request) {
      const entry = start(request);
      const response = await inner.getResponse(request);
      capture(entry, request, response);
      entry.settled = true;
      if (options.signal?.aborted || request.signal?.aborted) entry.reason = 'cancelled_or_incomplete';
      return response;
    },
    async *getStreamedResponse(request): AsyncIterable<StreamEvent> {
      const entry = start(request);
      let finished = false;
      try {
        for await (const event of inner.getStreamedResponse(request)) {
          if (event.type === 'response_done') capture(entry, request, event.response);
          yield event;
        }
        finished = true;
      } finally {
        entry.settled = finished;
        if (!finished || options.signal?.aborted || request.signal?.aborted) entry.reason = 'cancelled_or_incomplete';
      }
    },
    ...(inner.getRetryAdvice ? { getRetryAdvice: inner.getRetryAdvice.bind(inner) } : {}),
  });
  const finish = (responses: readonly unknown[] | undefined, finalOutput: unknown): ReviewInputObservation => {
    let reason: UnqualifiedReason = 'final_response_unproven';
    let record: ReviewInputObservation | undefined;
    try {
      const last = responses?.at(-1);
      const entry = last && typeof last === 'object' ? entries.get(last) : undefined;
      if (entry) {
        reason = entry.reason ?? 'final_response_unproven';
        const binding = completedModelResponseBinding(last);
        if (ambiguousOriginals.has(last as object) || originalOwners.get(last as object) !== token
          || responses?.filter(response => response === last).length !== 1) reason = 'response_ambiguous';
        else if (!entry.settled || options.signal?.aborted) reason = 'cancelled_or_incomplete';
        else if (entry.binding && (binding !== entry.binding
          || hash(canonical((last as ModelResponse).output)) !== entry.responseOutputSha256)) reason = 'response_mutated';
        else if (!entry.reason && binding && entry.snapshot && entry.responseOutputSha256
          && typeof finalOutput === 'string' && finalResponseText(last) === finalOutput) {
          record = Object.freeze({ version: 1, scope: 'sdk_model_entry', status: 'bound', sessionId: owner.sessionId,
            sourceUserSeq: owner.sourceUserSeq, attemptId: owner.attemptId!, objectiveDigest, candidateDigest,
            reviewStage: stage, reviewInvocationId: invocationId, requestOrdinal: entry.ordinal, ...binding,
            ...entry.snapshot, responseOutputSha256: entry.responseOutputSha256,
            components: Object.freeze([
              ...instructions.components.map(component => Object.freeze({ ...component, scope: 'instructions' as const })),
              ...prompt.components.map(component => Object.freeze({ ...component, scope: 'prompt' as const })),
            ]), wireDispatchInventory: 'unknown', accountBackendBilling: 'unknown' });
        }
      }
    } catch { reason = 'observation_unavailable'; }
    record ??= Object.freeze({ version: 1, scope: 'sdk_model_entry', status: 'unqualified', reason });
    observations.add(record);
    try {
      const returned = options.observe?.(record);
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') void Promise.resolve(returned).catch(() => {});
    } catch { /* observation cannot affect the reviewer or its verdict */ }
    return record;
  };
  return { wrap, finish };
}

/** Durable diagnostics only. A shape or cloned record never inherits nominal proof. */
export function reviewInputObservationForSource(value: unknown, expected: {
  sessionId: string; sourceUserSeq: number; attemptId?: string; objectiveDigest: string; candidateDigest: string;
}): ReviewInputObservation | undefined {
  try {
    if (!value || typeof value !== 'object' || !observations.has(value)) return undefined;
    const record = value as ReviewInputObservation;
    if (record.status === 'unqualified') return record;
    return record.sessionId === expected.sessionId && record.sourceUserSeq === expected.sourceUserSeq
      && record.attemptId === expected.attemptId && record.objectiveDigest === expected.objectiveDigest
      && record.candidateDigest === expected.candidateDigest ? record : undefined;
  } catch { return undefined; }
}
