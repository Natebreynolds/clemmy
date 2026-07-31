/**
 * Standing-rule capture steer (2026-07-31, live incident): the owner said
 * "we ONLY access Salesforce via the CLI" months of turns ago — it never became
 * a constraint, while its OPPOSITE ("fallback to Composio") got captured from
 * an episode. The next Salesforce ask routed wrong and the owner's reasonable
 * belief ("it should be in my memory") was false.
 *
 * The `remember(kind='constraint')` vehicle already exists (auto-pinned from
 * birth, checked by the dispatch gate). What was missing is CAPTURE: a
 * rule-shaped user statement should visibly become a constraint at the moment
 * it is said. This module is the conditional one-line steer — mirror of
 * prospectiveCaptureDirective: deterministic detection, model-owned decision
 * and phrasing, zero permanent rubric weight.
 */

const RULE_MARKER_RE = /\b(?:only|never|always|exclusively)\b/i;
const OPERATIONAL_RE = /\b(?:use|uses|used|using|access|send|post|create|deploy|publish|write|read|connect|query|via|through|route)\b/i;
const STANDING_PHRASE_RE = /\b(?:from now on|going forward|permanently|as a (?:standing )?rule|standing rule|hard rule)\b/i;

// Ordinary prose that contains rule words but is not a rule.
const QUESTION_START_RE = /^\s*(?:how|what|why|when|where|who|which|can|could|should|would|will|is|are|do|does|did)\b/i;
const CONDITIONAL_ONLY_RE = /\bonly\s+(?:if|when|once|after|\d)/i;
const NEVER_MIND_RE = /\bnever\s+mind\b/i;

/** Conditional steer: non-null only when the user's own words state a durable
 *  operating rule. Conservative — misses cost nothing (the user can always say
 *  "remember this"), while a false fire costs one wasted context line. */
export function standingRuleCaptureDirective(input: string): string | null {
  const text = (input ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 12) return null;
  if (QUESTION_START_RE.test(text) || NEVER_MIND_RE.test(text)) return null;

  const standingPhrase = STANDING_PHRASE_RE.test(text);
  const ruleShaped = RULE_MARKER_RE.test(text)
    && OPERATIONAL_RE.test(text)
    && !CONDITIONAL_ONLY_RE.test(text);
  if (!standingPhrase && !ruleShaped) return null;

  const excerpt = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  return (
    `Standing-rule signal: this message states a durable operating rule ("${excerpt}"). `
    + "If it is genuinely standing — not situational to this one task — persist it NOW with remember(kind='constraint', content=<the rule, stated precisely and generally>) "
    + 'so it auto-pins into every future turn and gates matching tool dispatch, then confirm in one natural line what you will always/never do. '
    + 'If the same store holds guidance that CONTRADICTS this rule, forget or supersede it in the same breath. If the statement is situational, ignore this signal.'
  );
}
