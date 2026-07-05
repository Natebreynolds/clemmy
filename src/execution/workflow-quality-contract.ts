/**
 * Ever-learning workflow QUALITY CONTRACT.
 *
 * The trust gap this closes: a workflow can run safely and complete, yet the
 * OUTPUT is off-goal or not good enough to use — and the same mistake recurs
 * run after run because nothing durably captures "this was wrong, and why".
 *
 * The workflow's `goal.successCriteria` are ALREADY judged against the final
 * deliverable at run completion (judgeWorkflowTarget → needsAttention on a
 * miss). So the missing piece is purely a LEARNING intake: turn a human's
 * plain-language "this run was wrong because X" into concrete, checkable
 * criteria and append them to that same list. Every future run is then held to
 * the sharper bar automatically — no runner or judge changes needed.
 *
 * This module is deterministic and pure (no LLM), so the learning loop is
 * testable end-to-end. The distillation flips the common "it didn't do X"
 * complaint shapes into affirmative "Must do X" requirements; anything it can't
 * confidently flip is kept as an explicit requirement so the judge still checks
 * it. (An LLM refinement pass can sharpen phrasing later without changing the
 * contract shape.)
 */
import type { WorkflowDefinition } from '../memory/workflow-store.js';

/** Max criteria we keep on a workflow — a quality bar, not a spec dump. */
const MAX_CRITERIA = 12;
const MAX_CRITERION_LEN = 200;
const MIN_CRITERION_LEN = 4;

/** Read the current quality bar for a workflow (its judged success criteria). */
export function workflowQualityCriteria(def: WorkflowDefinition): string[] {
  return (def.goal?.successCriteria ?? []).map((c) => c.trim()).filter(Boolean);
}

/** Normalize a criterion for dedupe: lowercased, punctuation/space-collapsed. */
function criterionKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Dedupe by normalized key, preserving first-seen order and original casing. */
export function dedupeQualityCriteria(criteria: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of criteria) {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < MIN_CRITERION_LEN) continue;
    const key = criterionKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text.length > MAX_CRITERION_LEN ? `${text.slice(0, MAX_CRITERION_LEN - 1)}…` : text);
  }
  return out;
}

/** Split freeform feedback into individual complaint clauses. */
function splitFeedbackClauses(feedback: string): string[] {
  return feedback
    .split(/[\n;]+|(?:\.\s)|(?:,?\s+and\s+)|(?:,?\s+also\s+)|(?:,?\s+plus\s+)/i)
    .map((c) => c.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, ''))
    .filter((c) => c.length >= MIN_CRITERION_LEN);
}

// Common complaint → affirmative-requirement flips. Ordered: first match wins.
const NEGATION_FLIPS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => string }> = [
  { re: /^(?:it|the\s+\w+)?\s*(?:didn'?t|did\s+not|does(?:n'?t|\s+not)|failed\s+to|never|forgot\s+to|neglected\s+to)\s+(.+)$/i, build: (m) => `Must ${m[1].trim()}` },
  { re: /^(?:there\s+(?:was|were)\s+)?(?:no|missing|lacked|lacks|without)\s+(.+)$/i, build: (m) => `Must include ${m[1].trim()}` },
  { re: /^(?:it\s+)?(?:had|has|contained|contains|included|left\s+in)\s+(.+)$/i, build: (m) => `Must not contain ${m[1].trim()}` },
  { re: /^(?:it\s+|the\s+\w+\s+)?(?:was|were|is|are|felt|seemed|looked)\s+(too\s+\w+|generic|vague|inaccurate|wrong|incomplete|off-?goal|placeholder\w*|low\s+quality|sloppy|boilerplate)\b.*$/i, build: (m) => `Must not be ${m[1].trim()}` },
  // "X should/must Y" → "X must Y" (preserve the subject); bare "should Y" → "Must Y".
  { re: /^(?:(.+?)\s+)?(?:should|must|needs?\s+to|has\s+to|ought\s+to)\s+(?:have\s+)?(.+)$/i, build: (m) => {
    const subject = (m[1] ?? '').trim();
    const rest = m[2].trim();
    return subject ? `${subject} must ${rest}` : `Must ${rest}`;
  } },
];

/** Turn one complaint clause into an affirmative, checkable criterion. */
function criterionFromClause(clause: string): string {
  const cleaned = clause.replace(/^(?:the\s+)?(?:output|result|deliverable|report|email|emails|run|response|it|this|that)\s+/i, '').trim() || clause;
  for (const flip of NEGATION_FLIPS) {
    const m = cleaned.match(flip.re);
    if (m) {
      const built = flip.build(m);
      return built.charAt(0).toUpperCase() + built.slice(1);
    }
  }
  // Couldn't confidently flip — keep it as an explicit requirement the judge
  // still checks, rather than dropping the signal.
  const framed = `Must address: ${cleaned}`;
  return framed.charAt(0).toUpperCase() + framed.slice(1);
}

/**
 * Distill plain-language run feedback into concrete, checkable success criteria.
 * Deterministic: same feedback → same criteria (so the learning loop is testable).
 */
export function distillQualityCriteria(feedback: string): string[] {
  const clauses = splitFeedbackClauses(feedback ?? '');
  return dedupeQualityCriteria(clauses.map(criterionFromClause));
}

/** Merge newly learned criteria into an existing bar (dedupe, cap). */
export function mergeQualityCriteria(existing: string[], learned: string[]): string[] {
  return dedupeQualityCriteria([...existing, ...learned]).slice(0, MAX_CRITERIA);
}

export interface LearnQualityResult {
  def: WorkflowDefinition;
  added: string[];
  criteria: string[];
  changed: boolean;
}

/**
 * Apply run feedback to a workflow: distill it into criteria and append them to
 * `goal.successCriteria` (synthesizing a `goal.objective` from the description
 * if the workflow had no goal yet). Returns the updated definition to write —
 * the caller persists it via writeWorkflowAndSyncTriggers. Pure; no I/O.
 */
export function applyLearnedQualityCriteria(def: WorkflowDefinition, feedback: string): LearnQualityResult {
  const existing = workflowQualityCriteria(def);
  const learned = distillQualityCriteria(feedback);
  const merged = mergeQualityCriteria(existing, learned);
  const added = merged.filter((c) => !existing.some((e) => criterionKey(e) === criterionKey(c)));
  if (added.length === 0) {
    return { def, added: [], criteria: existing, changed: false };
  }
  const objective = def.goal?.objective?.trim() || def.description?.trim() || `Deliver "${def.name}" to a usable quality bar`;
  return {
    def: {
      ...def,
      goal: {
        ...(def.goal ?? {}),
        objective,
        successCriteria: merged,
      },
    },
    added,
    criteria: merged,
    changed: true,
  };
}

/** Render the current quality bar for a chat / authoring surface. */
export function renderQualityContract(def: WorkflowDefinition): string {
  const criteria = workflowQualityCriteria(def);
  if (criteria.length === 0) {
    return `"${def.name}" has no learned quality criteria yet — its output is judged against the objective only. Tell me what a good result looks like (or what a bad run got wrong) and I'll hold every future run to it.`;
  }
  return [
    `Quality bar for "${def.name}" — every run is judged against these ${criteria.length} criteria:`,
    ...criteria.map((c, i) => `  ${i + 1}. ${c}`),
  ].join('\n');
}
