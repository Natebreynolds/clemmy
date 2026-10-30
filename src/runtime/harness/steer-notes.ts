import { isExecutionSourceBoundary } from './accepted-source-kind.js';
import { workflowConversationSlugFromSessionId } from '../../shared/workflow-conversation.js';
/**
 * Mid-run steering (2026-08-07) — user messages reach a RUNNING turn without
 * stopping it.
 *
 * Before this lane existed, a chat message sent while a session had an active
 * attempt SUPERSEDED that attempt (claimRunAttemptLease retires the prior
 * row), so the only mid-run controls were "wait" or "kill". Users steering a
 * long run — adding context, correcting course — destroyed the very work they
 * were steering (the owner's ask, live 2026-08-07: "steer Clem or add context
 * while Clem is working without stopping the run").
 *
 * Mechanism: the chat route appends a durable `user_steer_note` event instead
 * of claiming a competing attempt; the shared tool-result boundary (brackets —
 * every wrapped tool on every lane) delivers undelivered notes verbatim to the
 * model alongside the next tool result, then marks them delivered with a
 * durable `user_steer_note_delivered` marker so a note is injected exactly
 * once. Steering is CONTEXT, not authority: the injected block says so, and
 * every effect gate (approvals, send lock, destructive gate) is untouched —
 * a note that asks for a new external effect meets the same gates the
 * original objective did.
 */
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { appendEvent, listActiveRunAttemptOwnership, listEvents, openEventLog, type EventRow } from './eventlog.js';
import { isDispatchLeaseCurrent, type DispatchLeaseRef } from './dispatch-lease.js';
import { acceptedTurnCallAuthorityFor } from './accepted-turn-call-authority.js';
import { readApprovalExecutionSource } from './approval-execution-source.js';
import { readConnectionExecutionDelivery } from './connection-execution-activation-proof.js';

export type SteerNoteAdmissionErrorCode = 'STEER_NOTE_CUTOVER' | 'STEER_NOTE_OWNER_CHANGED' | 'STEER_NOTE_UNAVAILABLE';

/** The plain line each refusal shows. App voice, no first person: the chat
 * routes return it as the error field beside the code, and the clients show
 * it under the message that was not queued. */
export const STEER_NOTE_ADMISSION_MESSAGE: Readonly<Record<SteerNoteAdmissionErrorCode, string>> = {
  STEER_NOTE_CUTOVER: 'This turn is finishing; the message was not queued.',
  STEER_NOTE_OWNER_CHANGED: 'The running turn changed; the message was not queued.',
  STEER_NOTE_UNAVAILABLE: 'The running turn could not be verified; the message was not queued.',
};

/** The refusals a chat route makes on its own for a message the client
 * promised must never become a competing turn (steerOnly), in the same shape
 * as an admission refusal: the plain line in `error`, the machine code beside
 * it. App voice, no first person, no code in the line. The clients branch on
 * the code and show the line. */
export const CHAT_STEER_REFUSAL = {
  /** The run the message meant to join has already ended. */
  run_ended: { code: 'RUN_NOT_ACTIVE', error: 'The run just finished; send this again as a new message.' },
  /** The route could not tell whether the run is still live. */
  run_unverified: { code: 'RUN_NOT_ACTIVE', error: 'The running turn could not be checked; send this again as a new message.' },
  /** A mode change cannot ride a message into a turn already underway. */
  task_mode_on_active_turn: {
    code: 'TASK_MODE_CANNOT_CHANGE_ACTIVE_TURN',
    error: 'Finish or stop the running turn before changing its mode.',
  },
} as const satisfies Record<string, { code: string; error: string }>;

/** A refused enqueue is never permission to start a competing turn. */
export class SteerNoteAdmissionError extends Error {
  readonly code: SteerNoteAdmissionErrorCode;
  constructor(code: SteerNoteAdmissionErrorCode) {
    const fixed: SteerNoteAdmissionErrorCode = typeof code === 'string' && Object.hasOwn(STEER_NOTE_ADMISSION_MESSAGE, code)
      ? code : 'STEER_NOTE_UNAVAILABLE';
    super(STEER_NOTE_ADMISSION_MESSAGE[fixed]);
    this.code = fixed;
    this.name = 'SteerNoteAdmissionError';
  }
}

/** A decision on an approval card (Approve or Reject, tapped or typed) is a
 * control on the work it resumes, never an assignment of its own: a message
 * the owner sends after it belongs to that resumed work, whose own handoff
 * picks it up. Counting the decision as a boundary left such a message owned
 * by a source no turn would ever run. */
function isApprovalDecisionControl(row: EventRow): boolean {
  const data = row.data as Record<string, unknown>;
  return row.type === 'user_input_received'
    && (data.source === 'mobile_approval' || data.source === 'desktop_approval')
    && typeof data.approvalId === 'string' && data.approvalId.trim().length > 0
    && typeof data.decision === 'string' && data.decision.trim().length > 0;
}

/** Where one assignment's steering ends: the next accepted source that is a
 * real assignment, not an approval decision on this one. */
function isSteeringBoundary(row: EventRow): boolean {
  return isExecutionSourceBoundary(row) && !isApprovalDecisionControl(row);
}

export function isSteerNoteAdmissionError(error: unknown): error is SteerNoteAdmissionError {
  try { return !types.isProxy(error) && error instanceof SteerNoteAdmissionError; }
  catch { return false; }
}

export interface TerminalSteeringOwner {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  lease: DispatchLeaseRef;
}

interface TerminalSteeringMarker {
  version: 1;
  state: 'closed' | 'open';
  nonce: string;
  sourceUserSeq: number;
  attemptId: string;
  runId: string | null;
  scopeId: string;
  leaseId: string;
  objectiveDigest: string;
  candidateDigest: string;
  previousNonce?: string;
}

const CUTOVER_METADATA_KEY = '__host_terminal_steering_cutover';
/** Where the marker's own event sits, so reads seek the primary key instead
 * of scanning every guardrail row of the session. Convenience only: a missing
 * or stale slot falls back to the scan, and the marker slot stays the authority. */
const CUTOVER_SEQ_METADATA_KEY = '__host_terminal_steering_cutover_seq';
const CUTOVER_EVENT_KIND = 'host_terminal_steering_cutover';

interface TerminalMarkerSeqSlot {
  nonce: string;
  seq: number;
  previousSeq?: number;
}

interface TerminalMarkerState {
  marker: TerminalSteeringMarker;
  seq: number;
  previousSeq?: number;
}
const safeId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 240 && /^[A-Za-z0-9:._/-]+$/.test(value);
const safeRunId = (value: unknown): value is string | null => value === null || safeId(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function inertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotTerminalOwner(value: TerminalSteeringOwner): TerminalSteeringOwner {
  const owner = inertRecord(value);
  const lease = inertRecord(owner.lease);
  if (Object.keys(owner).some(key => !['sessionId', 'sourceUserSeq', 'attemptId', 'lease'].includes(key))
    || Object.keys(lease).some(key => !['sessionId', 'scopeId', 'leaseId', 'runAttemptId', 'parentScopeId', 'parentLeaseId'].includes(key))
    || !safeId(owner.sessionId) || !safeId(owner.attemptId) || !Number.isSafeInteger(owner.sourceUserSeq)
    || Number(owner.sourceUserSeq) <= 0 || lease.sessionId !== owner.sessionId || lease.runAttemptId !== owner.attemptId
    || !safeId(lease.scopeId) || !safeId(lease.leaseId)
    || (lease.parentScopeId !== undefined && !safeId(lease.parentScopeId))
    || (lease.parentLeaseId !== undefined && !safeId(lease.parentLeaseId))) {
    throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
  }
  return { sessionId: owner.sessionId, sourceUserSeq: Number(owner.sourceUserSeq), attemptId: owner.attemptId,
    lease: lease as unknown as DispatchLeaseRef };
}

function currentTerminalOwner(owner: TerminalSteeringOwner): { runId: string | null } {
  const db = openEventLog();
  const row = db.prepare(`SELECT run_id, source_user_seq FROM run_attempts
    WHERE session_id = ? AND attempt_id = ? AND finished_at IS NULL AND status = 'active'`)
    .get(owner.sessionId, owner.attemptId) as { run_id: string | null; source_user_seq: number | null } | undefined;
  const physical = db.prepare(`SELECT run_attempt_id, source_user_seq, accepted_task_id, logical_tool_call_id FROM run_dispatch_leases
    WHERE session_id = ? AND scope_id = ? AND lease_id = ?`).get(owner.sessionId, owner.lease.scopeId, owner.lease.leaseId) as {
      run_attempt_id: string | null; source_user_seq: number | null; accepted_task_id: string | null; logical_tool_call_id: string | null;
    } | undefined;
  if (!row || !safeRunId(row.run_id) || !physical || physical.run_attempt_id !== owner.attemptId
    || physical.source_user_seq !== null || physical.accepted_task_id !== null || physical.logical_tool_call_id !== null
    || !isDispatchLeaseCurrent(owner.lease)) throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
  // Approval/connection delivery owns a later input; execution still belongs
  // to its proven parent. No latest-input or equal-attempt-source shortcut.
  const executionSource = row.source_user_seq === owner.sourceUserSeq ? row.source_user_seq
    : row.source_user_seq === null ? null
      : readApprovalExecutionSource(db, { sessionId: owner.sessionId, sourceUserSeq: row.source_user_seq })
        ?? readConnectionExecutionDelivery(db, { sessionId: owner.sessionId, deliverySourceUserSeq: row.source_user_seq }, true)
          ?.activation.executionSourceUserSeq;
  const authority = acceptedTurnCallAuthorityFor(owner.sessionId, owner.sourceUserSeq);
  // A source handed to a durable workflow keeps its attempt beside the next
  // foreground request. Only another foreground attempt is a rival owner.
  const rival = listActiveRunAttemptOwnership(owner.sessionId)
    .some(active => active.attemptId !== owner.attemptId && !active.workflowHandoff);
  if (rival || executionSource !== owner.sourceUserSeq || authority.status !== 'ok' || authority.authority.state !== 'open') {
    throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
  }
  return { runId: row.run_id };
}

function parsedTerminalMarker(raw: unknown): TerminalSteeringMarker {
  const marker = inertRecord(raw);
  const keys = ['version', 'state', 'nonce', 'sourceUserSeq', 'attemptId', 'runId', 'scopeId', 'leaseId', 'objectiveDigest', 'candidateDigest', 'previousNonce'];
  if (Object.keys(marker).some(key => !keys.includes(key)) || marker.version !== 1
    || !['closed', 'open'].includes(typeof marker.state === 'string' ? marker.state : '')
    || !safeId(marker.nonce) || !safeId(marker.attemptId) || !safeRunId(marker.runId)
    || !safeId(marker.scopeId) || !safeId(marker.leaseId) || !Number.isSafeInteger(marker.sourceUserSeq)
    || Number(marker.sourceUserSeq) <= 0 || !digest(marker.objectiveDigest) || !digest(marker.candidateDigest)
    || (marker.state === 'open' ? !safeId(marker.previousNonce) : marker.previousNonce !== undefined)) {
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
  return marker as unknown as TerminalSteeringMarker;
}

function parsedSeqSlot(raw: unknown): TerminalMarkerSeqSlot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const slot = raw as Record<string, unknown>;
  if (!safeId(slot.nonce) || !Number.isSafeInteger(slot.seq) || Number(slot.seq) <= 0) return undefined;
  if (slot.previousSeq !== undefined && (!Number.isSafeInteger(slot.previousSeq) || Number(slot.previousSeq) <= 0)) return undefined;
  return { nonce: slot.nonce, seq: Number(slot.seq),
    ...(slot.previousSeq !== undefined ? { previousSeq: Number(slot.previousSeq) } : {}) };
}

function terminalMarkerEvent(sessionId: string, nonce: string, seqHint?: number): { seq: number; marker: TerminalSteeringMarker } {
  const db = openEventLog();
  if (seqHint !== undefined) {
    const row = db.prepare(`SELECT seq, data_json FROM events WHERE seq = ? AND session_id = ? AND type = 'guardrail_tripped' AND role = 'system'
      AND json_valid(data_json) AND json_extract(data_json, '$.kind') = ? AND json_extract(data_json, '$.marker.nonce') = ?`)
      .get(seqHint, sessionId, CUTOVER_EVENT_KIND, nonce) as { seq: number; data_json: string } | undefined;
    if (row) return { seq: row.seq, marker: parsedTerminalMarker(JSON.parse(row.data_json).marker) };
  }
  const events = db.prepare(`SELECT seq, data_json FROM events WHERE session_id = ? AND type = 'guardrail_tripped' AND role = 'system'
    AND json_valid(data_json) AND json_extract(data_json, '$.kind') = ?
    AND json_extract(data_json, '$.marker.nonce') = ? LIMIT 2`)
    .all(sessionId, CUTOVER_EVENT_KIND, nonce) as Array<{ seq: number; data_json: string }>;
  if (events.length !== 1) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  return { seq: events[0]!.seq, marker: parsedTerminalMarker(JSON.parse(events[0]!.data_json).marker) };
}

function readTerminalMarkerState(sessionId: string): TerminalMarkerState | undefined {
  const db = openEventLog();
  // Only the two slots are read; the rest of the metadata (the conversation
  // snapshot among it) never leaves SQLite.
  const row = db.prepare(`SELECT json_type(metadata_json) AS shape,
      json_type(metadata_json, ?) AS marker_type, json_extract(metadata_json, ?) AS marker,
      json_type(metadata_json, ?) AS slot_type, json_extract(metadata_json, ?) AS slot
    FROM sessions WHERE id = ?`)
    .get(`$.${CUTOVER_METADATA_KEY}`, `$.${CUTOVER_METADATA_KEY}`, `$.${CUTOVER_SEQ_METADATA_KEY}`, `$.${CUTOVER_SEQ_METADATA_KEY}`, sessionId) as {
      shape: string | null; marker_type: string | null; marker: unknown; slot_type: string | null; slot: unknown;
    } | undefined;
  if (!row) throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
  if (row.shape !== null && row.shape !== 'object') throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  const raw: unknown = row.marker_type === null ? undefined
    : row.marker_type === 'object' && typeof row.marker === 'string' ? JSON.parse(row.marker) : row.marker;
  let marker: TerminalSteeringMarker;
  let recorded: { seq: number; marker: TerminalSteeringMarker };
  if (raw === undefined) {
    // Losing a convenience metadata slot cannot erase a durable refusal.
    // Reconstruct only the negative closed boundary, never an open capability.
    const latest = db.prepare(`SELECT seq, data_json FROM events WHERE session_id = ? AND type = 'guardrail_tripped' AND role = 'system'
      AND json_valid(data_json) AND json_extract(data_json, '$.kind') = ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId, CUTOVER_EVENT_KIND) as { seq: number; data_json: string } | undefined;
    if (!latest) return undefined;
    const retained = parsedTerminalMarker(JSON.parse(latest.data_json).marker);
    marker = retained.state === 'closed' ? retained : terminalMarkerEvent(sessionId, retained.previousNonce!).marker;
    if (marker.state !== 'closed') throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    recorded = terminalMarkerEvent(sessionId, marker.nonce);
    if (JSON.stringify(recorded.marker) !== JSON.stringify(marker)) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    return { marker, seq: recorded.seq };
  }
  marker = parsedTerminalMarker(raw);
  const slot = row.slot_type === 'object' && typeof row.slot === 'string' ? parsedSeqSlot(JSON.parse(row.slot)) : undefined;
  const hint = slot?.nonce === marker.nonce ? slot : undefined;
  recorded = terminalMarkerEvent(sessionId, marker.nonce, hint?.seq);
  if (JSON.stringify(recorded.marker) !== JSON.stringify(marker)) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  // The slot must still name the latest cutover event. An index range from
  // the recorded row forward is enough; the earlier rows are not revisited.
  const later = db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'guardrail_tripped' AND seq > ? AND role = 'system'
    AND json_valid(data_json) AND json_extract(data_json, '$.kind') = ? LIMIT 1`)
    .get(sessionId, recorded.seq, CUTOVER_EVENT_KIND);
  if (later) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  if (marker.state !== 'open') return { marker, seq: recorded.seq };
  // A serialized open bit cannot erase an earlier fence. It must retain
  // the exact closed predecessor and its revoked physical generation.
  const previous = terminalMarkerEvent(sessionId, marker.previousNonce!, hint?.previousSeq);
  if (previous.marker.state !== 'closed' || previous.seq >= recorded.seq
    || ['sourceUserSeq', 'attemptId', 'runId', 'objectiveDigest', 'candidateDigest']
      .some(key => previous.marker[key as keyof TerminalSteeringMarker] !== marker[key as keyof TerminalSteeringMarker])
    || (previous.marker.scopeId === marker.scopeId && previous.marker.leaseId === marker.leaseId)) {
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
  const oldLease = db.prepare(`SELECT revoked_at FROM run_dispatch_leases
    WHERE session_id = ? AND scope_id = ? AND lease_id = ? AND run_attempt_id = ?`)
    .get(sessionId, previous.marker.scopeId, previous.marker.leaseId, marker.attemptId) as { revoked_at: string | null } | undefined;
  if (!oldLease?.revoked_at) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  return { marker, seq: recorded.seq, previousSeq: previous.seq };
}

function readTerminalMarker(sessionId: string): TerminalSteeringMarker | undefined {
  return readTerminalMarkerState(sessionId)?.marker;
}

function writeTerminalMarker(sessionId: string, marker: TerminalSteeringMarker, previousSeq?: number): void {
  const db = openEventLog();
  // Publish the negative slot before appendEvent's synchronous observers run.
  // Both writes commit together; re-entrant enqueues cannot slip between them.
  // The sequence slot is cleared here and filled once the event has its
  // sequence, so an observer inside the append reads this marker by scan.
  const changed = db.prepare(`UPDATE sessions SET metadata_json = json_remove(json_set(COALESCE(metadata_json, '{}'), ?, json(?)), ?)
    WHERE id = ? AND (metadata_json IS NULL OR json_valid(metadata_json))`)
    .run(`$.${CUTOVER_METADATA_KEY}`, JSON.stringify(marker), `$.${CUTOVER_SEQ_METADATA_KEY}`, sessionId);
  if (changed.changes !== 1) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  const row = appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: CUTOVER_EVENT_KIND, marker } });
  const slot: TerminalMarkerSeqSlot = { nonce: marker.nonce, seq: row.seq, ...(previousSeq !== undefined ? { previousSeq } : {}) };
  db.prepare(`UPDATE sessions SET metadata_json = json_set(metadata_json, ?, json(?)) WHERE id = ? AND json_valid(metadata_json)`)
    .run(`$.${CUTOVER_SEQ_METADATA_KEY}`, JSON.stringify(slot), sessionId);
}

function hasPublishedTerminal(sessionId: string, attemptId: string, sourceUserSeq: number): boolean {
  return Boolean(openEventLog().prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'conversation_completed'
    AND json_valid(data_json) AND (json_extract(data_json, '$.attemptId') = ?
      OR json_extract(data_json, '$.sourceUserSeq') = ?) LIMIT 1`).get(sessionId, attemptId, sourceUserSeq));
}

/** Negative-only handoff fence: either adopt pending input or close enqueue.
 * It finishes no attempt and grants no model, tool, approval or effect work. */
export function closeTerminalSteering(input: TerminalSteeringOwner, objectiveDigest: string, candidateDigest: string):
  { status: 'closed' } | { status: 'pending'; notes: SteerNote[] } {
  try {
    const owner = snapshotTerminalOwner(input);
    if (!digest(objectiveDigest) || !digest(candidateDigest)) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    return openEventLog().transaction(() => {
      const active = currentTerminalOwner(owner);
      const prior = readTerminalMarker(owner.sessionId);
      if (prior?.attemptId === owner.attemptId && prior.runId !== active.runId) {
        throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
      }
      if (hasUndeliveredSteerNotes(owner.sessionId, owner.sourceUserSeq)) {
        if (prior?.attemptId === owner.attemptId && prior.runId === active.runId && prior.state === 'closed') {
          throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
        }
        const notes = takeUndeliveredSteerNotes(owner.sessionId, owner.sourceUserSeq, true);
        if (!notes.length) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
        return { status: 'pending' as const, notes };
      }
      if (prior?.attemptId === owner.attemptId && prior.runId === active.runId && prior.state === 'closed') {
        if (prior.sourceUserSeq === owner.sourceUserSeq && prior.scopeId === owner.lease.scopeId && prior.leaseId === owner.lease.leaseId
          && prior.objectiveDigest === objectiveDigest && prior.candidateDigest === candidateDigest) return { status: 'closed' as const };
        throw new SteerNoteAdmissionError('STEER_NOTE_CUTOVER');
      }
      writeTerminalMarker(owner.sessionId, { version: 1, state: 'closed', nonce: randomUUID(), sourceUserSeq: owner.sourceUserSeq,
        attemptId: owner.attemptId, runId: active.runId, scopeId: owner.lease.scopeId, leaseId: owner.lease.leaseId,
        objectiveDigest, candidateDigest });
      return { status: 'closed' as const };
    }).immediate();
  } catch (error) {
    if (isSteerNoteAdmissionError(error)) throw error;
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
}

/** Failed publication may reopen only the same still-active execution under a
 * newly authorized physical generation. A stored marker never grants work. */
export function reopenTerminalSteering(input: TerminalSteeringOwner): void {
  try {
    const owner = snapshotTerminalOwner(input);
    openEventLog().transaction(() => {
      const priorState = readTerminalMarkerState(owner.sessionId);
      const prior = priorState?.marker;
      if (!priorState || !prior || prior.attemptId !== owner.attemptId) return;
      const active = currentTerminalOwner(owner);
      if (prior.sourceUserSeq !== owner.sourceUserSeq || prior.runId !== active.runId) throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
      if (hasPublishedTerminal(owner.sessionId, owner.attemptId, owner.sourceUserSeq)) throw new SteerNoteAdmissionError('STEER_NOTE_CUTOVER');
      if (prior.state === 'open' && prior.scopeId === owner.lease.scopeId && prior.leaseId === owner.lease.leaseId) return;
      const previous = openEventLog().prepare(`SELECT revoked_at FROM run_dispatch_leases
        WHERE session_id = ? AND scope_id = ? AND lease_id = ? AND run_attempt_id = ?`)
        .get(owner.sessionId, prior.scopeId, prior.leaseId, owner.attemptId) as { revoked_at: string | null } | undefined;
      if (!previous?.revoked_at || (prior.scopeId === owner.lease.scopeId && prior.leaseId === owner.lease.leaseId)) {
        throw new SteerNoteAdmissionError('STEER_NOTE_CUTOVER');
      }
      writeTerminalMarker(owner.sessionId, { ...prior, state: 'open', nonce: randomUUID(), previousNonce: prior.state === 'closed' ? prior.nonce : prior.previousNonce,
        scopeId: owner.lease.scopeId, leaseId: owner.lease.leaseId },
      prior.state === 'closed' ? priorState.seq : priorState.previousSeq);
    }).immediate();
  } catch (error) {
    if (isSteerNoteAdmissionError(error)) throw error;
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
}

export interface SteerNote {
  seq: number;
  text: string;
  createdAt?: string;
}

/** Sessions whose runs a user can steer from a chat surface. Background/cron
 *  agent sessions have no live human typing into them. */
export function sessionSupportsSteering(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && (/^(?:sess-|space-|discord-)/.test(sessionId)
    || workflowConversationSlugFromSessionId(sessionId) !== null);
}

export function appendSteerNote(
  sessionId: string,
  text: string,
  options: { clientRequestId?: string | undefined; clientEchoId?: string; voice?: boolean; expectedAttemptId?: string } = {},
): { seq: number } {
  try {
    // A retried SAME request remains its original instruction, even after the
    // handoff. A new request must atomically compare the current owner/fence.
    const requestId = options.clientRequestId?.trim();
    // Presentation correlation only. Admission and idempotency continue to
    // use the canonical requestId (device-scoped on mobile), never this echo.
    const clientEchoId = typeof options.clientEchoId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(options.clientEchoId) ? options.clientEchoId : undefined;
    return openEventLog().transaction(() => {
      if (requestId) {
        const existing = listEvents(sessionId, { types: ['user_steer_note'] })
          .find(row => row.data.clientRequestId === requestId);
        if (existing) return { seq: existing.seq };
      }
      const marker = readTerminalMarker(sessionId);
      const expectedAttemptId = options.expectedAttemptId;
      if (marker || expectedAttemptId !== undefined) {
        // The note goes to the one attempt that owns the foreground. An
        // attempt a durable workflow handoff keeps alive beside it is not a
        // rival; a second foreground attempt is, and refuses the note.
        const active = listActiveRunAttemptOwnership(sessionId);
        const foreground = active.filter(row => !row.workflowHandoff);
        const ownerAttempt = expectedAttemptId !== undefined ? active.find(row => row.attemptId === expectedAttemptId)
          : foreground.length === 1 ? foreground[0] : active.length === 1 ? active[0] : undefined;
        if (!ownerAttempt || active.some(row => row.attemptId !== ownerAttempt.attemptId && !row.workflowHandoff)) {
          throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
        }
        if (marker?.attemptId === ownerAttempt.attemptId && marker.runId !== ownerAttempt.runId) {
          throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
        }
        if (marker?.attemptId === ownerAttempt.attemptId && marker.runId === ownerAttempt.runId && marker.state === 'closed') {
          throw new SteerNoteAdmissionError('STEER_NOTE_CUTOVER');
        }
        if (marker?.attemptId === ownerAttempt.attemptId && marker.runId === ownerAttempt.runId && marker.state === 'open') {
          const current = currentTerminalOwner({ sessionId, sourceUserSeq: marker.sourceUserSeq, attemptId: marker.attemptId,
            lease: { sessionId, scopeId: marker.scopeId, leaseId: marker.leaseId, runAttemptId: marker.attemptId } });
          if (current.runId !== marker.runId || hasPublishedTerminal(sessionId, marker.attemptId, marker.sourceUserSeq)) {
            throw new SteerNoteAdmissionError('STEER_NOTE_OWNER_CHANGED');
          }
        }
      }
      const row = appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_steer_note',
        data: { text, ...(requestId ? { clientRequestId: requestId } : {}),
          ...(clientEchoId ? { clientEchoId } : {}), ...(options.voice === true ? { voice: true } : {}) } });
      return { seq: row.seq };
    }).immediate();
  } catch (error) {
    if (isSteerNoteAdmissionError(error)) throw error;
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
}

/**
 * The owner's later instructions that this accepted source has ADOPTED.
 *
 * A note belongs to exactly one source: the one that was accepted before it and
 * is not yet superseded by a newer accepted source. Only DELIVERED notes count —
 * an undelivered note has not reached the model, so it cannot have changed what
 * the run is doing, and judging against it would fail work for ignoring an
 * instruction it never saw.
 */
export function adoptedSteerNotesForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): SteerNote[] {
  try {
    const rows = listEvents(input.sessionId, {
      types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'],
    });
    const nextSource = rows.find(
      (row) => isSteeringBoundary(row) && row.seq > input.sourceUserSeq,
    )?.seq ?? Number.MAX_SAFE_INTEGER;
    const delivered = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'user_steer_note_delivered') continue;
      const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
      if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
    }
    return rows
      .filter((row) => (
        row.type === 'user_steer_note'
        && row.seq > input.sourceUserSeq
        && row.seq < nextSource
        && delivered.has(row.seq)
      ))
      .map((row) => ({
        seq: row.seq,
        text: String((row.data as { text?: unknown }).text ?? ''),
        createdAt: row.createdAt,
      }))
      .filter((note) => note.text.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Fold adopted steering into the objective a judge evaluates.
 *
 * THE DECISIVE C31 DEFECT: the owner said "Never mind that. In one short
 * sentence: what is 9 plus 4?", Clem understood it and answered correctly — and
 * the completion judge, which only ever saw the ORIGINAL request text, ruled her
 * incomplete and pushed her back into creating the abandoned workflow.
 *
 * The original is preserved verbatim, because the historical objective and its
 * prior terminals stay immutable. What changes is that the judge is told the
 * rest of the job: the owner's later words, in the owner's own language, marked
 * as governing where they conflict. No keyword grammar decides whether a note
 * amends or replaces — the judge reads both and interprets, exactly as the
 * model does at the tool boundary.
 */
export function objectiveWithAdoptedSteering(
  originalObjective: string,
  notes: readonly SteerNote[],
): string {
  if (notes.length === 0) return originalObjective;
  return [
    originalObjective,
    '',
    'While this work was running the owner sent further instructions. They are '
      + 'part of the same job and GOVERN WHERE THEY CONFLICT with the request '
      + 'above — including telling this work to stop or change direction. Judge '
      + 'the result against what the owner now wants, not only the original '
      + 'wording:',
    ...notes.map((note) => `- "${note.text}"`),
  ].join('\n');
}

function requireSourceSteerText(data: unknown): string {
  if (!data || typeof data !== 'object' || types.isProxy(data) || Array.isArray(data)) {
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
  const text = Object.getOwnPropertyDescriptor(data, 'text');
  if (!text || !('value' in text) || typeof text.value !== 'string') {
    throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
  }
  return text.value;
}

/**
 * Read the notes not yet delivered to the model and durably mark them
 * delivered. Host turns project the complete adopted same-source notes after
 * result budgeting on every model request, including reopen. Consequently a
 * crash after this marker cannot permanently hide an accepted instruction.
 * Legacy tool boundaries retain their existing delivery marker contract.
 * The source-owned host opts into strict text validation before fresh work;
 * that negative-only mode does not change legacy post-settlement projections.
 */
export function takeUndeliveredSteerNotes(sessionId: string | undefined, sourceUserSeq?: number, strictSourceText = false): SteerNote[] {
  const strict = strictSourceText === true;
  if (!sessionSupportsSteering(sessionId)) {
    if (strict) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    return [];
  }
  if ((sourceUserSeq !== undefined && (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0))
    || (strict && sourceUserSeq === undefined)) {
    if (strict) throw new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    return [];
  }
  try {
    const rows = listEvents(sessionId as string, {
      types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'],
    });
    const nextSourceSeq = sourceUserSeq === undefined ? Number.MAX_SAFE_INTEGER
      : rows.find((row) => isSteeringBoundary(row)
        && row.seq > sourceUserSeq)?.seq ?? Number.MAX_SAFE_INTEGER;
    const delivered = new Set<number>();
    for (const row of rows) {
      if (row.type !== 'user_steer_note_delivered') continue;
      const seqs = (row.data as { noteSeqs?: unknown }).noteSeqs;
      if (Array.isArray(seqs)) for (const seq of seqs) if (typeof seq === 'number') delivered.add(seq);
    }
    const pending = rows
      .filter((row) => row.type === 'user_steer_note' && !delivered.has(row.seq)
        && (sourceUserSeq === undefined || (row.seq > sourceUserSeq && row.seq < nextSourceSeq)))
      .map((row) => {
        if (!strict) return { seq: row.seq, text: String((row.data as { text?: unknown }).text ?? ''), createdAt: row.createdAt };
        return { seq: row.seq, text: requireSourceSteerText(row.data), createdAt: row.createdAt };
      })
      .filter((note) => note.text.trim().length > 0);
    if (pending.length === 0) return [];
    appendEvent({
      sessionId: sessionId as string,
      turn: 0,
      role: 'system',
      type: 'user_steer_note_delivered',
      data: { noteSeqs: pending.map((note) => note.seq), ...(sourceUserSeq === undefined ? {} : { sourceUserSeq }) },
    });
    return pending;
  } catch (error) {
    if (strict) throw isSteerNoteAdmissionError(error) ? error : new SteerNoteAdmissionError('STEER_NOTE_UNAVAILABLE');
    return []; // steering must never break a tool result
  }
}

/** A pre-dispatch check must not mark a note delivered before the next model
 * request can carry it. Newer accepted sources and approval acknowledgements
 * have the same boundaries as the actual delivery path. */
export function hasUndeliveredSteerNotes(sessionId: string, sourceUserSeq: number): boolean {
  if (!sessionSupportsSteering(sessionId)) return false;
  const rows = listEvents(sessionId, { sinceSeq: sourceUserSeq,
    types: ['user_steer_note', 'user_steer_note_delivered', 'user_input_received'] });
  const next = rows.find(isSteeringBoundary)?.seq
    ?? Number.MAX_SAFE_INTEGER;
  const delivered = new Set(rows.flatMap(row => row.type === 'user_steer_note_delivered'
    && Array.isArray(row.data.noteSeqs) ? row.data.noteSeqs : []));
  return rows.some(row => {
    if (row.type !== 'user_steer_note' || row.seq >= next || delivered.has(row.seq)) return false;
    const text = requireSourceSteerText(row.data);
    return text.trim().length > 0;
  });
}

/** The model-facing block appended to the next tool result. Verbatim user
 *  words first; the frame is a DIRECTIVE (allowed), not voice-cosplay. */
export function formatSteerBlock(notes: SteerNote[]): string {
  if (notes.length === 0) return '';
  const quoted = notes
    .map((note) => `- "${note.text}"`)
    .join('\n');
  return [
    '',
    '',
    '[MID-RUN MESSAGE FROM THE USER — arrived while you were working]',
    quoted,
    'Incorporate this NOW: adjust course and use the added context for the rest of the run, and briefly acknowledge it in your next visible update. It refines the current objective — it does not replace it unless it clearly says so. If it asks to stop, stop cleanly and report state. Any NEW external effect it introduces still takes the normal approval path.',
  ].join('\n');
}

/** One-call composition for the tool-result boundary. Returns '' when there is
 *  nothing to deliver (the overwhelmingly common case — one indexed read). */
export function steerBlockForToolBoundary(sessionId: string | undefined): string {
  return formatSteerBlock(takeUndeliveredSteerNotes(sessionId));
}

/**
 * How long a run-in-flight marker still counts as live work for the steering
 * decision. Boot recovery routinely resumes minutes-old interrupted turns (a
 * live decision recorded ageMs 165145 and resumed successfully), so the window
 * must comfortably cover a restart; past it an orphaned marker must not keep
 * swallowing messages into notes nobody will read.
 */
export const RECOVERING_STEER_WINDOW_MS = 10 * 60 * 1000;

export type SteerReason = 'lease_live' | 'recovering_in_flight';

/**
 * Does this message reach work that is still running, or start its own turn?
 *
 * RECOVERING WORK IS STILL RUNNING WORK. A lease belongs to the process that
 * took it, so after a crash the interrupted attempt keeps an expired lease
 * while boot recovery resumes the very same work. Judging on the lease alone
 * called that turn dead: the follow-up fell through to ordinary acceptance,
 * the unsettled head made the session non-reusable, and it branched into a NEW
 * conversation while the original task went on to write.
 *
 * Live 2026-09-07: "Never mind that. In one short sentence: what is 9 plus 4?"
 * was accepted at 00:30:17 into sess-branch-0b3390df…; source 139708 issued its
 * workflow_create at 00:30:33. The steering never reached the work it was
 * aimed at.
 *
 * The run-in-flight marker is the daemon's own claim that this session has live
 * work, and it survives the crash the lease does not.
 */
export function steerReasonForRunningWork(input: {
  runInFlightSince: string | null;
  leaseExpiresAt: string | null;
  attemptFinishedAt: string | null;
  /** An attempt exists for this session and has NOT finished. */
  hasUnfinishedAttempt: boolean;
  nowMs: number;
}): SteerReason | null {
  if (
    !input.attemptFinishedAt
    && input.leaseExpiresAt
    && Date.parse(input.leaseExpiresAt) > input.nowMs
  ) return 'lease_live';

  // The marker alone is NOT enough. Measured 2026-09-07 01:21: a resume
  // attempt finished at 01:21:09 while the run-in-flight marker was still
  // armed; a follow-up sent in that gap steered into a note no running turn
  // would ever read, and the user got no answer at all. An unfinished attempt
  // is the positive evidence that something is actually there to receive it.
  if (!input.hasUnfinishedAttempt) return null;
  if (!input.runInFlightSince) return null;
  const age = input.nowMs - Date.parse(input.runInFlightSince);
  return Number.isFinite(age) && age >= 0 && age < RECOVERING_STEER_WINDOW_MS
    ? 'recovering_in_flight'
    : null;
}
