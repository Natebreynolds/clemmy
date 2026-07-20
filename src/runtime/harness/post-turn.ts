import { autoCreditRecallRuns } from '../../memory/recall-auto-credit.js';
import { safeDetectCorrection } from './correction-hook.js';
import { appendEvent } from './eventlog.js';

/**
 * The ONE post-turn hook spine every brain lane calls.
 *
 * loop.ts (Codex @openai/agents loop), claude-agent-brain.ts (Claude Agent SDK
 * brain), and plan-first.ts each used to hand-wire the same two hooks — negative
 * credit (correction detection) then positive credit (auto-credit) — with a
 * byte-identical recall_auto_credit event. Wiring a new behavior meant editing
 * every lane, and one lane silently missed a hook (the "two-lane trap"). Now the
 * pairing lives here: new post-turn behavior is added ONCE and every lane
 * inherits it. Both SDK runtimes are preserved untouched — they just call the
 * same seam.
 *
 * Ordering is load-bearing: correction runs BEFORE auto-credit because it reads
 * the PRIOR turn's credited facts (which this turn's auto-credit is about to
 * overwrite). Both are best-effort and must never throw or fail a turn.
 */
export interface PostTurnHookInput {
  sessionId: string;
  turn: number;
  /** The user's message this turn — the correction detector's input. */
  userInput: unknown;
  /** Recall runs whose candidates this turn's output may have used. */
  recallIds: Array<string | null | undefined>;
  /** The turn's produced text (reply / drafted plan) for auto-credit matching. */
  replyText: string;
  /** Tool-call argument texts (a memory applied through a tool call is use too). */
  toolArgTexts?: string[];
  /** The turn's objective, when the lane wants echo-suppression on it. */
  queryText?: string;
  /**
   * Set false to skip correction detection for this call. An approval-resume
   * carries no new user message, so there is nothing to correct — but it still
   * runs every OTHER post-turn hook through this one seam, so a future hook
   * added here can never silently miss the resume path (the two-lane trap in
   * miniature). Defaults to true.
   */
  detectCorrection?: boolean;
}

export function runPostTurnHooks(input: PostTurnHookInput): void {
  // Negative half of the credit loop — BEFORE auto-credit so the prior turn's
  // credited facts are the ones a correction reads. Opt-out only for turns with
  // no new user message (approval-resume).
  if (input.detectCorrection !== false) {
    safeDetectCorrection({ sessionId: input.sessionId, turn: input.turn, userInput: input.userInput });
  }

  // Positive half: match this turn's recall runs against what it produced and
  // credit demonstrable use; record the attribution event.
  try {
    const credited = autoCreditRecallRuns({
      recallIds: input.recallIds,
      replyText: input.replyText,
      toolArgTexts: input.toolArgTexts,
      queryText: input.queryText,
    });
    if (credited.length > 0) {
      appendEvent({
        sessionId: input.sessionId,
        turn: input.turn,
        role: 'system',
        type: 'recall_auto_credit',
        data: {
          runs: credited.map((o) => ({
            recallId: o.recallId,
            refs: o.credited.map((d) => ({ ref: `${d.ref.type}:${d.ref.id}`, evidence: d.evidence })),
          })),
        },
      });
    }
  } catch (err) {
    // Crediting is bookkeeping; it must never break the turn.
    console.warn('[harness] post-turn auto-credit failed', err instanceof Error ? err.message : err);
  }
}
