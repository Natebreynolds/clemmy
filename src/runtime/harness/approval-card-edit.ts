/**
 * EDIT BY HAND ON A QUEUED CARD (owner-approved design, 2026-10-07).
 *
 * The owner retyped one of the fields the card showed. On a card that links
 * a queued exact payload (a shell command, a send) the edit lands on that
 * record itself — payload and hash move together, fitted to the tool's own
 * schema — and the card keeps its id and re-pins the record, so the decision
 * that follows is an ordinary approve of the edited record and what runs is
 * exactly what the card showed, edited. Shared by the desktop and the phone.
 */
import * as approvalRegistry from './approval-registry.js';
import { approvalArgsWithFieldEdits } from './approval-call-preview.js';
import { appendEvent } from './eventlog.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { amendPendingActionPayload, getPendingAction } from './pending-actions.js';
import { completePayloadForToolSchema } from '../../tools/tool-payload-shape.js';
import { exactCommandPreview } from '../../tools/pending-action-tools.js';

export type QueuedCardEditResult =
  | { ok: true; editedFields: Record<string, string> }
  | { ok: false; status: 400 | 409; reason: string };

/** Only string values, each bounded; the card's own field names. */
export function queuedCardEditsFrom(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const edits = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([name, v]) => [name, (v as string).slice(0, 20_000)]));
  return Object.keys(edits).length > 0 ? edits : null;
}

/** Apply the owner's retyped fields to the queued record behind a card.
 * Returns null when the card links no queued record (the caller's own edit
 * path applies); otherwise the exact outcome. Nothing is approved here. */
export async function applyQueuedCardFieldEdits(input: {
  approvalId: string;
  edits: Record<string, string>;
  actor: string;
}): Promise<QueuedCardEditResult | null> {
  const row = approvalRegistry.get(input.approvalId);
  if (!row) return { ok: false, status: 409, reason: 'approval not found' };
  const queuedId = pendingActionIdFromArgs(row.args ?? null);
  if (!queuedId) return null;
  const record = getPendingAction(queuedId);
  if (!record || record.approvalId !== row.approvalId) {
    return { ok: false, status: 409, reason: 'approval card is superseded or does not belong to this pending action' };
  }
  if (record.status !== 'queued' && record.status !== 'approval_requested') {
    return { ok: false, status: 409, reason: `pending action is already ${record.status}` };
  }
  const applied = approvalArgsWithFieldEdits(
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : null,
    input.edits,
  );
  if (!applied.ok) return { ok: false, status: 400, reason: applied.reason };
  let payload: Record<string, unknown> = applied.args;
  try {
    const { innerDispatchToolParameters } = await import('../../tools/inner-dispatch.js');
    const schema = await innerDispatchToolParameters(record.toolName);
    if (schema) {
      const shaped = completePayloadForToolSchema(schema, payload);
      if (shaped.issues.length > 0) {
        return { ok: false, status: 400, reason: `the edited call does not fit ${record.toolName}: ${shaped.issues.join('; ')}` };
      }
      payload = shaped.payload;
    }
  } catch { /* the dispatch-time validator still guards the call */ }
  const amended = amendPendingActionPayload(record.id, payload, {
    actor: input.actor,
    note: `Edited by hand on the card: ${Object.keys(input.edits).join(', ')}.`,
    preview: exactCommandPreview(record.toolName, payload),
  });
  if (!amended || amended.status !== record.status || !approvalRegistry.repinPendingActionCard(row.approvalId, input.edits)) {
    return { ok: false, status: 409, reason: 'the queued action could not be edited right now; nothing was approved' };
  }
  return { ok: true, editedFields: input.edits };
}

/** The card's copy reads "edited" with the fields the owner retyped, written
 * before the registry settles the row so no plain copy lands first. */
export function recordQueuedCardEditDecision(input: { approvalId: string; editedFields: Record<string, string> }): void {
  const row = approvalRegistry.get(input.approvalId);
  if (!row) return;
  try {
    appendEvent({
      sessionId: row.sessionId,
      turn: 0,
      role: 'system',
      type: 'approval_resolved',
      data: { approvalId: row.approvalId, tool: row.tool, decision: 'approve_with_edits', resolution: 'approved', sticky: false, edited: true, editedFields: input.editedFields },
    });
  } catch { /* the decision still lands */ }
}
