import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendEvent, getSession, getUserInputEventAtSequence, listEvents, type SessionKind } from '../runtime/harness/eventlog.js';
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

export type PendingActionContinuationMode = 'host_chat' | 'batch' | 'caller' | 'unowned';

/** Select guidance for the continuation that will own a valid human decision.
 * This is not execution authority: the registry, immutable card linkage and
 * executor still validate approval, source, account and payload at dispatch.
 * A staged ordinary action retains its caller until a human card owns it. */
export function pendingActionContinuationMode(input: {
  toolName: string;
  actionSessionId: string | null;
  contextSessionId: string | null;
  contextSessionKind: SessionKind | null;
  humanApprovalBound: boolean;
}): PendingActionContinuationMode {
  if (!input.actionSessionId || !input.contextSessionId || !input.contextSessionKind
    || input.actionSessionId !== input.contextSessionId) return 'unowned';
  if (input.toolName === 'run_batch') return 'batch';
  return input.humanApprovalBound && input.contextSessionKind === 'chat' ? 'host_chat' : 'caller';
}

function continuationModeFor(record: PendingActionRecord, approvalRequired: boolean, sessionId: string | null = ownedSessionId()): PendingActionContinuationMode {
  let sessionKind: SessionKind | null = null;
  try { sessionKind = sessionId ? getSession(sessionId)?.kind ?? null : null; } catch {
    // An unreadable owner cannot justify either a host promise or caller replay.
  }
  return pendingActionContinuationMode({
    toolName: record.toolName,
    actionSessionId: record.sessionId,
    contextSessionId: sessionId,
    contextSessionKind: sessionKind,
    humanApprovalBound: approvalRequired || (record.approvedBy === 'human' && Boolean(record.approvalId)),
  });
}

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
  const sourceUserSeq = runContext ? runContext.sourceUserSeq : outputContext?.sourceUserSeq;
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
    let turn = 0;
    if (type === 'queued' && data.sourceUserSeq !== undefined) {
      const run = harnessRunContextStorage.getStore();
      const output = getToolOutputContext();
      const owner = run ?? output;
      if (!Number.isSafeInteger(data.sourceUserSeq) || Number(data.sourceUserSeq) <= 0
        || !owner || owner.sessionId !== sessionId || owner.sourceUserSeq !== data.sourceUserSeq
        || (output?.sourceUserSeq !== undefined
          && (output.sessionId !== sessionId || output.sourceUserSeq !== data.sourceUserSeq))) return false;
      const source = getUserInputEventAtSequence(sessionId, Number(data.sourceUserSeq));
      if (!source || source.role !== 'user' || !Number.isSafeInteger(source.turn) || source.turn < 0) return false;
      // This edge belongs to the accepted source, not a mutable session turn
      // or a nested SDK invocation's default turn zero.
      turn = source.turn;
    }
    appendEvent({
      sessionId,
      turn,
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
  sessionId: string | null = ownedSessionId(),
): string {
  const continuationMode = continuationModeFor(record, approvalRequired, sessionId);
  const afterApproval = continuationMode === 'host_chat'
    ? 'After the owner approves the one exact card, the chat host runs the stored payload once and returns its durable result. Do not call pending_action_execute, repeat the underlying call, or reconstruct its arguments.'
    : continuationMode === 'batch'
      ? `After approval, call run_batch once with action="execute" and pending_action_id="${record.id}"; it consumes the certified stored plan. Do not call pending_action_execute or reconstruct any item.`
      : continuationMode === 'caller'
        ? 'After approval, this session\'s caller retains execution: call pending_action_execute once with this id; never reconstruct the underlying call.'
        : 'No authoritative session owner is available for this continuation. Do not execute or reconstruct the action; its owning session must handle the decision.';
  const voice = 'Speak to the owner as you would in person: say what you need to do and why, and that you are waiting on their go-ahead. '
    + 'Never mention ids, hashes, cards, graphs, tools or the harness; the id below is for your tool calls only.';
  if (record.status === 'approval_requested') {
    return `The owner already has the one card for this. Do not queue or request another; wait for their decision. ${voice}`;
  }
  if (record.status === 'approved') {
    if (approvalRequired && record.approvedBy !== 'human') {
      return 'This action still requires a verified human decision on its exact card. Do not execute it or treat a policy approval as the owner\'s consent.';
    }
    return `This exact action is approved. ${afterApproval}`;
  }
  if (record.status === 'executing' || record.status === 'executed') {
    return `This exact action is already ${record.status}. Do not dispatch or queue it again; report the durable result in your own words.`;
  }
  if (['rejected', 'expired', 'cancelled', 'failed'].includes(record.status)) {
    return `This exact action is already ${record.status}. Do not retry or create a replacement from this same request; tell the owner plainly.`;
  }
  return approvalRequired && approvalIntent === 'request_now'
    ? `QUEUED FOR APPROVAL: the exact payload is stored with the question "${pendingActionAsk(record)}". The card is not open yet and nothing has run. Return your proposed-action reply; the host turn boundary handles registration of this exact payload's card. Do not search for or create another approval. ${voice} ${afterApproval}`
    : approvalRequired && approvalIntent === 'queue_only'
      ? 'STAGED ONLY: stored without a card. Do not ask the owner to run it this turn. A later explicit request can open its one card for the same exact payload.'
      : approvalRequired
        ? `NEXT: end this turn with one plain question to the owner naming what you would do (for example, "Should I send it?"). The harness opens the one card from this record; do not search for or create another approval. ${voice} ${afterApproval}`
    : `Next: ask the owner whether to go ahead. If it needs a formal card, call request_approval with pendingActionId set to this id and a plain-language preview. ${afterApproval}`;
}

/**
 * The card for a per-call-effect tool shows the bytes that will run, not a
 * paraphrase: for such a tool the command IS the content. Any other tool
 * keeps the preview the model wrote.
 */
export function exactCommandPreview(toolName: string, payload: unknown): string | undefined {
  if (!isEffectDecidedPerCall(toolName) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const command = (payload as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

/** Exactly what pending_action_queue takes, for a host that stages a card itself. */
export interface QueueExactPendingActionInput {
  title: string;
  summary: string;
  ask?: string;
  why?: string;
  does?: string;
  kind: PendingActionKind;
  toolName: string;
  payloadJson: string;
  approvalIntent?: PendingActionApprovalIntent;
  targetSummary?: string;
  preview?: string;
  risk?: string;
  rollback?: string;
  createdBy?: string;
}

/** Who owns the queued action: the session and accepted source it belongs to.
 * The tool reads these from the harness context; a host passes its own. */
export interface QueueExactPendingActionOwner {
  sessionId: string | null;
  /** Whether a tool-output context was active (a context without an owner refuses). */
  contextPresent: boolean;
  attribution: { sourceUserSeq?: number; runScopeId?: string; callId?: string };
}

export interface QueueExactPendingActionResult {
  /** What the caller is told, in the queue tool's own words. */
  text: string;
  record: PendingActionRecord | null;
  reused: boolean;
  /** True when nothing was queued (refused, failed, or not approval-bound). */
  refused: boolean;
}

/**
 * Queue one fully prepared exact action, opening its one card at this turn's
 * boundary when approval is required and asked for. This is the whole of
 * pending_action_queue; the host calls it directly when it refuses a call
 * that leaves this machine, so the model never has to discover and call the
 * queue tool to reach the owner's card (live 10-19: two Windows testers each
 * spent three extra brain steps on that detour).
 */
export async function queueExactPendingAction(
  input: QueueExactPendingActionInput,
  owner: QueueExactPendingActionOwner,
): Promise<QueueExactPendingActionResult> {
  const refused = (text: string): QueueExactPendingActionResult => ({ text, record: null, reused: false, refused: true });
  let parsedPayload: unknown;
  try {
    parsedPayload = parsePendingActionPayloadJson(input.payloadJson);
  } catch (err) {
    return refused(`pending_action_queue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let admitted: AdmittedPendingActionCall;
  const approvalIntent = input.approvalIntent as PendingActionApprovalIntent | undefined;
  try {
    admitted = admitPendingActionCall(input.toolName, parsedPayload, {
      approvalIntent: approvalIntent ?? 'legacy',
    });
  } catch (err) {
    return refused(`pending_action_queue refused: ${err instanceof Error ? err.message : String(err)}`);
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
      if (shaped.issues.length > 0) return refused(payloadShapeRefusal(toolName, shaped.issues));
      payload = shaped.payload;
    }
  } catch { /* an unreadable schema leaves validation to dispatch, as before */ }
  const sessionId = owner.sessionId;
  if (owner.contextPresent && !sessionId) {
    return refused('pending_action_queue refused: the active harness context has no authoritative session owner.');
  }
  const shape = classifyExternalWrite(toolName, payload);
  const kind = input.kind as PendingActionKind;
  const needsFormalApproval = pendingActionRequiresHumanApproval({
    kind,
    toolName,
    payload,
  }, { sessionId });
  if (approvalIntent === 'request_now' && !needsFormalApproval) {
    return refused(
      'pending_action_queue refused: PENDING_ACTION_APPROVAL_NOT_REQUIRED. This exact action is not approval-bound. Execute it through the ordinary work boundary without asking for or creating a separate approval; use queue_only only when the user explicitly requested staging without execution.',
    );
  }
  if (needsFormalApproval && !sessionId) {
    return refused('pending_action_queue refused: an approval-bound action requires an authoritative harness session.');
  }
  // An approval-bound action queued now is the one the owner is about to
  // be asked about, so its one card opens at this turn's boundary unless
  // the caller asked only to stage it. The no-intent prose bridge remains
  // for edges recorded before the intent existed.
  const requestedIntent: PendingActionApprovalIntent | undefined = approvalIntent
    ?? (needsFormalApproval ? 'request_now' : undefined);
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
      return refused(`pending_action_queue refused by harness: ${error.message}`);
    }
  }
  const attribution = owner.attribution;
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
      does: input.does,
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
      ...(requestedIntent ? {
        approvalIntent: requestedIntent,
        autoMaterialize: requestedIntent === 'request_now',
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
      return refused(
        'pending_action_queue failed safely: the approval-bound payload was not accepted because its durable request edge could not be recorded. Nothing is authorized or executable; retry the queue once.',
      );
    }
  } else if (requestedIntent && attribution.sourceUserSeq) {
    const currentIntent = requestOwnedApprovalIntentState({
      sessionId,
      sourceUserSeq: attribution.sourceUserSeq,
      pendingActionId: record.id,
      payloadHash: record.payloadHash,
    });
    const shouldPromote = requestedIntent === 'request_now'
      && currentIntent !== 'request_now';
    const shouldRecordQueueOnly = requestedIntent === 'queue_only'
      && currentIntent !== 'request_now'
      && currentIntent !== 'queue_only';
    if (
      (shouldPromote || shouldRecordQueueOnly)
      && !maybeLog(sessionId, 'queued', {
        pendingActionId: record.id,
        toolName: record.toolName,
        actionKind: record.kind,
        approvalRequired: needsFormalApproval,
        approvalIntent: requestedIntent,
        autoMaterialize: requestedIntent === 'request_now',
        payloadHash: record.payloadHash,
        targetSummary: record.targetSummary,
        ...attribution,
      })
    ) {
      return refused(
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
    : requestedIntent;
  const nextStep = queuedActionNextStep(
    record,
    needsFormalApproval,
    effectiveApprovalIntent,
    sessionId,
  );
  return {
    text: [
      `Pending action ${reused ? 'reused' : 'queued'}: ${record.id}`,
      nextStep,
      '',
      formatPendingAction(record, { verbose: true }),
    ].join('\n'),
    record,
    reused,
    refused: false,
  };
}

export function registerPendingActionTools(server: McpServer): void {
  server.tool(
    'pending_action_queue',
    [
      'Queue a fully prepared exact action when formal approval is required, such as an irreversible send, destructive change, high-impact deploy, or other approval-bound execution. Do not attempt execution or wait for a refusal first; the host validates the requirement.',
      'This tool DOES NOT execute anything. Use it after you have gathered the facts, selected the exact tool, and built the exact payload.',
      'Do not queue an exact ordinary reversible write merely because it changes external state; execute that through the normal work boundary without a separate approval ceremony.',
      'State the graph edge with approvalIntent: request_now opens the one exact formal card this turn; queue_only stores it without a card. Use queue_only when the user explicitly asked to stage only, and do not queue at all while required scope is unresolved.',
      'Required fields include toolName (the exact inner tool, never its carrier) and payloadJson (its exact JSON arguments). If supplied, ask must be 12–200 characters; put longer context in summary, not ask.',
      'Follow the returned continuation guidance: the chat host executes a human-approved single-call card itself; do not call pending_action_execute for that host-owned continuation. A batch retains run_batch action=execute; other session owners retain their existing execution path.',
    ].join(' '),
    {
      title: z.string().min(3).max(160).describe('Short name for lists, e.g. "Run the backup on the server".'),
      summary: z.string().min(8).max(2000).describe('Plain-language summary of what is queued and why.'),
      ask: z.string().min(12).max(200).optional().describe('Optional question of 12–200 characters. In your own words, say what you need to do and ask for the go-ahead. Put longer reasoning in summary. No tool names, ids, hashes or harness terms. The exact command or content is shown below automatically.'),
      why: z.string().max(260).optional().describe('One optional extra line of context for the owner, in plain words (what it touches, what it does not).'),
      kind: kindEnum.describe('Descriptive action class only; the host derives approval from the exact tool and payload. external_write alone does not imply approval.'),
      toolName: z.string().min(1).max(160).describe('REQUIRED: exact inner tool stored for execution after approval, e.g. composio_execute_tool or run_shell_command. Do not omit it or name call_tool/work_call.'),
      payloadJson: z.string().min(2).max(100000).describe('Exact JSON payload for the execution tool. Use the tool schema shape, not prose.'),
      approvalIntent: approvalIntentEnum.optional().describe('request_now = exact payload is complete and the graph should open its one formal card now; queue_only = store it without opening a card this turn. Optional only for pre-3.0 callers, which retain the narrow legacy prose bridge.'),
      targetSummary: z.string().max(1000).optional().describe('Human-readable destination/recipient/resource.'),
      preview: z.string().max(8000).optional().describe('Human-reviewable content preview: email body, rows to update, command, deploy target, etc.'),
      risk: z.string().max(1000).optional().describe('Main risk/blast radius in plain language.'),
      rollback: z.string().max(1000).optional().describe('Undo/rollback note if available.'),
      createdBy: z.string().max(120).optional(),
    },
    async (input) => textResult((await queueExactPendingAction(input as QueueExactPendingActionInput, {
      sessionId: ownedSessionId(),
      contextPresent: Boolean(getToolOutputContext()),
      attribution: currentRequestAttribution(),
    })).text),
  );

  server.tool(
    'pending_action_list',
    'Inspect durable pending-action status and results. A human-approved single-call chat card is executed by the host; do not list actions merely to replay that decision or reconstruct its payload. Other session execution owners keep their existing approval path.',
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
      // Queued with no card means the owner was never asked: nothing can run
      // it yet, and a yes typed in chat approves nothing.
      const unasked = record.status === 'queued' && !record.approvalId
        ? '\n\nNEXT: no card is open for this action, so it is not approved and pending_action_execute cannot run it. '
          + 'To ask the owner, call pending_action_queue again with the same toolName and payloadJson; its one card opens when this turn ends.'
        : '';
      return textResult(`${formatPendingAction(record, { verbose: true })}\n\nPayload:\n${JSON.stringify(record.payload, null, 2)}${unasked}`);
    },
  );

  server.tool(
    'pending_action_execute',
    [
      'Compatibility executor for an APPROVED single-call pending action when this session\'s execution owner explicitly directs the caller to run it.',
      'A human-approved exact single-call card in chat is executed by the host automatically; do NOT call this tool for that continuation or re-issue its underlying call.',
      'For caller-owned execution the server dispatches the byte-identical stored payload through the gated write boundary; you cannot alter it.',
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
