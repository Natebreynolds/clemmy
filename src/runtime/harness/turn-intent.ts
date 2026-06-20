/**
 * Turn intent — the single shared signal for "is this turn consequential?"
 *
 * The harness used to answer this question in two different, duplicated ways:
 * the fusion layer's STAKES_ACTION_RE keyword match (debate-model.ts) and the
 * context packet's complexity heuristic. This module is the ONE source of truth,
 * reused by both, so "should this turn get the heavy treatment (judging / full
 * preflight)" is decided consistently.
 *
 * It is ADVISORY ONLY. It shapes per-turn ASSEMBLY (what preflight work runs,
 * whether fusion engages) — it NEVER decides whether a tool may run or a write
 * is allowed. The safety invariant lives at the tool boundary (the gates in
 * brackets.ts), so a misclassified turn is safe by construction: the worst case
 * is a slightly lighter context packet, and every irreversible write is still
 * gated. Keep it that way — do not let turnIntent gate tools.
 *
 * - 'action'  : the turn names an irreversible/high-stakes action (send,
 *               publish, deploy, delete, migrate, charge, …) → full preflight,
 *               fusion may engage.
 * - 'qa'      : a conversational question with no consequential verb → light.
 *
 * Continuation turns (the canned self-continuation nudge) are classified by the
 * caller, which knows it's a continuation and treats it as full-assembly.
 */
export type TurnIntent = 'qa' | 'action';

// Irreversible/high-stakes action verbs in free-text user input. Deliberately
// NARROW (irreversible shapes only) so it aligns with the gates' irreversible
// focus and does NOT over-fire on reversible chatter. Superset of the fusion
// layer's old STAKES_ACTION_RE (no old match is dropped), lifted here as the
// shared truth. UPCOMING tense only (base/-s/-ing) — NOT past tense: "I sent
// the email" describes a COMPLETED action and should not read as action-intent.
const ACTION_VERB_RE = /\b(send|sends|sending|publish|publishes|publishing|deploy|deploys|deploying|launch|launches|launching|delete|deletes|deleting|migrate|migrates|migrating|wire|wires|wiring|charge|charges|charging|refund|refunds|refunding|production|irreversible)\b/i;

/** Classify a turn's text as a consequential 'action' or a light 'qa'.
 *  Pure + cheap. Empty/whitespace → 'qa'. */
export function classifyTurnIntent(text: string | undefined | null): TurnIntent {
  const s = typeof text === 'string' ? text : '';
  return ACTION_VERB_RE.test(s) ? 'action' : 'qa';
}
