/**
 * Foreground turn outcome and public presentation contract.
 *
 * A brain may produce arbitrary internal text while it plans, calls tools, or
 * verifies work. None of that text is deliverable merely because the run
 * stopped. A TurnOutcome names the durable result of one accepted user turn;
 * its PresentationEvent is the only projection a transport may render as the
 * final assistant message.
 *
 * Keep this contract deliberately small. Progress, model identity, token use,
 * judge notes, and other operator telemetry remain ordinary internal events.
 */
import { parseNarratedEnvelope } from './envelope-narration.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import { looksLikeCompactDecisionProtocol } from './presentation-hygiene.js';

export type TurnOutcomeStatus = 'done' | 'needs_input' | 'blocked' | 'failed' | 'cancelled';

export type TurnNeed =
  | { kind: 'input' }
  | { kind: 'approval' }
  | { kind: 'continue' };

export type TurnEvidenceKind =
  | 'tool_result'
  | 'external_receipt'
  | 'artifact'
  | 'source'
  | 'memory';

/** Addressable proof only. Bulky tool output and internal reasoning stay in
 * their owning ledgers; the presentation boundary carries references. */
export interface TurnEvidenceRef {
  kind: TurnEvidenceKind;
  id: string;
  uri?: string;
}

interface TurnIdentityBase {
  sessionId: string;
  turn: number;
  /** Exact durable user_input_received event accepted for this logical turn. */
  sourceUserSeq: number;
  /** Physical execution metadata only. These fields may help operators trace a
   * winner, but must never affect public idempotency or logical ownership. */
  attemptId?: string;
  runId?: string;
}

/** Every public terminal belongs to one exact accepted user-input event.
 * Provider attempts and run ids are deliberately non-authoritative metadata:
 * several physical brains can race to finish the same logical turn. */
export type TurnIdentity = TurnIdentityBase;

export type PublicPresentation =
  | { kind: 'answer'; text: string }
  | { kind: 'question'; text: string }
  | { kind: 'approval'; text: string; approvalId: string }
  | { kind: 'continue'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'stopped'; text: string };

interface TurnOutcomeBase {
  version: 2;
  /** Stable idempotency identity for this logical user turn. */
  id: string;
  identity: TurnIdentity;
  evidenceRefs?: TurnEvidenceRef[];
}

/**
 * The discriminated union makes invalid public states unrepresentable:
 * completion has an answer, pauses name the required edge, and non-success
 * terminals cannot masquerade as completed work.
 */
export type TurnOutcome = TurnOutcomeBase & (
  | {
      status: 'done';
      resumable: false;
      needs?: never;
      presentation: Extract<PublicPresentation, { kind: 'answer' }>;
    }
  | {
      status: 'needs_input';
      resumable: true;
      needs: Extract<TurnNeed, { kind: 'input' }>;
      presentation: Extract<PublicPresentation, { kind: 'question' }>;
    }
  | {
      status: 'needs_input';
      resumable: true;
      needs: Extract<TurnNeed, { kind: 'approval' }>;
      presentation: Extract<PublicPresentation, { kind: 'approval' }>;
    }
  | {
      status: 'needs_input';
      resumable: true;
      needs: Extract<TurnNeed, { kind: 'continue' }>;
      presentation: Extract<PublicPresentation, { kind: 'continue' }>;
    }
  | {
      status: 'blocked';
      resumable: boolean;
      needs?: never;
      presentation: Extract<PublicPresentation, { kind: 'blocked' }>;
    }
  | {
      status: 'failed';
      resumable: false;
      needs?: never;
      presentation: Extract<PublicPresentation, { kind: 'error' }>;
    }
  | {
      status: 'cancelled';
      resumable: false;
      needs?: never;
      presentation: Extract<PublicPresentation, { kind: 'stopped' }>;
    }
);

/** Public-only event embedded in the existing conversation_completed row. */
export interface PresentationEvent {
  version: 1;
  id: string;
  outcomeId: string;
  audience: 'user';
  phase: 'final';
  identity: TurnIdentity;
  status: TurnOutcomeStatus;
  kind: PublicPresentation['kind'];
  text: string;
  resumable: boolean;
  needs?: TurnNeed;
  approvalId?: string;
  evidenceRefs?: TurnEvidenceRef[];
}

export class InvalidTurnOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTurnOutcomeError';
  }
}

export class UnsafePresentationError extends Error {
  readonly reason: 'empty' | 'tool_protocol' | 'decision_envelope';

  constructor(reason: UnsafePresentationError['reason']) {
    const message = reason === 'empty'
      ? 'Public presentation text is empty.'
      : reason === 'tool_protocol'
        ? 'Public presentation contains internal tool protocol.'
        : 'Public presentation contains an internal decision envelope.';
    super(message);
    this.name = 'UnsafePresentationError';
    this.reason = reason;
  }
}

function cleanRequired(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new InvalidTurnOutcomeError(`${field} is required.`);
  return cleaned;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

/** Content hygiene is fail-closed at the one public write boundary. It is not
 * completion authority and never rewrites malformed output into a green result. */
export function assertPublicPresentationText(value: string): string {
  const text = value.trim();
  if (!text) throw new UnsafePresentationError('empty');
  if (looksLikeToolCallShape(text)) throw new UnsafePresentationError('tool_protocol');
  if (parseNarratedEnvelope(text) || looksLikeCompactDecisionProtocol(text)) {
    throw new UnsafePresentationError('decision_envelope');
  }
  return text;
}

function normalizeIdentity(identity: TurnIdentity): TurnIdentity {
  const sessionId = cleanRequired(identity.sessionId, 'identity.sessionId');
  if (!Number.isSafeInteger(identity.turn) || identity.turn < 0) {
    throw new InvalidTurnOutcomeError('identity.turn must be a non-negative integer.');
  }
  const runId = cleanOptional(identity.runId);
  const attemptId = cleanOptional(identity.attemptId);
  const sourceUserSeq = Number.isSafeInteger(identity.sourceUserSeq) && Number(identity.sourceUserSeq) > 0
    ? Number(identity.sourceUserSeq)
    : undefined;
  if (sourceUserSeq === undefined) {
    throw new InvalidTurnOutcomeError('identity.sourceUserSeq must name the accepted user event.');
  }
  return {
    sessionId,
    turn: identity.turn,
    sourceUserSeq,
    ...(attemptId ? { attemptId } : {}),
    ...(runId ? { runId } : {}),
  };
}

/** Public idempotency is the logical accepted turn, never a physical attempt. */
export function turnOutcomeId(identity: TurnIdentity): string {
  const normalized = normalizeIdentity(identity);
  return `turn:${normalized.sourceUserSeq}`;
}

function normalizeEvidenceRefs(refs: TurnEvidenceRef[] | undefined): TurnEvidenceRef[] | undefined {
  if (!refs?.length) return undefined;
  const kinds: ReadonlySet<string> = new Set(['tool_result', 'external_receipt', 'artifact', 'source', 'memory']);
  const normalized = refs.map((ref, index): TurnEvidenceRef => {
    if (!ref || typeof ref !== 'object' || !kinds.has(ref.kind)) {
      throw new InvalidTurnOutcomeError(`evidenceRefs[${index}].kind is invalid.`);
    }
    return {
      kind: ref.kind,
      id: cleanRequired(ref.id, `evidenceRefs[${index}].id`),
      ...(cleanOptional(ref.uri) ? { uri: cleanOptional(ref.uri) } : {}),
    };
  });
  return normalized.length > 0 ? normalized : undefined;
}

/** Pure public projection. Unknown properties on a runtime-cast Outcome are
 * intentionally ignored, so fields such as internalSummary cannot cross. */
export function presentationEventForOutcome(outcome: TurnOutcome): PresentationEvent {
  if (outcome.version !== 2) throw new InvalidTurnOutcomeError('TurnOutcome.version must be 2.');
  const identity = normalizeIdentity(outcome.identity);
  const outcomeId = cleanRequired(outcome.id, 'outcome.id');
  const canonicalOutcomeId = turnOutcomeId(identity);
  if (outcome.id !== canonicalOutcomeId) {
    throw new InvalidTurnOutcomeError(
      `outcome.id must equal the canonical turn identity (${canonicalOutcomeId}).`,
    );
  }
  const text = assertPublicPresentationText(outcome.presentation.text);
  const evidenceRefs = normalizeEvidenceRefs(outcome.evidenceRefs);
  const needs = outcome.status === 'needs_input' ? outcome.needs : undefined;

  const shapeIsValid = outcome.status === 'done'
    ? outcome.presentation.kind === 'answer' && outcome.resumable === false && needs === undefined
    : outcome.status === 'needs_input'
      ? outcome.resumable === true && (
        (needs?.kind === 'input' && outcome.presentation.kind === 'question')
        || (needs?.kind === 'approval' && outcome.presentation.kind === 'approval')
        || (needs?.kind === 'continue' && outcome.presentation.kind === 'continue')
      )
      : outcome.status === 'blocked'
        ? outcome.presentation.kind === 'blocked' && needs === undefined
        : outcome.status === 'failed'
          ? outcome.presentation.kind === 'error' && outcome.resumable === false && needs === undefined
          : outcome.presentation.kind === 'stopped' && outcome.resumable === false && needs === undefined;
  if (!shapeIsValid) {
    throw new InvalidTurnOutcomeError('TurnOutcome status, need, presentation, and resumable fields disagree.');
  }
  if (outcome.presentation.kind === 'approval') {
    cleanRequired(outcome.presentation.approvalId, 'presentation.approvalId');
  }

  return {
    version: 1,
    id: `${outcomeId}:presentation`,
    outcomeId,
    audience: 'user',
    phase: 'final',
    identity,
    status: outcome.status,
    kind: outcome.presentation.kind,
    text,
    resumable: outcome.resumable,
    ...(needs ? { needs } : {}),
    ...(outcome.presentation.kind === 'approval'
      ? { approvalId: cleanRequired(outcome.presentation.approvalId, 'presentation.approvalId') }
      : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isTurnOutcomeStatus(value: unknown): value is TurnOutcomeStatus {
  return value === 'done'
    || value === 'needs_input'
    || value === 'blocked'
    || value === 'failed'
    || value === 'cancelled';
}

const PRESENTATION_KINDS: ReadonlySet<string> = new Set([
  'answer', 'question', 'approval', 'continue', 'blocked', 'error', 'stopped',
]);

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function persistedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new InvalidTurnOutcomeError(`${field} must be a non-empty canonical string.`);
  }
  return value;
}

function persistedOptionalString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  if (!owns(record, key)) return undefined;
  return persistedString(record[key], field);
}

function persistedOptionalSeq(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  if (!owns(record, key)) return undefined;
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new InvalidTurnOutcomeError(`${field} must be a positive event sequence.`);
  }
  return Number(value);
}

function persistedNeed(value: unknown, field: string): TurnNeed | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || (value.kind !== 'input' && value.kind !== 'approval' && value.kind !== 'continue')) {
    throw new InvalidTurnOutcomeError(`${field} is invalid.`);
  }
  return { kind: value.kind };
}

function persistedEvidenceRefs(value: unknown, field: string): TurnEvidenceRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidTurnOutcomeError(`${field} must be an array.`);
  }
  const normalized = normalizeEvidenceRefs(value as TurnEvidenceRef[]);
  if (!normalized) throw new InvalidTurnOutcomeError(`${field} must not be empty.`);
  return normalized;
}

function sameNeed(left: TurnNeed | undefined, right: TurnNeed | undefined): boolean {
  return left?.kind === right?.kind;
}

function sameEvidenceRefs(
  left: TurnEvidenceRef[] | undefined,
  right: TurnEvidenceRef[] | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.turn === right.turn
    && left.attemptId === right.attemptId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.runId === right.runId;
}

function assertTopLevelIdentityMatches(
  data: Record<string, unknown>,
  identity: TurnIdentity,
): void {
  const topAttemptId = persistedOptionalString(data, 'attemptId', 'completion.attemptId');
  const topRunId = persistedOptionalString(data, 'runId', 'completion.runId');
  const topSourceUserSeq = persistedOptionalSeq(data, 'sourceUserSeq', 'completion.sourceUserSeq');
  const identityAttemptId = identity.attemptId;

  // The canonical discriminator must be repeated at the top level. Optional
  // run/source fields can be enriched atomically by eventlog when the nested
  // attempt identity omitted them, but any overlapping claim must agree.
  if (identityAttemptId) {
    if (topAttemptId !== identityAttemptId) {
      throw new InvalidTurnOutcomeError('Persisted presentation attemptId contradicts the terminal owner.');
    }
  } else if (topSourceUserSeq !== identity.sourceUserSeq) {
    throw new InvalidTurnOutcomeError('Persisted presentation sourceUserSeq contradicts the terminal owner.');
  }
  if (identity.runId !== undefined && topRunId !== identity.runId) {
    throw new InvalidTurnOutcomeError('Persisted presentation runId contradicts the terminal owner.');
  }
  if (identity.sourceUserSeq !== undefined && topSourceUserSeq !== identity.sourceUserSeq) {
    throw new InvalidTurnOutcomeError('Persisted presentation sourceUserSeq contradicts the terminal owner.');
  }
}

/**
 * Decode the new typed terminal projection and cross-check every duplicated
 * authority field. A row is legacy only when BOTH typed fields are absent; a
 * partially present or contradictory typed row is corruption and throws so a
 * committer can never reinterpret it using the losing proposal.
 */
export function presentationEventFromCompletionData(value: unknown): PresentationEvent | null {
  if (!isRecord(value)) return null;
  const hasPresentation = owns(value, 'presentation');
  const hasTurnOutcome = owns(value, 'turnOutcome');
  if (!hasPresentation && !hasTurnOutcome) return null;
  if (!hasPresentation || !hasTurnOutcome) {
    throw new InvalidTurnOutcomeError(
      'A typed completion must contain both presentation and turnOutcome projections.',
    );
  }

  const raw = value.presentation;
  const durable = value.turnOutcome;
  if (!isRecord(raw) || !isRecord(durable)) {
    throw new InvalidTurnOutcomeError('Typed completion projections must be objects.');
  }
  if (raw.version !== 1 || raw.audience !== 'user' || raw.phase !== 'final') {
    throw new InvalidTurnOutcomeError('Persisted presentation header is invalid.');
  }
  if (durable.version !== 2) {
    throw new InvalidTurnOutcomeError('Persisted turnOutcome.version must be 2.');
  }
  if (!isTurnOutcomeStatus(raw.status)
    || typeof raw.kind !== 'string'
    || !PRESENTATION_KINDS.has(raw.kind)
    || typeof raw.resumable !== 'boolean'
    || !isRecord(raw.identity)) {
    throw new InvalidTurnOutcomeError('Persisted presentation shape is invalid.');
  }
  if (!isTurnOutcomeStatus(durable.status) || typeof durable.resumable !== 'boolean') {
    throw new InvalidTurnOutcomeError('Persisted turnOutcome shape is invalid.');
  }

  const persistedIdentity = normalizeIdentity(raw.identity as unknown as TurnIdentity);
  const persistedOutcomeId = persistedString(raw.outcomeId, 'presentation.outcomeId');
  const persistedPresentationId = persistedString(raw.id, 'presentation.id');
  const persistedDurableOutcomeId = persistedString(durable.id, 'turnOutcome.id');
  const persistedTerminalKey = owns(value, 'terminalKey')
    ? persistedString(value.terminalKey, 'completion.terminalKey')
    : undefined;
  const canonicalIdentity: TurnIdentity = {
    sessionId: persistedIdentity.sessionId,
    turn: persistedIdentity.turn,
    sourceUserSeq: persistedIdentity.sourceUserSeq,
  };
  const identity = persistedIdentity;
  const canonicalOutcomeId = turnOutcomeId(identity);
  const legacyAttemptOutcomeId = identity.attemptId ? `brain:${identity.attemptId}` : undefined;
  // One-release upgrade compatibility: 3.5 typed rows used a physical
  // brain:<attempt> key. Accept only a fully self-consistent old row that also
  // carries the exact source event, then expose a canonical source-owned view.
  // New rows (logicalTerminalVersion=1) can never take this compatibility path.
  const legacyAttemptKeyed = value.logicalTerminalVersion !== 1
    && legacyAttemptOutcomeId !== undefined
    && persistedTerminalKey === legacyAttemptOutcomeId
    && persistedOutcomeId === legacyAttemptOutcomeId
    && persistedDurableOutcomeId === legacyAttemptOutcomeId
    && persistedPresentationId === `${legacyAttemptOutcomeId}:presentation`;
  if (!legacyAttemptKeyed) {
    if (persistedOutcomeId !== canonicalOutcomeId || persistedDurableOutcomeId !== canonicalOutcomeId) {
      throw new InvalidTurnOutcomeError('Persisted outcome id contradicts its canonical turn identity.');
    }
    if (persistedPresentationId !== `${canonicalOutcomeId}:presentation`) {
      throw new InvalidTurnOutcomeError('Persisted presentation id contradicts its outcome id.');
    }
    if (persistedTerminalKey !== undefined && persistedTerminalKey !== canonicalOutcomeId) {
      throw new InvalidTurnOutcomeError('Persisted terminal key contradicts its outcome id.');
    }
  }
  assertTopLevelIdentityMatches(value, identity);

  if (owns(durable, 'identity')) {
    if (!isRecord(durable.identity)) {
      throw new InvalidTurnOutcomeError('Persisted turnOutcome.identity is invalid.');
    }
    const durableIdentity = normalizeIdentity(durable.identity as unknown as TurnIdentity);
    if (!sameIdentity(identity, durableIdentity)) {
      throw new InvalidTurnOutcomeError('Persisted presentation and turnOutcome identities disagree.');
    }
  }

  const needs = persistedNeed(raw.needs, 'presentation.needs');
  const durableNeeds = persistedNeed(durable.needs, 'turnOutcome.needs');
  const evidenceRefs = persistedEvidenceRefs(raw.evidenceRefs, 'presentation.evidenceRefs');
  const durableEvidenceRefs = persistedEvidenceRefs(durable.evidenceRefs, 'turnOutcome.evidenceRefs');
  const approvalId = raw.approvalId === undefined
    ? undefined
    : persistedString(raw.approvalId, 'presentation.approvalId');
  if (typeof raw.text !== 'string') {
    throw new InvalidTurnOutcomeError('presentation.text must be a string.');
  }
  const text = assertPublicPresentationText(raw.text);

  const shapeIsValid = raw.status === 'done'
    ? raw.kind === 'answer' && raw.resumable === false && needs === undefined && approvalId === undefined
    : raw.status === 'needs_input'
      ? raw.resumable === true && (
        (needs?.kind === 'input' && raw.kind === 'question' && approvalId === undefined)
        || (needs?.kind === 'approval' && raw.kind === 'approval' && approvalId !== undefined)
        || (needs?.kind === 'continue' && raw.kind === 'continue' && approvalId === undefined)
      )
      : raw.status === 'blocked'
        ? raw.kind === 'blocked' && needs === undefined && approvalId === undefined
        : raw.status === 'failed'
          ? raw.kind === 'error' && raw.resumable === false && needs === undefined && approvalId === undefined
          : raw.kind === 'stopped' && raw.resumable === false && needs === undefined && approvalId === undefined;
  if (!shapeIsValid) {
    throw new InvalidTurnOutcomeError('Persisted presentation status and shape disagree.');
  }
  if (durable.status !== raw.status
    || durable.resumable !== raw.resumable
    || !sameNeed(needs, durableNeeds)
    || !sameEvidenceRefs(evidenceRefs, durableEvidenceRefs)) {
    throw new InvalidTurnOutcomeError('Persisted presentation and turnOutcome projections disagree.');
  }

  return {
    version: 1,
    id: `${canonicalOutcomeId}:presentation`,
    outcomeId: canonicalOutcomeId,
    audience: 'user',
    phase: 'final',
    identity: legacyAttemptKeyed ? canonicalIdentity : identity,
    status: raw.status,
    kind: raw.kind as PublicPresentation['kind'],
    text,
    resumable: raw.resumable,
    ...(needs ? { needs } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
  };
}
