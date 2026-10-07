import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { pendingActionAsk } from '../runtime/harness/pending-action-view.js';
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
import { completePayloadForToolSchema, payloadShapeRefusal } from './tool-payload-shape.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import {
  evaluateRecipientSetIntegrity,
  isRecipientIntegrityGateEnabled,
  RecipientSetIntegrityError,
} from '../runtime/harness/recipient-integrity-gate.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';
import { isEffectDecidedPerCall } from './tool-registry.js';
import {
  admitPendingActionCall,
  type AdmittedPendingActionCall,
} from './pending-action-admission.js';
export {
  admitPendingActionCall,
  canonicalizePendingActionCall,
  type AdmittedPendingActionCall,
  type CanonicalPendingActionCall,
} from './pending-action-admission.js';

const statusEnum = z.enum(PENDING_ACTION_STATUSES);
const kindEnum = z.enum(PENDING_ACTION_KINDS);
const approvalIntentEnum = z.enum(['request_now', 'queue_only']);

export type PendingActionApprovalIntent = z.infer<typeof approvalIntentEnum>;

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

function requestOwnedApprovalIntentState(input: {
  sessionId: string | null;
  sourceUserSeq?: number;
  pendingActionId: string;
  payloadHash: string;
}): PendingActionApprovalIntent | 'legacy' | 'missing' {
  if (!input.sessionId || !input.sourceUserSeq) return 'missing';
  try {
    const matching = listEvents(input.sessionId, {
      types: ['autonomy_note'],
      sinceSeq: input.sourceUserSeq,
    }).filter((event) => (
      event.data.kind === 'pending_action_queued'
      && event.data.sourceUserSeq === input.sourceUserSeq
      && event.data.pendingActionId === input.pendingActionId
      && event.data.payloadHash === input.payloadHash
    ));
    if (matching.some((event) => (
      event.data.approvalIntent === 'request_now'
      || event.data.autoMaterialize === true
    ))) return 'request_now';
    if (matching.some((event) => event.data.approvalIntent === 'queue_only')) return 'queue_only';
    return matching.length > 0 ? 'legacy' : 'missing';
  } catch {
    return 'missing';
  }
}

function queuedActionNextStep(
  record: PendingActionRecord,
  approvalRequired: boolean,
  approvalIntent?: PendingActionApprovalIntent,
): string {
  const voice = 'Speak to the owner as you would in person: say what you need to do and why, and that you are waiting on their go-ahead. '
    + 'Never mention ids, hashes, cards, graphs, tools or the harness; the id below is for your tool calls only.';
  if (record.status === 'approval_requested') {
    return `The owner already has the one card for this. Do not queue or request another; wait for their decision. ${voice}`;
  }
  if (record.status === 'approved') {
    return 'The owner approved this exact action. Call pending_action_execute once with this id; do not reconstruct the underlying call.';
  }
  if (record.status === 'executing' || record.status === 'executed') {
    return `This exact action is already ${record.status}. Do not dispatch or queue it again; report the durable result in your own words.`;
  }
  if (['rejected', 'expired', 'cancelled', 'failed'].includes(record.status)) {
    return `This exact action is already ${record.status}. Do not retry or create a replacement from this same request; tell the owner plainly.`;
  }
  return approvalRequired && approvalIntent === 'request_now'
    ? `CARD OPENED: the owner now sees one card asking "${pendingActionAsk(record)}" with the exact content under it. Nothing has run. Do not search for or create another approval. ${voice} After their yes, call pending_action_execute with this id so the exact stored payload runs once; do not re-read and reconstruct the underlying tool call.`
    : approvalRequired && approvalIntent === 'queue_only'
      ? 'STAGED ONLY: stored without a card. Do not ask the owner to run it this turn. A later explicit request can open its one card for the same exact payload.'
      : approvalRequired
        ? `NEXT: end this turn with one plain question to the owner naming what you would do (for example, "Should I send it?"). The harness opens the one card from this record; do not search for or create another approval. ${voice} After their yes, call pending_action_execute with this id so the exact stored payload runs once.`
    : 'Next: ask the owner whether to go ahead. If it needs a formal card, call request_approval with pendingActionId set to this id and a plain-language preview. After approval, call pending_action_execute with this id so the exact stored payload runs once.';
}

/**
 * The card for a per-call-effect tool shows the bytes that will run, not a
 * paraphrase: for such a tool the command IS the content. Any other tool
 * keeps the preview the model wrote.
 */
function exactCommandPreview(toolName: string, payload: unknown): string | undefined {
  if (!isEffectDecidedPerCall(toolName) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const command = (payload as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

export function registerPendingActionTools(server: McpServer): void {
  server.tool(
    'pending_action_queue',
    [
      'Queue a fully prepared exact action only after the work boundary says one formal approval is required, such as an irreversible send, destructive change, high-impact deploy, or other approval-bound execution.',
      'This tool DOES NOT execute anything. Use it after you have gathered the facts, selected the exact tool, and built the exact payload.',
      'Do not queue an exact ordinary reversible write merely because it changes external state; execute that through the normal work boundary without a separate approval ceremony.',
      'State the graph edge with approvalIntent: request_now opens the one exact formal card this turn; queue_only stores it without a card. Use queue_only when the user explicitly asked to stage only, and do not queue at all while required scope is unresolved.',
      'After approval, call pending_action_execute with this id; it dispatches the exact queued payload once and records the outcome.',
    ].join(' '),
    {
      title: z.string().min(3).max(160).describe('Short name for lists, e.g. "Run the backup on the server".'),
      summary: z.string().min(8).max(2000).describe('Plain-language summary of what is queued and why.'),
      ask: z.string().min(12).max(200).optional().describe('Your words to the owner, as you would say them in person: what you need to do and why their request needs it, ending with the go-ahead question. Example: "To finish step 2 I need to run one command on your Mac. It only prints your SSH settings; nothing leaves the machine. OK to run it?" No tool names, ids, hashes or harness terms. The exact command or content is shown under your words automatically.'),
      why: z.string().max(260).optional().describe('One optional extra line of context for the owner, in plain words (what it touches, what it does not).'),
      kind: kindEnum.describe('Descriptive action class only; the host derives approval from the exact tool and payload. external_write alone does not imply approval.'),
      toolName: z.string().min(1).max(160).describe('The exact tool to call after approval, e.g. composio_execute_tool or run_shell_command.'),
      payloadJson: z.string().min(2).max(100000).describe('Exact JSON payload for the execution tool. Use the tool schema shape, not prose.'),
      approvalIntent: approvalIntentEnum.optional().describe('request_now = exact payload is complete and the graph should open its one formal card now; queue_only = store it without opening a card this turn. Optional only for pre-3.0 callers, which retain the narrow legacy prose bridge.'),
      targetSummary: z.string().max(1000).optional().describe('Human-readable destination/recipient/resource.'),
      preview: z.string().max(8000).optional().describe('Human-reviewable content preview: email body, rows to update, command, deploy target, etc.'),
      risk: z.string().max(1000).optional().describe('Main risk/blast radius in plain language.'),
      rollback: z.string().max(1000).optional().describe('Undo/rollback note if available.'),
      createdBy: z.string().max(120).optional(),
    },
    async (input) => {
      let parsedPayload: unknown;
      try {
        parsedPayload = parsePendingActionPayloadJson(input.payloadJson);
      } catch (err) {
        return textResult(`pending_action_queue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      let admitted: AdmittedPendingActionCall;
      const approvalIntent = input.approvalIntent as PendingActionApprovalIntent | undefined;
      try {
        admitted = admitPendingActionCall(input.toolName, parsedPayload, {
          approvalIntent: approvalIntent ?? 'legacy',
        });
      } catch (err) {
        return textResult(`pending_action_queue refused: ${err instanceof Error ? err.message : String(err)}`);
      }
      const { toolName, executionAuthority } = admitted;
      let payload = admitted.payload;
      // A card promises exactly what will run, so the payload must fit the
      // tool it names before the card exists. Live 2026-10-07: a queued
      // shell command without its nullable `cwd` was approved, then refused
      // before dispatch — the owner's yes ran nothing.
      try {
        const { innerDispatchToolParameters } = await import('./inner-dispatch.js');
        const schema = await innerDispatchToolParameters(toolName);
        if (schema && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const shaped = completePayloadForToolSchema(schema, payload as Record<string, unknown>);
          if (shaped.issues.length > 0) return textResult(payloadShapeRefusal(toolName, shaped.issues));
          payload = shaped.payload;
        }
      } catch { /* an unreadable schema leaves validation to dispatch, as before */ }
      const sessionId = ownedSessionId();
      if (getToolOutputContext() && !sessionId) {
        return textResult('pending_action_queue refused: the active harness context has no authoritative session owner.');
      }
      const shape = classifyExternalWrite(toolName, payload);
      const kind = input.kind as PendingActionKind;
      const needsFormalApproval = pendingActionRequiresHumanApproval({
        kind,
        toolName,
        payload,
      }, { sessionId });
      if (approvalIntent === 'request_now' && !needsFormalApproval) {
        return textResult(
          'pending_action_queue refused: PENDING_ACTION_APPROVAL_NOT_REQUIRED. This exact action is not approval-bound. Execute it through the ordinary work boundary without asking for or creating a separate approval; use queue_only only when the user explicitly requested staging without execution.',
        );
      }
      if (needsFormalApproval && !sessionId) {
        return textResult('pending_action_queue refused: an approval-bound action requires an authoritative harness session.');
      }
      if (sessionId && shape.mutating && shape.irreversible && isRecipientIntegrityGateEnabled()) {
        const recipientResult = evaluateRecipientSetIntegrity(sessionId, payload);
        if (recipientResult.action === 'block') {
          const error = new RecipientSetIntegrityError({ toolName, result: recipientResult });
          try {
            appendEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'recipient_set_integrity_blocked',
                phase: 'pending_action_queue',
                toolName,
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
      const payloadHash = pendingActionPayloadHash(toolName, payload, executionAuthority);
      const targetSummary = input.targetSummary
        ?? (executionAuthority
          ? `${executionAuthority.toolkit} CLI default — ${executionAuthority.label}`
          : undefined);
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
          toolName,
          payload,
          executionAuthority,
          targetSummary,
          preview: exactCommandPreview(toolName, payload) ?? input.preview,
          risk: input.risk,
          rollback: input.rollback,
          ask: input.ask,
          why: input.why,
          sessionId,
          // The accepted source this action was prepared for. An approval
          // that arrives with no turn of its own (a card button) settles the
          // approved call under this source.
          sourceUserSeq: attribution.sourceUserSeq,
          createdBy: input.createdBy ?? 'clementine',
        });
        const edgePersisted = maybeLog(sessionId, 'queued', {
          pendingActionId: record.id,
          toolName: record.toolName,
          actionKind: record.kind,
          approvalRequired: needsFormalApproval,
          ...(approvalIntent ? {
            approvalIntent,
            autoMaterialize: approvalIntent === 'request_now',
          } : {}),
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
      } else if (approvalIntent && attribution.sourceUserSeq) {
        const currentIntent = requestOwnedApprovalIntentState({
          sessionId,
          sourceUserSeq: attribution.sourceUserSeq,
          pendingActionId: record.id,
          payloadHash: record.payloadHash,
        });
        const shouldPromote = approvalIntent === 'request_now'
          && currentIntent !== 'request_now';
        const shouldRecordQueueOnly = approvalIntent === 'queue_only'
          && currentIntent !== 'request_now'
          && currentIntent !== 'queue_only';
        if (
          (shouldPromote || shouldRecordQueueOnly)
          && !maybeLog(sessionId, 'queued', {
            pendingActionId: record.id,
            toolName: record.toolName,
            actionKind: record.kind,
            approvalRequired: needsFormalApproval,
            approvalIntent,
            autoMaterialize: approvalIntent === 'request_now',
            payloadHash: record.payloadHash,
            targetSummary: record.targetSummary,
            ...attribution,
          })
        ) {
          return textResult(
            'pending_action_queue failed safely: the existing payload remains inert because its updated approval graph edge could not be recorded. Retry once.',
          );
        }
      }
      const persistedIntent = requestOwnedApprovalIntentState({
        sessionId,
        sourceUserSeq: attribution.sourceUserSeq,
        pendingActionId: record.id,
        payloadHash: record.payloadHash,
      });
      const effectiveApprovalIntent = persistedIntent === 'request_now'
        || persistedIntent === 'queue_only'
        ? persistedIntent
        : approvalIntent;
      const nextStep = queuedActionNextStep(
        record,
        needsFormalApproval,
        effectiveApprovalIntent,
      );
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
