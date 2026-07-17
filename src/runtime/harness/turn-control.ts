/**
 * TURN-CONTROL SPINE — the lane-agnostic deterministic controls, in ONE place.
 *
 * Born from the 2026-07-16 unkillable-run incident: a 33-minute runaway chat
 * turn on the Claude SDK brain lane (the DEFAULT brain) had no working kill
 * switch, no confirm beat, no background offer, and ignored 15 grind
 * advisories — because every one of those controls lived in the harness
 * loop / wrapToolForHarness spine, and the SDK lane consulted none of them.
 * The controls themselves were already pure functions over sessionId
 * (assertNotKilled, evaluateToolCall, the Stage-4 budget window); what was
 * missing was CONSULTATION. This module is the consultation surface both
 * lanes share, so a future lane inherits the spine instead of re-forgetting
 * controls piecemeal.
 *
 * Composition points:
 *  - Claude SDK lane: `withKillSwitchGate` + the widened grind enforcement
 *    wrap the composed canUseTool (the one gate every tool tier passes
 *    through, and the only reliable in-loop stop via deny+interrupt);
 *    `composeKillAwareShouldCancel` gives message-boundary aborts for the
 *    whole query stream.
 *  - Harness loop: already consults the underlying primitives directly;
 *    `evaluateTurnBoundary` unifies its between-step limit checks so both
 *    lanes park with identical verdicts.
 */
import { isKillRequested, appendEvent, getSession, listEvents } from './eventlog.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import { checkRunTokenWindow, type RunTokenWindow, type RunTokenStatus } from './run-token-budget.js';
import { getRuntimeEnv } from '../../config.js';

// The SDK's PermissionResult shape (structural — avoids importing SDK types here).
export interface ToolGateDeny {
  behavior: 'deny';
  message: string;
  interrupt: boolean;
  /** True when this deny is the fanout refuse-and-steer (its recovery text
   *  references run_tool_program — callers without that tool skip it). */
  fanout?: boolean;
}

/** Kill verdict for one tool call. Pure; never throws. */
export function killGateVerdict(sessionId: string | undefined): ToolGateDeny | null {
  try {
    if (!sessionId || !isKillRequested(sessionId)) return null;
    return {
      behavior: 'deny',
      // interrupt:true is the only reliable in-loop stop on the SDK lane —
      // the turn ends instead of the model retrying around a soft deny.
      interrupt: true,
      message: 'This run was stopped by the user (kill switch). Do not continue — acknowledge the stop.',
    };
  } catch {
    return null; // the gate must never itself break a tool call
  }
}

/**
 * Grind verdict for one NATIVE-EXTERNAL tool call (tools that never reach
 * wrapToolForHarness). Enforces the SAME ladder the wrapped lane gets:
 * fanout refuse-and-steer, soft block, halt, and the terminal escalate —
 * before this, withReadFanoutGuard evaluated these tools but silently
 * discarded every verdict except the fanout block, which is exactly how the
 * incident's model ignored 15 advisories. Returns null to allow.
 */
export function grindGateVerdict(
  sessionId: string | undefined,
  strippedToolName: string,
  input: unknown,
  opts?: {
    /** The caller's recovery skeleton has run_tool_program, so the fanout
     *  refuse-and-steer is actionable. When false the fanout branch is a
     *  silent allow — no deny AND no guardrail_tripped event (review
     *  wf_2ed83f94 #6: emitting a discarded verdict fills the operator view
     *  with trips that never happened). */
    honorFanout?: boolean;
  },
): ToolGateDeny | null {
  try {
    if (!sessionId) return null;
    const decision = applyMode(evaluateToolCall(sessionId, strippedToolName, input));
    const emit = (kind: string, reason: string): void => {
      try {
        appendEvent({
          sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
          data: { kind, toolName: decision.toolName, count: decision.count, reason, sdk: true },
        });
      } catch { /* telemetry never blocks */ }
    };
    if (decision.fanoutBlock) {
      if (!opts?.honorFanout) return null; // not actionable here — allow, and do not log a phantom trip
      emit('fanout_block', decision.fanoutBlock);
      return { behavior: 'deny', message: decision.fanoutBlock, interrupt: false, fanout: true };
    }
    if (decision.action === 'escalate') {
      emit('tool_call_guardrail_escalate', decision.reason);
      return {
        behavior: 'deny',
        interrupt: true, // terminal — matches ToolGuardrailEscalated ending the turn
        message: `Terminal guardrail (${decision.reason}): ${strippedToolName} repeated past the hard stop. The turn is over; report honestly what was and was not done.`,
      };
    }
    if (decision.action === 'block' || decision.action === 'halt') {
      emit('tool_call_guardrail', decision.reason);
      return {
        behavior: 'deny',
        interrupt: false,
        message: `Guardrail ${decision.action} (${decision.reason}): ${strippedToolName} has repeated too many times this turn — change approach (fan out with run_worker, or batch the reads with run_tool_program) instead of retrying one at a time.`,
      };
    }
  } catch { /* the guardrail must never itself break a tool call */ }
  return null;
}

/** shouldCancel composition: the SDK polls this before start and after every
 *  stream message — OR-ing the kill switch in gives the whole query
 *  message-boundary kill coverage, not just tool edges. */
export function composeKillAwareShouldCancel(
  sessionId: string,
  base?: () => boolean | Promise<boolean>,
): () => boolean | Promise<boolean> {
  return async () => {
    try {
      if (isKillRequested(sessionId)) return true;
    } catch { /* fail-open: a kill-read error must not cancel a healthy run */ }
    return base ? await base() : false;
  };
}

// ── between-step / between-query boundary verdict ───────────────────────────

export type TurnBoundaryVerdict =
  | { kind: 'continue'; tokenStatus?: RunTokenStatus }
  | { kind: 'killed'; reason: string }
  | { kind: 'limit'; limit: 'wall_clock' | 'token_budget' | 'max_steps'; tokenStatus?: RunTokenStatus };

/**
 * One boundary check shared by both lanes: kill → wall-clock → token budget →
 * step cap, in the loop's established precedence. Pure over its inputs plus
 * two point reads (kill row, token counter); never throws.
 */
export function evaluateTurnBoundary(input: {
  sessionId: string;
  startedAt: number;
  maxWallMs: number;
  stepIndex: number;
  maxSteps: number;
  tokenWindow: RunTokenWindow | null;
  now?: number;
}): TurnBoundaryVerdict {
  const now = input.now ?? Date.now();
  try {
    if (isKillRequested(input.sessionId)) return { kind: 'killed', reason: 'kill switch' };
  } catch { /* fail-open */ }
  const tokenStatus = input.tokenWindow ? checkRunTokenWindow(input.tokenWindow) : undefined;
  if (input.maxWallMs > 0 && now - input.startedAt > input.maxWallMs) {
    return { kind: 'limit', limit: 'wall_clock', tokenStatus };
  }
  if (tokenStatus?.exceeded) return { kind: 'limit', limit: 'token_budget', tokenStatus };
  if (input.stepIndex >= input.maxSteps) return { kind: 'limit', limit: 'max_steps', tokenStatus };
  return { kind: 'continue', tokenStatus };
}

// ── background offer (policy 2026-07-16: always offer on long execution) ────

/** The nudge graduates to default ON (validated behavior; the incident's run
 *  got no offer partly because this flag sat default-off). */
export function backgroundOfferEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_BG_OFFER_NUDGE', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export const BACKGROUND_OFFER_MIN_TOOLS = 6;
export const BACKGROUND_OFFER_MIN_ELAPSED_MS = 90_000;

/** Pure trigger both lanes share: a chat-session execution grind that has
 *  either racked up tool calls or wall-clock deserves the one-shot offer. */
export function shouldOfferBackground(input: {
  sessionId: string;
  sessionKind?: string;
  toolCalls: number;
  elapsedMs: number;
  alreadyNudged: boolean;
  suppressed?: boolean;
}): boolean {
  if (!backgroundOfferEnabled()) return false;
  if (input.alreadyNudged || input.suppressed) return false;
  if (input.sessionId.startsWith('background:')) return false;
  const kind = input.sessionKind ?? (() => {
    try { return getSession(input.sessionId)?.kind; } catch { return undefined; }
  })();
  if (kind !== 'chat') return false;
  return input.toolCalls >= BACKGROUND_OFFER_MIN_TOOLS
    || input.elapsedMs >= BACKGROUND_OFFER_MIN_ELAPSED_MS;
}

// ── confirm beat (policy 2026-07-16: "shovel before driving over") ──────────
// "If I asked a friend to help me dig a hole and they just blindly drove to my
// house without a shovel it would be a waste of time." A FRESH chat request
// that is execution-shaped gets ONE conversational beat — confirm the plan,
// surface missing tools/connections, offer background — before the work
// starts. Delivered as a directive in the agent context packet (both lanes
// read it), NOT a formal plan card: the 2026-06-01 converse-until-aligned
// rollback stands — the model converses, the trigger is deterministic.

/** Write-VERB anchored (review wf_2ed83f94 #10: plan-first's EXTERNAL_WRITE_RE
 *  matches bare service NOUNS — "check my email" tripped the beat). Verbs only;
 *  a read-only mention of a service never confirms. Kept inline so the spine
 *  stays import-light — plan-first pulls the planner subsystem. */
const CONFIRM_EXECUTION_SHAPE_RE =
  /\b(?:send|sends|sending|post|posting|publish|publishing|deploy|deploying|host|hosting|notify|notifying|email|emailing|message|draft|drafting|create|creating|update|updating|upload|uploading|submit|submitting|schedule|scheduling|dispatch|dispatching|delete|deleting|remove|removing|commit|committing|push|merge|merging|migrate|migrating|import|importing|export|exporting|sync|syncing|blast)\b/i;
/** A read-verb opener means the ask is a lookup even when write-ish words
 *  appear later ("check my email and tell me if…") — bias-to-action wins. */
const CONFIRM_READ_LEAD_RE =
  /^(?:check|look|read|show|summari[sz]e|tell|find|list|review|search|browse|view|explain|describe|analy[sz]e|compare|give\s+me|pull\s+up|what'?s)\b/i;
const CONFIRM_QUESTION_LEAD_RE =
  /^(?:who|whom|whose|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b/i;
const CONFIRM_CONTROL_RE =
  /^(?:approve|approved|yes|yep|yeah|y|ok|okay|go|go ahead|proceed|continue|resume|cancel|stop|halt|no|nope|reject)\b/i;

export function confirmBeatEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CONFIRM_BEAT', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export const CONFIRM_BEAT_TEXT =
  '[confirm-first] This is the FIRST turn of a session and the request is execution-shaped (external writes or many items). '
  + 'Take ONE conversational beat before doing the work, the way a colleague would:\n'
  + '1. Confirm the plan in 2-4 lines — what you will do, in what order, and where the results land.\n'
  + '2. Verify you actually have the tools/connections the plan needs (the MCP scope and health warnings above; check_capability for CLIs). If something is missing, SAY so and offer to help connect it — never improvise around a missing tool.\n'
  + '3. If the work will take more than a couple of minutes, offer to run it in the background.\n'
  + 'Then STOP and wait for the go-ahead; once the user says go, run it to completion without re-asking. '
  + 'EXCEPTION: if the request is actually a quick read-only task (a lookup, a summary, one small read), skip the beat and just do it now.';

/** Directive for a fresh execution-shaped chat turn, or null. Pure over its
 *  inputs plus one point read (prior completed turns); never throws. */
export function confirmBeatDirective(input: {
  message: string;
  sessionId?: string;
  sessionKind?: string;
  isMultiItem?: boolean;
  itemCount?: number;
}): string | null {
  try {
    if (!confirmBeatEnabled()) return null;
    if (input.sessionKind !== 'chat' || !input.sessionId) return null;
    const text = (input.message ?? '').trim();
    if (text.length < 24) return null; // control words and quick asks never confirm-beat
    if (CONFIRM_CONTROL_RE.test(text)) return null;
    if (CONFIRM_READ_LEAD_RE.test(text)) return null;
    if (CONFIRM_QUESTION_LEAD_RE.test(text) && text.endsWith('?')) return null;
    const executionShaped = CONFIRM_EXECUTION_SHAPE_RE.test(text)
      || (input.isMultiItem === true && (input.itemCount ?? 0) >= 3);
    if (!executionShaped) return null;
    // FRESH sessions only. Any completed turn means the conversation already
    // aligned (approve-once-then-run) — the beat must never re-ask mid-thread.
    if (listEvents(input.sessionId, { types: ['conversation_completed'] }).length > 0) return null;
    return CONFIRM_BEAT_TEXT;
  } catch { return null; }
}

export const BACKGROUND_OFFER_TEXT =
  '[background offer] This is turning into a long run while the user waits in the foreground. '
  + 'If finishing needs more than a step or two, offer the user a background handoff NOW: '
  + 'if the `offer_background` tool is available to you, call it with a one-line summary of the remaining work; '
  + 'otherwise END your reply by asking whether to (a) run the rest in the background, (b) hold it for later, or (c) keep going here. '
  + 'Then STOP and wait — do not keep grinding in the foreground. '
  + 'If you are genuinely a step or two from done, just finish; do not offer.';
