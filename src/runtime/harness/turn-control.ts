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
import { isKillRequested, appendEvent, getSession } from './eventlog.js';
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

export const BACKGROUND_OFFER_TEXT =
  '[background offer] This is turning into a long run while the user waits in the foreground. '
  + 'If finishing needs more than a step or two, call `offer_background` NOW with a one-line summary of the remaining work, then STOP and wait — do not keep grinding in the foreground. '
  + 'If you are genuinely a step or two from done, just finish; do not offer.';
