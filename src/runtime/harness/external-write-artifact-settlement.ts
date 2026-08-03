import { appendEvent, listEvents } from './eventlog.js';
import type { RunArtifact } from './artifact-ledger.js';

function eventCallId(data: Record<string, unknown>): string {
  const value = data.canonicalCallId ?? data.callId;
  return typeof value === 'string' ? value.trim() : '';
}

/** Join exact artifact verification back to the write receipt that created it.
 *
 * Artifact verification and external-write settlement are persisted in
 * separate durable projections. A process can therefore die after the exact
 * provider read is committed but before the success receipt is appended. This
 * bridge is deliberately model-independent and idempotent: the artifact's
 * immutable reservation binding chooses the one write that may be settled.
 */
export function settleExternalWriteFromVerifiedArtifact(
  sessionId: string,
  artifact: RunArtifact,
  verificationCallId: string | undefined,
): void {
  const sourceCallId = artifact.sourceCallId?.trim() ?? '';
  const verifiedBy = artifact.verificationCallId?.trim() ?? '';
  const reservationEventId = artifact.externalWriteEventId?.trim() ?? '';
  const reservationActionKey = artifact.externalWriteActionKey?.trim() ?? '';
  const reservationToolName = artifact.externalWriteToolName?.trim() ?? '';
  if (
    !sourceCallId
    || !reservationEventId
    || !reservationActionKey
    || !reservationToolName
    || !verificationCallId
    || !verifiedBy
    || !artifact.bindingVerifiedAt
    || !artifact.verificationFingerprint
    || !artifact.resourceId
  ) return;

  try {
    const allLifecycle = listEvents(sessionId, {
      types: [
        'external_write',
        'external_write_succeeded',
        'external_write_failed',
        'external_write_orphaned',
      ],
    });
    const reservation = allLifecycle.find((event) =>
      event.id === reservationEventId && event.type === 'external_write');
    if (!reservation) return;
    const reservationData = reservation.data as Record<string, unknown>;
    if (
      eventCallId(reservationData) !== sourceCallId
      || reservationData.actionKey !== reservationActionKey
      || reservationData.toolName !== reservationToolName
    ) return;

    const settlements = allLifecycle.filter((event) => event.parentEventId === reservationEventId);
    const latestSettlement = [...settlements].reverse().find((event) =>
      event.type === 'external_write_succeeded'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    );
    // Success is already closed; a typed/proven no-dispatch failure must never
    // be overwritten by a later, unrelated resource observation.
    if (latestSettlement?.type === 'external_write_succeeded' || latestSettlement?.type === 'external_write_failed') return;

    const { preDispatch: _preDispatch, ...settlementData } = reservationData;
    appendEvent({
      sessionId,
      turn: reservation.turn,
      role: 'system',
      type: 'external_write_succeeded',
      parentEventId: reservation.id,
      data: {
        ...settlementData,
        callId: sourceCallId,
        canonicalCallId: sourceCallId,
        settlementKey: `external-write:${reservation.id}`,
        reason: 'artifact_readback_verified',
        evidenceCallId: verifiedBy,
        artifactId: artifact.id,
        resourceId: artifact.resourceId,
        verificationFingerprint: artifact.verificationFingerprint,
        reconciledBy: 'artifact_ledger',
      },
    });
  } catch {
    // Bookkeeping remains fail-closed: the prior orphan stays ambiguous.
  }
}
