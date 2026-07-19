/**
 * Correction hook — the harness-side orchestration of the negative credit loop,
 * shared by ALL brain lanes (loop / claude-agent-brain / plan-first) so the
 * control can never be wired on one lane only (the recurring two-lane drift bug).
 *
 * It reads the durable, session-keyed `recall_auto_credit` event to find the
 * facts that fed the prior answer, and — when this turn's user message corrects
 * that answer — records a bounded, reversible `not_useful` signal against them.
 * Lives in the harness (not memory/) because it reads the eventlog; the memory
 * module (correction-detector.ts) stays pure and harness-free.
 *
 * MUST be invoked BEFORE this turn's own auto-credit append, so the latest
 * `recall_auto_credit` event is the PRIOR turn's, not this one's.
 */
import {
  correctionDetectEnabled,
  detectCorrectionCue,
  judgeCorrectionCrossFamily,
  parseSerializedRefs,
  recordCorrectionSignal,
} from '../../memory/correction-detector.js';
import { getFact } from '../../memory/facts.js';
import { appendEvent, listEvents } from './eventlog.js';

/** A prior credited answer older than this is not the turn a correction targets.
 *  Lane-agnostic staleness bound (the SDK brain lane writes turn:0, so turn
 *  numbers can't gate this). */
const CORRECTION_MAX_AGE_MS = 15 * 60 * 1_000;

function priorCreditedRefs(sessionId: string, nowMs: number): string[] {
  const [event] = listEvents(sessionId, { types: ['recall_auto_credit'], desc: true, limit: 1 });
  if (!event) return [];
  const ageMs = nowMs - Date.parse(event.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > CORRECTION_MAX_AGE_MS) return [];
  const runs = (event.data?.runs as Array<{ refs?: Array<{ ref?: unknown }> }> | undefined) ?? [];
  return Array.from(new Set(
    runs
      .flatMap((r) => (r.refs ?? []).map((x) => (typeof x.ref === 'string' ? x.ref : '')))
      .filter(Boolean),
  ));
}

function priorAnswerPreview(sessionId: string): string {
  try {
    const events = listEvents(sessionId, { types: ['run_completed'], desc: true, limit: 1 });
    const preview = events[0]?.data?.finalOutputPreview;
    return typeof preview === 'string' ? preview : '';
  } catch {
    return '';
  }
}

export type CorrectionOutcome =
  | { status: 'disabled' | 'no_cue' | 'no_target' | 'veto' | 'noop' | 'downstream_error' }
  | { status: 'recorded'; judged: boolean; refs: string[]; factIds: number[] };

const DOWNSTREAM_ACTION_CORRECTION_RE = /\b(?:sent|send|emailed|emailing|invited|invite|invitation|calendar event|meeting invite|recipients?|attendees?)\b/i;
const WRONG_TARGET_RE = /\b(?:wrong|incorrect|different|not the right|shouldn'?t|should not|didn'?t mean|did not mean)\b/i;

/** A complaint about a just-queued/sent payload is a derivation failure unless
 * the user explicitly corrects the source fact itself. Penalizing every recalled
 * fact in this case would demote the correct roster that the bad output failed
 * to preserve — exactly the opposite lesson. */
function isDownstreamActionCorrection(sessionId: string, userText: string): boolean {
  if (!DOWNSTREAM_ACTION_CORRECTION_RE.test(userText) || !WRONG_TARGET_RE.test(userText)) return false;
  try {
    return listEvents(sessionId, {
      types: ['external_write', 'approval_requested', 'autonomy_note'],
      desc: true,
      limit: 40,
    }).some((event) => event.type === 'external_write'
      || event.type === 'approval_requested'
      || event.data.kind === 'pending_action_queued');
  } catch {
    return false;
  }
}

/**
 * Best-effort correction detection. Never throws, never blocks a turn: the async
 * judge + record run detached. Callers pass `turn` only to label the audit event.
 */
export function safeDetectCorrection(input: {
  sessionId: string;
  turn: number;
  userInput: unknown;
  nowMs?: number;
}): void {
  void detectCorrection(input)
    .catch((err) => console.warn('[harness] correction detect failed', err instanceof Error ? err.message : err));
}

/** Awaitable core (the test surface). The eventlog read happens synchronously
 *  before the first await, so the ordering guarantee (read prior credit before
 *  this turn's auto-credit append) holds even though the caller doesn't await. */
export async function detectCorrection(input: {
  sessionId: string;
  turn: number;
  userInput: unknown;
  nowMs?: number;
}): Promise<CorrectionOutcome> {
  if (!correctionDetectEnabled()) return { status: 'disabled' };
  const userText = typeof input.userInput === 'string' ? input.userInput : '';
  const cue = detectCorrectionCue(userText);
  if (!cue.cued) return { status: 'no_cue' };
  const refs = priorCreditedRefs(input.sessionId, input.nowMs ?? Date.now());
  if (refs.length === 0) return { status: 'no_target' };
  return finish({ sessionId: input.sessionId, turn: input.turn, userText, cueSpan: cue.span, priorRefs: refs });
}

async function finish(input: {
  sessionId: string;
  turn: number;
  userText: string;
  cueSpan?: string;
  priorRefs: string[];
}): Promise<CorrectionOutcome> {
  const targetRefs = parseSerializedRefs(input.priorRefs);
  if (targetRefs.length === 0) return { status: 'noop' };
  const targetFacts = targetRefs
    .filter((r) => (r.type === 'fact' || r.type === 'policy') && /^\d+$/.test(r.id))
    .map((r) => ({ ref: r, fact: getFact(Number(r.id)) }))
    .filter((x): x is { ref: typeof x.ref; fact: NonNullable<ReturnType<typeof getFact>> } => Boolean(x.fact))
    .map((x) => ({ id: x.ref.id, content: x.fact.content }));

  if (isDownstreamActionCorrection(input.sessionId, input.userText)) {
    safeAudit(input.sessionId, input.turn, {
      applied: false,
      reason: 'downstream_derivation_failure',
      refs: input.priorRefs,
      cue: input.cueSpan ?? null,
    });
    return { status: 'downstream_error' };
  }

  // Judge upgrades confidence; it never gates the soft signal. veto -> stop;
  // approve -> high confidence (unlocks escalation); unavailable (no
  // different-family judge — the common case) -> proceed on the deterministic cue.
  const verdict = await judgeCorrectionCrossFamily({
    priorAnswer: priorAnswerPreview(input.sessionId),
    correction: input.userText,
    targetFacts,
  });
  if (verdict.verdict === 'veto') {
    safeAudit(input.sessionId, input.turn, { applied: false, reason: 'judge_veto', judge: verdict.reason ?? null, cue: input.cueSpan ?? null });
    return { status: 'veto' };
  }
  const judged = verdict.verdict === 'approve';
  const result = recordCorrectionSignal({
    objective: `correction: ${input.userText.slice(0, 200)}`,
    refs: targetRefs,
    detail: judged ? 'auto:correction-judged' : 'auto:correction',
  });
  if (!result.ok) return { status: 'noop' };
  safeAudit(input.sessionId, input.turn, {
    applied: true,
    judged,
    refs: result.recordedRefs,
    factIds: result.factIds,
    cue: input.cueSpan ?? null,
  });

  // Tier 3 — in-turn escalation. A judge-confirmed correction shouldn't wait for
  // the 4:35am batch: run the EXISTING self-heal pass now, bounded. It reuses the
  // whole gated + revertible pipeline (detect -> cross-family veto judge ->
  // applyMemoryFix), so a stale fact is superseded/retired immediately when a
  // newer contradicting fact exists, and merely deferred otherwise (Tier-2
  // demotion holds the line). Only fires on the judged path: with no different-
  // family judge, retirement stays deferred exactly like nightly self-heal.
  if (judged && result.factIds.length > 0) {
    void escalateInTurn().catch((err) =>
      console.warn('[harness] correction escalation failed', err instanceof Error ? err.message : err));
  }
  return { status: 'recorded', judged, refs: result.recordedRefs, factIds: result.factIds };
}

/** Run the gated self-heal pass immediately, bounded. Dynamic import keeps the
 *  heavy self-heal module off the hot path until a confirmed correction needs it. */
async function escalateInTurn(): Promise<void> {
  const { runMemorySelfHeal } = await import('../../memory/self-heal.js');
  await runMemorySelfHeal({ maxApply: 3 });
}

function safeAudit(sessionId: string, turn: number, data: Record<string, unknown>): void {
  try {
    appendEvent({ sessionId, turn, role: 'system', type: 'memory_correction', data });
  } catch { /* audit is observability; never fail the turn */ }
}
