/**
 * Approved-payload replay (2026-07-21).
 *
 * A workflow step that parks on approval loses its in-flight model turn: on
 * re-admission the step re-runs from scratch, the model RE-COMPOSES its
 * payload, and the exact-payload resume key (sha256 over the args) can never
 * match the grant the user just gave. Live failure: team-activity-slack-updates
 * minted four approvals for the same Slack send — three were approved, zero
 * were consumed (`consumed_at IS NULL`), nothing ever sent.
 *
 * The fix preserves the fail-closed exact-payload invariant by inverting who
 * adapts: instead of hoping the model reproduces the approved bytes, the
 * harness executes the APPROVED bytes itself. On re-admission we atomically
 * claim the session's resolved-approved unconsumed approval row (one winner —
 * a racing duplicate re-admission can never double-send) and dispatch the
 * stored payload verbatim through the composio gateway. The model then runs
 * with the executed result in its prompt and is told to finish the step, not
 * re-propose the action. Rejected/expired/cancelled rows are never touched —
 * those remain terminal for the occurrence (reaper policy).
 *
 * Scope: composio_execute_tool — the canonical external-write surface every
 * SaaS send/write rides. Other parked tools keep today's behavior (re-run +
 * exact-hash match), which is safe: worst case they re-ask, never double-run.
 */
import pino from 'pino';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { appendEvent, writeToolOutput } from '../runtime/harness/eventlog.js';

const logger = pino({ name: 'clementine-next.approval-replay' });

export interface ApprovedReplayOutcome {
  approvalId: string;
  /** The inner provider slug, e.g. SLACK_SEND_MESSAGE. */
  toolSlug: string;
  ok: boolean;
  /** Rendered result (or error) text, clipped for prompt injection. */
  resultText: string;
}

const RESULT_CLIP = 4000;

type DispatchFn = (
  toolSlug: string,
  args: Record<string, unknown>,
  opts: { sessionId?: string; connectedAccountId?: string },
) => Promise<{ ok: true; result: unknown } | { ok: false } | Record<string, unknown>>;

let dispatchImpl: DispatchFn | null = null;
export function setApprovalReplayDispatchForTest(fn: DispatchFn | null): void {
  dispatchImpl = fn;
}

function clip(text: string): string {
  return text.length > RESULT_CLIP ? `${text.slice(0, RESULT_CLIP)}\n…[truncated]` : text;
}

/**
 * Claim + replay the session's approved unconsumed action, if any.
 * Returns null when there is nothing to replay (the common case).
 * Never throws — a replay failure is reported in the outcome so the step
 * model can surface it honestly.
 */
export async function replayApprovedActionForSession(sessionId: string): Promise<ApprovedReplayOutcome | null> {
  let row: approvalRegistry.PendingApprovalRow | null = null;
  try {
    row = approvalRegistry.claimApprovedUnconsumedForSession(sessionId, { tools: ['composio_execute_tool'] });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, 'approved-replay claim failed');
    return null;
  }
  if (!row) return null;

  let toolSlug = '';
  let innerArgs: Record<string, unknown> = {};
  let connectedAccountId: string | undefined;
  try {
    const wrapper = (row.args ?? {}) as Record<string, unknown>;
    toolSlug = String(wrapper.tool_slug ?? '');
    const rawInner = wrapper.arguments;
    innerArgs = typeof rawInner === 'string'
      ? (JSON.parse(rawInner) as Record<string, unknown>)
      : ((rawInner ?? {}) as Record<string, unknown>);
    const account = wrapper.connected_account_id;
    connectedAccountId = typeof account === 'string' && account.trim() ? account : undefined;
  } catch (err) {
    // The grant is consumed but unparseable — surface honestly rather than
    // silently re-minting; the model will report the step as needs-attention.
    const message = `ERROR: approved action ${row.approvalId} could not be replayed — its stored payload failed to parse (${err instanceof Error ? err.message : String(err)}). The action was NOT performed.`;
    logger.warn({ approvalId: row.approvalId, sessionId }, 'approved-replay payload unparseable');
    return { approvalId: row.approvalId, toolSlug: toolSlug || 'unknown', ok: false, resultText: message };
  }
  if (!toolSlug) {
    return {
      approvalId: row.approvalId,
      toolSlug: 'unknown',
      ok: false,
      resultText: `ERROR: approved action ${row.approvalId} had no tool_slug in its stored payload. The action was NOT performed.`,
    };
  }

  const callId = `approval-replay-${row.approvalId}`;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'tool_called',
      data: { tool: 'composio_execute_tool', toolSlug, callId, approvalId: row.approvalId, source: 'approval-replay' },
    });
  } catch { /* audit trail is best-effort; the dispatch below is the truth */ }

  try {
    const dispatch = dispatchImpl ?? (await import('../tools/composio-tools.js')).dispatchComposioTool as unknown as DispatchFn;
    const outcome = await dispatch(toolSlug, innerArgs, { sessionId, connectedAccountId });
    const ok = (outcome as { ok?: boolean }).ok === true;
    const resultText = ok
      ? clip(JSON.stringify((outcome as { result?: unknown }).result ?? outcome))
      : clip(`ERROR: dispatch blocked: ${JSON.stringify(outcome)}`);
    try {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_returned',
        data: { tool: 'composio_execute_tool', toolSlug, callId, approvalId: row.approvalId, ok, source: 'approval-replay' },
      });
      writeToolOutput({ sessionId, callId, tool: 'composio_execute_tool', output: resultText });
    } catch { /* audit trail best-effort */ }
    logger.info({ approvalId: row.approvalId, sessionId, toolSlug, ok }, 'approved action replayed verbatim');
    return { approvalId: row.approvalId, toolSlug, ok, resultText };
  } catch (err) {
    const message = `ERROR: the approved ${toolSlug} action failed during replay: ${err instanceof Error ? err.message : String(err)}`;
    try {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_returned',
        data: { tool: 'composio_execute_tool', toolSlug, callId, approvalId: row.approvalId, ok: false, source: 'approval-replay' },
      });
      writeToolOutput({ sessionId, callId, tool: 'composio_execute_tool', output: message });
    } catch { /* audit trail best-effort */ }
    logger.warn({ approvalId: row.approvalId, sessionId, toolSlug, err: err instanceof Error ? err.message : String(err) }, 'approved-replay dispatch failed');
    return { approvalId: row.approvalId, toolSlug, ok: false, resultText: clip(message) };
  }
}

/** The prompt block a re-admitted step carries when its approved action was
 *  already executed by the harness. */
export function renderApprovedReplayNote(outcome: ApprovedReplayOutcome): string {
  if (outcome.ok) {
    return [
      `APPROVED ACTION ALREADY EXECUTED (approval ${outcome.approvalId}): the user approved this step's pending ${outcome.toolSlug} action and the harness has ALREADY executed it with the exact approved payload.`,
      `Result: ${outcome.resultText}`,
      'Do NOT run or re-propose this action again — it is done. Finish the step from this result (verify/summarize and produce the step output).',
    ].join('\n');
  }
  return [
    `APPROVED ACTION FAILED (approval ${outcome.approvalId}): the user approved this step's pending ${outcome.toolSlug} action, the harness replayed the exact approved payload, and the execution FAILED.`,
    `Failure: ${outcome.resultText}`,
    'Do NOT silently retry with a rewritten payload. Report the step as failed/needs-attention with this reason; only re-propose the action if you can fix the concrete cause, and expect it to require a fresh approval.',
  ].join('\n');
}
