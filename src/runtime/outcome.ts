/**
 * Unified report-back: the ONE Outcome contract + delivery mechanism every
 * async lane (background task, workflow run, cron, …) uses to report back to the
 * conversation that started it. North-star Move 4 (`docs/north-star-unification.md`).
 *
 * Before this, each lane had its own near-identical `enqueue*OutcomeTurn` —
 * same mechanism (append a synthetic turn to the origin SessionStore + stage it
 * into the HarnessSession snapshot the desktop/Discord orchestrator replays +
 * idempotency by id-prefix), differing only in label/guidance wording. That
 * duplication is collapsed here, so:
 *   • every surface (desktop, Discord, mobile) renders the SAME structure, and
 *   • adding a new lane (or a new status like needs_input) is one call, not a
 *     new copy of the plumbing.
 *
 * Delivery is best-effort and idempotent: a completed run must never fail on a
 * session write, and a retried/double completion must not post twice.
 */
import { SessionStore } from '../memory/session-store.js';
import { HarnessSession } from './harness/session.js';
import pino from 'pino';

const logger = pino({ name: 'clementine-next.outcome' });

// Kept lean to what lanes actually produce today (done/blocked/failed) plus
// needs_input — the north-star "ask for clarity" status, the one forward-looking
// member, intentionally retained. Grow the contract (artifacts, nextStep, …)
// when a real lane produces them, not before.
export type OutcomeStatus = 'done' | 'blocked' | 'failed' | 'needs_input';

/** The single shape every lane produces to report back. */
export interface Outcome {
  status: OutcomeStatus;
  /** One-line headline of what happened (optional — `detail` alone is fine). */
  summary?: string;
  /** The full result body / preview. Truncated on render. */
  detail?: string;
}

export interface DeliverContext {
  /** The conversation to report back into. No-op when absent (cron/autonomous
   *  spawns with no session to wake). */
  originSessionId?: string;
  /** Lane label used in the idempotency prefix + headline, e.g. 'background
   *  task', 'workflow run'. */
  sourceLabel: string;
  /** The run/task id. */
  sourceId: string;
  /** Human title (workflow name, task title). */
  title?: string;
  /** How the agent fetches the full result, e.g. `background_task_status('id')`. */
  statusHint?: string;
  /** Per-status head-word overrides, for back-compat with a lane's existing
   *  prefix wording (e.g. workflow renders `blocked` as "needs attention"). */
  headWord?: Partial<Record<OutcomeStatus, string>>;
  /** Detail truncation cap. */
  maxDetailChars?: number;
  /**
   * Report-back v2 (2026-06-11): when true and the origin is an IDLE chat
   * session, fire ONE proactive conversation turn so Clementine SPEAKS the
   * outcome into the conversation immediately ("test passed — fire it now or
   * wait for the schedule?") instead of waiting for the user's next message.
   * Falls back to the passive synthetic-turn staging whenever the session is
   * busy, non-chat, or anything errors. Best-effort by construction.
   */
  proactiveTurn?: boolean;
}

/** Pure gate for the proactive report-back turn: only an idle CHAT session
 *  qualifies — a session mid-turn (recent event) must not get a colliding
 *  turn, and workflow/agent sessions have no human watching them. */
export function shouldProactivelyReport(
  sessionKind: string | null,
  lastEventAgeMs: number | null,
  idleThresholdMs = 60_000,
): boolean {
  if (sessionKind !== 'chat') return false;
  if (lastEventAgeMs !== null && lastEventAgeMs < idleThresholdMs) return false;
  return true;
}

const DEFAULT_HEAD_WORDS: Record<OutcomeStatus, string> = {
  done: 'completed',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  needs_input: 'NEEDS INPUT',
};

const DEFAULT_MAX_DETAIL = 4000;

/** The idempotency / UI-detect prefix every outcome turn starts with. */
export function outcomePrefix(ctx: DeliverContext): string {
  return `[${ctx.sourceLabel} ${ctx.sourceId} `;
}

function guidanceFor(status: OutcomeStatus, statusHint?: string): string {
  const ref = statusHint ? ` Details via ${statusHint}.` : '';
  switch (status) {
    case 'done':
      return `This ran in the background and just finished — continue from here.${statusHint ? ` Full result via ${statusHint}.` : ''}`;
    case 'failed':
      return `This FAILED — it did NOT complete. Decide whether to retry with an adjusted approach or tell the user; do not assume it succeeded.${ref}`;
    case 'blocked':
      return `This is BLOCKED — it could not finish without a prerequisite. Surface the blocker to the user or resolve it, then re-run.${ref}`;
    case 'needs_input':
      return `This NEEDS YOUR INPUT to continue — ask the user the question above, then resume; do not guess.${ref}`;
  }
}

/** Render the canonical report-back text. The head + prefix are stable (UI and
 *  idempotency depend on them); the body is the unified card. */
export function renderOutcomeText(outcome: Outcome, ctx: DeliverContext): string {
  const word = ctx.headWord?.[outcome.status] ?? DEFAULT_HEAD_WORDS[outcome.status];
  const head = `${outcomePrefix(ctx)}${word}]${ctx.title ? ` ${ctx.title}` : ''}`;
  const cap = ctx.maxDetailChars ?? DEFAULT_MAX_DETAIL;

  const parts: string[] = [];
  if (outcome.summary && outcome.summary.trim()) parts.push(outcome.summary.trim());
  if (outcome.detail && outcome.detail.trim() && outcome.detail.trim() !== outcome.summary?.trim()) {
    const d = outcome.detail.trim();
    parts.push(d.length > cap ? `${d.slice(0, cap)}\n…[truncated]` : d);
  }
  parts.push(`(${guidanceFor(outcome.status, ctx.statusHint)})`);

  return `${head}\n\n${parts.join('\n\n')}`;
}

/**
 * Deliver an Outcome back to the conversation that started the work. Appends a
 * synthetic turn to the origin SessionStore (PWA/mobile read this) AND stages it
 * into the HarnessSession snapshot (desktop/Discord orchestrator replays this) —
 * so all surfaces see the SAME report-back. Idempotent by id-prefix across
 * retries / daemon restarts. Best-effort: never throws, never blocks the run.
 *
 * Returns true if a turn was written, false if it was a no-op (no origin
 * session) or a duplicate.
 */
export function deliverOutcome(outcome: Outcome, ctx: DeliverContext): boolean {
  try {
    const sessionId = ctx.originSessionId;
    if (!sessionId) return false;
    const idPrefix = outcomePrefix(ctx);
    const store = new SessionStore();
    const existing = store.get(sessionId);
    if (existing.turns.some((t) => typeof t.text === 'string' && t.text.startsWith(idPrefix))) {
      return false; // already reported — idempotent across retries / restarts
    }
    const text = renderOutcomeText(outcome, ctx);
    store.appendTurn(sessionId, { role: 'user', text, createdAt: new Date().toISOString() });
    // Stage into the harness conversation snapshot so the desktop/Discord
    // orchestrator (which replays the snapshot, not this SessionStore) sees the
    // outcome on its next turn. Best-effort + idempotent.
    try {
      const hs = HarnessSession.load(sessionId);
      if (hs) hs.injectSyntheticUserTurn(idPrefix, text);
    } catch { /* a harness-store write must never affect run state */ }
    logger.info({ sourceId: ctx.sourceId, sessionId, status: outcome.status }, 'Outcome delivered to origin session');
    if (ctx.proactiveTurn) {
      // Fire-and-forget: a proactive relay failure must never affect the run
      // or the passive staging above (which remains the guaranteed baseline).
      void (async () => {
        try {
          const hs = HarnessSession.load(sessionId);
          if (!hs) return;
          const { listEvents } = await import('./harness/eventlog.js');
          const last = listEvents(sessionId, { limit: 1, desc: true })[0];
          const ageMs = last ? Date.now() - Date.parse(last.createdAt) : null;
          if (!shouldProactivelyReport(hs.sessionRow.kind, ageMs)) return;
          const [{ runConversation }, { buildOrchestratorAgent }] = await Promise.all([
            import('./harness/loop.js'),
            import('../agents/orchestrator.js'),
          ]);
          const directive =
            `A ${ctx.sourceLabel} you started from this conversation just finished (see the latest [${ctx.sourceLabel} ${ctx.sourceId}] note in context). `
            + 'Relay the outcome to the user NOW in one short message: lead with pass/fail and the key evidence. '
            + 'If it passed and the workflow is enabled, end by asking: fire it off now, or wait for the next scheduled run? '
            + 'If it failed, say exactly what you will fix. Do not re-run anything in this turn.';
          const agent = await buildOrchestratorAgent({ userInput: directive, sessionId });
          await runConversation({ agent, sessionId, input: directive, judgeCompletion: false });
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId },
            'proactive report-back turn failed (passive staging + notification remain)',
          );
        }
      })();
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId },
      'deliverOutcome failed (best-effort; run + notification unaffected)',
    );
    return false;
  }
}
