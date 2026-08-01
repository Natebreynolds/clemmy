/**
 * TURN-CONTROL SPINE — the lane-agnostic deterministic controls, in ONE place.
 *
 * Born from the 2026-07-16 unkillable-run incident: a 33-minute runaway chat
 * turn on the Claude SDK brain lane (the DEFAULT brain) had no working kill
 * switch or background handoff and ignored 15 grind
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
import { isKillRequested, appendEvent, listEvents, type KillRequestTarget } from './eventlog.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import { checkRunTokenWindow, type RunTokenWindow, type RunTokenStatus } from './run-token-budget.js';

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
export function killGateVerdict(sessionId: string | undefined, target?: KillRequestTarget): ToolGateDeny | null {
  try {
    if (!sessionId || !isKillRequested(sessionId, target)) return null;
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
  authoritySessionId: string | undefined,
  strippedToolName: string,
  input: unknown,
  opts?: {
    /** Isolated/stable counter identity. Approval authority remains on the real
     *  session above so workers and resumed attempts cannot lose consent. */
    trackerScopeId?: string;
    /** Byte-pinned run_batch execution already certified by the user. */
    approvedBatch?: boolean;
    /** The caller's recovery skeleton has run_tool_program, so the fanout
     *  refuse-and-steer is actionable. When false the fanout branch is a
     *  silent allow — no deny AND no guardrail_tripped event (review
     *  Turn-control review: emitting a discarded verdict fills the operator view
     *  with trips that never happened). */
    honorFanout?: boolean;
  },
): ToolGateDeny | null {
  try {
    if (!authoritySessionId) return null;
    const trackerScopeId = opts?.trackerScopeId ?? authoritySessionId;
    const decision = applyMode(evaluateToolCall(
      trackerScopeId,
      strippedToolName,
      input,
      undefined,
      { authoritySessionId, approvedBatch: opts?.approvedBatch },
    ));
    const emit = (kind: string, reason: string): void => {
      try {
        appendEvent({
          sessionId: authoritySessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
          data: {
            kind,
            toolName: decision.toolName,
            count: decision.count,
            reason,
            effect: decision.effect ?? null,
            dangerousWrite: decision.dangerousWrite === true,
            trackerScopeId,
            sdk: true,
          },
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
  target?: KillRequestTarget,
): () => boolean | Promise<boolean> {
  return async () => {
    try {
      if (isKillRequested(sessionId, target)) return true;
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
  sourceUserSeq?: number;
  startedAt: number;
  maxWallMs: number;
  stepIndex: number;
  maxSteps: number;
  tokenWindow: RunTokenWindow | null;
  now?: number;
}): TurnBoundaryVerdict {
  const now = input.now ?? Date.now();
  try {
    if (isKillRequested(
      input.sessionId,
      input.sourceUserSeq ? { sourceUserSeq: input.sourceUserSeq } : undefined,
    )) return { kind: 'killed', reason: 'kill switch' };
  } catch { /* fail-open */ }
  const tokenStatus = input.tokenWindow ? checkRunTokenWindow(input.tokenWindow) : undefined;
  if (input.maxWallMs > 0 && now - input.startedAt > input.maxWallMs) {
    return { kind: 'limit', limit: 'wall_clock', tokenStatus };
  }
  if (tokenStatus?.exceeded) return { kind: 'limit', limit: 'token_budget', tokenStatus };
  if (input.stepIndex >= input.maxSteps) return { kind: 'limit', limit: 'max_steps', tokenStatus };
  return { kind: 'continue', tokenStatus };
}

// ── one-release legacy alignment reader ─────────────────────────────────────
// Clementine 3.5 briefly persisted turn_preflight_decision rows for a
// ceremonial confirmation beat. New turns never create those rows. Keep this
// read-only decoder for one release so an in-flight upgrade can still interpret
// the user's immediately-following acknowledgement without replacing the real
// objective with a low-information control phrase. Remove with the legacy event
// compatibility window once the graph owns active-objective continuity.
const LEGACY_CONFIRM_CONTROLS: ReadonlySet<string> = new Set([
  'approve', 'approved', 'yes', 'yep', 'yeah', 'y', 'ok', 'okay',
  'go', 'go ahead', 'proceed', 'continue', 'resume',
]);

function normalizedLegacyControl(text: string): string {
  return text.trim().toLowerCase().replace(/[.!]+$/g, '').replace(/\s+/g, ' ');
}

interface LegacyAlignmentDecision {
  phase?: unknown;
  objective?: unknown;
  sourceUserSeq?: unknown;
}

function legacyAlignedObjectiveForAcknowledgement(
  sessionId: string,
  acknowledgement: string,
  sourceUserSeq: number | undefined,
): string | null {
  const normalizedAcknowledgement = normalizedLegacyControl(acknowledgement);
  if (!LEGACY_CONFIRM_CONTROLS.has(normalizedAcknowledgement)) return null;
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received', 'turn_preflight_decision'] });
    const users = rows
      .filter((row) => row.type === 'user_input_received')
      .filter((row) => (row.data as { synthetic?: boolean } | undefined)?.synthetic !== true)
      .sort((a, b) => a.seq - b.seq);
    const currentIndex = users.findIndex((row) => row.seq === sourceUserSeq);
    if (currentIndex <= 0) return null;
    const currentText = (users[currentIndex]?.data as { text?: unknown } | undefined)?.text;
    if (
      typeof currentText !== 'string'
      || normalizedLegacyControl(currentText) !== normalizedAcknowledgement
    ) return null;
    const previousUserSeq = users[currentIndex - 1]?.seq;
    if (!previousUserSeq) return null;
    const legacyAlignment = rows
      .filter((row) => row.type === 'turn_preflight_decision')
      .filter((row) => (row.data as LegacyAlignmentDecision).sourceUserSeq === previousUserSeq)
      .sort((a, b) => b.seq - a.seq)
      .map((row) => row.data as LegacyAlignmentDecision)
      .find((decision) => decision.phase === 'align');
    const objective = typeof legacyAlignment?.objective === 'string'
      ? legacyAlignment.objective.trim()
      : '';
    return objective || null;
  } catch {
    return null;
  }
}

/** One-release compatibility reader for an acknowledgement accepted while an
 * older persisted alignment is still pending. It is intentionally read-only:
 * new turns never create or consume turn_preflight_decision rows. */
export function effectiveTurnObjective(
  sessionId: string | undefined,
  fallback: string,
  sourceUserSeq?: number,
): string {
  if (!sessionId) return fallback;
  return legacyAlignedObjectiveForAcknowledgement(sessionId, fallback, sourceUserSeq) ?? fallback;
}
