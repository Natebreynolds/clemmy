import { addNotification } from '../notifications.js';
import * as approvalRegistry from './approval-registry.js';
import { appendEvent, getSession, listEvents } from './eventlog.js';
import {
  pendingActionApprovalView,
  pendingActionIdFromArgs,
} from './pending-action-view.js';
import {
  cancelPendingActionIfQueuedUnlinked,
  getPendingAction,
  type PendingActionRecord,
} from './pending-actions.js';
import { isDirectionSeekingQuestion } from './objective-judge.js';

export interface QueuedApprovalTransition {
  eventSeq: number;
  record: PendingActionRecord;
  duplicateRecordIds: string[];
  /** Explicit propose→approval primitives (currently run_batch) can request
   * deterministic card materialization without depending on closing prose. */
  autoMaterialize: boolean;
}

export interface MaterializedQueuedApproval {
  transition: QueuedApprovalTransition;
  approval: approvalRegistry.PendingApprovalRow;
  created: boolean;
}

const DIRECT_EXECUTION_QUESTION_RE =
  /\b(?:should|shall|may|can)\s+i\s+(?:now\s+)?(?:execute|send|post|publish|deploy|delete|submit|write|update|add|create|upload|apply|schedule|launch|run)\b|\b(?:do you want|would you like)\s+me\s+to\s+(?:now\s+)?(?:execute|send|post|publish|deploy|delete|submit|write|update|add|create|upload|apply|schedule|launch|run)\b|\bready\s+for\s+me\s+to\s+(?:execute|send|post|publish|deploy|delete|submit|write|update|add|create|upload|apply|schedule|launch|run)\b/i;
const EXPLICIT_APPROVAL_DECISION_RE =
  /\b(?:do you approve|please approve|approve (?:it|this|the|execution)|authorize (?:it|this|the|execution)|give (?:me )?the go[- ]?ahead|go[- ]?ahead with (?:this|the) (?:queued )?(?:action|send|post|publish|deploy|delete|write|update)|proceed with (?:this|the) (?:queued )?(?:action|send|post|publish|deploy|delete|write|update))\b/i;
const CONTEXT_BOUND_PROCEED_QUESTION_RE =
  /\b(?:(?:should|shall|may|can)\s+i|(?:do you want|would you like)\s+me\s+to)\s+(?:proceed|go ahead)(?:\s+now)?\s*\?$/i;
const APPROVE_OR_STOP_DECISION_RE =
  /\bapprove\s+to\s+proceed\s+or\s+(?:tell\s+me\s+to\s+)?stop\b/i;

/**
 * Narrow queue→card intent. Generic material questions keep the action inert:
 * "Which account should I use to send it?" is not execution authorization.
 */
export function isQueuedActionApprovalQuestion(reply?: string | null): boolean {
  const text = (reply ?? '').trim();
  if (!isDirectionSeekingQuestion(text)) return false;
  const tail = text.slice(-500);
  const questionEnd = tail.lastIndexOf('?');
  const beforeQuestion = tail.slice(0, questionEnd);
  const questionStart = Math.max(
    beforeQuestion.lastIndexOf('.'),
    beforeQuestion.lastIndexOf('!'),
    beforeQuestion.lastIndexOf('?'),
    beforeQuestion.lastIndexOf('\n'),
    beforeQuestion.lastIndexOf(';'),
  );
  const question = tail.slice(questionStart + 1, questionEnd + 1).trim();
  if (/^(?:who|what|which|where|when|how)\b/i.test(question)) return false;
  const explicitApproveOrStop = APPROVE_OR_STOP_DECISION_RE.test(question);
  if (/\bor\b/i.test(question) && !explicitApproveOrStop) return false;
  return DIRECT_EXECUTION_QUESTION_RE.test(question)
    || EXPLICIT_APPROVAL_DECISION_RE.test(question)
    || CONTEXT_BOUND_PROCEED_QUESTION_RE.test(question)
    || explicitApproveOrStop;
}

function exactPendingApprovalRow(
  sessionId: string,
  record: PendingActionRecord,
): approvalRegistry.PendingApprovalRow | null {
  if (record.status !== 'approval_requested' || !record.approvalId) return null;
  const row = approvalRegistry.get(record.approvalId);
  const expectedResumeKey =
    `pending-action-approval-v1:${sessionId}:${record.id}:${record.payloadHash}`;
  return row
    && row.status === 'pending'
    && row.sessionId === sessionId
    && row.tool === 'request_approval'
    && row.resumeKey === expectedResumeKey
    && pendingActionIdFromArgs(row.args) === record.id
    ? row
    : null;
}

/**
 * Return one transition per distinct approval-bound payload queued by the
 * current user request. Same-payload retries are folded into the transition's
 * duplicate list; Calendar + Airtable (different hashes) remain two exact
 * authorities. This is a graph-state check, not a text classifier.
 */
export function queuedApprovalTransitionsForRequest(
  sessionId: string,
  sourceUserSeq: number | null | undefined,
): QueuedApprovalTransition[] {
  if (!sourceUserSeq) return [];
  try {
    const newerUserRequestExists = listEvents(sessionId, {
      types: ['user_input_received'],
      sinceSeq: sourceUserSeq,
    }).some((event) => (
      event.seq > sourceUserSeq
      && event.data.synthetic !== true
    ));
    if (newerUserRequestExists) return [];

    const candidates = listEvents(sessionId, {
      types: ['autonomy_note'],
      sinceSeq: sourceUserSeq,
    }).filter((event) => (
      event.seq > sourceUserSeq
      && event.data.kind === 'pending_action_queued'
      && event.data.approvalRequired === true
      && event.data.sourceUserSeq === sourceUserSeq
      && typeof event.data.pendingActionId === 'string'
      && typeof event.data.payloadHash === 'string'
    ));
    if (candidates.length === 0) return [];
    const byPayloadHash = new Map<string, typeof candidates>();
    for (const event of candidates) {
      const hash = String(event.data.payloadHash);
      const group = byPayloadHash.get(hash) ?? [];
      group.push(event);
      byPayloadHash.set(hash, group);
    }
    const transitions: QueuedApprovalTransition[] = [];
    for (const events of byPayloadHash.values()) {
      const valid = events.flatMap((event) => {
        const record = getPendingAction(String(event.data.pendingActionId));
        const queued = record?.status === 'queued' && !record.approvalId;
        const linked = record ? Boolean(exactPendingApprovalRow(sessionId, record)) : false;
        return record
          && record.sessionId === sessionId
          && (queued || linked)
          && record.payloadHash === event.data.payloadHash
          && record.kind === event.data.actionKind
          ? [{ event, record, linked }]
          : [];
      });
      if (valid.length === 0) continue;
      valid.sort((a, b) => Number(b.linked) - Number(a.linked) || a.event.seq - b.event.seq);
      const canonical = valid[0];
      const duplicateRecordIds = [...new Set(
        valid.slice(1)
          .filter(({ linked }) => !linked)
          .map(({ record }) => record.id)
          .filter((id) => id !== canonical.record.id),
      )];
      transitions.push({
        eventSeq: canonical.event.seq,
        record: canonical.record,
        duplicateRecordIds,
        autoMaterialize: valid.some(({ event }) => event.data.autoMaterialize === true),
      });
    }
    return transitions.sort((a, b) => a.eventSeq - b.eventSeq);
  } catch {
    // Losing this advisory correction must never execute the action or crash the
    // turn. The queued record remains inert and the model's question can surface.
    return [];
  }
}

/**
 * Materialize the deterministic queue → approval edge without asking a model
 * to translate one already-validated graph state into another. This saves a
 * full continuation and works identically on every brain. The card is parked,
 * so approving it re-drives the chat and executes only the stored payload.
 */
function materializeQueuedApproval(
  sessionId: string,
  turn: number,
  sourceUserSeq: number,
  transition: QueuedApprovalTransition,
): MaterializedQueuedApproval | null {
  try {
    const record = getPendingAction(transition.record.id);
    const queued = record?.status === 'queued' && !record.approvalId;
    const linked = record ? Boolean(exactPendingApprovalRow(sessionId, record)) : false;
    if (
      !record
      || record.sessionId !== sessionId
      || (!queued && !linked)
      || record.payloadHash !== transition.record.payloadHash
    ) return null;
    if (linked && record.approvalId) {
      const existingSurfaceEvents = listEvents(sessionId, {
        types: ['approval_requested', 'approval_parked'],
        sinceSeq: transition.eventSeq,
      });
      const alreadyRequested = existingSurfaceEvents.some((event) =>
        event.type === 'approval_requested'
        && event.data.approvalId === record.approvalId);
      const alreadyParked = existingSurfaceEvents.some((event) =>
        event.type === 'approval_parked'
        && event.data.approvalId === record.approvalId);
      if (alreadyRequested && alreadyParked) return null;
    }

    const session = getSession(sessionId);
    const metadata = session?.metadata ?? {};
    const channelId = typeof metadata.channelId === 'string'
      ? metadata.channelId
      : typeof metadata.discordChannelId === 'string'
        ? metadata.discordChannelId
        : null;
    const args: Record<string, unknown> = {
      subject: record.title,
      reason: record.summary,
      destructive: false,
      preview: null,
      pendingActionId: record.id,
      // Immutable authority snapshot stored inside the approval row itself.
      // Execution verifies this independent copy under the same lock as the
      // approved→executing claim, so a mutable queue record cannot redefine
      // what the user approved.
      pendingAction: pendingActionApprovalView(record),
    };
    // A crash may leave a fully linked row but lose the surface events. Reuse
    // that row verbatim: regenerating its args from the now-linked file would
    // change snapshot-only fields such as status/approvalId and correctly trip
    // the resumable authority collision guard.
    const existingExactRow = linked
      ? exactPendingApprovalRow(sessionId, record)
      : null;
    const registered = existingExactRow
      ? { row: existingExactRow, created: false }
      : approvalRegistry.registerResumable({
        sessionId,
        channel: session?.channel ?? null,
        channelId,
        subject: record.title,
        tool: 'request_approval',
        args,
        resumeKey: `pending-action-approval-v1:${sessionId}:${record.id}:${record.payloadHash}`,
      });
    const linkedRecord = getPendingAction(record.id);
    if (
      !linkedRecord
      || linkedRecord.sessionId !== sessionId
      || linkedRecord.payloadHash !== record.payloadHash
      || linkedRecord.approvalId !== registered.row.approvalId
      || !['approval_requested', 'approved'].includes(linkedRecord.status)
    ) return null;

    const priorEvents = listEvents(sessionId, {
      types: ['approval_requested', 'approval_parked'],
      sinceSeq: transition.eventSeq,
    });
    const hasRequestedEvent = priorEvents.some((event) =>
      event.type === 'approval_requested'
      && event.data.approvalId === registered.row.approvalId);
    const hasParkedEvent = priorEvents.some((event) =>
      event.type === 'approval_parked'
      && event.data.approvalId === registered.row.approvalId);
    if (!hasRequestedEvent) {
      try {
        addNotification({
          id: `approval-${registered.row.approvalId}`,
          kind: 'approval',
          title: 'Approval pending',
          body: record.title,
          createdAt: new Date().toISOString(),
          read: false,
          metadata: {
            approvalId: registered.row.approvalId,
            tool: 'request_approval',
            sessionId,
            discordInlineHandled: session?.channel === 'discord' && Boolean(channelId),
          },
        });
      } catch {
        // The registry row and event are the durable card; delivery fan-out is best-effort.
      }
      try {
        appendEvent({
          sessionId,
          turn,
          role: 'Clem',
          type: 'approval_requested',
          data: {
            tool: 'request_approval',
            subject: record.title,
            args,
            rawArgs: JSON.stringify(args),
            pendingAction: pendingActionApprovalView(linkedRecord),
            approvalId: registered.row.approvalId,
            sourceUserSeq,
            source: 'pending_action_graph_transition',
          },
        });
      } catch { /* registry row + verified action link remain authoritative */ }
    }
    if (!hasParkedEvent) {
      try {
        appendEvent({
          sessionId,
          turn,
          role: 'system',
          type: 'approval_parked',
          data: {
            approvalId: registered.row.approvalId,
            tool: 'request_approval',
            subject: record.title,
            pendingActionId: record.id,
            sourceUserSeq,
            source: 'pending_action_graph_transition',
          },
        });
      } catch { /* the pending registry row remains visible and inert */ }
    }
    for (const duplicateId of transition.duplicateRecordIds) {
      try {
        cancelPendingActionIfQueuedUnlinked(
          duplicateId,
          record.id,
        );
      } catch {
        // The canonical card is already durable. Duplicate cleanup is
        // defense-in-depth and must not hide the awaiting-approval state.
      }
    }
    return {
      transition,
      approval: registered.row,
      created: registered.created || !hasRequestedEvent || !hasParkedEvent,
    };
  } catch {
    // Fail closed: the queued payload stays inert and the model's question can
    // still surface. A missing card can never authorize execution.
    return null;
  }
}

/** Materialize every eligible distinct transition independently. One damaged
 * record cannot authorize or suppress a different exact payload from the same
 * request; failures remain inert and are omitted from the returned evidence. */
export function materializeQueuedApprovals(
  sessionId: string,
  turn: number,
  sourceUserSeq: number,
  transitions: QueuedApprovalTransition[],
): MaterializedQueuedApproval[] {
  return transitions.flatMap((transition) => {
    const materialized = materializeQueuedApproval(
      sessionId,
      turn,
      sourceUserSeq,
      transition,
    );
    return materialized ? [materialized] : [];
  });
}
