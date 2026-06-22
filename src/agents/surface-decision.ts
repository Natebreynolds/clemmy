/**
 * surface-decision — the "when to stay silent" primitive (Lane E Phase 1,
 * proactive/ambient). The make-or-break control for a proactive agent: too eager
 * = a notification firehose; too quiet = it misses the real ask and looks broken.
 *
 * A PURE, deterministic multi-axis scorer (NO LLM — the axes are the verifiable
 * signal) mapping a normalized SurfaceSignal → act | ask | watch | ignore |
 * escalate. The monitors (inbox/calendar/…) build a SurfaceSignal from their
 * existing reason heuristics and feed it here instead of `score = reasons.length`
 * — so every surface decision uses ONE tuned, testable policy. This module is
 * pure + side-effect-free; wiring the monitors to it (and gating notifications on
 * ask/escalate only) is a later phase, validated by the firehose/true-positive
 * eval set.
 */

export interface SurfaceSignal {
  /** 0-1 time pressure — how soon it matters. */
  urgency: number;
  /** 0-1 consequence if it's missed. */
  impact: number;
  /** 0-1 new vs. already-seen/already-surfaced. */
  novelty: number;
  /** 0-1 irreversibility / cost of acting WRONG (a send, a delete). */
  risk: number;
  /** 0-1 how sure we are about what the right action is. */
  confidence: number;
  /** 0-1 concrete & actionable vs. vague. */
  specificity: number;
  /** 0-1 contradicts/clashes with something (a double-book, a conflicting fact). */
  conflict: number;
}

export type SurfaceDecision = 'act' | 'ask' | 'watch' | 'ignore' | 'escalate';

export interface SurfaceVerdict {
  decision: SurfaceDecision;
  /** The composite attention score [0,1] the decision was made from. */
  salience: number;
  reason: string;
}

// Tunable thresholds (code-level defaults — NOT per-user config, per the
// global-not-user-specific directive). Documented so the firehose/true-positive
// eval can move them with evidence.
const IGNORE_BELOW = 0.25;   // below this attention score → stay silent
const ACT_ASK_AT = 0.40;     // at/above this → worth surfacing (act or ask)
const HIGH = 0.7;            // "high" on a single axis
const LOW = 0.3;             // "low" on a single axis

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Composite "does this warrant attention" score. Urgency + impact dominate;
 *  specificity + conflict + novelty refine. (Risk/confidence gate the KIND of
 *  response, not whether it's salient, so they're not in this sum.) */
export function salienceOf(s: SurfaceSignal): number {
  return (
    0.30 * clamp01(s.urgency) +
    0.30 * clamp01(s.impact) +
    0.15 * clamp01(s.specificity) +
    0.15 * clamp01(s.conflict) +
    0.10 * clamp01(s.novelty)
  );
}

/**
 * Decide whether/how to surface a signal. Precedence: ignore the low-salience
 * (anti-firehose) → escalate a high-risk + time-critical event → act when we're
 * confident AND it's safe → ask when it's worth surfacing but uncertain or risky
 * → watch the moderate middle.
 */
export function decideSurface(signal: SurfaceSignal): SurfaceVerdict {
  const s: SurfaceSignal = {
    urgency: clamp01(signal.urgency), impact: clamp01(signal.impact), novelty: clamp01(signal.novelty),
    risk: clamp01(signal.risk), confidence: clamp01(signal.confidence),
    specificity: clamp01(signal.specificity), conflict: clamp01(signal.conflict),
  };
  const salience = salienceOf(s);

  if (salience < IGNORE_BELOW) {
    return { decision: 'ignore', salience, reason: 'below the attention floor — stay silent (anti-firehose)' };
  }
  if (s.risk >= HIGH && s.urgency >= HIGH) {
    return { decision: 'escalate', salience, reason: 'high-risk and time-critical — surface to the user now' };
  }
  if (s.confidence >= HIGH && s.risk <= LOW && salience >= ACT_ASK_AT) {
    return { decision: 'act', salience, reason: 'confident and low-risk — safe to act and report back' };
  }
  if (salience >= ACT_ASK_AT) {
    return { decision: 'ask', salience, reason: 'worth surfacing but uncertain or irreversible — ask the user' };
  }
  return { decision: 'watch', salience, reason: 'moderate signal — watch, do not surface yet' };
}

/** Whether a verdict should fire a notification at all (the anti-firehose gate):
 *  only ask/escalate interrupt the user; act is done silently + reported, watch/
 *  ignore stay quiet. */
export function shouldSurface(decision: SurfaceDecision): boolean {
  return decision === 'ask' || decision === 'escalate';
}
