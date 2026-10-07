/**
 * EDIT BY HAND ON A QUEUED CARD (owner-approved design, 2026-10-07).
 *
 * The owner retyped one of the fields the card showed. On a card that links
 * a queued exact payload (a shell command, a send), preparation is inert. The
 * edited snapshot and approval decision commit together, then the durable
 * record reconciles to those exact bytes. The card keeps its id. Shared by
 * the desktop and the phone.
 */
import * as approvalRegistry from './approval-registry.js';
import { approvalArgsWithFieldEdits } from './approval-call-preview.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import { getPendingAction } from './pending-actions.js';
import { completePayloadForToolSchema } from '../../tools/tool-payload-shape.js';
import { exactCommandPreview } from '../../tools/pending-action-tools.js';

export type QueuedCardEditResult =
  | { ok: true; editedFields: Record<string, string>; approval: approvalRegistry.PendingApprovalRow }
  | { ok: false; status: 400 | 409; reason: string };

/** Only string values, each bounded; the card's own field names. */
export function queuedCardEditsFrom(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('edited fields must be an object of text values');
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [name, v] of entries) {
    if (typeof v !== 'string') throw new Error(`"${name}" must be text; no edited fields were accepted`);
    if (v.length > 20_000) throw new Error(`"${name}" exceeds 20,000 characters; shorten it before approving`);
  }
  const edits = Object.fromEntries(entries) as Record<string, string>;
  return Object.keys(edits).length > 0 ? edits : null;
}

let schemaLoaderForTests: ((tool: string) => Promise<unknown>) | null = null;
export function _setQueuedCardSchemaLoaderForTests(loader: typeof schemaLoaderForTests): void {
  schemaLoaderForTests = loader;
}

/** Apply the owner's retyped fields to the queued record behind a card.
 * Returns null when the card links no queued record (the caller's own edit
 * path applies); otherwise prepare and commit the exact edited approval. */
export async function applyQueuedCardFieldEdits(input: {
  approvalId: string;
  edits: Record<string, string>;
  actor: string;
}): Promise<QueuedCardEditResult | null> {
  const row = approvalRegistry.get(input.approvalId);
  if (!row) return { ok: false, status: 409, reason: 'approval not found' };
  if (!approvalRegistry.isActionable(row) || !approvalRegistry.isFormalApprovalSurface(row)) {
    return { ok: false, status: 409, reason: 'approval is already decided or expired' };
  }
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
    const schema = await (schemaLoaderForTests ?? innerDispatchToolParameters)(record.toolName);
    if (schema) {
      const shaped = completePayloadForToolSchema(schema, payload);
      if (shaped.issues.length > 0) {
        return { ok: false, status: 400, reason: `the edited call does not fit ${record.toolName}: ${shaped.issues.join('; ')}` };
      }
      payload = shaped.payload;
    }
  } catch { /* the dispatch-time validator still guards the call */ }
  const decision = approvalRegistry.approvePendingActionCardEdit({
    approvalId: row.approvalId, expectedArgs: row.args, expectedPayloadHash: record.payloadHash,
    payload, editedFields: input.edits, actor: input.actor,
    preview: exactCommandPreview(record.toolName, payload),
  });
  if (!decision.ok || !decision.row) {
    return { ok: false, status: 409, reason: 'the queued action could not be edited right now; nothing was approved' };
  }
  return { ok: true, editedFields: input.edits, approval: decision.row };
}
