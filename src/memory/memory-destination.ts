import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MemoryScope } from './memory-scope.js';

// These hashes bind stored bytes; they do not confer owner authority. Intake
// must verify the admitted event and retained context before making an origin.
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
const scopeSchema = z.object({ projectId: z.string().min(1).nullable(), agentKey: z.string().min(1).nullable() }).strict();
const contextSchema = z.object({
  sessionId: z.string().min(1), sourceUserSeq: z.number().int().positive(), digest: hashSchema,
  memoryScope: scopeSchema,
}).strict();
const sourceSchema = z.object({
  authority: z.enum(['accepted_user_input', 'direct_user_input']),
  sessionId: z.string().min(1), eventId: z.string().min(1).nullable(), eventSeq: z.number().int().positive().nullable(),
  eventType: z.enum(['user_input_received', 'user_steer_note', 'direct_user_input']),
  ownerText: z.string().min(1), context: contextSchema.nullable(),
}).strict();
const originInputSchema = z.object({
  source: sourceSchema,
  claim: spanSchema,
  // Complete explicit claims cannot shrink. Inferred source candidates may be
  // narrowed by the existing durability reviewer. Unknown mappings stay held.
  claimMode: z.enum(['complete', 'selectable', 'unresolved']),
  candidate: z.object({ kind: z.enum(['user', 'project', 'feedback', 'reference', 'constraint']), text: z.string().min(1) }).strict(),
}).strict();
const originSchema = originInputSchema.extend({
  ownerTextDigest: hashSchema, claimTextDigest: hashSchema, candidateTextDigest: hashSchema,
}).strict();
const decisionSchema = z.object({
  durability: z.enum(['standing', 'task', 'unresolved']), claim: spanSchema,
  destination: z.enum(['kind_default', 'everywhere', 'current_project', 'current_agent', 'current_context', 'unresolved']),
  destinationSpans: z.array(spanSchema), reason: z.string().trim().min(1),
}).strict();
const envelopeSchema = z.object({
  version: z.literal(1), origin: originSchema, originDigest: hashSchema, decision: decisionSchema.nullable(),
}).strict();

export type MemoryDestinationSpan = z.infer<typeof spanSchema>;
export type AutomaticMemoryOriginInput = z.infer<typeof originInputSchema>;
export type AutomaticMemoryOrigin = z.infer<typeof originSchema>;
export type AutomaticMemoryDecision = z.infer<typeof decisionSchema>;
export type AutomaticMemoryEnvelope = z.infer<typeof envelopeSchema>;
export type AutomaticMemoryDestination =
  | { status: 'resolved'; scope: MemoryScope; claimText: string }
  | { status: 'task' | 'unresolved'; reason: string };

function spanText(source: string, span: MemoryDestinationSpan): string {
  if (span.start >= span.end || span.end > source.length) throw new Error('Memory destination span is outside its owner source.');
  // Spans use JavaScript UTF-16 indices. Splitting a surrogate pair is not an
  // exact source-text boundary, even if both halves can be JSON-serialized.
  for (const edge of [span.start, span.end]) {
    if (edge > 0 && edge < source.length
      && /[\uD800-\uDBFF]/.test(source[edge - 1]!) && /[\uDC00-\uDFFF]/.test(source[edge]!)) {
      throw new Error('Memory destination span splits a source character.');
    }
  }
  const text = source.slice(span.start, span.end);
  if (!text.trim()) throw new Error('Memory destination span is empty.');
  return text;
}

export function createAutomaticMemoryOrigin(input: AutomaticMemoryOriginInput): AutomaticMemoryOrigin {
  const parsed = originInputSchema.parse(input);
  const { source } = parsed;
  if (source.authority === 'accepted_user_input') {
    if (!source.eventId || source.eventSeq === null || source.eventType === 'direct_user_input') {
      throw new Error('Automatic memory has no exact owner event identity.');
    }
  } else if (source.eventId !== null || source.eventSeq !== null || source.eventType !== 'direct_user_input') {
    throw new Error('Direct memory origin cannot claim an accepted event.');
  }
  if (source.context && (source.context.sessionId !== source.sessionId
    || (source.eventType === 'user_input_received' && source.context.sourceUserSeq !== source.eventSeq))) {
    throw new Error('Automatic memory context belongs to a different accepted source.');
  }
  return { ...parsed, ownerTextDigest: digest(source.ownerText),
    claimTextDigest: digest(spanText(source.ownerText, parsed.claim)), candidateTextDigest: digest(parsed.candidate.text) };
}

function validateOrigin(value: unknown): AutomaticMemoryOrigin {
  const origin = originSchema.parse(value);
  const { ownerTextDigest: _source, claimTextDigest: _claim, candidateTextDigest: _candidate, ...input } = origin;
  const expected = createAutomaticMemoryOrigin(input);
  if (digest(origin) !== digest(expected)) throw new Error('Automatic memory origin digest does not match its source bytes.');
  return expected;
}

export function automaticMemoryOriginDigest(origin: AutomaticMemoryOrigin): string {
  return digest(validateOrigin(origin));
}

/** Kind and reviewer-selected spans are immutable values, not alternate keys.
 * A changed replay must conflict with its original candidate, not mint another. */
export function automaticMemoryCandidateIdentity(origin: AutomaticMemoryOrigin): string {
  const parsed = validateOrigin(origin);
  const { source } = parsed;
  return digest({ version: 1, sessionId: source.sessionId, authority: source.authority,
    eventId: source.eventId, eventSeq: source.eventSeq, eventType: source.eventType, claim: parsed.claim });
}

export function createAutomaticMemoryEnvelope(origin: AutomaticMemoryOrigin): AutomaticMemoryEnvelope {
  const parsed = validateOrigin(origin);
  return { version: 1, origin: parsed, originDigest: digest(parsed), decision: null };
}

export function withAutomaticMemoryDecision(
  envelope: AutomaticMemoryEnvelope, value: AutomaticMemoryDecision,
): AutomaticMemoryEnvelope {
  const origin = validateOrigin(envelope.origin);
  if (envelope.version !== 1 || envelope.originDigest !== digest(origin)) throw new Error('Automatic memory envelope identity changed.');
  const decision = decisionSchema.parse(value);
  spanText(origin.source.ownerText, decision.claim);
  for (const span of decision.destinationSpans) spanText(origin.source.ownerText, span);
  if (decision.durability === 'standing') {
    if (origin.claimMode === 'unresolved') throw new Error('Unresolved claim provenance cannot authorize a standing memory.');
    const complete = origin.claimMode === 'complete';
    if (complete
      ? decision.claim.start > origin.claim.start || decision.claim.end < origin.claim.end
      : decision.claim.start < origin.claim.start || decision.claim.end > origin.claim.end) {
      throw new Error('Memory destination decision lost its authorized claim span.');
    }
    if (decision.destination !== 'kind_default' && decision.destination !== 'unresolved'
      && decision.destinationSpans.length === 0) throw new Error('Explicit memory destination has no owner source span.');
  }
  if (envelope.decision !== null && digest(envelope.decision) !== digest(decision)) {
    throw new Error('Automatic memory destination decision is already frozen.');
  }
  return { version: 1, origin, originDigest: digest(origin), decision };
}

export function parseAutomaticMemoryEnvelope(value: unknown): AutomaticMemoryEnvelope {
  const parsed = envelopeSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
  const initial = createAutomaticMemoryEnvelope(parsed.origin);
  if (parsed.originDigest !== initial.originDigest) throw new Error('Automatic memory envelope origin is inconsistent.');
  return parsed.decision === null ? initial : withAutomaticMemoryDecision(initial, parsed.decision);
}

export function automaticMemoryEnvelopeDigest(envelope: AutomaticMemoryEnvelope): string {
  return digest(parseAutomaticMemoryEnvelope(envelope));
}

export function automaticMemoryDecisionDigest(envelope: AutomaticMemoryEnvelope): string | null {
  const parsed = parseAutomaticMemoryEnvelope(envelope);
  return parsed.decision === null ? null : digest({ originDigest: parsed.originDigest, decision: parsed.decision });
}

export function resolveAutomaticMemoryDestination(envelope: AutomaticMemoryEnvelope): AutomaticMemoryDestination {
  const { origin, decision } = parseAutomaticMemoryEnvelope(envelope);
  if (decision?.durability === 'task') return { status: 'task', reason: decision.reason };
  if (!decision || decision.durability === 'unresolved' || decision.destination === 'unresolved') {
    return { status: 'unresolved', reason: decision?.reason ?? 'Memory destination has not been reviewed.' };
  }
  // A valid JSON shape is not proof that a historical source had a context.
  // Consumers must also reopen/verify this exact retained context before use.
  const context = origin.source.context;
  if (!context || origin.source.authority !== 'accepted_user_input') {
    return { status: 'unresolved', reason: 'Memory destination has no retained accepted-source context.' };
  }
  let scope: MemoryScope;
  switch (decision.destination) {
    case 'everywhere': scope = { projectId: null, agentKey: null }; break;
    case 'kind_default': scope = origin.candidate.kind === 'user' || origin.candidate.kind === 'constraint'
      ? { projectId: null, agentKey: null } : { ...context.memoryScope }; break;
    case 'current_project':
      if (!context.memoryScope.projectId) return { status: 'unresolved', reason: 'The accepted source has no project destination.' };
      scope = { projectId: context.memoryScope.projectId, agentKey: null }; break;
    case 'current_agent':
      if (!context.memoryScope.agentKey) return { status: 'unresolved', reason: 'The accepted source has no agent destination.' };
      scope = { projectId: null, agentKey: context.memoryScope.agentKey }; break;
    case 'current_context':
      if (!context.memoryScope.projectId && !context.memoryScope.agentKey) {
        return { status: 'unresolved', reason: 'The accepted source has no local context destination.' };
      }
      scope = { ...context.memoryScope }; break;
  }
  return { status: 'resolved', scope, claimText: spanText(origin.source.ownerText, decision.claim) };
}
