import { createHash } from 'node:crypto';
import type { AttemptOutcome } from './attempt-outcome.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import {
  canonicalExternalWriteActionKey,
  externalWriteDuplicateIdentityKeys,
  externalWriteSemanticFingerprint,
} from './external-write-admission.js';
import { appendEvent, listEvents, type EventRow } from './eventlog.js';
import {
  extractDuplicateIdentityKeys,
  extractExternalWriteIdentityKeys,
} from './grounding-gate.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';

export type ExternalWriteTerminalEventType =
  | 'external_write_succeeded'
  | 'external_write_failed'
  | 'external_write_orphaned';

export interface ExternalWriteEventDescriptor {
  toolName: string;
  args: unknown;
  shapeKey: string;
  actionKey: string;
  correlationFingerprint: string;
  semanticFingerprint: string;
  irreversible: boolean;
  targets: string[];
  duplicateIdentityKeys: string[];
}

export interface ExternalWriteReservationRef {
  eventId: string;
  actionKey: string;
  toolName: string;
  callId: string;
}

export interface DurableExternalWriteProjectionIdentity {
  reservation: ExternalWriteReservationRef;
  descriptor: ExternalWriteEventDescriptor;
}

export class ExternalWriteProjectionConflictError extends Error {
  override readonly name = 'ExternalWriteProjectionConflictError';
}

/**
 * Build the provider-neutral identity shared by every external-write event
 * producer. A host-owned provider call may force the mutation fact because its
 * effect came from an immutable catalog manifest; the legacy wrapper continues
 * to rely on the ordinary classifier.
 */
export function describeExternalWriteEvent(input: {
  toolName: string;
  args: unknown;
  forceMutating?: boolean;
  shapeKey?: string;
  irreversible?: boolean;
  targets?: readonly string[];
  duplicateIdentityKeys?: readonly string[];
}): ExternalWriteEventDescriptor | null {
  const toolName = input.toolName.trim();
  if (!toolName) return null;
  const shape = classifyExternalWrite(toolName, input.args);
  if (!shape.mutating && input.forceMutating !== true) return null;
  const shapeKey = input.shapeKey?.trim() || shape.shapeKey?.trim() || toolName;
  const actionKey = canonicalExternalWriteActionKey(toolName, shapeKey);
  const semanticFingerprint = externalWriteSemanticFingerprint(actionKey, input.args);
  return {
    toolName,
    args: input.args,
    shapeKey,
    actionKey,
    correlationFingerprint: toolCallCorrelationFingerprint(toolName, input.args),
    semanticFingerprint,
    irreversible: input.irreversible ?? shape.irreversible,
    targets: [...new Set(input.targets ?? extractExternalWriteIdentityKeys(input.args))],
    duplicateIdentityKeys: externalWriteDuplicateIdentityKeys(
      input.duplicateIdentityKeys ?? extractDuplicateIdentityKeys(input.args),
      semanticFingerprint,
    ),
  };
}

function eventCallId(event: EventRow): string {
  const value = event.data.canonicalCallId ?? event.data.callId;
  return typeof value === 'string' ? value.trim() : '';
}

function eventDataString(event: EventRow, key: string): string {
  const value = event.data[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Re-open the exact identity already persisted on a reservation. This is used
 * by read-back/recovery code which owns the reservation event rather than the
 * original arguments. Historical rows can lack newer optional fingerprints;
 * absence stays absence and is never recomputed from guessed arguments.
 */
export function externalWriteProjectionIdentityFromReservation(
  event: EventRow,
): DurableExternalWriteProjectionIdentity | null {
  if (event.type !== 'external_write') return null;
  const callId = eventCallId(event);
  const actionKey = eventDataString(event, 'actionKey');
  if (!callId || !actionKey) return null;
  const toolName = eventDataString(event, 'toolName');
  const shapeKey = eventDataString(event, 'shapeKey') || actionKey;
  const semanticFingerprint = eventDataString(event, 'semanticFingerprint');
  return {
    reservation: {
      eventId: event.id,
      actionKey,
      toolName,
      callId,
    },
    descriptor: {
      toolName,
      args: undefined,
      shapeKey,
      actionKey,
      correlationFingerprint: eventDataString(event, 'correlationFingerprint'),
      semanticFingerprint,
      irreversible: event.data.irreversible === true,
      targets: Array.isArray(event.data.targets)
        ? event.data.targets.filter((value): value is string => typeof value === 'string')
        : [],
      duplicateIdentityKeys: Array.isArray(event.data.duplicateIdentityKeys)
        ? event.data.duplicateIdentityKeys.filter((value): value is string => typeof value === 'string')
        : externalWriteDuplicateIdentityKeys([], semanticFingerprint || undefined),
    },
  };
}

function digestProjectionIdentity(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reservationProjectionKey(input: {
  sourceUserSeq?: number;
  callId: string;
  descriptor: ExternalWriteEventDescriptor;
  physicalDispatchId?: string;
  projectionNonce?: string;
}): string {
  return `external-write-reservation:${digestProjectionIdentity({
    sourceUserSeq: input.sourceUserSeq ?? null,
    callId: input.callId,
    toolName: input.descriptor.toolName,
    actionKey: input.descriptor.actionKey,
    correlationFingerprint: input.descriptor.correlationFingerprint,
    physicalDispatchId: input.physicalDispatchId ?? null,
    projectionNonce: input.projectionNonce ?? null,
  })}`;
}

function orphanProjectionKey(reservation: ExternalWriteReservationRef): string {
  return `external-write-orphan:${reservation.eventId}`;
}

function decisiveProjectionKey(reservation: ExternalWriteReservationRef): string {
  return `external-write-decisive:${reservation.eventId}`;
}

function exactReservation(input: {
  sessionId: string;
  sourceUserSeq?: number;
  callId: string;
  descriptor: ExternalWriteEventDescriptor;
  physicalDispatchId?: string;
  projectionNonce?: string;
}): EventRow | undefined {
  const projectionKey = reservationProjectionKey(input);
  const events = listEvents(input.sessionId, { types: ['external_write'] });
  const keyed = events.filter((event) => event.data.projectionKey === projectionKey);
  const candidates = keyed.length > 0 ? keyed : events.filter((event) => {
    if (event.data.projectionKey !== undefined) return false;
    if (eventCallId(event) !== input.callId) return false;
    if (event.data.toolName !== input.descriptor.toolName) return false;
    if (event.data.actionKey !== input.descriptor.actionKey) return false;
    if (
      input.sourceUserSeq !== undefined
      && event.data.sourceUserSeq !== input.sourceUserSeq
    ) return false;
    if (
      input.physicalDispatchId !== undefined
      && event.data.physicalDispatchId !== input.physicalDispatchId
    ) return false;
    return true;
  });
  if (candidates.length > 1) {
    throw new ExternalWriteProjectionConflictError(
      'multiple external-write reservations claim one exact logical/physical identity',
    );
  }
  return candidates[0];
}

export function loadExternalWriteReservation(input: {
  sessionId: string;
  sourceUserSeq?: number;
  acceptedTaskId?: string;
  callId: string;
  descriptor: ExternalWriteEventDescriptor;
  physicalDispatchId?: string;
  projectionNonce?: string;
}): ExternalWriteReservationRef | undefined {
  const prior = exactReservation(input);
  if (!prior) return undefined;
  if (
    prior.data.correlationFingerprint !== input.descriptor.correlationFingerprint
    || prior.data.semanticFingerprint !== input.descriptor.semanticFingerprint
    || (input.acceptedTaskId !== undefined && prior.data.acceptedTaskId !== input.acceptedTaskId)
  ) {
    throw new ExternalWriteProjectionConflictError(
      'external-write reservation conflicts with its durable argument identity',
    );
  }
  return {
    eventId: prior.id,
    actionKey: input.descriptor.actionKey,
    toolName: input.descriptor.toolName,
    callId: input.callId,
  };
}

/** Append the durable pre-dispatch reservation, reusing an exact replay. */
export function projectExternalWriteReservation(input: {
  sessionId: string;
  turn?: number;
  sourceUserSeq?: number;
  acceptedTaskId?: string;
  callId: string;
  physicalDispatchId?: string;
  descriptor: ExternalWriteEventDescriptor;
  attribution?: Record<string, unknown>;
  data?: Record<string, unknown>;
}): ExternalWriteReservationRef {
  const callId = input.callId.trim();
  if (!input.sessionId.trim() || !callId) {
    throw new ExternalWriteProjectionConflictError('external-write reservation lacks exact session/call identity');
  }
  const exact = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    callId,
    descriptor: input.descriptor,
    physicalDispatchId: input.physicalDispatchId,
    projectionNonce: typeof input.attribution?.invocationNonce === 'string'
      ? input.attribution.invocationNonce
      : undefined,
  };
  const prior = loadExternalWriteReservation(exact);
  if (prior) return prior;
  const projectionKey = reservationProjectionKey(exact);
  let event: EventRow;
  try {
    event = appendEvent({
      sessionId: input.sessionId,
      turn: input.turn ?? 0,
      role: 'system',
      type: 'external_write',
      data: {
        ...(input.attribution ?? {}),
        ...(input.data ?? {}),
        ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
        ...(input.acceptedTaskId ? { acceptedTaskId: input.acceptedTaskId } : {}),
        ...(input.physicalDispatchId ? { physicalDispatchId: input.physicalDispatchId } : {}),
        projectionKey,
        ...(exact.projectionNonce ? { projectionNonce: exact.projectionNonce } : {}),
        shapeKey: input.descriptor.shapeKey,
        actionKey: input.descriptor.actionKey,
        toolName: input.descriptor.toolName,
        callId,
        canonicalCallId: callId,
        correlationFingerprint: input.descriptor.correlationFingerprint,
        semanticFingerprint: input.descriptor.semanticFingerprint,
        irreversible: input.descriptor.irreversible,
        preDispatch: true,
        targets: input.descriptor.targets,
        duplicateIdentityKeys: input.descriptor.duplicateIdentityKeys,
      },
    });
  } catch (error) {
    const raced = loadExternalWriteReservation(exact);
    if (raced) return raced;
    throw error;
  }
  return {
    eventId: event.id,
    actionKey: input.descriptor.actionKey,
    toolName: input.descriptor.toolName,
    callId,
  };
}

/**
 * Translate the shared attempt classifier into write-ledger truth. Only an
 * acknowledged success confirms a write. Exact provider rejections prove no
 * effect; every other post-dispatch failure remains orphaned/uncertain.
 */
export function externalWriteTerminalForAttemptOutcome(
  outcome: AttemptOutcome,
  physicalOutcome: 'not_started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown',
  options: { hasDurableResultHandle: boolean },
): ExternalWriteTerminalEventType {
  if (
    outcome.kind === 'succeeded'
    && physicalOutcome === 'returned'
    && options.hasDurableResultHandle
  ) {
    return 'external_write_succeeded';
  }
  if (physicalOutcome === 'not_started') return 'external_write_failed';
  // The classifier's providerStatus is machine-structured, but durable
  // transports may preserve an HTTP status as a decimal string. Accept that
  // exact representation without ever guessing from prose/error messages.
  const rawStatus = outcome.providerStatus;
  const status = typeof rawStatus === 'number'
    ? rawStatus
    : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus.trim())
      ? Number(rawStatus.trim())
      : Number.NaN;
  if (
    (physicalOutcome === 'returned' || physicalOutcome === 'threw')
    && outcome.evidence === 'structured'
    && [400, 401, 403, 404, 405, 422, 501].includes(status)
  ) return 'external_write_failed';
  return 'external_write_orphaned';
}

function exactTerminalLifecycle(input: {
  sessionId: string;
  reservation: ExternalWriteReservationRef;
}): EventRow[] {
  const orphanKey = orphanProjectionKey(input.reservation);
  const decisiveKey = decisiveProjectionKey(input.reservation);
  return listEvents(input.sessionId, {
    types: ['external_write_succeeded', 'external_write_failed', 'external_write_orphaned'],
  }).filter((event) => (
    event.parentEventId === input.reservation.eventId
    || event.data.orphanProjectionKey === orphanKey
    || event.data.decisiveProjectionKey === decisiveKey
  ));
}

function decisiveTerminal(
  lifecycle: readonly EventRow[],
): Extract<ExternalWriteTerminalEventType, 'external_write_succeeded' | 'external_write_failed'> | undefined {
  const types = new Set(lifecycle
    .filter((event) => (
      event.type === 'external_write_succeeded' || event.type === 'external_write_failed'
    ))
    .map((event) => event.type));
  if (types.size > 1) {
    throw new ExternalWriteProjectionConflictError(
      'external-write reservation has conflicting decisive terminals',
    );
  }
  const value = types.values().next().value;
  return value === 'external_write_succeeded' || value === 'external_write_failed'
    ? value
    : undefined;
}

/**
 * Append one exact terminal projection. Orphan is an ambiguity observation,
 * not a decisive settlement: a later read-back/reaper may append exactly one
 * success-or-failure terminal. The separate unique keys make both lanes
 * race-safe while keeping success and failure mutually exclusive.
 */
export function projectExternalWriteTerminal(input: {
  sessionId: string;
  turn?: number;
  sourceUserSeq?: number;
  acceptedTaskId?: string;
  physicalDispatchId?: string;
  reservation: ExternalWriteReservationRef;
  descriptor: ExternalWriteEventDescriptor;
  type: ExternalWriteTerminalEventType;
  reason?: string;
  attribution?: Record<string, unknown>;
  data?: Record<string, unknown>;
}): ExternalWriteTerminalEventType {
  const { reservation, descriptor } = input;
  if (
    reservation.callId !== reservation.callId.trim()
    || !reservation.callId
    || reservation.toolName !== descriptor.toolName
    || reservation.actionKey !== descriptor.actionKey
  ) {
    throw new ExternalWriteProjectionConflictError(
      'external-write terminal conflicts with its exact reservation identity',
    );
  }
  const durableReservations = listEvents(input.sessionId, { types: ['external_write'] })
    .filter((event) => event.id === reservation.eventId);
  if (durableReservations.length !== 1) {
    throw new ExternalWriteProjectionConflictError(
      'external-write terminal lacks one exact durable reservation',
    );
  }
  const durable = durableReservations[0]!;
  if (
    eventCallId(durable) !== reservation.callId
    || eventDataString(durable, 'toolName') !== descriptor.toolName
    || eventDataString(durable, 'actionKey') !== descriptor.actionKey
    || eventDataString(durable, 'correlationFingerprint') !== descriptor.correlationFingerprint
    || eventDataString(durable, 'semanticFingerprint') !== descriptor.semanticFingerprint
    || (input.sourceUserSeq !== undefined && durable.data.sourceUserSeq !== input.sourceUserSeq)
    || (input.acceptedTaskId !== undefined && durable.data.acceptedTaskId !== input.acceptedTaskId)
    || (input.physicalDispatchId !== undefined
      && durable.data.physicalDispatchId !== input.physicalDispatchId)
  ) {
    throw new ExternalWriteProjectionConflictError(
      'external-write terminal conflicts with durable reservation authority',
    );
  }
  const lifecycle = exactTerminalLifecycle({
    sessionId: input.sessionId,
    reservation,
  });
  const decisive = decisiveTerminal(lifecycle);
  if (decisive) {
    if (input.type === 'external_write_orphaned' || decisive === input.type) return decisive;
    throw new ExternalWriteProjectionConflictError(
      `external-write reservation already settled ${decisive}`,
    );
  }
  if (
    input.type === 'external_write_orphaned'
    && lifecycle.some((event) => event.type === 'external_write_orphaned')
  ) return input.type;

  const projectionData = input.type === 'external_write_orphaned'
    ? { orphanProjectionKey: orphanProjectionKey(reservation) }
    : { decisiveProjectionKey: decisiveProjectionKey(reservation) };
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: input.turn ?? 0,
      role: 'system',
      type: input.type,
      parentEventId: reservation.eventId,
      data: {
        ...(input.attribution ?? {}),
        ...(input.data ?? {}),
        ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
        ...(input.acceptedTaskId ? { acceptedTaskId: input.acceptedTaskId } : {}),
        ...(input.physicalDispatchId ? { physicalDispatchId: input.physicalDispatchId } : {}),
        ...projectionData,
        shapeKey: descriptor.shapeKey,
        actionKey: descriptor.actionKey,
        ...(descriptor.toolName ? { toolName: descriptor.toolName } : {}),
        callId: reservation.callId,
        canonicalCallId: reservation.callId,
        ...(descriptor.correlationFingerprint
          ? { correlationFingerprint: descriptor.correlationFingerprint }
          : {}),
        ...(descriptor.semanticFingerprint
          ? { semanticFingerprint: descriptor.semanticFingerprint }
          : {}),
        irreversible: descriptor.irreversible,
        targets: descriptor.targets,
        duplicateIdentityKeys: descriptor.duplicateIdentityKeys,
        ...(input.type === 'external_write_succeeded'
          ? {
              settlementKey: `external-write:${reservation.eventId}`,
              ...(input.reason?.trim()
                ? { reason: input.reason.replace(/\s+/g, ' ').trim().slice(0, 240) }
                : {}),
            }
          : {
              reason: (input.reason?.replace(/\s+/g, ' ').trim()
                || 'provider result did not carry a trusted clean acknowledgement').slice(0, 240),
            }),
      },
    });
  } catch (error) {
    const raced = exactTerminalLifecycle({
      sessionId: input.sessionId,
      reservation,
    });
    const racedDecisive = decisiveTerminal(raced);
    if (racedDecisive) {
      if (input.type === 'external_write_orphaned' || racedDecisive === input.type) {
        return racedDecisive;
      }
      throw new ExternalWriteProjectionConflictError(
        `external-write reservation raced with conflicting ${racedDecisive}`,
      );
    }
    if (
      input.type === 'external_write_orphaned'
      && raced.some((event) => event.type === 'external_write_orphaned')
    ) return input.type;
    throw error;
  }
  return input.type;
}
