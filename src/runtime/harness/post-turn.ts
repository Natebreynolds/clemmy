import { autoCreditRecallRuns } from '../../memory/recall-auto-credit.js';
import { listSessionRecallRunIds } from '../../memory/recall-usage.js';
import { captureProvenSkill } from '../../memory/skill-choice-capture.js';
import { gatherSessionSkills } from './skill-execution.js';
import { safeDetectCorrection } from './correction-hook.js';
import { appendEvent } from './eventlog.js';
import { maybeAutoFocusSession } from './auto-focus.js';

/**
 * The ONE post-turn hook spine every brain lane calls.
 *
 * loop.ts (Codex @openai/agents loop), claude-agent-brain.ts (Claude Agent SDK
 * brain), and plan-first.ts each used to hand-wire the same two hooks — negative
 * credit (correction detection) then positive credit (auto-credit) — with a
 * byte-identical recall_auto_credit event. Wiring a new behavior meant editing
 * every lane, and one lane silently missed a hook (the "two-lane trap"). Now the
 * pairing and continuity hooks live here: new post-turn behavior is added ONCE and every lane
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
  /**
   * When the turn started (ISO). Enables the cross-process recall-run sweep:
   * runs recorded for this session since this instant are merged into
   * `recallIds`, so explicit tool recalls executed in the separate MCP process
   * (Claude Agent SDK lane) earn credit even though their ids never reach the
   * lane's in-memory context. Omitted → only lane-passed ids are matched.
   */
  turnStartedAt?: string;
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
    // Cross-process sweep: the lane's list can only carry ids that survived in
    // ITS process memory. Memory tools in the Claude Agent SDK lane run in a
    // separate MCP process, so their runs are recoverable only via the shared
    // DB's session stamp. Merged (not replacing) — autoCreditRecallRuns dedupes.
    let sweptIds: string[] = [];
    if (input.turnStartedAt) {
      try {
        sweptIds = listSessionRecallRunIds(input.sessionId, input.turnStartedAt);
      } catch { /* sweep is recovery, never required */ }
    }
    const credited = autoCreditRecallRuns({
      recallIds: [...input.recallIds, ...sweptIds],
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

  // Proven-skill capture: a standard that governed a WORKING run becomes
  // memory, so the next run of this class binds it instead of re-deriving it
  // from lexical retrieval (which silently lost the owner's own outbound
  // standard, live 2026-07-31). Lives in the shared spine so both brains learn
  // identically. Best-effort — learning must never fail a turn.
  try {
    const loaded = gatherSessionSkills(input.sessionId).map((s) => s.name);
    if (loaded.length > 0) {
      captureProvenSkill({
        request: typeof input.userInput === 'string' ? input.userInput : (input.queryText ?? ''),
        loadedSkillNames: loaded,
        // Real work reached a clean end: the turn produced output AND applied
        // the skill through at least one tool call.
        workingRun: Boolean(input.replyText?.trim()) && (input.toolArgTexts?.length ?? 0) > 0,
      });
    }
  } catch (err) {
    console.warn('[harness] post-turn skill capture failed', err instanceof Error ? err.message : err);
  }

  // Focus is a provider-neutral continuity aid. Keeping this in the shared
  // spine prevents one brain from auto-pinning a sustained collaboration while
  // another silently forgets it. maybeAutoFocusSession is conservative
  // (chat-only, three substantive turns or strong tool/resource evidence) and
  // never invents a workstate/plan.
  try {
    maybeAutoFocusSession({
      sessionId: input.sessionId,
      summaryHint: input.replyText,
    });
  } catch (err) {
    console.warn('[harness] post-turn auto-focus failed', err instanceof Error ? err.message : err);
  }
}
