/**
 * Detect the failure shape where the model self-reports that the current run has
 * no usable tool surface. Clementine's harness owns tool availability; a model
 * turn that says "this environment has no tool access" is not a deliverable.
 *
 * Keep this pure and dependency-free so active-loop stall detection and
 * unattended report-back verification share the same vocabulary.
 */

const CURRENT_RUN_ANCHOR_PATTERN =
  /\b(?:this|current)\s+(?:run|turn|environment|session|execution\s+context)\b|\bhere\b|\bto me\b|\bi\s+(?:do\s+not|don't|cannot|can't|am\s+not|have\s+no|lack)\b/i;

const TOOL_SURFACE_UNAVAILABLE_PATTERN =
  /\b(?:no\s+(?:live\s+)?tool\s+access|without\s+(?:live\s+)?tool\s+access|tool[- ]?enabled\s+run|tool\s+runtime|tool\s+surface[\s\S]{0,80}(?:not\s+available|unavailable|missing|not\s+exposed)|tools?[\s\S]{0,80}(?:not\s+available|unavailable|not\s+exposed|aren't\s+exposed|are\s+not\s+exposed)|file\s+i\/o[\s\S]{0,80}(?:not\s+available|unavailable|not\s+exposed|isn't\s+exposed|are\s+not\s+exposed)|shell\s+execution[\s\S]{0,80}(?:not\s+available|unavailable|not\s+exposed|isn't\s+exposed)|text-only[\s\S]{0,80}subprocess)\b/i;

const TOOL_CAUSAL_INABILITY_PATTERN =
  /\b(?:cannot|can't|unable\s+to|not\s+able\s+to|couldn't)\s+(?:fetch|create|read|write|search|execute|run|verify|pull|access|call)\b[\s\S]{0,140}\b(?:without|because\s+(?:there\s+)?(?:is|are)?\s*(?:no|not))\b[\s\S]{0,80}\btools?\b/i;

export function looksLikeToolUnavailableSelfReport(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (!CURRENT_RUN_ANCHOR_PATTERN.test(t)) return false;
  return TOOL_SURFACE_UNAVAILABLE_PATTERN.test(t) || TOOL_CAUSAL_INABILITY_PATTERN.test(t);
}
