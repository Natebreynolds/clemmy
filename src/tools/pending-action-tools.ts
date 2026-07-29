import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import {
  PENDING_ACTION_KINDS,
  PENDING_ACTION_STATUSES,
  cancelPendingActionIfQueuedUnlinked,
  formatPendingAction,
  getPendingAction,
  listPendingActions,
  parsePendingActionPayloadJson,
  pendingActionPayloadHash,
  queuePendingAction,
  recordPendingActionResult,
  type PendingActionKind,
  type PendingActionRecord,
  type PendingActionStatus,
} from '../runtime/harness/pending-actions.js';
import { textResult } from './shared.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import {
  evaluateRecipientSetIntegrity,
  isRecipientIntegrityGateEnabled,
  RecipientSetIntegrityError,
} from '../runtime/harness/recipient-integrity-gate.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';

const statusEnum = z.enum(PENDING_ACTION_STATUSES);
const kindEnum = z.enum(PENDING_ACTION_KINDS);

function normalizeSessionId(value?: string | null): string | null {
  const clean = value?.trim();
  if (!clean || /^(?:null|undefined)$/i.test(clean)) return null;
  return clean;
}

/**
 * Mutation ownership comes only from the harness context. A model must never
 * choose which session owns a queued or executed write.
 */
function ownedSessionId(): string | null {
  return normalizeSessionId(getToolOutputContext()?.sessionId);
}

/**
 * Listing is a read/filter operation, so an explicit filter remains useful.
 * Fall back to the active session only when no valid filter was supplied.
 */
function filteredSessionId(explicit?: string | null): string | null {
  return normalizeSessionId(explicit)
    ?? normalizeSessionId(getToolOutputContext()?.sessionId);
}

function currentRequestAttribution(): {
  sourceUserSeq?: number;
  runScopeId?: string;
  callId?: string;
} {
  const outputContext = getToolOutputContext();
  const runContext = harnessRunContextStorage.getStore();
  const sourceUserSeq = runContext?.sourceUserSeq;
  return {
    ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? { sourceUserSeq: sourceUserSeq as number }
      : {}),
    ...((outputContext?.runScopeId ?? runContext?.behaviorScopeId)
      ? { runScopeId: outputContext?.runScopeId ?? runContext?.behaviorScopeId }
      : {}),
    ...(outputContext?.callId ? { callId: outputContext.callId } : {}),
  };
}

function activeContextOwns(record: { sessionId: string | null }): boolean {
  const context = getToolOutputContext();
  if (!context) return true;
  const sessionId = normalizeSessionId(context.sessionId);
  return Boolean(sessionId && record.sessionId === sessionId);
}

function maybeLog(sessionId: string | null, type: 'queued' | 'result', data: Record<string, unknown>): boolean {
  if (!sessionId) return false;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: { kind: `pending_action_${type}`, ...data },
    });
    return true;
  } catch {
    return false;
  }
}

function requestOwnedQueueRetry(input: {
  sessionId: string | null;
  sourceUserSeq?: number;
  payloadHash: string;
  kind: PendingActionKind;
  approvalRequired: boolean;
}): PendingActionRecord | null {
  if (!input.sessionId || !input.sourceUserSeq) return null;
  try {
    const events = listEvents(input.sessionId, {
      types: ['autonomy_note'],
      sinceSeq: input.sourceUserSeq,
    });
    for (const event of events) {
      if (
        event.data.kind !== 'pending_action_queued'
        || event.data.sourceUserSeq !== input.sourceUserSeq
        || event.data.payloadHash !== input.payloadHash
        || event.data.actionKind !== input.kind
        || event.data.approvalRequired !== input.approvalRequired
        || typeof event.data.pendingActionId !== 'string'
      ) continue;
      const record = getPendingAction(event.data.pendingActionId);
      if (
        record
        && record.sessionId === input.sessionId
        && record.payloadHash === input.payloadHash
        && record.kind === input.kind
      ) return record;
    }
  } catch {
    // Dedupe uncertainty must not make a new write safer. The graph transition
    // independently collapses same-request races before it can mint a card.
  }
  return null;
}

function queuedActionNextStep(record: PendingActionRecord, approvalRequired: boolean): string {
  if (record.status === 'approval_requested') {
    return 'This exact request already has its one formal approval card. Do not queue or request another; wait for the user decision.';
  }
  if (record.status === 'approved') {
    return 'This exact queued action is approved. Call pending_action_execute once with this id; do not reconstruct the underlying call.';
  }
  if (record.status === 'executing' || record.status === 'executed') {
    return `This exact request is already ${record.status}. Do not dispatch or queue it again; report the durable result.`;
  }
  if (['rejected', 'expired', 'cancelled', 'failed'].includes(record.status)) {
    return `This exact request is already ${record.status}. Do not retry or create a replacement from this same request; explain the status.`;
  }
  return approvalRequired
    ? 'REQUIRED NEXT EDGE: end this turn with one concise question naming the external action (for example, "Should I send it?"). The harness will materialize the single formal approval card from this request-owned record; do not search for or create another approval tool call. After approval, call pending_action_execute with this id so the byte-identical payload fires once; do not re-read and reconstruct the underlying tool call.'
    : 'Next step: ask the user whether to execute this queued action. If it requires a formal approval card, call request_approval with pendingActionId set to this id and include a concise preview. After approval, call pending_action_execute with this id so the byte-identical payload fires once; do not re-read and reconstruct the underlying tool call.';
}

export function registerPendingActionTools(server: McpServer): void {
  server.tool(
    'pending_action_queue',
    [
      'Queue a fully prepared action payload before an irreversible external write/send/deploy or other approval-bound execution.',
      'This tool DOES NOT execute anything. Use it after you have gathered the facts, selected the exact tool, and built the exact payload.',
      'For an approval-bound action, end the turn with one concise execution/approval question. The harness turns this exact queued record into the single formal card.',
      'After approval, call pending_action_execute with this id; it dispatches the exact queued payload once and records the outcome.',
    ].join(' '),
    {
      title: z.string().min(3).max(160),
      summary: z.string().min(8).max(2000).describe('Plain-language summary of what is queued and why.'),
      kind: kindEnum.describe('The action class. external_send/external_write/deployment are approval-bound in normal operation.'),
      toolName: z.string().min(1).max(160).describe('The exact tool to call after approval, e.g. composio_execute_tool or run_shell_command.'),
      payloadJson: z.string().min(2).max(100000).describe('Exact JSON payload for the execution tool. Use the tool schema shape, not prose.'),
      targetSummary: z.string().max(1000).optional().describe('Human-readable destination/recipient/resource.'),
      preview: z.string().max(8000).optional().describe('Human-reviewable content preview: email body, rows to update, command, deploy target, etc.'),
      risk: z.string().max(1000).optional().describe('Main risk/blast radius in plain language.'),
      rollback: z.string().max(1000).optional().describe('Undo/rollback note if available.'),
      createdBy: z.string().max(120).optional(),
    },
    async (input) => {
      let payload: unknown;
      try {
        payload = parsePendingActionPayloadJson(input.payloadJson);
      } catch (err) {
        return textResult(`pending_action_queue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const sessionId = ownedSessionId();
      if (getToolOutputContext() && !sessionId) {
        return textResult('pending_action_queue refused: the active harness context has no authoritative session owner.');
      }
      const shape = classifyExternalWrite(input.toolName, payload);
      const kind = input.kind as PendingActionKind;
      const needsFormalApproval = pendingActionRequiresHumanApproval({
        kind,
        toolName: input.toolName,
        payload,
      });
      if (needsFormalApproval && !sessionId) {
        return textResult('pending_action_queue refused: an approval-bound action requires an authoritative harness session.');
      }
      if (sessionId && shape.mutating && shape.irreversible && isRecipientIntegrityGateEnabled()) {
        const recipientResult = evaluateRecipientSetIntegrity(sessionId, payload);
        if (recipientResult.action === 'block') {
          const error = new RecipientSetIntegrityError({ toolName: input.toolName, result: recipientResult });
          try {
            appendEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'recipient_set_integrity_blocked',
                phase: 'pending_action_queue',
                toolName: input.toolName,
                recipients: recipientResult.recipients,
                unsupportedRecipients: recipientResult.unsupportedRecipients ?? [],
                reason: recipientResult.reason,
              },
            });
          } catch { /* refusal remains deterministic even if telemetry is unavailable */ }
          return textResult(`pending_action_queue refused by harness: ${error.message}`);
        }
      }
      const attribution = currentRequestAttribution();
      const payloadHash = pendingActionPayloadHash(input.toolName, payload);
      let record = requestOwnedQueueRetry({
        sessionId,
        sourceUserSeq: attribution.sourceUserSeq,
        payloadHash,
        kind,
        approvalRequired: needsFormalApproval,
      });
      const reused = Boolean(record);
      if (!record) {
        record = queuePendingAction({
          title: input.title,
          summary: input.summary,
          kind,
          toolName: input.toolName,
          payload,
          targetSummary: input.targetSummary,
          preview: input.preview,
          risk: input.risk,
          rollback: input.rollback,
          sessionId,
          createdBy: input.createdBy ?? 'clementine',
        });
        const edgePersisted = maybeLog(sessionId, 'queued', {
          pendingActionId: record.id,
          toolName: record.toolName,
          actionKind: record.kind,
          approvalRequired: needsFormalApproval,
          payloadHash: record.payloadHash,
          targetSummary: record.targetSummary,
          ...attribution,
        });
        if (needsFormalApproval && !edgePersisted) {
          cancelPendingActionIfQueuedUnlinked(
            record.id,
            record.id,
            'Approval-bound queue was cancelled because its durable request edge could not be recorded.',
          );
          return textResult(
            'pending_action_queue failed safely: the approval-bound payload was not accepted because its durable request edge could not be recorded. Nothing is authorized or executable; retry the queue once.',
          );
        }
      }
      const nextStep = queuedActionNextStep(record, needsFormalApproval);
      return textResult([
        `Pending action ${reused ? 'reused' : 'queued'}: ${record.id}`,
        nextStep,
        '',
        formatPendingAction(record, { verbose: true }),
      ].join('\n'));
    },
  );

  server.tool(
    'pending_action_list',
    'List durable pending actions. Use before executing a user approval like "yes, send it" so you execute the queued payload, not a reconstructed guess.',
    {
      status: statusEnum.or(z.literal('all')).optional(),
      sessionId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ status, sessionId, limit }) => {
      const records = listPendingActions({
        status: (status ?? 'all') as PendingActionStatus | 'all',
        sessionId: filteredSessionId(sessionId),
        limit,
      });
      if (records.length === 0) return textResult('No pending actions match.');
      return textResult(records.map((record) => formatPendingAction(record)).join('\n\n'));
    },
  );

  server.tool(
    'pending_action_get',
    'Read one queued action with its exact payload, status, approval id, preview, and result history.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const record = getPendingAction(id);
      if (!record || !activeContextOwns(record)) return textResult(`No pending action found with id ${id}.`);
      return textResult(`${formatPendingAction(record, { verbose: true })}\n\nPayload:\n${JSON.stringify(record.payload, null, 2)}`);
    },
  );

  server.tool(
    'pending_action_execute',
    [
      'Fire the exact stored tool call of an APPROVED single-call pending action (e.g. a card minted because a fidelity judge could not verify a send).',
      'The server executes the byte-identical queued payload through the gated write boundary — you cannot alter it. Use this after the user approves such a card; do NOT re-issue the underlying send yourself.',
      'This call returns the authoritative provider result AND records the outcome. After it succeeds, report that result directly; do NOT call pending_action_get or pending_action_record_result.',
      'run_batch plans are executed via run_batch action=execute instead.',
    ].join(' '),
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const { executeApprovedPendingActionCall } = await import('../execution/pending-action-executor.js');
      const ownerSessionId = ownedSessionId();
      if (!ownerSessionId) {
        return textResult('pending_action_execute refused: the active harness context has no authoritative session owner.');
      }
      const result = await executeApprovedPendingActionCall(id, { sessionId: ownerSessionId });
      maybeLog(ownerSessionId, 'result', { pendingActionId: id, status: result.status });
      return textResult(result.resultSummary);
    },
  );

  server.tool(
    'pending_action_record_result',
    'After executing or cancelling a queued action, record the outcome so Clementine can report back and avoid duplicate sends/writes.',
    {
      id: z.string().min(1),
      status: z.enum(['executed', 'failed', 'cancelled']),
      resultSummary: z.string().min(1).max(4000),
    },
    async ({ id, status, resultSummary }) => {
      const current = getPendingAction(id);
      if (!current || !activeContextOwns(current)) return textResult(`No pending action found with id ${id}.`);
      const updated = recordPendingActionResult(id, status, resultSummary);
      if (!updated) return textResult(`No pending action found with id ${id}.`);
      maybeLog(updated.sessionId, 'result', {
        pendingActionId: updated.id,
        status: updated.status,
        resultSummary: updated.resultSummary,
      });
      return textResult(`Pending action ${updated.id} marked ${updated.status}.\n${formatPendingAction(updated, { verbose: true })}`);
    },
  );
}
