import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { completedModelResponseBinding, type CompletedModelResponseBinding } from './model-response-binding.js';
import { CACHE_BREAK_SENTINEL, INSTRUCTION_CACHE_DELIM } from './model-wire-registry.js';
import { modelUsageAttributionStorage, type ModelUsageAttributionContext } from '../usage-log.js';

/** Fixed vocabulary only: changing source text is hashed, never retained in a receipt. */
export type ReviewInputComponentName =
  | 'judge_rubric' | 'host_completion_guidance' | 'memory_review_guidance'
  | 'effective_objective' | 'candidate_response' | 'private_review_evidence'
  | 'coverage_ledger' | 'retained_skill_references' | 'standing_instructions'
  | 'memory_requirement_context' | 'evidence_tool_guidance' | 'evidence_reference_inventory'
  | 'coverage_followup' | 'verdict_restatement_instructions' | 'verdict_restatement_input'
  /** A later review round's new message, sent after the earlier round's exact conversation. */
  | 'review_revision';

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
interface TerminalDelimiter { startByte: number; endByte: number; sentinelByte: number }
const compositionLayouts = new WeakMap<object, { terminal?: TerminalDelimiter; unsupportedMarker: boolean }>();
const componentNames = new Set<string>([
  'judge_rubric', 'host_completion_guidance', 'memory_review_guidance', 'effective_objective',
  'candidate_response', 'private_review_evidence', 'coverage_ledger', 'retained_skill_references',
  'standing_instructions', 'memory_requirement_context', 'evidence_tool_guidance',
  'evidence_reference_inventory', 'coverage_followup', 'verdict_restatement_instructions', 'verdict_restatement_input',
  'review_revision',
]);
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Preserve join bytes and derive component positions at construction, never by parsing prose. */
export function composeReviewInput(parts: readonly ReviewInputPart[], separator: string): ReviewInputComposition {
  const components: ReviewInputComponent[] = [];
  const texts: string[] = [];
  let position = 0;
  let terminal: TerminalDelimiter | undefined;
  let unsupportedMarker = false;
  for (const [index, part] of parts.entries()) {
    if (index) position += Buffer.byteLength(separator, 'utf8');
    const text = typeof part === 'string' ? part : part.text;
    texts.push(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    const child = typeof part !== 'string' && compositions.has(part) ? compositionLayouts.get(part) : undefined;
    if (typeof part === 'string' && part === INSTRUCTION_CACHE_DELIM && index === parts.length - 1) {
      terminal = { startByte: position, endByte: position + bytes, sentinelByte: position + Buffer.byteLength('\n\n') };
    } else if (child?.terminal && !child.unsupportedMarker && index === parts.length - 1 && child.terminal.endByte === bytes) {
      terminal = { startByte: child.terminal.startByte + position, endByte: child.terminal.endByte + position,
        sentinelByte: child.terminal.sentinelByte + position };
    } else if (child?.terminal || text.includes(CACHE_BREAK_SENTINEL)) {
      // Negative eligibility only. Never find a guide/component by searching text.
      unsupportedMarker = true;
    }
    unsupportedMarker ||= child?.unsupportedMarker ?? false;
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
  compositionLayouts.set(result, { terminal, unsupportedMarker });
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
  readonly wireInputInclusion?: ReviewWireCompletionObservation;
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

/** Opaque request-local tokens. Serialized shapes never inherit their proof. */
export interface ReviewWireExpectation { readonly kind: 'review_wire_expectation' }
export interface ReviewWireTransform { readonly kind: 'review_wire_transform' }
export interface ReviewWireOwner extends ReviewInputOwner { modelCallId: string; physicalAttempt: number }
export interface ClaudeSystemTextProjection {
  readonly branch: 'parity_cache'; readonly identityPrefixRemoved: boolean;
  readonly cacheBreakByte: number | null; readonly role: string; readonly core: string; readonly dynamic: string;
}
export interface ReviewWireInclusionObservation {
  readonly version: 1; readonly scope: 'sdk_text_components_to_final_decoded_wire';
  readonly status: 'bound' | 'unqualified'; readonly receiptId: string; readonly reason?: string;
  readonly [key: string]: unknown;
}
export interface ReviewWireCompletionObservation {
  readonly version: 1; readonly scope: 'original_sdk_response_dispatch_inclusion'; readonly status: 'bound' | 'unqualified';
  readonly dispatches: readonly ReviewWireInclusionObservation[];
  readonly wireResponseAttribution: 'unproved'; readonly wireUsageAndEof: 'unproved';
}
interface WireExpectationState {
  owner: Readonly<ReviewInputOwner>; invocationId: string; ordinal: number; sdkRequestSha256: string;
  instructions?: Buffer; prompt?: Buffer; terminal?: TerminalDelimiter; reason?: string;
  components: readonly (ReviewInputComponent & { scope: 'instructions' | 'prompt' })[]; closed: boolean;
}
interface WireTransformState {
  expectation: ReviewWireExpectation; owner: ReviewWireOwner; reason?: string;
  identity?: string; role?: Buffer; retainedStart?: number; retainedEnd?: number;
  finalized: boolean;
}
const wireExpectations = new WeakMap<ReviewWireExpectation, WireExpectationState>();
const wireTransforms = new WeakMap<ReviewWireTransform, WireTransformState>();
const wireContext = new AsyncLocalStorage<ReviewWireExpectation>();
const absentWireExpectation = Object.freeze({ kind: 'review_wire_expectation' as const });
export function unavailableReviewWireExpectation(): ReviewWireExpectation { return absentWireExpectation; }
const wireReceipts = new WeakMap<ReviewWireInclusionObservation, { expectation: ReviewWireExpectation; owner: ReviewWireOwner; dispatchId: string }>();
const wireOriginals = new WeakMap<object, { expectation: ReviewWireExpectation; observation: ReviewWireCompletionObservation }>();
const ambiguousWireOriginals = new WeakSet<object>();

export function captureReviewWireExpectation(): ReviewWireExpectation {
  return wireContext.getStore() ?? absentWireExpectation;
}
export function withReviewWireExpectation<T>(expectation: ReviewWireExpectation, work: () => T): T {
  return wireContext.run(expectation, work);
}
function expectationStream<T>(expectation: ReviewWireExpectation, iterable: AsyncIterable<T>,
  accounting: Readonly<ModelUsageAttributionContext> | undefined): AsyncIterable<T> {
  // Only accounting is restored, never tool/harness authority or model pins.
  const run = <U>(work: () => U) => accounting ? modelUsageAttributionStorage.run(accounting, () => withReviewWireExpectation(expectation, work))
    : modelUsageAttributionStorage.exit(() => withReviewWireExpectation(expectation, work));
  return { [Symbol.asyncIterator]() {
    const iterator = run(() => iterable[Symbol.asyncIterator]());
    return {
      next: (...args: [] | [unknown]) => run(() => iterator.next(...args as [])),
      ...(iterator.return ? { return: (value?: unknown) => run(() => iterator.return!(value as never)) } : {}),
      ...(iterator.throw ? { throw: (error?: unknown) => run(() => iterator.throw!(error)) } : {}),
    };
  } };
}
function createWireExpectation(seed: ReviewInputSeed, invocationId: string, entry: Entry, request: ModelRequest): ReviewWireExpectation {
  const token = Object.freeze({ kind: 'review_wire_expectation' as const });
  try {
    const layout = compositionLayouts.get(seed.instructions);
    const promptLayout = compositionLayouts.get(seed.prompt);
    const input = request.input;
    const singleUser = typeof input === 'string' || (Array.isArray(input) && input.length === 1
      && (input[0] as { role?: unknown; content?: unknown }).role === 'user'
      && typeof (input[0] as { content?: unknown }).content === 'string');
    const override = request.modelSettings.providerData as Record<string, unknown> | undefined;
    const reason = entry.reason || !entry.snapshot ? 'sdk_input_unqualified'
      : !singleUser || override?.prompt !== undefined || request.prompt !== undefined ? 'unsupported_sdk_layout'
      : layout?.unsupportedMarker || promptLayout?.unsupportedMarker || promptLayout?.terminal ? 'unsupported_marker_layout' : undefined;
    const components = Object.freeze([
      ...seed.instructions.components.map(c => Object.freeze({ ...c, scope: 'instructions' as const })),
      ...seed.prompt.components.map(c => Object.freeze({ ...c, scope: 'prompt' as const })),
    ]);
    const terminal = layout?.terminal;
    const intersects = terminal && components.some(c => c.scope === 'instructions'
      && c.startByte < terminal.endByte && c.endByte > terminal.startByte);
    wireExpectations.set(token, { owner: Object.freeze({ ...seed.owner }), invocationId, ordinal: entry.ordinal,
      sdkRequestSha256: entry.snapshot?.sdkRequestSha256 ?? '', components, terminal,
      ...(reason || intersects ? { reason: reason ?? 'component_intersects_removed_marker' }
        : { instructions: Buffer.from(seed.instructions.text, 'utf8'), prompt: Buffer.from(seed.prompt.text, 'utf8') }), closed: false });
  } catch { /* no token state means explicit unqualified; never foreign fallback */ }
  return token;
}
function closeWireExpectation(expectation: ReviewWireExpectation): void {
  const state = wireExpectations.get(expectation);
  if (state) { state.closed = true; state.instructions = undefined; state.prompt = undefined; }
}
function sameWireOwner(a: ReviewWireOwner, b: ReviewWireOwner): boolean {
  return a.sessionId === b.sessionId && a.sourceUserSeq === b.sourceUserSeq && a.attemptId === b.attemptId
    && a.modelCallId === b.modelCallId && a.physicalAttempt === b.physicalAttempt;
}
function plainText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const part = value as Record<string, unknown>;
  return part.type === 'text' && typeof part.text === 'string'
    && Object.keys(part).every(key => ['type', 'text', 'cache_control'].includes(key)) ? part.text : undefined;
}
function oneUserText(body: Record<string, unknown>): string | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user') return undefined;
  const content = messages[0].content;
  return Array.isArray(content) && content.length === 1 ? plainText(content[0]) : undefined;
}

/** Called only through an active nominal raw-aisdk factory/attempt. Fixed slots
 * must equal the whole SDK text before any host transform; no content search. */
export function beginReviewWireTransform(expectation: ReviewWireExpectation, owner: ReviewWireOwner,
  body: Record<string, unknown>): ReviewWireTransform | undefined {
  const state = wireExpectations.get(expectation);
  if (!state) return undefined;
  const transform = Object.freeze({ kind: 'review_wire_transform' as const });
  let reason = state.reason;
  try {
    if (state.closed || state.owner.sessionId !== owner.sessionId || state.owner.sourceUserSeq !== owner.sourceUserSeq
      || state.owner.attemptId !== owner.attemptId) reason = 'foreign_or_retired_expectation';
    const system = body.system;
    const instructions = Array.isArray(system) && system.length === 1 ? plainText(system[0]) : undefined;
    const prompt = oneUserText(body);
    if (!reason && (instructions === undefined || prompt === undefined)) reason = 'unsupported_pre_envelope_slots';
    if (!reason && (!state.instructions?.equals(Buffer.from(instructions!, 'utf8'))
      || !state.prompt?.equals(Buffer.from(prompt!, 'utf8')))) reason = 'pre_envelope_text_mismatch';
  } catch { reason = 'observation_unavailable'; }
  wireTransforms.set(transform, { expectation, owner: Object.freeze({ ...owner }), reason, finalized: false });
  return transform;
}

/** Projection is from the branch actually executed by buildClaudeSystemBlocks,
 * including its already selected sentinel, trim and role/core/dynamic slots. */
export function finishReviewWireTransform(transform: ReviewWireTransform, body: Record<string, unknown>,
  projection: ClaudeSystemTextProjection | undefined, identityText: string): void {
  const recipe = wireTransforms.get(transform);
  if (!recipe || recipe.finalized) return;
  recipe.finalized = true;
  const state = wireExpectations.get(recipe.expectation);
  try {
    if (recipe.reason) return;
    if (!state?.instructions || !state.prompt || state.closed) { recipe.reason = 'retired_expectation'; return; }
    if (!projection || projection.branch !== 'parity_cache' || projection.identityPrefixRemoved
      || projection.core !== '' || projection.dynamic !== '') { recipe.reason = 'unsupported_executed_branch'; return; }
    if (projection.cacheBreakByte !== (state.terminal?.sentinelByte ?? null)) { recipe.reason = 'unsupported_cache_split'; return; }
    const prefix = state.instructions.subarray(0, state.terminal?.startByte ?? state.instructions.length).toString('utf8');
    const role = Buffer.from(prefix.trim(), 'utf8');
    const left = Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(prefix.trimStart(), 'utf8');
    const end = left + role.length;
    const system = body.system;
    if (!Array.isArray(system) || system.length !== 2 || plainText(system[0]) !== identityText
      || plainText(system[1]) !== projection.role || !role.equals(Buffer.from(projection.role, 'utf8'))
      || oneUserText(body) !== state.prompt.toString('utf8')) { recipe.reason = 'final_executed_slots_mismatch'; return; }
    recipe.identity = identityText; recipe.role = role; recipe.retainedStart = left; recipe.retainedEnd = end;
  } catch { recipe.reason = 'observation_unavailable'; }
}

/** Revalidate every ACTUAL serialized body, including each TTL retry. JSON
 * syntax bytes are hashed separately from decoded text and component bytes. */
export function reviewWireInclusionForDispatch(expectation: ReviewWireExpectation, transform: ReviewWireTransform | undefined,
  owner: ReviewWireOwner, dispatchId: string, wireSubattempt: number, serialized: unknown): ReviewWireInclusionObservation | undefined {
  const state = wireExpectations.get(expectation);
  if (!state) return undefined;
  const recipe = transform && wireTransforms.get(transform);
  const base = { version: 1 as const, scope: 'sdk_text_components_to_final_decoded_wire' as const,
    receiptId: randomUUID(), sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq, attemptId: owner.attemptId,
    modelCallId: owner.modelCallId, physicalAttempt: owner.physicalAttempt, dispatchId, wireSubattempt };
  let record: ReviewWireInclusionObservation;
  try {
    let reason = state.reason ?? recipe?.reason;
    if (!recipe || recipe.expectation !== expectation || !sameWireOwner(recipe.owner, owner) || !recipe.finalized) reason = 'foreign_or_unfinished_transform';
    if (state.closed) reason = 'retired_expectation';
    else if (!state.instructions || !state.prompt) reason ??= 'sdk_input_unqualified';
    if (!reason && typeof serialized !== 'string') reason = 'serialized_request_unavailable';
    const body = !reason ? JSON.parse(serialized as string) as Record<string, unknown> : undefined;
    const system = body?.system;
    const roleText = Array.isArray(system) && system.length === 2 ? plainText(system[1]) : undefined;
    const userText = body ? oneUserText(body) : undefined;
    if (!reason && (!Array.isArray(system) || system.length !== 2 || plainText(system[0]) !== recipe!.identity
      || roleText === undefined || userText === undefined
      || !recipe!.role?.equals(Buffer.from(roleText, 'utf8'))
      || !state.prompt!.equals(Buffer.from(userText, 'utf8')))) reason = 'actual_dispatch_text_mismatch';
    if (reason) record = Object.freeze({ ...base, status: 'unqualified', reason });
    else {
      const first = recipe!.retainedStart!; const end = recipe!.retainedEnd!;
      const components = state.components.map(c => {
        const source = c.scope === 'instructions' ? state.instructions! : state.prompt!;
        const valid = Number.isSafeInteger(c.startByte) && Number.isSafeInteger(c.endByte)
          && c.startByte >= 0 && c.endByte >= c.startByte && c.endByte <= source.length
          && c.bytes === c.endByte - c.startByte && hash(source.subarray(c.startByte, c.endByte).toString('utf8')) === c.sha256;
        const retained = valid && (c.scope === 'prompt' || (c.startByte >= first && c.endByte <= end));
        return Object.freeze({ ...c, preservation: retained ? 'same_bytes' : 'unqualified_trimmed_or_removed',
          ...(retained ? { wireSlot: c.scope === 'instructions' ? 'system[1].text' : 'messages[0].content[0].text',
            wireStartByte: c.startByte - (c.scope === 'instructions' ? first : 0),
            wireEndByte: c.endByte - (c.scope === 'instructions' ? first : 0) } : {}) });
      });
      const allComponentsPreserved = components.every(component => component.preservation === 'same_bytes');
      record = Object.freeze({ ...base, status: allComponentsPreserved ? 'bound' : 'unqualified',
        ...(!allComponentsPreserved ? { reason: 'component_bytes_transformed' } : {}), constructorProfile: 'claude_aisdk_single_system_single_user_text_v1',
        reviewInvocationId: state.invocationId, requestOrdinal: state.ordinal, sdkRequestSha256: state.sdkRequestSha256,
        wireRequestSha256: hash(serialized as string), wireRequestBytes: Buffer.byteLength(serialized as string, 'utf8'),
        wholeInstructions: state.terminal || first !== 0 || end !== state.instructions!.length ? 'transformed_match' : 'same_bytes',
        transforms: Object.freeze([...(state.terminal ? ['nominal_terminal_cache_delimiter_removed'] : []),
          ...(first !== 0 || end !== (state.terminal?.startByte ?? state.instructions!.length) ? ['executed_outer_trim'] : [])]),
        retainedInstructionStartByte: first, retainedInstructionEndByte: end, components: Object.freeze(components),
        wireResponseAttribution: 'unproved', wireUsageAndEof: 'unproved' });
    }
  } catch { record = Object.freeze({ ...base, status: 'unqualified', reason: 'observation_unavailable' }); }
  wireReceipts.set(record, { expectation, owner: Object.freeze({ ...owner }), dispatchId });
  return record;
}

export function associateOriginalReviewWireResponse(expectation: ReviewWireExpectation, response: unknown,
  owner: ReviewWireOwner, dispatchIds: readonly string[], receipts: readonly ReviewWireInclusionObservation[]): void {
  const state = wireExpectations.get(expectation); const binding = completedModelResponseBinding(response);
  if (!state || !response || typeof response !== 'object' || !binding || state.closed
    || state.owner.sessionId !== owner.sessionId || state.owner.sourceUserSeq !== owner.sourceUserSeq || state.owner.attemptId !== owner.attemptId
    || binding.modelCallId !== owner.modelCallId || binding.physicalAttempt !== owner.physicalAttempt) return;
  if (wireOriginals.has(response)) { ambiguousWireOriginals.add(response); return; }
  const valid = receipts.length === dispatchIds.length && receipts.length > 0 && new Set(dispatchIds).size === dispatchIds.length
    && new Set(receipts.map(record => record.receiptId)).size === receipts.length && receipts.every((receipt, index) => {
    const nominal = wireReceipts.get(receipt);
    return nominal?.expectation === expectation && sameWireOwner(nominal.owner, owner)
      && nominal.dispatchId === dispatchIds[index] && receipt.status === 'bound';
  });
  wireOriginals.set(response, { expectation, observation: Object.freeze({ version: 1,
    scope: 'original_sdk_response_dispatch_inclusion', status: valid ? 'bound' : 'unqualified',
    dispatches: Object.freeze([...receipts]), wireResponseAttribution: 'unproved', wireUsageAndEof: 'unproved' }) });
}

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

function hasInitialPrompt(input: ModelRequest['input'], prompt: string, continuedFrom?: readonly unknown[]): boolean {
  if (continuedFrom) return continuesReview(input, prompt, continuedFrom);
  if (typeof input === 'string') return input === prompt;
  const first = input[0] as { role?: unknown; content?: unknown } | undefined;
  // Exact structural SDK message, never substring/prefix matching or inferred prose.
  return first?.role === 'user' && first.content === prompt;
}

/** A continued review round: the earlier round's exact conversation, item for
 *  item, then this round's message as the next user turn. Nothing else. */
export function continuesReview(input: ModelRequest['input'], prompt: string, history: readonly unknown[]): boolean {
  if (typeof input === 'string' || history.length === 0 || input.length <= history.length) return false;
  const next = input[history.length] as { role?: unknown; content?: unknown } | undefined;
  if (next?.role !== 'user' || next.content !== prompt) return false;
  try {
    return JSON.stringify(input.slice(0, history.length)) === JSON.stringify(history);
  } catch {
    return false;
  }
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
  wireExpectation?: ReviewWireExpectation;
  wireInputInclusion?: ReviewWireCompletionObservation;
}

/** Each reviewer attempt owns this collector. Cached/shared models keep no mutable callback. */
export function createReviewInputObservation(seed: ReviewInputSeed, options: {
  signal?: AbortSignal;
  /** Read the owning request-local scope; a supplied seed alone cannot attest ownership. */
  ownerAtEntry?: () => ReviewInputOwner | undefined;
  observe?: (record: ReviewInputObservation) => unknown;
  /** A continued round: the exact earlier conversation the prompt follows. */
  continuedFrom?: readonly unknown[];
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
  const wireSeed = Object.freeze({ owner, stage, objectiveDigest, candidateDigest, instructions, prompt });
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
          if (request.systemInstructions !== instructions.text || !hasInitialPrompt(request.input, prompt.text, options.continuedFrom)) entry.reason = 'request_mismatch';
        }
      }
    } catch { entry.reason = 'request_unavailable'; }
    entry.wireExpectation = createWireExpectation(wireSeed, invocationId, entry, request);
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
      const wire = wireOriginals.get(response);
      if (wire && wire.expectation === entry.wireExpectation && !ambiguousWireOriginals.has(response)) entry.wireInputInclusion = wire.observation;
      entries.set(response, entry);
    } catch { entry.reason ??= 'observation_unavailable'; }
  };
  const wrap = (inner: Model): Model => ({
    async getResponse(request) {
      const entry = start(request);
      try {
        const response = await withReviewWireExpectation(entry.wireExpectation!, () => inner.getResponse(request));
        capture(entry, request, response);
        entry.settled = true;
        if (options.signal?.aborted || request.signal?.aborted) entry.reason = 'cancelled_or_incomplete';
        return response;
      } finally { closeWireExpectation(entry.wireExpectation!); }
    },
    getStreamedResponse(request): AsyncIterable<StreamEvent> {
      const entry = start(request);
      const currentAccounting = modelUsageAttributionStorage.getStore();
      let accounting: Readonly<ModelUsageAttributionContext> | undefined;
      try { accounting = currentAccounting ? Object.freeze({ ...currentAccounting,
        ...(currentAccounting.usageParentTurn ? { usageParentTurn: Object.freeze({ ...currentAccounting.usageParentTurn }) } : {}),
        ...(currentAccounting.promptComponents ? { promptComponents: Object.freeze({ ...currentAccounting.promptComponents }) } : {}) }) : undefined;
      } catch { /* explicit absent accounting, never a later drainer's owner */ }
      const stream = (async function* (): AsyncIterable<StreamEvent> {
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
          closeWireExpectation(entry.wireExpectation!);
        }
      })();
      return expectationStream(entry.wireExpectation!, stream, accounting);
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
            ...(entry.wireInputInclusion ? { wireInputInclusion: entry.wireInputInclusion } : {}),
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
