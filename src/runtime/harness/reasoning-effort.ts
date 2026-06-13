/**
 * Dynamic reasoning effort (per-turn). gpt-5.x reasoning models "think" before
 * emitting any token, and that think-time is the dominant latency on simple
 * turns (a calendar lookup paid ~3s of deliberation it didn't need). Instead of
 * a single fixed effort, pick it per turn from the input: trivial lookups go
 * FAST (low), genuinely complex/multi-step work keeps FULL depth (high), and the
 * ambiguous middle stays balanced (medium).
 *
 * Conservative by design — the cost of a misclassification is bounded: a `low`
 * on a medium task loses a little deliberation; a `medium` on a hard task is
 * roughly today's behavior. Only CLEARLY-trivial turns drop to `low`, and the
 * default for anything uncertain (incl. continuations like "go ahead", which
 * can kick off real work) is `medium`.
 *
 * Kill-switch: CLEMMY_DYNAMIC_REASONING=off → return null (no reasoning field
 * is sent, i.e. the model's own default — byte-identical to before this).
 */
import { getRuntimeEnv } from '../../config.js';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export function dynamicReasoningEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DYNAMIC_REASONING', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** A bare ack/continuation — but a continuation can trigger real work, so these
 *  resolve to `medium`, never `low`. */
const CONTINUATION = /^(yes|yep|yeah|ya|ok|okay|kk|k|go ahead|do it|go for it|continue|proceed|keep going|sounds good|looks good|perfect|great|sure|please do|👍|👍🏻|👍🏼)\b[\s.!]*$/i;

/** Multi-step / heavy-reasoning signals → full depth. */
const COMPLEX = /\b(research|analy[sz]e|analysis|audit|build|design|draft|compose|write\s*up|outline|plan\b|planning|strateg(y|ize)|roadmap|compare|evaluate|assess|migrate|refactor|debug|diagnose|investigate|troubleshoot|break\s*down|step[\s-]?by[\s-]?step|all\s+(my|the|of)|every\b|each\b|batch|fan\s*out|workflow|pipeline|enrich|prospect|outreach|campaign|proposal|brief)\b/i;

/** Short read-only lookups / questions → fast. */
const LOOKUP = /^(what|what's|whats|when|where|who|which|why|how\s+many|how\s+much|do\s+i|does|did|is\s+there|are\s+there|show\s+me|show|list|find|check|get|count|tell\s+me|any\b|remind\s+me)\b/i;

export interface EffortSignals {
  /** True when the session has an active goal/plan — bias toward depth. */
  hasActiveGoal?: boolean;
}

/**
 * Pick the reasoning effort for a turn from its input. Pure + cheap (no LLM).
 * Returns null when the feature is disabled (caller sends no reasoning field).
 */
export function selectReasoningEffort(
  input: string,
  signals: EffortSignals = {},
): { effort: ReasoningEffort; reason: string } {
  const text = (input ?? '').trim();
  const words = text ? text.split(/\s+/).length : 0;

  if (signals.hasActiveGoal) return { effort: 'high', reason: 'active-goal' };
  if (COMPLEX.test(text)) return { effort: 'high', reason: 'complex-keyword' };
  if (words > 40) return { effort: 'high', reason: 'long-input' };
  if (/\band\b/i.test(text) && words > 22) return { effort: 'high', reason: 'multi-clause' };

  if (!CONTINUATION.test(text) && words <= 12 && (LOOKUP.test(text) || text.endsWith('?'))) {
    return { effort: 'low', reason: 'short-lookup' };
  }

  return { effort: 'medium', reason: 'default' };
}
