import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { stepLooksLikeIrreversibleSend } from './workflow-enforce.js';
import { COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';

/**
 * Super-plan authoring gap test.
 *
 * The owner's ask (2026-06-03): "if she is going to author a workflow she can't
 * author something set up for failure. Because she saves a workflow she should
 * run a test to find the gaps and ask the user for clarity when setting it up."
 *
 * `checkWorkflowForWrite` already BLOCKS the workflow-killers (dangling deps,
 * malformed tokens, ungated sends, un-runnable scheduled inputs). This is the
 * softer half: a deterministic pass over a freshly-saved workflow that surfaces
 * the gaps which won't fail validation but WILL produce a wrong/empty result at
 * 2am — and turns each into a plain clarifying QUESTION for Clem to ask the user
 * before the workflow is relied on. No LLM, no API, no side effects: it reads
 * the definition and reasons about it, so it's cheap enough to run on every save.
 *
 * Conservative by design (the owner's "don't make simple workflows hard"): each
 * heuristic only fires on a clear signal, and the whole report is capped so a
 * thin, well-formed workflow saves with zero questions.
 */

export interface WorkflowGap {
  /** Always 'clarify' here — blockers live in checkWorkflowForWrite. */
  severity: 'clarify';
  /** The step the gap concerns, when applicable. */
  stepId?: string;
  /** The plain-language question Clem should put to the user. */
  question: string;
  /** Why it matters — the failure it heads off. */
  why: string;
}

/** Cap so a complex workflow doesn't bury the author in questions. */
const MAX_GAPS = 5;

const DELIVERABLE_PRODUCER_RE =
  /\b(?:create|creates|build|builds|generate|generates|writ\w*|draft\w*|compile|compiles|produce|produces|export\w*|save\w*|assemble|assembles|populate|populates|fill\w*)\b[\s\S]{0,40}\b(?:sheets?|spreadsheets?|docs?|documents?|reports?|briefs?|csv|pdfs?|decks?|presentations?|slides?|files?|drafts?)\b/i;
const DELIVERABLE_PRODUCER_REV_RE =
  /\b(?:sheets?|spreadsheets?|docs?|documents?|reports?|briefs?|csv|pdfs?|decks?|presentations?|slides?|files?|drafts?)\b[\s\S]{0,40}\b(?:create|creates|build|builds|generate|generates|writ\w*|draft\w*|compile|compiles|produce|produces|export\w*|save\w*|assemble|assembles|populate|populates|fill\w*)\b/i;

const CADENCE_RE =
  /\b(?:daily|nightly|hourly|weekly|monthly|mornings?|evenings?|every\s+(?:day|morning|evening|night|week|hour|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(?:day|morning|week|month))\b/i;

const FOREACH_HINT_RE =
  /\b(?:for each|each of|one per|per\s+(?:prospect|lead|item|row|client|account|company|firm|record|contact)|every\s+[a-z]+s\b|all\s+(?:the\s+)?[a-z]+s\b)\b/i;

function looksLikeDeliverableProducer(prompt: string): boolean {
  const p = prompt ?? '';
  return DELIVERABLE_PRODUCER_RE.test(p) || DELIVERABLE_PRODUCER_REV_RE.test(p);
}

function hasOutputContract(step: WorkflowDefinition['steps'][number]): boolean {
  const o = step.output as { type?: unknown; required_keys?: unknown; verify?: unknown } | undefined;
  return Boolean(o && (o.type || o.required_keys || o.verify));
}

/** Declared input names (lowercased) for membership checks. */
function declaredInputNames(def: WorkflowDefinition): Set<string> {
  return new Set(Object.keys(def.inputs ?? {}).map((k) => k.toLowerCase()));
}

/**
 * Run the gap test over a workflow definition. Returns clarifying questions
 * (possibly empty). Deterministic and side-effect free.
 */
export function analyzeWorkflowGaps(def: WorkflowDefinition): WorkflowGap[] {
  const gaps: WorkflowGap[] = [];
  const declared = declaredInputNames(def);
  const steps = def.steps ?? [];
  // A step is "terminal" if nothing depends on it — these tend to be the ones
  // that yield the final deliverable, so an undeclared output there is worse.
  const dependedOn = new Set<string>();
  for (const s of steps) for (const d of s.dependsOn ?? []) dependedOn.add(d);

  // 1 + 7: deliverable producers that declare no output contract. Worse on a
  // terminal step (the final hand-off), but worth a question on any of them.
  for (const step of steps) {
    if (step.usesSkill) continue; // a skill owns its own output shape
    if (!looksLikeDeliverableProducer(step.prompt ?? '')) continue;
    if (hasOutputContract(step)) continue;
    const terminal = !dependedOn.has(step.id);
    gaps.push({
      severity: 'clarify',
      stepId: step.id,
      question: terminal
        ? `Step "${step.id}" produces the final deliverable but doesn't declare what it must return — should it create a NEW destination each run, or write to a specific existing one (share the URL/ID)? And what concrete handle (a sheet URL, a file path) proves it actually produced something?`
        : `Step "${step.id}" produces a deliverable but doesn't declare where it goes — create a NEW one each run, or a specific existing destination (URL/ID)?`,
      why: terminal
        ? 'Without a declared output the run can report "done" with nothing to show, and the result is unverifiable.'
        : 'Downstream steps and your report-back need a real handle, not a hollow "done".',
    });
  }

  // 2: irreversible sends — who is the audience, and is it a hard-coded list?
  for (const step of steps) {
    if (!stepLooksLikeIrreversibleSend(step.prompt ?? '')) continue;
    gaps.push({
      severity: 'clarify',
      stepId: step.id,
      question: `Step "${step.id}" sends to the outside world — who exactly should it go to, and should that recipient/list be a workflow input rather than hard-coded so it can't go to the wrong people?`,
      why: 'A send with an unclear or baked-in audience is the highest-cost thing to get wrong.',
    });
  }

  // 3: a step references an input that was never declared (and isn't a common
  // injectable key). Satisfiable by a manual caller, but the author should
  // declare it so the run knows it's required and the UI can prompt for it.
  const referenced = new Set<string>();
  for (const step of steps) {
    for (const m of (step.prompt ?? '').matchAll(/\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g)) {
      referenced.add(m[1]);
    }
  }
  for (const key of referenced) {
    if (declared.has(key.toLowerCase())) continue;
    if (COMMON_WORKFLOW_INPUT_KEYS.has(key)) continue;
    gaps.push({
      severity: 'clarify',
      question: `A step references input "${key}" but it isn't declared — what supplies it? Declare it under inputs (with a description, and a default if there's a sensible one), or confirm an earlier step produces it.`,
      why: 'An undeclared input has nothing to fill it on a scheduled run and no prompt for it in the UI.',
    });
  }

  // 5: the prose implies a cadence but no schedule is set. Manual-only may be
  // intended, so ASK rather than assume.
  const proseForCadence = [
    def.description ?? '',
    def.description_body ?? '',
    ...steps.map((s) => s.prompt ?? ''),
  ].join('\n');
  if (!def.trigger?.schedule && CADENCE_RE.test(proseForCadence)) {
    gaps.push({
      severity: 'clarify',
      question: 'This reads like recurring work, but no schedule is set — should I schedule it (what time + timezone), or keep it manual-only?',
      why: 'A workflow meant to run "every morning" that has no schedule will simply never fire on its own.',
    });
  }

  // 6: a step reads like per-item work but doesn't fan out over its upstream.
  for (const step of steps) {
    if (step.forEach) continue;
    if (!(step.dependsOn && step.dependsOn.length > 0)) continue;
    if (!FOREACH_HINT_RE.test(step.prompt ?? '')) continue;
    gaps.push({
      severity: 'clarify',
      stepId: step.id,
      question: `Step "${step.id}" reads like it should run once per item — should it fan out (forEach) over ${step.dependsOn.map((d) => `"${d}"`).join('/')}'s list so every item is actually covered, instead of one pass over the whole batch?`,
      why: 'Serial "do them all" steps routinely cover only the first few items and silently drop the rest.',
    });
  }

  return gaps.slice(0, MAX_GAPS);
}

/**
 * Render gap questions for the workflow_create / workflow_update tool result,
 * so the AUTHORING agent asks the user before the workflow is relied on. Empty
 * string when there are no gaps (a clean save stays byte-identical).
 */
export function renderWorkflowGapQuestions(gaps: WorkflowGap[]): string {
  if (gaps.length === 0) return '';
  const lines = gaps.map((g) => `- ${g.question}\n  (why: ${g.why})`);
  return [
    '',
    '',
    "Gap test — before this workflow is reliable, get the user's answer on:",
    ...lines,
    '',
    'Ask these now, then refine the workflow with workflow_update. Do not present it as ready until they\'re resolved.',
  ].join('\n');
}
