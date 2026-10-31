/** Host-authored request stages for display and diagnosis only. These do not
 * attest a review verdict, grant execution, or change usage attribution. */
export const MODEL_CALL_PURPOSES = [
  'jev-read-nomination', 'jev-prepare', 'jev-rank', 'jev-primer', 'jev-turn-start',
  'jev-open-question-reply', 'jev-approval-reply', 'jev-requested-write',
  'jev-owner-choice', 'jev-approval-label', 'jev-resolution-name', 'jev-agent-select',
  'jev-grounding', 'jev-trajectory', 'jev-completion', 'jev-watch', 'jev-heartbeat',
  'jev-output-grounding', 'jev-revision', 'jev-request-effect', 'jev-quantified-universe',
  'jev-operation-delivery', 'jev-worker-route', 'jev-operation-variant-read',
  'jev-operation-effect', 'jev-rejected-claim', 'jev:clarification_answer_completeness', 'jev:clarification_revision',
] as const;

export type ModelCallPurpose = typeof MODEL_CALL_PURPOSES[number];
const known = new Set<string>(MODEL_CALL_PURPOSES);

/** Unknown or user-authored strings stay absent rather than being exposed as
 * a purpose, inferred from a model name, or recovered from a later caller. */
export function modelCallPurpose(value: unknown): ModelCallPurpose | undefined {
  return typeof value === 'string' && known.has(value) ? value as ModelCallPurpose : undefined;
}
