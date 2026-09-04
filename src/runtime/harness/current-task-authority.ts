/**
 * Deterministic precedence for the current accepted user input.
 *
 * Focus, working memory, goals, and clarification packets are continuity aids;
 * none of them may turn an explicit fresh start into a continuation of older
 * work.  Keep this vocabulary deliberately small and provider-neutral so every
 * prompt/runtime lane makes the same decision before model interpretation.
 */

export type CurrentTaskInputDisposition = 'fresh' | 'resume' | 'unspecified';
export type CurrentTaskSemanticRelation =
  | 'conversation'
  | 'new_goal'
  | 'continue_goal'
  | 'answer_open_slot'
  | 'amend_goal'
  | 'abandon_goal'
  | 'ambiguous';

const EXPLICIT_FRESH_PATTERNS: readonly RegExp[] = [
  /\bbrand[\s-]*new\b/i,
  /\bfrom\s+scratch\b/i,
  /^\s*fresh[.!?]?\s*$/i,
  /\bfresh\s+(?:task|request|workflow|job|batch|set|start|objective)\b/i,
  /\b(?:different|another)\s+(?:task|request|workflow|job|batch|set|goal|objective|thing)\b/i,
  /\b(?:something|anything)\s+different\b/i,
  /\bstart(?:ing)?\s+(?:over|again)\b/i,
  /\bnew\s+(?:task|request|batch|set|workflow|job|goal|objective)\b/i,
  /\bswitch(?:ing)?\s+(?:over\s+)?to\b/i,
  /\bmov(?:e|ing)\s+on\s+to\b/i,
];

const EXPLICIT_RESUME_PATTERNS: readonly RegExp[] = [
  /^\s*(?:please\s+)?(?:continue|resume|keep\s+going|carry\s+on|go\s+on)\b/i,
  /\b(?:continue|resume)\s+(?:the|this|that|my|our)\s+(?:task|work|run|workflow|job|conversation)\b/i,
  /\bpick\s+(?:it|this|that|the\s+task|the\s+work)?\s*back\s+up\b/i,
  /\bpick\s+up\s+(?:where\s+(?:we|you)\s+left\s+off|this|that|the\s+task|the\s+work)\b/i,
  /\bwhere\s+(?:we|you)\s+left\s+off\b/i,
];

function normalizedInput(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Fresh/pivot wording wins even when the same sentence also says continue. */
export function classifyCurrentTaskInput(
  value: string | null | undefined,
  semanticRelation?: CurrentTaskSemanticRelation | null,
): CurrentTaskInputDisposition {
  const input = normalizedInput(value);
  // Explicit boundary wording is a fail-safe against an old open-slot view
  // incorrectly projecting a new request as its answer. Outside that narrow
  // case, an admitted accepted-source relation is stronger than phrase shape.
  if (EXPLICIT_FRESH_PATTERNS.some((pattern) => pattern.test(input))) return 'fresh';
  if (semanticRelation === 'new_goal' || semanticRelation === 'abandon_goal') return 'fresh';
  if (
    semanticRelation === 'continue_goal'
    || semanticRelation === 'answer_open_slot'
    || semanticRelation === 'amend_goal'
  ) return 'resume';
  if (!input) return 'unspecified';
  if (EXPLICIT_RESUME_PATTERNS.some((pattern) => pattern.test(input))) return 'resume';
  return 'unspecified';
}

export function currentInputSuppressesPriorTask(
  value: string | null | undefined,
  semanticRelation?: CurrentTaskSemanticRelation | null,
): boolean {
  return classifyCurrentTaskInput(value, semanticRelation) === 'fresh';
}

export function currentInputExplicitlyResumesPriorTask(
  value: string | null | undefined,
  semanticRelation?: CurrentTaskSemanticRelation | null,
): boolean {
  return classifyCurrentTaskInput(value, semanticRelation) === 'resume';
}
